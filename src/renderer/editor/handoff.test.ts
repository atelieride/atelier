import { afterEach, expect, test } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history, historyField, undo } from '@codemirror/commands';
import type { EditorHandoff } from '@shared/popout';
import { HISTORY_LIMIT, beginMove, endMove, hasHandoff, isMoving, moveGuard, putHandoff, snapshotEditor, stateFromHandoff, takeHandoff } from './handoff';
import { handoffOf, registerSaver } from './savers';
import { reloadSpec } from './conflict';

// Tab pop-out windows: an editor moving between windows takes its buffer along — text, selection,
// undo history, scroll and what Save compares against. These are EditorState-level: the test environment has no DOM.

const typed = () => {
  let s = EditorState.create({ doc: 'x', extensions: [history()] });
  // Two typing transactions (the history may join them into one undo step).
  s = s.update({ changes: { from: 1, insert: 'ab' }, userEvent: 'input.type' }).state;
  s = s.update({ changes: { from: 3, insert: 'c' }, userEvent: 'input.type' }).state;
  return s.update({ selection: EditorSelection.single(1, 2) }).state;
};

const fakeView = (state: EditorState, scrollTop = 0) => ({ state, scrollDOM: { scrollTop } }) as unknown as EditorView;
const extra = { path: '/p/a.ts', saved: 'x', stamp: { mtimeMs: 1, size: 1, hash: 'h' }, eol: 'crlf' as const };

afterEach(() => { takeHandoff('/p/a.ts'); takeHandoff('/p/b.ts'); });

test('round trip: same text and selection, and undo brings back the text before the last edit', () => {
  const s = typed();
  const h = snapshotEditor(fakeView(s, 240), extra);
  expect(h).toMatchObject({ path: '/p/a.ts', saved: 'x', stamp: { mtimeMs: 1, size: 1, hash: 'h' }, eol: 'crlf', scrollTop: 240 });
  expect(h.state.doc).toBe('xabc');
  expect(h.state.history).toBeDefined();
  // Through JSON, as the IPC carries it.
  const back = stateFromHandoff(JSON.parse(JSON.stringify(h)) as EditorHandoff, [history()]);
  expect(back.doc.toString()).toBe('xabc');
  expect(back.selection.main.from).toBe(1);
  expect(back.selection.main.to).toBe(2);
  let after = back;
  expect(undo({ state: back, dispatch: (tr) => { after = tr.state; } })).toBe(true);
  expect(after.doc.toString()).not.toBe('xabc');
  expect('xabc'.startsWith(after.doc.toString())).toBe(true);
});

test('a corrupt history or selection: the editor still gets the text, nothing throws', () => {
  const h: EditorHandoff = { ...extra, scrollTop: 0, state: { doc: 'mine', selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 }, history: { done: 'garbage', undone: 7 } } };
  const s = stateFromHandoff(h, [history()]);
  expect(s.doc.toString()).toBe('mine');
  const bad: EditorHandoff = { ...h, state: { doc: 'mine', selection: { ranges: [{ anchor: 99, head: 99 }], main: 0 } } };
  expect(stateFromHandoff(bad, [history()]).doc.toString()).toBe('mine');
  const none: EditorHandoff = { ...h, state: { doc: 'mine', selection: null } };
  expect(stateFromHandoff(none, [history()]).doc.toString()).toBe('mine');
});

test('a handoff is handed once', () => {
  const h = snapshotEditor(fakeView(typed()), extra);
  putHandoff(h);
  expect(hasHandoff('/p/a.ts')).toBe(true);
  expect(hasHandoff('/p/b.ts')).toBe(false);
  expect(takeHandoff('/p/b.ts')).toBeNull();
  expect(takeHandoff('/p/a.ts')).toBe(h);
  expect(takeHandoff('/p/a.ts')).toBeNull();
  expect(hasHandoff('/p/a.ts')).toBe(false);
});

test('a history over 8 MiB stays behind; the text never does', () => {
  const s = typed();
  const big = 'y'.repeat(HISTORY_LIMIT + 1);
  const huge = { ...s, toJSON: () => ({ doc: big, selection: s.selection.toJSON(), history: { done: [big], undone: [] } }) } as unknown as EditorState;
  const h = snapshotEditor(fakeView(huge), extra);
  expect(h.state.history).toBeUndefined();
  expect(h.state.doc).toBe(big);
  expect(HISTORY_LIMIT).toBe(8 * 1024 * 1024);
});

test('a read-only editor (no history in its state) hands its text and selection without history', () => {
  const s = EditorState.create({ doc: 'ro', selection: { anchor: 1 }, extensions: [EditorState.readOnly.of(true)] });
  const h = snapshotEditor(fakeView(s), extra);
  expect(h.state.history).toBeUndefined();
  expect(stateFromHandoff(h, []).selection.main.head).toBe(1);
  expect(historyField).toBeDefined();
});

test('while its tab is moving, the editor takes no edits (they would stay behind); after, it does again', () => {
  let s = EditorState.create({ doc: 'a', extensions: [moveGuard('/p/a.ts')] });
  beginMove('/p/a.ts');
  try {
    s = s.update({ changes: { from: 1, insert: 'lost' } }).state;
    expect(s.doc.toString()).toBe('a');
    // Another file's editor is not concerned.
    const other = EditorState.create({ doc: 'b', extensions: [moveGuard('/p/b.ts')] });
    expect(other.update({ changes: { from: 1, insert: '!' } }).state.doc.toString()).toBe('b!');
  } finally { endMove('/p/a.ts'); }
  s = s.update({ changes: { from: 1, insert: 'kept' } }).state;
  expect(s.doc.toString()).toBe('akept');
  expect(isMoving('/p/a.ts')).toBe(false);
});

test('while its tab is moving, a reload from disk still reaches the editor (saved and stamp follow it)', () => {
  let s = EditorState.create({ doc: 'a', extensions: [history(), moveGuard('/p/a.ts')] });
  beginMove('/p/a.ts');
  try {
    s = s.update(reloadSpec({ from: 1, to: 1, insert: ' from Claude' })).state;
    expect(s.doc.toString()).toBe('a from Claude');
    // A user edit is still refused.
    s = s.update({ changes: { from: 0, insert: '!' }, userEvent: 'input.type' }).state;
    expect(s.doc.toString()).toBe('a from Claude');
  } finally { endMove('/p/a.ts'); }
});

test('a handoff never lands on a path whose editor is open here (it would replace a live buffer)', () => {
  const off = registerSaver('/p/a.ts', async () => true, () => true);
  try {
    expect(putHandoff(snapshotEditor(fakeView(typed()), extra))).toBe(false);
    expect(hasHandoff('/p/a.ts')).toBe(false);
  } finally { off(); }
  expect(putHandoff(snapshotEditor(fakeView(typed()), extra))).toBe(true);
  expect(hasHandoff('/p/a.ts')).toBe(true);
});

test('the savers registry answers with the open editor’s handoff, nothing for an editor that has none', () => {
  const h = snapshotEditor(fakeView(typed()), extra);
  const off = registerSaver('/p/a.ts', async () => true, () => true, () => h);
  const offB = registerSaver('/p/b.ts', async () => true, () => false, () => null);
  expect(handoffOf('/p/a.ts')).toBe(h);
  expect(handoffOf('/p/b.ts')).toBeUndefined();
  expect(handoffOf('/p/c.ts')).toBeUndefined();
  off(); offB();
  expect(handoffOf('/p/a.ts')).toBeUndefined();
});

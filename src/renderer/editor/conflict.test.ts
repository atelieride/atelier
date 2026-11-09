import { expect, test } from 'vitest';
import { normalizeEol, onDiskChange, saveGate, unsaved } from './conflict';

test('file changed on disk: reload, nothing, or conflict', () => {
  expect(onDiskChange({ dirty: false, disk: 'b', buffer: 'a', saved: 'a' })).toBe('reload-minimal');
  expect(onDiskChange({ dirty: true, disk: 'mine', buffer: 'mine', saved: 'old' })).toBe('adopt');
  expect(onDiskChange({ dirty: true, disk: 'old', buffer: 'mine', saved: 'old' })).toBe('none');
  expect(onDiskChange({ dirty: true, disk: 'claude', buffer: 'mine', saved: 'old' })).toBe('conflict');
  expect(onDiskChange({ dirty: false, disk: 'a', buffer: 'a', saved: 'a' })).toBe('none');
});

test('CRLF becomes LF for the editor', () => {
  expect(normalizeEol('a\r\nb\r\n')).toBe('a\nb\n');
  expect(normalizeEol('a\nb')).toBe('a\nb');
});

test('a reload from disk does not enter the history: ⌘Z undoes only the user\'s edits', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { history, undo } = await import('@codemirror/commands');
  const { reloadSpec } = await import('./conflict');
  let s = EditorState.create({ doc: 'a\n', extensions: [history()] });
  s = s.update({ changes: { from: 2, insert: 'mine\n' } }).state;
  s = s.update(reloadSpec({ from: 0, to: 1, insert: 'CLAUDE' })).state;
  expect(s.doc.toString()).toBe('CLAUDE\nmine\n');
  let after = s;
  undo({ state: s, dispatch: (tr) => { after = tr.state; } });
  expect(after.doc.toString()).toBe('CLAUDE\n');
});

test('a buffer with edits is unsaved whatever the disk holds now (a copy that turned not UTF-8 included); the Diff view never', () => {
  expect(unsaved({ doc: 'mine', saved: 'old', diff: false })).toBe(true);
  expect(unsaved({ doc: 'same', saved: 'same', diff: false })).toBe(false);
  // The Diff view's text is the diff, not the file: it holds no edits.
  expect(unsaved({ doc: '+ a\n- b', saved: 'a', diff: true })).toBe(false);
  expect(unsaved(null)).toBe(false);
});

test('saving: the Diff view and a read-only file stay quiet; edits over a disk copy that is not UTF-8 get a clear error', () => {
  const ok = { diff: false, notUtf8: false, gitInternal: false, unsaved: true };
  expect(saveGate(ok)).toBe('save');
  expect(saveGate({ ...ok, diff: true })).toBe('quiet');
  expect(saveGate({ ...ok, gitInternal: true })).toBe('quiet');
  expect(saveGate({ ...ok, notUtf8: true })).toBe('not-utf8');
  // Opened not UTF-8 and never edited (read-only from the start): nothing to say.
  expect(saveGate({ ...ok, notUtf8: true, unsaved: false })).toBe('quiet');
});


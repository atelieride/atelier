import { expect, test } from 'vitest';
import type { FileChange } from '@shared/git';
import {
  type GitWrite, modelLabel, seconds, sparkleMode, stagedKey, stale, TWEAKS, tweaksLeft, writeApplied, writeChunk, writeEdited, writeMeta, writeReady,
  writeStart, writeStopped
} from './message';

// ✦ in the commit drawer as data: a run streams, is ready (one replacement to put in the field,
// then the pills until the user types), stops with what it had, and what the sparkle, the meta line and the pills show.

const ch = (rel: string, stage: FileChange['stage']): FileChange => ({ path: `/r/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0 });
const start = (o: Partial<Parameters<typeof writeStart>[1]> = {}) => writeStart(null, { root: '/r', staged: 'k', at: 1000, tweak: null, ...o });
const DONE = { text: 'feat(cart): round half up', model: 'haiku', ms: 1830, notes: ['1 file left out of ✦ (looks like a secret)'] };

test('stagedKey: the staged files and how much of each, in any order; unstaged ones do not count', () => {
  const a = stagedKey({ changes: [ch('b.ts', 'all'), ch('a.ts', 'partial'), ch('c.ts', 'none')] });
  expect(a).toBe(stagedKey({ changes: [ch('a.ts', 'partial'), ch('b.ts', 'all')] }));
  expect(a).not.toBe(stagedKey({ changes: [ch('a.ts', 'all'), ch('b.ts', 'all')] }));
  expect(a).not.toBe(stagedKey({ changes: [ch('b.ts', 'all')] }));
  expect(stagedKey(undefined)).toBe('');
});

test('a run: writing, chunks appended, ready with one replacement to apply, then the pills until the user types', () => {
  let w: GitWrite | null = start();
  expect(w).toMatchObject({ root: '/r', phase: 'writing', id: null, text: '', apply: null, used: [] });
  w = writeChunk(writeChunk(w, 'feat(cart): '), 'round');
  expect(w.text).toBe('feat(cart): round');
  w = writeReady(w, DONE);
  expect(w).toMatchObject({ phase: 'ready', text: DONE.text, apply: DONE.text, model: 'haiku', ms: 1830, notes: DONE.notes });
  // Until the field takes it, no pills.
  expect(tweaksLeft(w)).toEqual([]);
  w = writeApplied(w)!;
  expect(w.apply).toBeNull();
  expect(tweaksLeft(w)).toEqual(TWEAKS);
  // The replacement itself arriving in the field is not typing.
  expect(writeEdited(w, DONE.text)).toBe(w);
  // Typing (or ⌘Z back to the old text): ready is over, the pills and the meta line go.
  expect(writeEdited(w, `${DONE.text}!`)).toBeNull();
  // A chunk after ready (a late event) changes nothing.
  expect(writeChunk(w, 'x')).toBe(w);
});

test('a tweak rewrites once: the pill used is spent for the next ready; a fresh ✦ brings them all back', () => {
  const ready = writeApplied(writeReady(start(), DONE))!;
  const shorter = writeStart(ready, { root: '/r', staged: 'k', at: 2000, tweak: 'shorter' });
  expect(shorter).toMatchObject({ phase: 'writing', tweak: 'shorter', used: ['shorter'] });
  const again = writeApplied(writeReady(shorter, DONE))!;
  expect(tweaksLeft(again)).toEqual(['detail', 'subject']);
  const subject = writeApplied(writeReady(writeStart(again, { root: '/r', staged: 'k', at: 3000, tweak: 'subject' }), DONE))!;
  expect(tweaksLeft(subject)).toEqual(['detail']);
  expect(writeStart(subject, { root: '/r', staged: 'k', at: 4000, tweak: null }).used).toEqual([]);
  // Another repository starts its own chain.
  expect(writeStart(again, { root: '/other', staged: 'k', at: 4000, tweak: 'detail' }).used).toEqual(['detail']);
});

test('Stop keeps what was streamed (one replacement), nothing when nothing came; applied, it is over', () => {
  const w = writeChunk(start(), 'feat(cart): ');
  const stopped = writeStopped(w)!;
  expect(stopped).toMatchObject({ phase: 'stopped', apply: 'feat(cart): ' });
  expect(writeApplied(stopped)).toBeNull();
  expect(writeStopped(start())).toBeNull();
  expect(writeStopped(writeChunk(start(), '  \n'))).toBeNull();
  // Only a run in progress stops.
  const ready = writeReady(w, DONE);
  expect(writeStopped(ready)).toBe(ready);
});

test('the meta line: writing, then the model and the time', () => {
  expect(writeMeta(start())).toBe('✦ writing · Esc to stop');
  expect(writeMeta(writeApplied(writeReady(start(), DONE))!)).toBe('✦ Haiku · 1.8 s');
  expect(writeMeta(writeApplied(writeReady(start(), { ...DONE, model: 'sonnet', ms: 12_340 }))!)).toBe('✦ Sonnet · 12.3 s');
  expect(writeMeta(writeStopped(writeChunk(start(), 'x'))!)).toBeNull();
  expect(writeMeta(null)).toBeNull();
  expect(modelLabel('haiku')).toBe('Haiku');
  expect(modelLabel('claude-x')).toBe('Claude-x');
  expect(seconds(950)).toBe('0.9 s');
  expect(seconds(1850)).toBe('1.9 s');
});

test('the sparkle: glows on an empty field, quiet otherwise; Stop while writing; ↻ when ready', () => {
  expect(sparkleMode({ w: null, empty: true })).toBe('glow');
  expect(sparkleMode({ w: null, empty: false })).toBe('write');
  expect(sparkleMode({ w: start(), empty: true })).toBe('stop');
  expect(sparkleMode({ w: writeReady(start(), DONE), empty: false })).toBe('again');
  expect(sparkleMode({ w: writeStopped(writeChunk(start(), 'x')), empty: false })).toBe('write');
});

test('stale: what is staged changed since ✦ started (writing or ready), never after typing', () => {
  const w = start({ staged: stagedKey({ changes: [ch('a.ts', 'all')] }) });
  expect(stale(w, { changes: [ch('a.ts', 'all')] })).toBe(false);
  expect(stale(w, { changes: [ch('a.ts', 'all'), ch('b.ts', 'all')] })).toBe(true);
  expect(stale(writeReady(w, DONE), { changes: [ch('a.ts', 'partial')] })).toBe(true);
  expect(stale(null, { changes: [ch('a.ts', 'all')] })).toBe(false);
  expect(stale(writeStopped(writeChunk(w, 'x')), { changes: [] })).toBe(false);
});

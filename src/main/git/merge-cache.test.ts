import { expect, test } from 'vitest';
import type { MergeInfo, RepoStatus } from '@shared/git';
import { MergeSummaries, type DefaultRef } from './merge-cache';

const st = (root: string, o: Partial<RepoStatus> = {}): RepoStatus => ({ root, name: 'x', branch: 'feat', detached: false, ahead: 0, behind: 0, changes: [], oid: '1'.repeat(40), checkedAt: 0, truncated: 0, ...o });
const info: MergeInfo = { base: 'main', commits: 2, files: ['a.ts'], truncated: 0, merged: false };

function setup(def: DefaultRef | null = { ref: 'main', base: 'main', oid: 'd'.repeat(40) }) {
  const calls = { probe: 0, compute: 0 };
  let current = def;
  const cache = new MergeSummaries(
    async () => { calls.probe++; return current; },
    async () => { calls.compute++; return info; }
  );
  return { cache, calls, move: (d: DefaultRef | null) => { current = d; } };
}

test('one default-branch probe per git common dir and one computation per (HEAD, default) pair', async () => {
  const { cache, calls } = setup();
  expect(await cache.summary('/p/.git', '/p/wt1', st('/p/wt1'))).toEqual({ changed: true, info });
  expect(await cache.summary('/p/.git', '/p/wt1', st('/p/wt1'))).toEqual({ changed: false, info });
  await cache.summary('/p/.git', '/p/wt2', st('/p/wt2'));
  expect(calls).toEqual({ probe: 1, compute: 2 });
  // A new commit on the branch: computed again.
  await cache.summary('/p/.git', '/p/wt1', st('/p/wt1', { oid: '2'.repeat(40) }));
  expect(calls).toEqual({ probe: 1, compute: 3 });
});

test('on the default branch nothing is computed; without a default branch neither', async () => {
  const { cache, calls } = setup();
  expect(await cache.summary('/p/.git', '/p', st('/p', { branch: 'main' }))).toEqual({ changed: true, info: null });
  expect(await cache.summary('/p/.git', '/p', st('/p', { branch: 'main' }))).toEqual({ changed: false, info: null });
  expect(calls.compute).toBe(0);
  const none = setup(null);
  expect((await none.cache.summary('/q/.git', '/q/wt', st('/q/wt'))).info).toBeNull();
  expect(none.calls.compute).toBe(0);
});

test('refs moved: the default branch is probed again, and a moved default recomputes', async () => {
  const { cache, calls, move } = setup();
  await cache.summary('/p/.git', '/p/wt1', st('/p/wt1'));
  cache.invalidate('/p/.git');
  await cache.summary('/p/.git', '/p/wt1', st('/p/wt1'));
  expect(calls).toEqual({ probe: 2, compute: 1 });
  move({ ref: 'main', base: 'main', oid: 'e'.repeat(40) });
  cache.invalidate('/p/.git');
  expect((await cache.summary('/p/.git', '/p/wt1', st('/p/wt1'))).changed).toBe(true);
  expect(calls).toEqual({ probe: 3, compute: 2 });
});

test('a forgotten working tree starts over; no HEAD or an error is no summary', async () => {
  const { cache, calls } = setup();
  await cache.summary('/p/.git', '/p/wt1', st('/p/wt1'));
  cache.forget('/p/wt1');
  expect((await cache.summary('/p/.git', '/p/wt1', st('/p/wt1'))).changed).toBe(true);
  expect(calls.compute).toBe(2);
  expect((await cache.summary('/p/.git', '/p/wt3', st('/p/wt3', { oid: null }))).info).toBeNull();
  expect((await cache.summary('/p/.git', '/p/wt4', st('/p/wt4', { error: 'x' }))).info).toBeNull();
  expect(calls.compute).toBe(2);
});

import { expect, test } from 'vitest';
import type { RepoStatus } from '@shared/git';
import { viewFetchKey, viewFetchRoots, watchViewFetches } from './view-fetch';

// Changes counts as "viewing" for auto-fetch: every readable main repository
// of the window asks main for a view fetch when it appears and whenever the window comes back to the front. Main
// decides (setting, remote, 10 min, backoff, auth).

const st = (root: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root, name: root.split('/').at(-1)!, branch: 'main', detached: false, ahead: 0, behind: 0, changes: [], oid: null, checkedAt: 0, truncated: 0, ...o
});

test('the roots to fetch: readable main repositories, in order, once; never a linked worktree (it shares its repo\'s objects)', () => {
  const repos = [st('/p/api'), st('/p/api/.claude/worktrees/x', { worktreeOf: '/p/api' }), st('/p/odd', { error: 'safe.directory' }), st('/p/web'), st('/p/api')];
  expect(viewFetchRoots(repos)).toEqual(['/p/api', '/p/web']);
  expect(viewFetchRoots([])).toEqual([]);
});

test('asks once per root at once, again for each on focus; stops when cleaned up', () => {
  const asked: string[] = [];
  const target = new EventTarget();
  const stop = watchViewFetches(['/p/api', '/p/web'], (root) => { asked.push(root); }, target);
  expect(asked).toEqual(['/p/api', '/p/web']);
  target.dispatchEvent(new Event('focus'));
  expect(asked).toEqual(['/p/api', '/p/web', '/p/api', '/p/web']);
  stop();
  target.dispatchEvent(new Event('focus'));
  expect(asked).toHaveLength(4);
});

test('the key Changes asks by: the same while only the statuses change, another when the set of readable main repos does', () => {
  const a = [st('/p/api'), st('/p/web'), st('/p/web/.claude/worktrees/x', { worktreeOf: '/p/web' })];
  const key = viewFetchKey(a);
  expect(key).toBe('/p/api\n/p/web');
  // Every status broadcast is a new array of new objects: same roots, same key (no ask per broadcast).
  expect(viewFetchKey(a.map((r) => ({ ...r, ahead: r.ahead + 1, changes: [], checkedAt: 9 })))).toBe(key);
  // A worktree coming or going doesn't ask (it shares its repo's objects).
  expect(viewFetchKey(a.slice(0, 2))).toBe(key);
  expect(viewFetchKey([...a, st('/p/docs')])).not.toBe(key);
  expect(viewFetchKey([a[0]!, st('/p/web', { error: 'timeout' })])).toBe('/p/api');
  expect(viewFetchKey([])).toBe('');
});

test('no roots: asks nothing, listens to nothing', () => {
  const asked: string[] = [];
  const target = new EventTarget();
  watchViewFetches([], (root) => { asked.push(root); }, target);
  target.dispatchEvent(new Event('focus'));
  expect(asked).toEqual([]);
});

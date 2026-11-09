import { expect, test } from 'vitest';
import type { ScmRef, ScmRefs } from '@shared/scm';
import { checkedOutIn, matchPositions, pickerGroups, rowCursor } from './picker';

test('rowCursor: the highlighted row is found by its key wherever a refs reload moved it (Enter must switch to what is shown)', () => {
  // feat/a highlighted; a session commits on feat/b, which moves to the top of Local.
  expect(rowCursor(['local:refs/heads/feat/b', 'local:refs/heads/feat/a', 'local:refs/heads/main'], 'local:refs/heads/feat/a')).toBe(1);
  // Nothing highlighted yet, or the row gone (a branch deleted): the first row.
  expect(rowCursor(['local:refs/heads/main'], null)).toBe(0);
  expect(rowCursor(['local:refs/heads/main'], 'local:refs/heads/gone')).toBe(0);
  expect(rowCursor([], 'x')).toBe(0);
});
import { shortRef } from './view';

const ref = (name: string, o: Partial<ScmRef> = {}): ScmRef => {
  const kind = name.startsWith('refs/heads/') ? 'head' : name.startsWith('refs/remotes/') ? 'remote' : 'tag';
  return { name, short: shortRef(name), kind, ...(kind === 'remote' ? { remote: 'origin' } : {}), oid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, gone: false, current: false, date: 0, ...o };
};
const refs = (list: ScmRef[]): ScmRefs => ({ root: '/p', head: { branch: 'main', oid: 'a'.repeat(40), detached: false }, refs: list, defaultBranch: { ref: 'main', base: 'main' }, shallow: false, fetchedAt: null, remotes: ['origin'], hasRemote: true, emptyTree: '' });
const R = refs([ref('refs/heads/main', { current: true, date: 1 }), ref('refs/heads/feat/x', { date: 9 }), ref('refs/heads/v2.2-integrate', { date: 5 }), ref('refs/remotes/origin/main', { date: 1 }), ref('refs/remotes/origin/feat/x', { date: 9 }), ref('refs/tags/v0.2.0-beta.6', { date: 3 }), ref('refs/tags/v0.1.0', { date: 1 })]);

test('empty query: the current branch, the recent refs, then local branches by date; remotes and tags newest first', () => {
  const g = pickerGroups(R, '', ['refs/tags/v0.1.0', 'refs/heads/v2.2-integrate']);
  expect(g.recent.map((x) => x.ref.short)).toEqual(['main', 'v0.1.0', 'v2.2-integrate']);
  expect(g.local.map((x) => x.ref.short)).toEqual(['feat/x']);
  expect(g.remote.map((x) => x.ref.short)).toEqual(['origin/feat/x', 'origin/main']);
  expect(g.tags.map((x) => x.ref.short)).toEqual(['v0.2.0-beta.6']);
});

test('a query filters every group by fuzzy match on the short name, best first, with the matched positions', () => {
  const g = pickerGroups(R, 'feat', []);
  expect(g.recent).toEqual([]);
  expect(g.local.map((x) => x.ref.short)).toEqual(['feat/x']);
  expect(g.remote.map((x) => x.ref.short)).toEqual(['origin/feat/x']);
  expect(g.tags).toEqual([]);
  expect(g.local[0]!.match).toEqual([0, 1, 2, 3]);
  expect(pickerGroups(R, 'v22', []).local.map((x) => x.ref.short)).toEqual(['v2.2-integrate']);
});

test('matchPositions', () => {
  expect(matchPositions('fx', 'feat/x')).toEqual([0, 5]);
  expect(matchPositions('', 'abc')).toEqual([]);
  expect(matchPositions('zz', 'abc')).toEqual([]);
});

test('checkedOutIn: the working tree of this repository a branch is checked out in, never one of another repository', () => {
  const st = (branch: string) => ({ branch, detached: false, oid: 'a'.repeat(40), ahead: 0, behind: 0, upstream: null, changes: 0 });
  const e = (root: string, common: string, branch: string) => ({ root, rel: root.slice(3), name: root.split('/').pop()!, worktreeOf: null, common, status: st(branch) });
  const entries = [e('/p/a', '/p/a/.git', 'main'), e('/p/a/.wt/x', '/p/a/.git', 'feat/x'), e('/p/b', '/p/b/.git', 'feat/x'), e('/p/c', '/p/c/.git', 'main')];
  expect(checkedOutIn(entries, '/p/a', 'feat/x')?.root).toBe('/p/a/.wt/x');
  expect(checkedOutIn(entries, '/p/a', 'main')?.root).toBe('/p/a');
  // Another repository on a branch of the same name is not this one's.
  expect(checkedOutIn(entries, '/p/c', 'feat/x')).toBeNull();
  expect(checkedOutIn(null, '/p/a', 'main')).toBeNull();
});

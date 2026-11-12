import { expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { WtView } from './worktrees';
import { pullLabel, pullTipLines, syncLabel, syncOf, syncTip, toPull, toSyncOf } from './sync';

// Sync arrows in Changes: ↓/↑ only against the branch's own upstream, only
// when something is to pull or push; the tooltip names the upstream.

const st = (o: Partial<RepoStatus>) => ({ branch: 'main', upstream: 'origin/main', upstreamGone: false, ahead: 0, behind: 0, ...o });

test('own upstream with commits either way: the counts and the short upstream', () => {
  expect(syncOf(st({ ahead: 2 }))).toEqual({ behind: 0, ahead: 2, upstream: 'origin/main' });
  expect(syncOf(st({ behind: 3, branch: 'develop', upstream: 'origin/develop' }))).toEqual({ behind: 3, ahead: 0, upstream: 'origin/develop' });
  expect(syncOf(st({ behind: 1, ahead: 2, branch: 'feat/x', upstream: 'origin/feat/x' }))).toEqual({ behind: 1, ahead: 2, upstream: 'origin/feat/x' });
  // A full ref name comes back short.
  expect(syncOf(st({ ahead: 1, upstream: 'refs/remotes/origin/main' }))).toEqual({ behind: 0, ahead: 1, upstream: 'origin/main' });
});

test('nothing to show: in sync, no upstream, another name, gone, detached, unreadable', () => {
  expect(syncOf(st({}))).toBeNull();
  expect(syncOf(st({ upstream: null, ahead: 2 }))).toBeNull();
  expect(syncOf(st({ upstream: undefined, ahead: 2 }))).toBeNull();
  expect(syncOf(st({ branch: 'feat/x', upstream: 'origin/main', ahead: 4 }))).toBeNull();
  expect(syncOf(st({ upstreamGone: true, ahead: 2 }))).toBeNull();
  expect(syncOf(st({ branch: null, ahead: 2 }))).toBeNull();
  expect(syncOf(st({ error: 'safe.directory', ahead: 2 }))).toBeNull();
});

test('tooltip and label for each shape', () => {
  expect(syncTip({ behind: 0, ahead: 2, upstream: 'origin/main' })).toBe('2 to push to origin/main');
  expect(syncTip({ behind: 3, ahead: 0, upstream: 'origin/develop' })).toBe('3 to pull from origin/develop');
  expect(syncTip({ behind: 1, ahead: 2, upstream: 'origin/main' })).toBe('1 to pull · 2 to push · origin/main');
  expect(syncLabel({ behind: 1, ahead: 2, upstream: 'origin/main' })).toBe('1 to pull, 2 to push');
  expect(syncLabel({ behind: 0, ahead: 2, upstream: 'origin/main' })).toBe('2 to push');
  expect(syncLabel({ behind: 4, ahead: 0, upstream: 'origin/main' })).toBe('4 to pull');
});

// Grouped by session: "To sync" holds the working trees whose arrows have no other place there — main repos
// with changes shown, and worktrees with their own upstream's counts (clean or not). Clean main repos are in "Clean".

const ch = (root: string, rel: string): FileChange => ({ path: `${root}/${rel}`, rel, kind: 'M', stage: 'none', added: 1, removed: 0 });
const repo = (name: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root: `/p/${name}`, name, branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, changes: [], oid: 'a'.repeat(40), checkedAt: 0, truncated: 0, ...o
});
const wtv = (name: string, o: Partial<RepoStatus> = {}): WtView => {
  const status = repo(name, { root: `/p/web/.claude/worktrees/${name}`, branch: `worktree-${name}`, upstream: null, worktreeOf: '/p/web', ...o });
  return { status, name, rows: [], state: status.merge?.commits ? 'merge' : 'idle' };
};

test('"To sync": dirty main repos with something to sync, in order, then worktrees with own-upstream counts, by name', () => {
  const cleanBehind = repo('docs', { behind: 3 });
  const dirtyAhead = repo('api', { ahead: 2, changes: [ch('/p/api', 'a.ts')] });
  const dirtyInSync = repo('infra', { changes: [ch('/p/infra', 'b.ts')] });
  const unreadable = repo('odd', { ahead: 1, changes: [ch('/p/odd', 'c.ts')], error: 'safe.directory' });
  const dirtyAhead2 = repo('web', { behind: 1, changes: [ch('/p/web', 'd.ts')] });
  const pushed = wtv('zeta', { upstream: 'origin/worktree-zeta', branch: 'worktree-zeta', ahead: 1 });
  const pushed2 = wtv('alpha', { upstream: 'origin/worktree-alpha', branch: 'worktree-alpha', behind: 2 });
  const localOnly = wtv('spike', { merge: { commits: 4, merged: false, base: 'main', files: [], truncated: 0 } });
  const otherName = wtv('fix', { upstream: 'origin/main', ahead: 3 });
  const mains = [cleanBehind, dirtyAhead, dirtyInSync, unreadable, dirtyAhead2];
  const shown = [...dirtyAhead.changes, ...dirtyInSync.changes, ...unreadable.changes, ...dirtyAhead2.changes].map((c) => ({ repo: c.path.split('/').slice(0, 3).join('/') }));
  const list = toSyncOf(mains, shown, [pushed, localOnly, pushed2, otherName]);
  expect(list.map((x) => (x.kind === 'repo' ? x.status.root : x.view.status.root))).toEqual(['/p/api', '/p/web', '/p/web/.claude/worktrees/alpha', '/p/web/.claude/worktrees/zeta']);
  expect(list.map((x) => x.kind)).toEqual(['repo', 'repo', 'wt', 'wt']);
});

test('"To sync": a main repo whose changes are all hidden (This workspace) is not shown, so neither are its arrows', () => {
  const hidden = repo('api', { ahead: 2, changes: [ch('/p/api', 'a.ts')] });
  expect(toSyncOf([hidden], [], [])).toEqual([]);
  expect(toSyncOf([hidden], [{ repo: '/p/api' }], [])).toEqual([{ kind: 'repo', status: hidden }]);
});

// Source Control's dot: the working trees with a ↓, clean or not, worktrees included, by name; pushing alone is not
// pulling, and the arrows' own rule decides (own upstream, readable).
test('to pull: every working tree with a ↓ of its own upstream and how many, by name', () => {
  const repos = [
    repo('web', { behind: 2, changes: [ch('/p/web', 'a.ts')] }),
    repo('api', { behind: 1, ahead: 3 }),
    repo('docs', { ahead: 4 }),
    repo('infra'),
    repo('odd', { behind: 5, error: 'safe.directory' }),
    repo('lib', { behind: 2, branch: 'feat/x', upstream: 'origin/main' }),
    repo('cli', { behind: 2, upstream: null }),
    wtv('alpha', { upstream: 'origin/worktree-alpha', branch: 'worktree-alpha', behind: 7 }).status
  ];
  expect(toPull(repos, ['/p'])).toEqual([{ name: 'api', behind: 1 }, { name: 'web', behind: 2 }, { name: 'web › alpha', behind: 7 }]);
  expect(toPull([repo('docs', { ahead: 1 }), repo('infra')], ['/p'])).toEqual([]);
  expect(toPull([], ['/p'])).toEqual([]);
});

// Named as Source Control names them: a worktree after its repository, and two repositories of one name (one in sync
// is enough) by their path in the project — under the root the window opened or its real path.
test('to pull: two repositories of one name by their path in the project, the others by name', () => {
  const repos = [
    repo('api', { root: '/p/services/api', behind: 2 }),
    repo('api', { root: '/p/legacy/api' }),
    repo('web', { root: '/p/web', behind: 1 })
  ];
  expect(toPull(repos, ['/p'])).toEqual([{ name: 'services/api', behind: 2 }, { name: 'web', behind: 1 }]);
  expect(toPull(repos, ['/link/p', '/p'])).toEqual([{ name: 'services/api', behind: 2 }, { name: 'web', behind: 1 }]);
  // Outside every root, its name is all there is.
  expect(toPull(repos, ['/elsewhere'])).toEqual([{ name: 'api', behind: 2 }, { name: 'web', behind: 1 }]);
});

test('the label and the tooltip lines: five names whole; past five, four and how many more', () => {
  const items = (n: number) => ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, n).map((name, i) => ({ name, behind: i + 1 }));
  expect(pullLabel(items(5))).toBe('To pull: a, b, c, d, e');
  expect(pullTipLines(items(5))).toEqual(['a · 1 to pull', 'b · 2 to pull', 'c · 3 to pull', 'd · 4 to pull', 'e · 5 to pull']);
  expect(pullLabel(items(6))).toBe('To pull: a, b, c, d and 2 more');
  expect(pullTipLines(items(6))).toEqual(['a · 1 to pull', 'b · 2 to pull', 'c · 3 to pull', 'd · 4 to pull', 'and 2 more']);
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { GitOpEvent } from '@shared/git-write';
import type { ScmRef, ScmRefs, ScmRepoEntry } from '@shared/scm';
import { useApp } from '../store';

// The store's git slice: the drawer, its target, drafts, running ops, last results, sheets.

const saved = new Map<string, string>();
const g = globalThis as { localStorage?: unknown };
const ch = (rel: string, stage: FileChange['stage']): FileChange => ({ path: `/x/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0 });
const repo = (root: string, ...stages: FileChange['stage'][]): RepoStatus => ({
  root, name: root.split('/').pop()!, branch: 'main', detached: false, ahead: 0, behind: 0, changes: stages.map((s, i) => ch(`f${i}`, s)), oid: 'a'.repeat(40), checkedAt: 0, truncated: 0
});
const ev = (o: Partial<GitOpEvent>): GitOpEvent => ({ id: 'op1', root: '/p/a', op: 'commit', phase: 'running', startedAt: 1, ...o });
const closed = { open: false, height: null, unfolded: [], openedFor: null };

beforeEach(() => {
  saved.clear();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, repos: [repo('/p/a', 'none'), repo('/p/b', 'all', 'all'), repo('/p/c', 'all')],
    gitDrawer: closed, gitTarget: null, gitLastStaged: null, gitDrafts: {}, gitOps: {}, gitResult: {}, gitSheet: null, commitAll: null, gitFacts: {},
    activeTab: 'term', menu: null, paletteOpen: false, toast: null
  });
});
afterEach(() => { delete g.localStorage; });

describe('drawer and target', () => {
  test('opening picks the default target and never moves it on its own; closing forgets unfolds and what it was opened for', () => {
    useApp.getState().openGitDrawer();
    expect(useApp.getState().gitDrawer).toMatchObject({ open: true, openedFor: null });
    expect(useApp.getState().gitTarget).toBe('/p/b');
    useApp.getState().toggleGitUnfold('/p/c');
    expect(useApp.getState().gitDrawer.unfolded).toEqual(['/p/c']);
    useApp.getState().closeGitDrawer();
    expect(useApp.getState().gitDrawer).toEqual(closed);
    useApp.getState().openGitDrawer({ root: '/p/a' });
    expect(useApp.getState().gitTarget).toBe('/p/a');
    expect(useApp.getState().gitDrawer.openedFor).toEqual({ root: '/p/a' });
    useApp.getState().openGitDrawer({ session: 't1' });
    expect(useApp.getState().gitDrawer.openedFor).toEqual({ session: 't1' });
  });

  test('the active tab and the last staged file count when nothing else decides', () => {
    useApp.setState({ repos: [repo('/p/a', 'none'), repo('/p/b', 'none')], activeTab: '/p/b/src/x.ts' });
    useApp.getState().openGitDrawer();
    expect(useApp.getState().gitTarget).toBe('/p/b');
    useApp.getState().closeGitDrawer();
    useApp.getState().noteStaged('/p/a', '/p/a/f0');
    useApp.getState().openGitDrawer();
    expect(useApp.getState().gitTarget).toBe('/p/a');
  });

  test('staging in another repository moves the target there while the drawer is open, never opens it', () => {
    useApp.getState().noteStaged('/p/a', '/p/a/f0');
    expect(useApp.getState().gitDrawer.open).toBe(false);
    expect(useApp.getState().gitTarget).toBeNull();
    expect(useApp.getState().gitLastStaged).toBe('/p/a/f0');
    useApp.getState().openGitDrawer({ root: '/p/b' });
    useApp.getState().noteStaged('/p/c', '/p/c/f0');
    expect(useApp.getState().gitTarget).toBe('/p/c');
  });

  test("the drawer's height and the drafts are kept per project and come back with it", () => {
    useApp.getState().setGitDrawerHeight(280);
    useApp.getState().setGitDraft('/p/b', 'feat: totals');
    useApp.getState().setGitDraft('/p/c', 'fix: x');
    useApp.getState().setGitDraft('/p/c', '');
    expect(useApp.getState().gitDrafts).toEqual({ '/p/b': 'feat: totals' });
    useApp.setState({ gitDrafts: {}, gitDrawer: closed, project: null });
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    expect(useApp.getState().gitDrafts).toEqual({ '/p/b': 'feat: totals' });
    expect(useApp.getState().gitDrawer.height).toBe(280);
  });
});

describe('ops and results', () => {
  test('running ops by id with their output so far; done removes them and records the result', () => {
    const s = () => useApp.getState();
    s().applyGitOp(ev({ phase: 'queued' }));
    s().applyGitOp(ev({ phase: 'hook', hook: 'pre-commit' }));
    s().applyGitOp(ev({ phase: 'hook', chunk: 'lint… ' }));
    s().applyGitOp(ev({ phase: 'hook', chunk: 'ok\n' }));
    expect(s().gitOps.op1).toMatchObject({ phase: 'hook', hook: 'pre-commit', output: 'lint… ok\n' });
    s().applyGitOp(ev({ id: 'op2', root: '/p/c', op: 'push', phase: 'running' }));
    s().applyGitOp(ev({ phase: 'done', result: { outcome: 'hook', hook: 'pre-commit' } }));
    expect(Object.keys(s().gitOps)).toEqual(['op2']);
    expect(s().gitResult['/p/a']).toMatchObject({ op: 'commit', failed: { outcome: 'hook' }, seen: false });
  });

  test('a pull or sync refused as diverged is a question (the rebase sheet), never a kept failure on the bar', () => {
    const s = () => useApp.getState();
    s().applyGitOp(ev({ id: 'p1', op: 'pull', phase: 'done', result: { outcome: 'error', message: 'Not possible to fast-forward, aborting.' } }));
    s().applyGitOp(ev({ id: 's1', root: '/p/b', op: 'sync', phase: 'done', result: { outcome: 'state', message: 'Your branch and its upstream have diverged: rebase your 2 commits first' } }));
    expect(s().gitResult['/p/a']).toBeUndefined();
    expect(s().gitResult['/p/b']).toBeUndefined();
    // Any other failure stays.
    s().applyGitOp(ev({ id: 'p2', op: 'pull', phase: 'done', result: { outcome: 'network', message: 'Could not resolve host' } }));
    expect(s().gitResult['/p/a']).toMatchObject({ op: 'pull', failed: { outcome: 'network' } });
  });

  test("a commit is \"just now\" only in the window that made it: another window's commit (its event) records no sha", () => {
    const s = () => useApp.getState();
    s().recordGitResult('/p/a', 'commit', { outcome: 'hook', hook: 'pre-commit' });
    // Another window committed in /p/a: the failure here is over, but nothing was committed from this window.
    s().applyGitOp(ev({ id: 'x1', phase: 'done', result: { outcome: 'ok', sha: 'f0d6c52aa', undo: { oid: 'f0d6c52aa' } } }));
    expect(s().gitResult['/p/a']).toBeUndefined();
    s().applyGitOp(ev({ id: 'x2', root: '/p/b', phase: 'done', result: { outcome: 'ok', sha: 'b0d6c52aa' } }));
    expect(s().gitResult['/p/b']).toBeUndefined();
    // This window's own commit (the action's answer) is.
    s().recordGitResult('/p/b', 'commit', { outcome: 'ok', sha: 'b0d6c52aa', undo: { oid: 'b0d6c52aa' } });
    expect(s().gitResult['/p/b']).toMatchObject({ sha: 'b0d6c52aa' });
    // Its event arriving after the answer changes nothing.
    s().applyGitOp(ev({ id: 'x3', root: '/p/b', phase: 'done', result: { outcome: 'ok', sha: 'b0d6c52aa' } }));
    expect(s().gitResult['/p/b']).toMatchObject({ sha: 'b0d6c52aa' });
  });

  test('when the latest op started (the result notice lasts until the next op): new ops only, never backwards', () => {
    const s = () => useApp.getState();
    useApp.setState({ gitActedAt: 0 });
    s().applyGitOp(ev({ id: 'a', phase: 'queued', startedAt: 50 }));
    expect(s().gitActedAt).toBe(50);
    s().applyGitOp(ev({ id: 'b', phase: 'queued', startedAt: 40 }));
    expect(s().gitActedAt).toBe(50);
    s().applyGitOp(ev({ id: 'c', phase: 'running', startedAt: 70 }));
    expect(s().gitActedAt).toBe(70);
    // A later event of a known op, or the end of one never seen running, is not a new op.
    useApp.setState({ gitActedAt: 0 });
    s().applyGitOp(ev({ id: 'c', phase: 'hook', startedAt: 70 }));
    s().applyGitOp(ev({ id: 'z', phase: 'done', startedAt: 90, result: { outcome: 'ok' } }));
    expect(s().gitActedAt).toBe(0);
  });

  test('a failed commit, push, pull or sync stays until seen; a later success of that root clears it', () => {
    const s = () => useApp.getState();
    s().recordGitResult('/p/a', 'commit', { outcome: 'hook', hook: 'pre-commit', message: 'eslint found 2 problems' });
    expect(s().gitResult['/p/a']).toMatchObject({ op: 'commit', seen: false, failed: { outcome: 'hook', hook: 'pre-commit' } });
    s().seeGitResult('/p/a');
    expect(s().gitResult['/p/a']).toMatchObject({ seen: true });
    s().recordGitResult('/p/a', 'push', { outcome: 'ok' });
    expect(s().gitResult['/p/a']).toBeUndefined();
    s().recordGitResult('/p/a', 'push', { outcome: 'rejected' });
    s().recordGitResult('/p/a', 'commit', { outcome: 'ok', sha: 'abc1234' });
    expect(s().gitResult['/p/a']).toMatchObject({ sha: 'abc1234', undo: null });
  });

  test('a push after a commit keeps the commit (its Undo goes by main\'s facts); an undone commit leaves nothing', () => {
    const s = () => useApp.getState();
    s().recordGitResult('/p/a', 'commit', { outcome: 'ok', sha: 'abc1234', undo: { oid: 'abc1234' } });
    s().recordGitResult('/p/a', 'push', { outcome: 'ok' });
    expect(s().gitResult['/p/a']).toMatchObject({ sha: 'abc1234' });
    s().recordGitResult('/p/a', 'undoCommit', { outcome: 'ok', message: 'feat: x' });
    expect(s().gitResult['/p/a']).toBeUndefined();
  });

  test('cancelled, nothing to commit, and the other ops leave the results alone', () => {
    const s = () => useApp.getState();
    s().recordGitResult('/p/a', 'commit', { outcome: 'cancelled' });
    s().recordGitResult('/p/a', 'commit', { outcome: 'nothing' });
    s().recordGitResult('/p/a', 'stage', { outcome: 'busy' });
    s().recordGitResult('/p/a', 'stashDrop', { outcome: 'stale' });
    expect(s().gitResult).toEqual({});
  });

  test('the same commit reported twice (its answer and its event) keeps its first time', () => {
    const s = () => useApp.getState();
    s().recordGitResult('/p/a', 'commit', { outcome: 'ok', sha: 'abc1234' });
    const at = (s().gitResult['/p/a'] as { at: number }).at;
    s().recordGitResult('/p/a', 'commit', { outcome: 'ok', sha: 'abc1234' });
    expect((s().gitResult['/p/a'] as { at: number }).at).toBe(at);
  });

  test('facts per root; null forgets them', () => {
    const facts = { root: '/p/a', branch: 'main' } as never;
    useApp.getState().setGitFacts('/p/a', facts);
    expect(useApp.getState().gitFacts['/p/a']).toBe(facts);
    useApp.getState().setGitFacts('/p/a', null);
    expect(useApp.getState().gitFacts).toEqual({});
  });
});

test('a git sheet closes the menu and the palette; Commit all is its own state', () => {
  useApp.setState({ menu: { x: 0, y: 0, items: [] }, paletteOpen: true });
  useApp.getState().setGitSheet({ kind: 'rejected', root: '/p/a' });
  expect(useApp.getState()).toMatchObject({ gitSheet: { kind: 'rejected', root: '/p/a' }, menu: null, paletteOpen: false });
  useApp.getState().setGitSheet(null);
  expect(useApp.getState().gitSheet).toBeNull();
  const all = { open: true, mode: 'per-repo' as const, message: '', cards: [{ root: '/p/b', include: true, message: '' }], session: null, pushAfter: false, coAuthor: true, phase: 'edit' as const, stopAfter: false, files: 0 };
  useApp.getState().setCommitAll(all);
  expect(useApp.getState().commitAll?.cards).toHaveLength(1);
  // Its run and ✦'s streams update it in place: a menu opened meanwhile stays.
  useApp.setState({ menu: { x: 0, y: 0, items: [] } });
  useApp.getState().updateCommitAll((s) => ({ ...s, message: 'feat: b' }));
  expect(useApp.getState()).toMatchObject({ commitAll: { message: 'feat: b' }, menu: { x: 0 } });
  useApp.getState().setCommitAll(null);
  useApp.getState().updateCommitAll((s) => ({ ...s, message: 'gone' }));
  expect(useApp.getState().commitAll).toBeNull();
});

describe('the Sync button after a pull, push or sync', () => {
  const behind = (root: string, n: number, checkedAt: number): RepoStatus => ({ ...repo(root), behind: n, upstream: 'origin/main', checkedAt });
  const entry = (s: RepoStatus): ScmRepoEntry => ({ root: s.root, rel: s.root.split('/').pop()!, name: s.name, worktreeOf: null, nestedIn: null, common: `${s.root}/.git`, status: { branch: s.branch, detached: false, oid: s.oid, ahead: s.ahead, behind: s.behind, upstream: s.upstream ?? null, upstreamGone: false, changes: s.changes.length, checkedAt: s.checkedAt } });
  const shown = () => ({ changes: useApp.getState().repos.find((r) => r.root === '/p/a')?.behind, scm: useApp.getState().scmRepos?.find((e) => e.root === '/p/a')?.status?.behind });
  beforeEach(() => {
    useApp.setState({ gitStageIntents: [], gitReposSeen: [], gitSyncIntents: [] });
    useApp.getState().seeRepos([behind('/p/a', 2, 5)]);
    useApp.getState().setScmRepos([entry(behind('/p/a', 2, 5))]);
  });

  const pulled = ev({ op: 'pull', phase: 'done', result: { outcome: 'ok', at: 10, left: { behind: 0 } } });

  test('a pull done shows nothing to pull at once, and statuses read before it never bring ↓2 back', () => {
    useApp.getState().applyGitOp(pulled);
    expect(shown()).toEqual({ changes: 0, scm: 0 });
    // A read that started during the pull, then the switcher's list answered from it.
    useApp.getState().seeRepos([behind('/p/a', 2, 8)]);
    useApp.getState().setScmRepos([entry(behind('/p/a', 2, 8))]);
    expect(shown()).toEqual({ changes: 0, scm: 0 });
    // What main sent stays as it sent it: the override is only laid over it.
    expect(useApp.getState().gitReposSeen[0]?.behind).toBe(2);
    // The read from after the pull settles it; later reads show git as it is.
    useApp.getState().seeRepos([behind('/p/a', 0, 12)]);
    expect(useApp.getState().gitSyncIntents).toEqual([]);
    useApp.getState().seeRepos([behind('/p/a', 1, 20)]);
    expect(shown()).toEqual({ changes: 1, scm: 1 });
  });

  test("the read from after the op shows git as it is, even when the op's answer said otherwise", () => {
    useApp.getState().applyGitOp(pulled);
    // A session's fetch landed meanwhile: one more commit to pull.
    useApp.getState().seeRepos([behind('/p/a', 1, 12)]);
    expect(shown()).toEqual({ changes: 1, scm: 1 });
  });

  test('a failed pull changes nothing', () => {
    useApp.getState().applyGitOp(ev({ op: 'pull', phase: 'done', result: { outcome: 'network', at: 10 } }));
    expect(shown()).toEqual({ changes: 2, scm: 2 });
  });

  test('a branch published from any window tracks its remote branch at once, in Changes and Source Control', () => {
    const local = { ...behind('/p/a', 0, 5), branch: 'feat/x', upstream: null };
    useApp.getState().seeRepos([local]);
    useApp.getState().setScmRepos([entry(local)]);
    useApp.getState().applyGitOp(ev({ op: 'push', phase: 'done', result: { outcome: 'ok', at: 10, left: { ahead: 0, behind: 0, published: 'origin' } } }));
    expect(useApp.getState().repos[0]?.upstream).toBe('origin/feat/x');
    expect(useApp.getState().scmRepos?.[0]?.status?.upstream).toBe('origin/feat/x');
  });

  test("the current branch's row in Source Control shows what the op left at once (its refs are read again next)", () => {
    const ref = (o: Partial<ScmRef>): ScmRef => ({ name: 'refs/heads/main', short: 'main', kind: 'head', oid: 'a'.repeat(40), upstream: 'refs/remotes/origin/main', ahead: 1, behind: 2, gone: false, current: true, date: 0, ...o });
    const refs = (list: ScmRef[]): ScmRefs => ({ root: '/p/a', head: { branch: 'main', oid: 'a'.repeat(40), detached: false }, refs: list, defaultBranch: null, shallow: false, fetchedAt: null, remotes: ['origin'], hasRemote: true, emptyTree: '' });
    useApp.setState({ scmRefs: { '/p/a': refs([ref({}), ref({ name: 'refs/heads/dev', short: 'dev', current: false, behind: 3 })]) } });
    useApp.getState().applyGitOp(pulled);
    expect(useApp.getState().scmRefs['/p/a']?.refs.map((r) => [r.short, r.ahead, r.behind])).toEqual([['main', 1, 0], ['dev', 1, 3]]);
    // Published: the branch row tracks its new remote branch.
    useApp.setState({ scmRefs: { '/p/a': refs([ref({ short: 'feat/x', name: 'refs/heads/feat/x', upstream: null, ahead: 0, behind: 0 })]) } });
    useApp.getState().applyGitOp(ev({ id: 'op9', op: 'push', phase: 'done', result: { outcome: 'ok', at: 11, left: { ahead: 0, behind: 0, published: 'origin' } } }));
    expect(useApp.getState().scmRefs['/p/a']?.refs[0]).toMatchObject({ upstream: 'refs/remotes/origin/feat/x', gone: false });
  });

  test('a working tree gone takes its override with it; the next one there starts clean', () => {
    useApp.getState().applyGitOp(pulled);
    useApp.getState().seeRepos([]);
    expect(useApp.getState().gitSyncIntents).toEqual([]);
  });

  test("Changes' statuses reach Source Control's entries at once, without waiting for its list", () => {
    useApp.getState().seeRepos([behind('/p/a', 0, 12)]);
    expect(shown()).toEqual({ changes: 0, scm: 0 });
  });
});

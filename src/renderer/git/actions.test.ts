import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { GitFacts, GitOpEvent, GitOpResult } from '@shared/git-write';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp, type AppState, type ToastAction } from '../store';
import * as git from './actions';

// The renderer's git actions: thin wrappers over window.atelier.git that update the store,
// toast and open sheets from the outcome; nothing runs in Read-only.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: [string, ...unknown[]][];
let answers: Record<string, unknown>;
let gitOp: ((e: GitOpEvent) => void) | null;
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeGit() {
  const method = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    const a = answers[name];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? (a as (...x: unknown[]) => unknown)(...args) : a ?? { outcome: 'ok' };
  };
  const names = ['stage', 'unstage', 'commit', 'undoCommit', 'push', 'pull', 'sync', 'syncAll', 'switchTo', 'checkBranchName', 'branchCreate', 'branchRename',
    'branchDelete', 'branchRestore', 'worktreeCheck', 'worktreeAdd', 'stashPush', 'stashApply', 'stashDrop', 'stashRestore', 'discard', 'cancel', 'facts', 'running',
    'incoming', 'message', 'messageCancel'];
  return Object.fromEntries(names.map((n) => [n, method(n)]));
}

const ch = (rel: string, stage: FileChange['stage']): FileChange => ({ path: `/x/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0 });
const repo = (root: string, name: string, ...stages: FileChange['stage'][]): RepoStatus => ({
  root, name, branch: 'main', detached: false, ahead: 0, behind: 0, changes: stages.map((s, i) => ch(`f${i}`, s)), oid: 'a'.repeat(40), checkedAt: 0, truncated: 0
});
const facts = (o: Partial<GitFacts> = {}): GitFacts => ({
  root: '/p/a', identity: true, state: null, detached: false, branch: 'main', head: 'h', upstream: 'origin/main', headPushed: false, headIsMerge: false,
  headHasParent: true, headMessage: 'x', hooks: { preCommit: false, commitMsg: false, prePush: false }, gpgProgram: null, signs: false, gitVersion: [2, 50, 1],
  undo: null, remotes: ['origin'], ...o
});
const toast = () => useApp.getState().toast;
const actionsOf = (): ToastAction[] => { const tt = toast(); return tt ? [tt.action, tt.second].filter((a): a is ToastAction => !!a) : []; };
/** A click on a toast's button: the toast closes, then the action runs (Toast.tsx). */
const click = (i: number) => { const a = actionsOf()[i]!; useApp.getState().showToast(null); a.run(); };

beforeEach(() => {
  calls = []; answers = {}; gitOp = null;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = { atelier: { git: fakeGit(), on: { gitOp: (cb: (e: GitOpEvent) => void) => { gitOp = cb; return () => { gitOp = null; }; } } } };
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' },
    repos: [repo('/p/a', 'acme-store', 'all'), repo('/p/b', 'billing', 'none'), repo('/p/c', 'checkout', 'all')],
    gitDrawer: { open: false, height: null, unfolded: [], openedFor: null }, gitTarget: null, gitLastStaged: null, gitDrafts: {}, gitOps: {}, gitResult: {},
    gitSheet: null, commitAll: null, gitFacts: { '/p/a': facts() }, toast: null, activeTab: 'term', gitStageIntents: [], gitReposSeen: [],
    gitSyncIntents: [], scmRepos: null, scmRefs: {}
  });
});
afterEach(() => { delete g.window; delete g.localStorage; });

test('Read-only: nothing exported runs, nothing is asked of main', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  const results = await Promise.all([
    git.stage('/p/a', ['f0']), git.unstage('/p/a', 'all'), git.toggleStage([{ repo: '/p/a', rel: 'f0', kind: 'M', stage: 'none' }]),
    git.commit({ root: '/p/a', message: 'm', amend: false, coAuthor: false, noVerify: false }), git.undoCommit('/p/a', 'abc'),
    git.push('/p/a'), git.pull('/p/a', { rebase: false }), git.sync('/p/a', { rebase: false }), git.syncAll(), git.switchTo('/p/a', 'refs/heads/x'),
    git.checkBranchName('/p/a', 'x'), git.branchCreate({ root: '/p/a', name: 'x', switch: true }), git.branchRename({ root: '/p/a', ref: 'refs/heads/x', name: 'y' }),
    git.branchDelete('/p/a', 'refs/heads/x'), git.branchRestore({ root: '/p/a', name: 'x', oid: 'abc' }), git.worktreeCheck('/p/a', '/p/a/w'),
    git.worktreeAdd({ root: '/p/a', path: '/p/a/w', newName: 'x' }), git.stashPush({ root: '/p/a', message: 'm', untracked: true, staged: false }),
    git.stashApply({ root: '/p/a', index: 0, oid: 'abc', pop: false }), git.stashDrop({ root: '/p/a', index: 0, oid: 'abc' }),
    git.stashRestore({ root: '/p/a', oid: 'abc', message: 'm' }), git.discard('/p/a', ['f0'])
  ]);
  expect(calls).toEqual([]);
  expect(results.filter((r) => r !== null && r !== false && r !== undefined)).toEqual([]);
  expect(useApp.getState().toast).toBeNull();
});

test('Cancel always works, Read-only or not (an op started before the switch)', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  await git.cancelOp('op1');
  expect(calls).toEqual([['cancel', 'op1']]);
});

describe('staging', () => {
  test('staging remembers the last file staged and moves an open drawer to its repository', async () => {
    useApp.getState().openGitDrawer({ root: '/p/c' });
    await git.stage('/p/a', ['src/x.ts', 'src/y.ts']);
    expect(calls).toEqual([['stage', '/p/a', ['src/x.ts', 'src/y.ts']]]);
    expect(useApp.getState()).toMatchObject({ gitLastStaged: '/p/a/src/y.ts', gitTarget: '/p/a' });
    await git.stage('/p/c', 'all');
    expect(useApp.getState()).toMatchObject({ gitLastStaged: '/p/c', gitTarget: '/p/c' });
  });

  test('a group toggle runs one stage or unstage per root', async () => {
    await git.toggleStage([
      { repo: '/p/a', rel: 'a', kind: 'M', stage: 'all' }, { repo: '/p/b', rel: 'n', origRel: 'o', kind: 'R', stage: 'none' }, { repo: '/p/c', rel: 'c', kind: 'M', stage: 'partial' }
    ]);
    expect(calls).toEqual([['stage', '/p/b', ['n', 'o']], ['stage', '/p/c', ['c']]]);
    calls = [];
    await git.toggleStage([{ repo: '/p/a', rel: 'a', kind: 'M', stage: 'all' }]);
    expect(calls).toEqual([['unstage', '/p/a', ['a']]]);
  });

  // git add and the status read after it took seconds on a Windows PC, the box unchanged meanwhile (stage-intents.ts).
  test('a checkbox shows its click at once, until a status read that started once git was done', async () => {
    let answer: (r: GitOpResult) => void = () => {};
    answers.stage = () => new Promise<GitOpResult>((resolve) => { answer = resolve; });
    const stageOf = () => useApp.getState().repos.find((r) => r.root === '/p/b')!.changes[0]!.stage;
    const running = git.toggleStage([{ repo: '/p/b', rel: 'f0', kind: 'M', stage: 'none' }]);
    expect(stageOf()).toBe('all');
    // A read that began before git was done (it may show the old index) changes nothing yet.
    useApp.getState().setRepos([repo('/p/a', 'acme-store', 'all'), { ...repo('/p/b', 'billing', 'none'), checkedAt: 50 }, repo('/p/c', 'checkout', 'all')]);
    expect(stageOf()).toBe('all');
    answer({ outcome: 'ok', at: 100 });
    await running;
    useApp.getState().setRepos([repo('/p/a', 'acme-store', 'all'), { ...repo('/p/b', 'billing', 'none'), checkedAt: 99 }, repo('/p/c', 'checkout', 'all')]);
    expect(stageOf()).toBe('all');
    // The read that shows it: git's own answer from then on (here a session unstaged it again meanwhile).
    useApp.getState().setRepos([repo('/p/a', 'acme-store', 'all'), { ...repo('/p/b', 'billing', 'none'), checkedAt: 100 }, repo('/p/c', 'checkout', 'all')]);
    expect(stageOf()).toBe('none');
    expect(useApp.getState().gitStageIntents).toEqual([]);
  });

  test('a stage or unstage that fails shows the box as git has it again, and says why', async () => {
    const stageOf = (root: string) => useApp.getState().repos.find((r) => r.root === root)!.changes[0]!.stage;
    answers.unstage = { outcome: 'busy' };
    await git.toggleStage([{ repo: '/p/a', rel: 'f0', kind: 'M', stage: 'all' }]);
    expect(stageOf('/p/a')).toBe('all');
    expect(toast()?.text).toBe(git.failText('unstage', '/p/a', { outcome: 'busy' }));
    answers.stage = new Error('window gone');
    await git.stage('/p/b', 'all');
    expect(stageOf('/p/b')).toBe('none');
    expect(useApp.getState().gitStageIntents).toEqual([]);
  });

  test('Read-only: a click shows nothing it would not do', async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
    await git.toggleStage([{ repo: '/p/b', rel: 'f0', kind: 'M', stage: 'none' }]);
    expect(useApp.getState().repos.find((r) => r.root === '/p/b')!.changes[0]!.stage).toBe('none');
    expect(useApp.getState().gitStageIntents).toEqual([]);
  });

  test("Commit <name>'s Work…, one repository: stages its files there, opens the drawer for that session on it, ✦ starts", async () => {
    const w = g.window as { atelier: { git: Record<string, unknown>; on: Record<string, unknown> } };
    w.atelier.git.message = async (o: unknown) => { calls.push(['message', o]); return { id: 'm1' }; };
    w.atelier.git.messageCancel = async () => {};
    w.atelier.on.scmMessage = () => () => {};
    await git.commitWork('t1', [{ repo: '/p/b', rel: 'x', kind: 'M', stage: 'none' }, { repo: '/p/b', rel: 'y', kind: 'M', stage: 'all' }]);
    expect(calls).toEqual([['stage', '/p/b', ['x', 'y']], ['message', { root: '/p/b' }]]);
    expect(useApp.getState().gitDrawer).toMatchObject({ open: true, openedFor: { session: 't1' } });
    expect(useApp.getState().gitTarget).toBe('/p/b');
    expect(useApp.getState().commitAll).toBeNull();
    // Closing drops the run (and its listeners).
    useApp.getState().closeGitDrawer();
  });

  test("Commit <name>'s Work…, one repository with files staged by others too: the commit takes them as well, so a notice says so", async () => {
    const w = g.window as { atelier: { git: Record<string, unknown>; on: Record<string, unknown> } };
    w.atelier.git.message = async (o: unknown) => { calls.push(['message', o]); return { id: 'm1' }; };
    w.atelier.git.messageCancel = async () => {};
    w.atelier.on.scmMessage = () => () => {};
    useApp.setState({ terminals: [{ id: 't1', title: 'auth-refactor' } as AppState['terminals'][number]] });
    // /p/c has f0 staged already, not one of the session's files.
    await git.commitWork('t1', [{ repo: '/p/c', rel: 'z', kind: 'M', stage: 'none' }]);
    expect(useApp.getState().gitDrawer).toMatchObject({ open: true, openedFor: { session: 't1' } });
    expect(useApp.getState().toast?.text).toBe('Also staged: 1 file not from auth-refactor');
    useApp.getState().closeGitDrawer();
  });

  test("Commit <name>'s Work…, several repositories: Commit all with those, ✦ Write All started on the empty ones, the drawer stays closed", async () => {
    useApp.setState({ gitDrafts: { '/p/c': 'wip: checkout' } });
    const w = g.window as { atelier: { git: Record<string, unknown>; on: Record<string, unknown> } };
    w.atelier.git.message = async (o: unknown) => { calls.push(['message', o]); return { id: 'm1' }; };
    w.atelier.on.scmMessage = () => () => {};
    await git.commitWork('t1', [{ repo: '/p/b', rel: 'x', kind: 'M', stage: 'none' }, { repo: '/p/c', rel: 'z', kind: 'M', stage: 'none' }]);
    expect(calls.slice(0, 2)).toEqual([['stage', '/p/b', ['x']], ['stage', '/p/c', ['z']]]);
    expect(useApp.getState().gitDrawer.open).toBe(false);
    expect(useApp.getState().commitAll).toMatchObject({
      open: true, session: 't1', mode: 'per-repo', pushAfter: false, coAuthor: true, phase: 'edit',
      cards: [{ root: '/p/b', include: true, message: '' }, { root: '/p/c', include: true, message: 'wip: checkout' }]
    });
    for (let i = 0; i < 5; i++) await tick();
    expect(calls.slice(2)).toEqual([['message', { root: '/p/b' }]]);
    expect(useApp.getState().commitAll?.cards.map((c) => c.write)).toEqual(['writing', undefined]);
  });

  test('Git › Commit… (⌥⌘K): shows the Changes panel when hidden and opens the drawer on its default target; open already, it stays; Read-only: nothing', () => {
    useApp.setState({ showChanges: false });
    git.openCommitDrawer();
    expect(useApp.getState().showChanges).toBe(true);
    expect(useApp.getState().gitDrawer.open).toBe(true);
    expect(useApp.getState().gitTarget).toBe('/p/a');
    useApp.getState().setGitTarget('/p/c');
    git.openCommitDrawer();
    expect(useApp.getState().gitTarget).toBe('/p/c');
    useApp.setState({ gitDrawer: { open: false, height: null, unfolded: [], openedFor: null }, showChanges: false, settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
    git.openCommitDrawer();
    expect(useApp.getState().gitDrawer.open).toBe(false);
    expect(useApp.getState().showChanges).toBe(false);
  });

  test('Commit all… from the drawer: every repository with staged files, their drafts as messages; Read-only opens nothing', () => {
    useApp.setState({ gitDrafts: { '/p/c': 'feat: checkout' } });
    git.openCommitAll();
    expect(useApp.getState().commitAll).toMatchObject({
      open: true, session: null, mode: 'per-repo', coAuthor: true,
      cards: [{ root: '/p/a', include: true, message: '' }, { root: '/p/c', include: true, message: 'feat: checkout' }]
    });
    useApp.setState({ commitAll: null, settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
    git.openCommitAll();
    expect(useApp.getState().commitAll).toBeNull();
  });

  test('Commit all… while a run goes on, or while its failures wait for a retry: that run comes back, never a new sheet', () => {
    git.openCommitAll();
    const sheet = useApp.getState().commitAll!;
    const running = { ...sheet, open: false, phase: 'running' as const, cards: sheet.cards.map((c) => ({ ...c, run: { kind: 'waiting' as const } })) };
    useApp.setState({ commitAll: running });
    git.openCommitAll(['/p/b']);
    expect(useApp.getState().commitAll).toEqual({ ...running, open: true });
    const failed = { ...running, open: false, phase: 'results' as const, cards: running.cards.map((c) => ({ ...c, run: { kind: 'failed' as const, result: { outcome: 'hook' as const } } })) };
    useApp.setState({ commitAll: failed });
    git.openCommitAll(['/p/b']);
    expect(useApp.getState().commitAll).toEqual({ ...failed, open: true });
    // All committed: the results go, a new sheet opens.
    useApp.setState({ commitAll: { ...failed, cards: failed.cards.map((c) => ({ ...c, run: { kind: 'committed' as const, sha: 'abc', undo: null } })) } });
    git.openCommitAll(['/p/b']);
    expect(useApp.getState().commitAll).toMatchObject({ phase: 'edit', cards: [{ root: '/p/b' }] });
  });

  test("Commit <name>'s Work…: a failed stage stops there (its toast says why), nothing opens", async () => {
    answers.stage = { outcome: 'busy' };
    await git.commitWork('t1', [{ repo: '/p/b', rel: 'x', kind: 'M', stage: 'none' }, { repo: '/p/c', rel: 'z', kind: 'M', stage: 'none' }]);
    expect(calls).toEqual([['stage', '/p/b', ['x']]]);
    expect(useApp.getState().gitDrawer.open).toBe(false);
    expect(useApp.getState().commitAll).toBeNull();
  });

  test('a failure says why (busy: the index is locked); a rejected IPC call is an error, never a throw', async () => {
    answers.stage = { outcome: 'busy', message: 'index.lock exists' };
    expect(await git.stage('/p/a', ['a'])).toMatchObject({ outcome: 'busy' });
    expect(toast()?.text).toBe('Git is busy in this repository. Try again in a moment.');
    expect(useApp.getState().gitLastStaged).toBeNull();
    answers.unstage = new Error("Error invoking remote method 'git:unstage': invalid input");
    expect(await git.unstage('/p/a', ['a'])).toMatchObject({ outcome: 'error' });
    expect(toast()?.text).toBe("Unstage failed: Error invoking remote method 'git:unstage': invalid input");
  });
});

describe('commit', () => {
  const o = { root: '/p/a', message: 'feat: totals', amend: false, coAuthor: true, noVerify: false };

  test('the last staged repository: its draft goes, the drawer closes, a toast offers Push and Undo', async () => {
    useApp.setState({ repos: [repo('/p/a', 'acme-store', 'all')] });
    useApp.getState().setGitDraft('/p/a', 'feat: totals');
    useApp.getState().openGitDrawer({ root: '/p/a' });
    answers.commit = { outcome: 'ok', sha: 'f0d6c52e1', undo: { oid: 'f0d6c52e1' } };
    answers.facts = facts({ undo: { oid: 'f0d6c52e1', files: ['f0'] } });
    await git.commit(o);
    expect(calls[0]).toEqual(['commit', o]);
    expect(useApp.getState().gitDrafts).toEqual({});
    expect(useApp.getState().gitDrawer.open).toBe(false);
    expect(useApp.getState().gitResult['/p/a']).toMatchObject({ sha: 'f0d6c52e1', undo: { oid: 'f0d6c52e1' } });
    expect(toast()).toMatchObject({ text: 'Committed f0d6c52 to acme-store', tone: 'info' });
    expect(actionsOf().map((a) => a.label)).toEqual(['Push', 'Undo']);
    answers.undoCommit = { outcome: 'ok', message: 'feat: totals' };
    click(1);
    await tick();
    expect(calls.at(-1)).toEqual(['undoCommit', '/p/a', 'f0d6c52e1']);
    expect(useApp.getState().gitDrafts).toEqual({ '/p/a': 'feat: totals' });
  });

  test('another repository with staged files: the drawer moves there, no toast', async () => {
    useApp.getState().openGitDrawer({ root: '/p/a' });
    answers.commit = { outcome: 'ok', sha: 'f0d6c52e1' };
    await git.commit(o);
    expect(useApp.getState().gitDrawer.open).toBe(true);
    expect(useApp.getState().gitTarget).toBe('/p/c');
    expect(toast()).toBeNull();
  });

  test('a repository committed since its status was read is not the next target: its staged files are gone already', async () => {
    useApp.getState().openGitDrawer({ root: '/p/c' });
    answers.commit = { outcome: 'ok', sha: 'c0ffee123' };
    await git.commit({ ...o, root: '/p/c' });
    expect(useApp.getState().gitTarget).toBe('/p/a');
    // Committing /p/a before /p/c's new status arrives: nothing left, the drawer closes.
    await git.commit(o);
    expect(useApp.getState().gitDrawer.open).toBe(false);
    expect(toast()?.text).toBe('Committed c0ffee1 to acme-store');
    // A status read after that commit counts again.
    useApp.setState({ repos: useApp.getState().repos.map((r) => (r.root === '/p/c' ? { ...r, checkedAt: Date.now() + 1 } : r)) });
    useApp.getState().openGitDrawer({ root: '/p/a' });
    await git.commit(o);
    expect(useApp.getState().gitTarget).toBe('/p/c');
  });

  test('without an Undo from main the toast only offers Push; amend keeps the draft', async () => {
    useApp.getState().setGitDraft('/p/a', 'feat: wip');
    answers.commit = { outcome: 'ok', sha: 'f0d6c52e1' };
    await git.commit({ ...o, amend: true });
    expect(useApp.getState().gitDrafts).toEqual({ '/p/a': 'feat: wip' });
    expect(actionsOf().map((a) => a.label)).toEqual(['Push']);
  });

  test('Commit and Push: the commit, then the push, with no commit toast in between', async () => {
    useApp.setState({ repos: [repo('/p/a', 'acme-store', 'all')] });
    answers.commit = { outcome: 'ok', sha: 'f0d6c52e1' };
    answers.facts = facts();
    await git.commit({ ...o, push: true });
    expect(calls.map((c) => c[0]).filter((n) => n !== 'facts')).toEqual(['commit', 'push']);
    expect(toast()?.text).toBe('Pushed to origin/main');
  });

  test('amend names the commit the drawer showed (expectHead); a plain commit never sends one; HEAD moved: stale, on the bar', async () => {
    answers.commit = { outcome: 'ok', sha: 'f0d6c52e1' };
    await git.commit({ ...o, amend: true, expectHead: 'h1' });
    await git.commit({ ...o, expectHead: 'h1' });
    expect(calls.filter((c) => c[0] === 'commit')).toEqual([['commit', { ...o, amend: true, expectHead: 'h1' }], ['commit', o]]);
    answers.commit = { outcome: 'stale', message: 'HEAD moved' };
    await git.commit({ ...o, amend: true, expectHead: 'h1' });
    expect(useApp.getState().gitResult['/p/a']).toMatchObject({ op: 'commit', seen: false, failed: { outcome: 'stale' } });
  });

  test('a message typed while the commit ran (a long hook) stays as the draft; only the committed one goes', async () => {
    useApp.getState().setGitDraft('/p/a', 'feat: totals');
    answers.commit = () => { useApp.getState().setGitDraft('/p/a', 'feat: next thing'); return { outcome: 'ok', sha: 'f0d6c52e1' }; };
    await git.commit({ ...o, message: 'feat: totals' });
    expect(useApp.getState().gitDrafts).toEqual({ '/p/a': 'feat: next thing' });
    answers.commit = { outcome: 'ok', sha: 'f0d6c52e2' };
    await git.commit({ ...o, message: 'feat: next thing' });
    expect(useApp.getState().gitDrafts).toEqual({});
  });

  test("the toast offers Undo only while main offers it for that commit; taken back meanwhile, Undo asks main nothing", async () => {
    useApp.setState({ repos: [repo('/p/a', 'acme-store', 'all')] });
    answers.commit = { outcome: 'ok', sha: 'f0d6c52e1', undo: { oid: 'f0d6c52e1' } };
    // Main no longer offers it (a hook pushed, HEAD moved): Push only.
    answers.facts = facts({ undo: null });
    await git.commit(o);
    expect(actionsOf().map((a) => a.label)).toEqual(['Push']);
    answers.facts = facts({ undo: { oid: 'f0d6c52e1', files: ['f0'] } });
    await git.commit(o);
    expect(actionsOf().map((a) => a.label)).toEqual(['Push', 'Undo']);
    // Pushed from a terminal before the click: nothing is undone, it says why.
    useApp.getState().setGitFacts('/p/a', facts({ undo: null }));
    click(1);
    await tick();
    expect(calls.some((c) => c[0] === 'undoCommit')).toBe(false);
    expect(toast()?.text).toMatch(/^No commit to undo/);
  });

  test('a failed hook stays on the bar (unseen), with no toast; nothing to commit says so', async () => {
    answers.commit = { outcome: 'hook', hook: 'pre-commit', message: 'eslint found 2 problems' };
    await git.commit(o);
    expect(useApp.getState().gitResult['/p/a']).toMatchObject({ op: 'commit', seen: false, failed: { hook: 'pre-commit' } });
    expect(toast()).toBeNull();
    answers.commit = { outcome: 'nothing' };
    await git.commit(o);
    expect(toast()).toMatchObject({ text: 'Nothing to commit', tone: 'info' });
  });

  test('Undo puts the message back as the draft and clears the result; a stale Undo says so', async () => {
    useApp.getState().recordGitResult('/p/a', 'commit', { outcome: 'ok', sha: 'abc1234', undo: { oid: 'abc1234' } });
    answers.undoCommit = { outcome: 'ok', message: 'feat: totals\n\nBody' };
    await git.undoCommit('/p/a', 'abc1234');
    expect(useApp.getState().gitDrafts['/p/a']).toBe('feat: totals\n\nBody');
    expect(useApp.getState().gitResult['/p/a']).toBeUndefined();
    expect(toast()).toMatchObject({ text: 'Commit undone in acme-store: its changes are staged again', tone: 'info' });
    answers.undoCommit = { outcome: 'stale', message: 'HEAD moved' };
    await git.undoCommit('/p/a', 'abc1234');
    expect(toast()?.text).toBe('acme-store changed meanwhile. Look again and retry.');
  });

  test('Undo with a new message being written: the draft stays; the toast offers the undone commit\'s message', async () => {
    useApp.getState().setGitDraft('/p/a', 'fix: the next one, half written');
    answers.undoCommit = { outcome: 'ok', message: 'feat: totals' };
    await git.undoCommit('/p/a', 'abc1234');
    expect(useApp.getState().gitDrafts['/p/a']).toBe('fix: the next one, half written');
    expect(toast()).toMatchObject({ text: 'Commit undone in acme-store: its changes are staged again. Your draft is kept', tone: 'info' });
    actionsOf().find((a) => a.label === 'Use Its Message')!.run();
    expect(useApp.getState().gitDrafts['/p/a']).toBe('feat: totals');
  });

  test('Git › Undo Last Commit: the commit main still offers an Undo for (the target first); none: it says so; Read-only: nothing', async () => {
    useApp.setState({ gitTarget: '/p/a', gitFacts: { '/p/a': facts(), '/p/c': facts({ root: '/p/c', undo: { oid: 'c0ffee1', files: ['f0'] } }) } });
    answers.undoCommit = { outcome: 'ok', message: 'feat: c' };
    await git.undoLastCommit();
    expect(calls).toEqual([['undoCommit', '/p/c', 'c0ffee1']]);
    expect(useApp.getState().gitDrafts['/p/c']).toBe('feat: c');
    calls = [];
    useApp.setState({ gitFacts: { '/p/a': facts() } });
    await git.undoLastCommit();
    expect(calls).toEqual([]);
    expect(toast()?.text).toMatch(/^No commit to undo/);
    useApp.setState({ gitFacts: { '/p/a': facts({ undo: { oid: 'a1', files: [] } }) }, settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
    await git.undoLastCommit();
    expect(calls).toEqual([]);
  });

  test("the drawer's log dismissed: a commit's failure goes, a commit's result stays", async () => {
    answers.commit = { outcome: 'hook', hook: 'pre-commit', output: 'lint' };
    await git.commit(o);
    useApp.getState().dismissGitResult('/p/a');
    expect(useApp.getState().gitResult['/p/a']).toBeUndefined();
    // A commit result stays: only a failure is dismissed.
    useApp.getState().recordGitResult('/p/a', 'commit', { outcome: 'ok', sha: 'abc1234' });
    useApp.getState().dismissGitResult('/p/a');
    expect(useApp.getState().gitResult['/p/a']).toMatchObject({ sha: 'abc1234' });
  });
});

describe('the Git menu state', () => {
  test('Undo Last Commit is enabled while main offers an Undo in this project: main hears each change once', async () => {
    const sent: unknown[] = [];
    (g.window as { atelier: Record<string, unknown> }).atelier.menuState = (s: unknown) => { sent.push(s); };
    const off = git.installGit();
    await tick();
    const base = { gitUndo: false, hasRepos: true, gitWrites: true, messages: true, project: true };
    expect(sent).toEqual([base]);
    useApp.getState().setGitFacts('/p/c', facts({ root: '/p/c', undo: { oid: 'c1', files: [] } }));
    useApp.getState().setGitTarget('/p/b');
    expect(sent).toEqual([base, { ...base, gitUndo: true }]);
    // A repository outside this project's list doesn't count.
    useApp.getState().setGitFacts('/p/c', null);
    useApp.getState().setGitFacts('/elsewhere', facts({ root: '/elsewhere', undo: { oid: 'e1', files: [] } }));
    expect(sent).toEqual([base, { ...base, gitUndo: true }, base]);
    off();
    useApp.getState().setGitFacts('/p/a', facts({ undo: { oid: 'a1', files: [] } }));
    expect(sent).toHaveLength(3);
  });

  test('the Git menu shows only with a repository; Read-only hides its writes (no Undo either); messages Off hides ✦', async () => {
    const sent: unknown[] = [];
    (g.window as { atelier: Record<string, unknown> }).atelier.menuState = (s: unknown) => { sent.push(s); };
    useApp.getState().setGitFacts('/p/a', facts({ undo: { oid: 'a1', files: [] } }));
    const off = git.installGit();
    const on = { gitUndo: true, hasRepos: true, gitWrites: true, messages: true, project: true };
    expect(sent.at(-1)).toEqual(on);
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
    expect(sent.at(-1)).toEqual({ ...on, gitUndo: false, gitWrites: false });
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, commitMessages: 'off' } });
    expect(sent.at(-1)).toEqual({ ...on, messages: false });
    useApp.setState({ settings: DEFAULT_SETTINGS, repos: [], scmRepos: [] });
    expect(sent.at(-1)).toEqual({ gitUndo: false, hasRepos: false, gitWrites: true, messages: true, project: true });
    // Source Control's list alone counts too (Changes may not have read a status yet).
    useApp.setState({ scmRepos: [{ root: '/p/a', rel: '', name: 'acme-store', common: '/p/a/.git', status: null }] as never });
    expect(sent.at(-1)).toMatchObject({ hasRepos: true });
    const n = sent.length;
    useApp.setState({ toast: null, activeTab: 'other' });
    expect(sent).toHaveLength(n);
    off();
  });
});

describe('push, pull, sync', () => {
  test('no upstream: the Publish sheet, nothing pushed; publishing sends the remote', async () => {
    answers.facts = facts({ upstream: null });
    expect(await git.push('/p/a')).toBeNull();
    expect(calls).toEqual([['facts', '/p/a']]);
    expect(useApp.getState().gitSheet).toEqual({ kind: 'publish', root: '/p/a' });
    calls = [];
    await git.push('/p/a', { publish: { remote: 'origin' } });
    expect(calls).toEqual([['push', { root: '/p/a', publish: { remote: 'origin' } }]]);
  });

  test("Publish clicked before the sheet's facts arrived: the toast names the upstream git set, never the repository", async () => {
    useApp.setState({ gitFacts: {} });
    answers.facts = facts({ branch: 'feat/x', upstream: 'origin/feat/x' });
    await git.push('/p/a', { publish: { remote: 'origin' } });
    expect(toast()?.text).toBe('Pushed to origin/feat/x');
  });

  test("no upstream with the facts not read yet (or read before the branch was made): main's facts decide, Publish opens", async () => {
    useApp.setState({ gitFacts: {} });
    answers.facts = facts({ upstream: null, branch: 'feat/x' });
    expect(await git.push('/p/a')).toBeNull();
    expect(calls.map((c) => c[0])).toEqual(['facts']);
    expect(useApp.getState().gitSheet).toEqual({ kind: 'publish', root: '/p/a' });
    // Stale facts that still name an upstream: main's answer now wins.
    useApp.setState({ gitSheet: null, gitFacts: { '/p/a': facts() } });
    expect(await git.push('/p/a')).toBeNull();
    expect(useApp.getState().gitSheet).toEqual({ kind: 'publish', root: '/p/a' });
    expect(calls.some((c) => c[0] === 'push')).toBe(false);
  });

  test('a push that failed for another reason: its toast offers Show Full Output, which opens its log in the drawer', async () => {
    answers.facts = facts();
    answers.push = { outcome: 'error', message: 'remote: protected branch hook declined', output: 'remote: error: GH006: Protected branch update failed\nremote: more' };
    useApp.setState({ showChanges: false });
    await git.push('/p/a');
    expect(toast()?.text).toBe('Push failed: remote: protected branch hook declined');
    expect(actionsOf().map((a) => a.label)).toEqual(['Show Full Output']);
    click(0);
    expect(useApp.getState().showChanges).toBe(true);
    expect(useApp.getState().gitDrawer.open).toBe(true);
    expect(useApp.getState().gitTarget).toBe('/p/a');
    expect(useApp.getState().gitResult['/p/a']).toMatchObject({ op: 'push', failed: { output: 'remote: error: GH006: Protected branch update failed\nremote: more' } });
    // Nothing printed: nothing more to show.
    answers.push = { outcome: 'error', message: 'nope' };
    await git.push('/p/a');
    expect(actionsOf()).toEqual([]);
  });

  test('rejected: the Rejected sheet; auth: the sign-in message', async () => {
    answers.push = { outcome: 'rejected' };
    await git.push('/p/a');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'rejected', root: '/p/a' });
    answers.push = { outcome: 'auth', message: 'Authentication failed' };
    await git.push('/p/a');
    expect(toast()?.text).toBe("Push needs sign-in: git asked for a password Atelier can't type");
  });

  test('pull over dirty files offers Stash and Pull, which pulls again with the stash', async () => {
    answers.pull = (o: { stash?: boolean }) => (o.stash ? { outcome: 'ok' } : { outcome: 'conflict', dirty: true, files: ['a.ts', 'b.ts'] });
    await git.pull('/p/a', { rebase: false });
    expect(toast()?.text).toBe('Your changes to 2 files would be overwritten: commit or stash them first');
    expect(actionsOf().map((a) => a.label)).toEqual(['Stash and Pull']);
    click(0);
    await tick();
    expect(calls.at(-1)).toEqual(['pull', { root: '/p/a', rebase: false, stash: true }]);
    expect(toast()).toMatchObject({ text: 'Pulled from origin/main', tone: 'info' });
  });

  test("dirty with no file list: main's words or a plain sentence, never \"0 files\"", async () => {
    answers.pull = { outcome: 'conflict', dirty: true, message: 'Your local changes would be overwritten: commit or stash them first' };
    await git.pull('/p/a', { rebase: false });
    expect(toast()?.text).toBe('Your local changes would be overwritten: commit or stash them first');
    answers.pull = { outcome: 'conflict', dirty: true };
    await git.pull('/p/a', { rebase: false });
    expect(toast()?.text).toBe('Your changes would be overwritten: commit or stash them first');
    useApp.setState({ toast: null });
    answers.stashApply = { outcome: 'conflict', dirty: true };
    await git.stashApply({ root: '/p/a', index: 0, oid: 's1', pop: true });
    expect(toast()?.text).toBe('Commit or stash your changes first');
    answers.stashApply = { outcome: 'conflict', dirty: true, files: ['a'] };
    await git.stashApply({ root: '/p/a', index: 0, oid: 's1', pop: true });
    expect(toast()?.text).toBe('Commit or stash that file first');
  });

  test('a sync over dirty files: Stash and Pull, then the push the sync was for', async () => {
    answers.facts = facts();
    answers.sync = { outcome: 'conflict', dirty: true, files: ['a.ts'] };
    await git.sync('/p/a', { rebase: false });
    expect(toast()?.text).toBe('Your changes to 1 file would be overwritten: commit or stash them first');
    click(0);
    for (let i = 0; i < 4; i++) await tick();
    expect(calls.filter((c) => c[0] !== 'facts').slice(-2)).toEqual([['pull', { root: '/p/a', rebase: false, stash: true }], ['push', { root: '/p/a' }]]);
    // A pull's Stash and Pull pulls only.
    calls = [];
    answers.pull = (x: { stash?: boolean }) => (x.stash ? { outcome: 'ok' } : { outcome: 'conflict', dirty: true, files: ['a.ts'] });
    await git.pull('/p/a', { rebase: false });
    click(0);
    for (let i = 0; i < 4; i++) await tick();
    expect(calls.map((c) => c[0])).toEqual(['pull', 'pull']);
  });

  test('a rebase that conflicted was aborted: it says so', async () => {
    answers.pull = { outcome: 'conflict' };
    await git.pull('/p/a', { rebase: true });
    expect(toast()?.text).toBe("Couldn't rebase cleanly: your commits and origin/main change the same lines. Finish it in the terminal.");
    expect(useApp.getState().gitResult['/p/a']).toMatchObject({ op: 'pull', seen: false });
  });

  test('Sync All: one toast, and the list when some need you', async () => {
    answers.syncAll = [{ root: '/p/a', result: { outcome: 'ok' } }, { root: '/p/c', result: null, needsYou: 'diverged' }];
    await git.syncAll();
    expect(toast()?.text).toBe('Synced 1 · 1 needs you');
    click(0);
    expect(useApp.getState().gitSheet).toMatchObject({ kind: 'syncAll', rows: [{ root: '/p/a' }, { root: '/p/c' }] });
    answers.syncAll = [];
    useApp.getState().showToast(null);
    await git.syncAll();
    expect(toast()?.text).toBe('Every repository is in sync');
    answers.syncAll = [{ root: '/p/a', result: { outcome: 'ok' } }, { root: '/p/b', result: { outcome: 'network' } }, { root: '/p/c', result: null, needsYou: 'diverged' }];
    await git.syncAll();
    expect(toast()?.text).toBe('Synced 1 · 2 need you');
  });
});

describe('branches and stashes', () => {
  test('a dirty switch opens the Switch sheet; carrying the changes goes straight to main', async () => {
    answers.switchTo = (o: { carry: string }) => (o.carry === 'none' ? { outcome: 'conflict', dirty: true, files: ['a'] } : { outcome: 'ok' });
    await git.switchTo('/p/a', 'refs/heads/feat/x');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'switch', root: '/p/a', ref: 'refs/heads/feat/x' });
    useApp.setState({ gitSheet: null });
    await git.switchTo('/p/a', 'refs/heads/feat/x', 'stash');
    expect(calls.at(-1)).toEqual(['switchTo', { root: '/p/a', ref: 'refs/heads/feat/x', carry: 'stash' }]);
    expect(useApp.getState().gitSheet).toBeNull();
  });

  test('done, but git also reported a failure (a post-checkout hook): the toast says both', async () => {
    const warning = 'The post-checkout hook failed: git-lfs was not found';
    answers.switchTo = () => ({ outcome: 'ok', warning });
    await git.switchTo('/p/a', 'refs/heads/feat/x');
    expect(toast()?.text).toBe(`Switched to feat/x. ${warning}`);
    answers.branchCreate = () => ({ outcome: 'ok', warning });
    await git.branchCreate({ root: '/p/a', name: 'feat/n', switch: true });
    expect(toast()?.text).toBe(`Switched to new branch feat/n. ${warning}`);
    answers.worktreeAdd = () => ({ outcome: 'ok', warning });
    await git.worktreeAdd({ root: '/p/a', path: '/elsewhere/w', newName: 'w' });
    expect(toast()?.text).toBe(`Worktree ready at /elsewhere/w. ${warning}`);
  });

  test('pulled or synced, but the hook after the pull failed (husky\'s npm install): the toast says both', async () => {
    const warning = 'The post-merge hook failed: npm ERR! code ERESOLVE';
    answers.pull = () => ({ outcome: 'ok', warning });
    await git.pull('/p/a', { rebase: false });
    expect(toast()?.text).toMatch(/^Pulled from .+\. The post-merge hook failed: npm ERR! code ERESOLVE$/);
    answers.sync = () => ({ outcome: 'ok', warning });
    await git.sync('/p/a', { rebase: false });
    expect(toast()?.text).toMatch(/ is in sync\. The post-merge hook failed: npm ERR! code ERESOLVE$/);
  });

  test('a pop whose stash stays in the list says so, from the row and from Undo of a stash alike', async () => {
    const warning = 'The stash stays in the list: The stash list moved: nothing was dropped. Look again';
    answers.stashApply = () => ({ outcome: 'ok', warning });
    useApp.getState().showToast(null);
    await git.stashApply({ root: '/p/a', index: 0, oid: 'a'.repeat(40), pop: true });
    expect(toast()?.text).toBe(warning);
    await git.stashApply({ root: '/p/a', index: 0, oid: 'a'.repeat(40), pop: true, message: 'On main: wip' });
    expect(toast()?.text).toContain(warning);
    answers.pull = () => ({ outcome: 'ok', warning });
    await git.pull('/p/a', { rebase: false, stash: true });
    expect(toast()?.text).toContain(warning);
  });

  test('delete: unmerged opens the sheet; deleted offers Undo for 30 s, which restores the branch', async () => {
    answers.branchDelete = (o: { force: boolean }) => (o.force ? { outcome: 'ok', branch: { name: 'feat/x', oid: 'abc' } } : { outcome: 'conflict', message: 'feat/x has 3 commits that aren\'t merged anywhere' });
    await git.branchDelete('/p/a', 'refs/heads/feat/x');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'deleteBranch', root: '/p/a', ref: 'refs/heads/feat/x', message: 'feat/x has 3 commits that aren\'t merged anywhere' });
    await git.branchDelete('/p/a', 'refs/heads/feat/x', true);
    expect(toast()).toMatchObject({ text: 'Deleted feat/x', ms: 30_000 });
    click(0);
    await tick();
    expect(calls.at(-1)).toEqual(['branchRestore', { root: '/p/a', name: 'feat/x', oid: 'abc' }]);
  });

  test('stash: Undo pops that exact stash; drop: Undo stores it back, for 30 s', async () => {
    answers.stashPush = { outcome: 'ok', stash: { oid: 's1', message: 'wip' } };
    await git.stashPush({ root: '/p/a', message: 'wip', untracked: true, staged: false });
    expect(toast()?.text).toBe('Stashed your changes in acme-store');
    click(0);
    await tick();
    expect(calls.at(-1)).toEqual(['stashApply', { root: '/p/a', index: 0, oid: 's1', pop: true }]);
    answers.stashDrop = { outcome: 'ok', stash: { oid: 's2', message: 'On main: wip' } };
    await git.stashDrop({ root: '/p/a', index: 1, oid: 's2' });
    expect(toast()).toMatchObject({ text: 'Dropped “On main: wip”', ms: 30_000 });
    click(0);
    await tick();
    expect(calls.at(-1)).toEqual(['stashRestore', { root: '/p/a', oid: 's2', message: 'On main: wip' }]);
  });

  test('apply over dirty files is refused upfront; a conflict keeps the stash and says so', async () => {
    answers.stashApply = { outcome: 'conflict', dirty: true, files: ['a', 'b'] };
    await git.stashApply({ root: '/p/a', index: 0, oid: 's1', pop: true });
    expect(toast()?.text).toBe('Commit or stash those 2 files first');
    answers.stashApply = { outcome: 'conflict', files: ['a'] };
    await git.stashApply({ root: '/p/a', index: 0, oid: 's1', pop: true });
    expect(toast()?.text).toBe('Applied with conflicts in 1 file: resolve them in the terminal or ask a session');
  });
});

describe('installGit: ev:gitOp once at boot', () => {
  test('ops already running come from main; events update the store; an op that ends asks for the facts again', async () => {
    const running: GitOpEvent = { id: 'op0', root: '/p/c', op: 'push', phase: 'running', startedAt: 1 };
    answers.running = [running];
    answers.facts = (root: string) => facts({ root, head: 'new' });
    const off = git.installGit();
    await tick();
    expect(Object.keys(useApp.getState().gitOps)).toEqual(['op0']);
    gitOp!({ id: 'op1', root: '/p/a', op: 'commit', phase: 'hook', hook: 'pre-commit', startedAt: 2 });
    expect(useApp.getState().gitOps.op1).toMatchObject({ hook: 'pre-commit' });
    const result: GitOpResult = { outcome: 'ok', sha: 'abc1234' };
    gitOp!({ id: 'op1', root: '/p/a', op: 'commit', phase: 'done', result, startedAt: 2 });
    await tick();
    expect(Object.keys(useApp.getState().gitOps)).toEqual(['op0']);
    expect(calls.filter((c) => c[0] === 'facts')).toEqual([['facts', '/p/a']]);
    expect(useApp.getState().gitFacts['/p/a']).toMatchObject({ head: 'new' });
    off();
    expect(gitOp).toBeNull();
  });

  test('Git actions leaving On closes the git sheet and a Commit all being edited (Read-only shows no write)', async () => {
    const off = git.installGit();
    useApp.getState().setGitSheet({ kind: 'stash', root: '/p/a' });
    git.openCommitAll();
    expect(useApp.getState().commitAll).not.toBeNull();
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
    for (let i = 0; i < 4; i++) await tick();
    expect(useApp.getState().gitSheet).toBeNull();
    expect(useApp.getState().commitAll).toBeNull();
    off();
  });

  // The branch rows' ↑↓ (Source Control's refs) waited for the watcher's event after a pull: seconds on Windows.
  test("an op that moves refs reads the store's loaded refs again at once; a stage reads none", async () => {
    const refsAsked: string[] = [];
    const w = g.window as { atelier: Record<string, unknown> };
    w.atelier.scm = { refs: async (root: string) => { refsAsked.push(root); return null; } };
    const entry = (root: string, common: string) => ({ root, rel: root.slice(3), name: root.slice(3), worktreeOf: null, nestedIn: null, common, status: null });
    const refs = (root: string) => ({ root, head: { branch: 'main', oid: null, detached: false }, refs: [], defaultBranch: null, shallow: false, fetchedAt: null, remotes: [], hasRemote: true, emptyTree: '' });
    useApp.setState({ scmRepos: [entry('/p/a', '/p/a/.git'), entry('/p/a-wt', '/p/a/.git'), entry('/p/b', '/p/b/.git')], scmRefs: { '/p/a': refs('/p/a'), '/p/a-wt': refs('/p/a-wt'), '/p/b': refs('/p/b') } });
    const off = git.installGit();
    gitOp!({ id: 'op2', root: '/p/a', op: 'stage', phase: 'done', result: { outcome: 'ok', at: 3 }, startedAt: 2 });
    await tick();
    expect(refsAsked).toEqual([]);
    gitOp!({ id: 'op3', root: '/p/a', op: 'pull', phase: 'done', result: { outcome: 'ok', at: 5, left: { behind: 0 } }, startedAt: 4 });
    await tick();
    expect(refsAsked.sort()).toEqual(['/p/a', '/p/a-wt']);
    off();
  });

  test('an op that ended before main listed the running ones does not come back', async () => {
    let answer!: (list: GitOpEvent[]) => void;
    answers.running = () => new Promise((r) => { answer = r; });
    git.installGit();
    gitOp!({ id: 'op1', root: '/p/a', op: 'push', phase: 'done', result: { outcome: 'ok' }, startedAt: 1 });
    answer([{ id: 'op1', root: '/p/a', op: 'push', phase: 'running', startedAt: 1 }]);
    await tick();
    expect(useApp.getState().gitOps).toEqual({});
  });
});

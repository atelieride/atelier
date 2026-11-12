import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Attribution } from '@shared/attribution';
import type { GitFacts, GitOpResult } from '@shared/git-write';
import type { TerminalInfo } from '@shared/protocol';
import type { ScmRepoEntry, ScmRepoStatus } from '@shared/scm';
import type { SessionInfo } from '@shared/session';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp, type ToastAction } from '../store';
import * as git from './actions';
import { loadGitPrefs } from './drafts';
import { commitsShown, githubCompareUrl, overlapFiles, publish, pullThenPush, sentence, startPull, startSync, syncAction, syncAllRow, syncView } from './sync';

// The Source Control sidebar's sync: what the split button says, the compare page, the
// files a pull would change under a live session, and the flows that ask before pulling.

const typed = vi.hoisted(() => [] as [string, string | null, boolean][]);
vi.mock('../send-selection', () => ({ textInNewTerminal: async (text: string, cwd: string | null, run: boolean) => { typed.push([text, cwd, run]); } }));

const status = (o: Partial<ScmRepoStatus> = {}): ScmRepoStatus => ({ branch: 'main', detached: false, oid: 'a'.repeat(40), ahead: 0, behind: 0, upstream: 'origin/main', changes: 0, ...o });

test("syncAction: Pull with only commits to pull, Push with only commits to push, Sync with both (and when in sync, where it asks the remote first)", () => {
  expect(syncAction({ ahead: 0, behind: 2 })).toBe('pull');
  expect(syncAction({ ahead: 3, behind: 0 })).toBe('push');
  expect(syncAction({ ahead: 1, behind: 1 })).toBe('sync');
  expect(syncAction({ ahead: 0, behind: 0 })).toBe('sync');
});

describe('syncView', () => {
  test('a branch with an upstream: Sync with its counts; in sync: 0 and 0', () => {
    expect(syncView(status({ ahead: 2, behind: 1 }), true)).toEqual({ kind: 'sync', ahead: 2, behind: 1, upstream: 'origin/main' });
    expect(syncView(status(), true)).toEqual({ kind: 'sync', ahead: 0, behind: 0, upstream: 'origin/main' });
  });
  test('no upstream: Publish Branch, only when there is a remote to publish to', () => {
    expect(syncView(status({ upstream: null, branch: 'feat/x' }), true)).toEqual({ kind: 'publish', branch: 'feat/x' });
    expect(syncView(status({ upstream: null }), false)).toEqual({ kind: 'none' });
  });
  test('an upstream gone from the remote, or one of another name: Publish Branch, never a quiet Sync', () => {
    expect(syncView(status({ branch: 'feat/x', upstream: 'origin/feat/x', upstreamGone: true }), true)).toEqual({ kind: 'publish', branch: 'feat/x', reason: { kind: 'gone', upstream: 'origin/feat/x' } });
    expect(syncView(status({ branch: 'feat/x', upstream: 'origin/main', ahead: 3, behind: 1 }), true)).toEqual({ kind: 'publish', branch: 'feat/x', reason: { kind: 'other', upstream: 'origin/main' } });
    expect(syncView(status({ branch: 'feat/x', upstream: 'origin/main' }), false)).toEqual({ kind: 'none' });
  });
  test('detached, no branch, no status: nothing to sync', () => {
    expect(syncView(status({ detached: true, branch: null }), true)).toEqual({ kind: 'none' });
    expect(syncView(status({ branch: null }), true)).toEqual({ kind: 'none' });
    expect(syncView(null, true)).toEqual({ kind: 'none' });
  });
});

describe('githubCompareUrl', () => {
  test('from main\'s compare base (facts.githubRepos)', () => {
    expect(githubCompareUrl('https://github.com/acme/store', 'feat/x')).toBe('https://github.com/acme/store/compare/feat/x?expand=1');
    expect(githubCompareUrl('https://github.com/Acme-Co/my_repo.v2', 'main')).toBe('https://github.com/Acme-Co/my_repo.v2/compare/main?expand=1');
  });
  test('the branch is escaped segment by segment', () => {
    expect(githubCompareUrl('https://github.com/acme/store', 'feat/a b#1?')).toBe('https://github.com/acme/store/compare/feat/a%20b%231%3F?expand=1');
  });
  test('anything but a compare base: no URL (raw remote URLs, credentials, other hosts, look-alikes, plain http, odd names, missing)', () => {
    for (const url of ['https://github.com/acme/store.git/x', 'git@github.com:acme/store.git', 'https://ada:tok@github.com/acme/store', 'https://gitlab.com/acme/store',
      'https://github.com.evil.com/acme/store', 'http://github.com/acme/store', 'https://github.com/acme/store/', 'https://github.com/acme/store/extra',
      'https://github.com/ac me/store', 'https://github.com/../store', 'https://github.com/acme/..', '', undefined]) expect(githubCompareUrl(url, 'main'), String(url)).toBeNull();
  });
});

const session = (o: Partial<SessionInfo>): SessionInfo => ({ sessionId: 's1', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, lastMessageAt: 100, ...o });
const term = (id: string, title: string, s: Partial<SessionInfo> = {}): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title, name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: session(s) });
const attr = (path: string, terminalId: string, title: string): Attribution => ({ path, terminalId, sessionId: 's1', color: '#c0ffee', title, at: 150 });

test('overlapFiles: the incoming paths a live session is changing, and who', () => {
  const live = new Map([['/p/a/src/cart.ts', { terminalId: 't1', title: 'auth-refactor', color: '#f00' }], ['/p/a/src/pay.ts', { terminalId: 't1', title: 'auth-refactor', color: '#f00' }],
    ['/p/b/src/cart.ts', { terminalId: 't2', title: 'billing', color: '#0f0' }]]);
  expect(overlapFiles('/p/a', ['src/cart.ts', 'README.md', 'src/pay.ts'], live)).toEqual({ files: ['src/cart.ts', 'src/pay.ts'], who: [{ terminalId: 't1', title: 'auth-refactor', color: '#f00' }] });
  expect(overlapFiles('/p/a', ['README.md'], live)).toEqual({ files: [], who: [] });
});

// ── The flows, over a fake window.atelier ─────────────────────────────────────────────────────────────────────────────

const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: [string, ...unknown[]][];
let answers: Record<string, unknown>;
const tick = () => new Promise((r) => setTimeout(r, 0));

function fake(names: string[]) {
  return Object.fromEntries(names.map((name) => [name, async (...args: unknown[]) => {
    calls.push([name, ...args]);
    const a = answers[name];
    return typeof a === 'function' ? (a as (...x: unknown[]) => unknown)(...args) : a ?? { outcome: 'ok' };
  }]));
}
const facts = (o: Partial<GitFacts> = {}): GitFacts => ({
  root: '/p/a', identity: true, state: null, detached: false, branch: 'main', head: 'h', upstream: 'origin/main', headPushed: false, headIsMerge: false,
  headHasParent: true, headMessage: 'x', hooks: { preCommit: false, commitMsg: false, prePush: false }, gpgProgram: null, signs: false, gitVersion: [2, 50, 1],
  undo: null, remotes: ['origin'], ...o
});
const entry = (o: Partial<ScmRepoStatus> = {}): ScmRepoEntry => ({ root: '/p/a', rel: 'a', name: 'acme-store', worktreeOf: null, nestedIn: null, common: '/p/a/.git', status: status(o) });
const toast = () => useApp.getState().toast;
const actionsOf = (): ToastAction[] => { const tt = toast(); return tt ? [tt.action, tt.second].filter((a): a is ToastAction => !!a) : []; };
const names = () => calls.map((c) => c[0]);

beforeEach(() => {
  calls = []; answers = { incoming: [], fetchRepo: { outcome: 'ok' } }; typed.length = 0;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = { atelier: { git: fake(['push', 'pull', 'sync', 'syncAll', 'incoming', 'remoteCommits', 'facts']), scm: fake(['fetchRepo']), openUrl: async (url: string) => { calls.push(['openUrl', url]); } } };
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' }, repos: [], scmRepos: [entry()], terminals: [], attributions: [],
    gitSheet: null, gitResult: {}, gitFacts: { '/p/a': facts() }, toast: null
  });
});
afterEach(() => { delete g.window; delete g.localStorage; });

describe('Pull and Sync from the palette or a menu follow the split button', () => {
  test('an upstream of another name or gone: Sync opens Publish, Pull says why it is off; nothing runs', async () => {
    useApp.setState({ scmRepos: [entry({ branch: 'feat/x', upstream: 'origin/main', behind: 3 })] });
    await startSync('/p/a');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'publish', root: '/p/a' });
    useApp.setState({ gitSheet: null });
    await startPull('/p/a');
    expect(useApp.getState().gitSheet).toBeNull();
    expect(toast()?.text).toBe('feat/x tracks origin/main, a branch of another name: publish it as its own branch');
    useApp.setState({ scmRepos: [entry({ branch: 'feat/y', upstream: 'origin/feat/y', upstreamGone: true })] });
    await startPull('/p/a');
    expect(toast()?.text).toBe('origin/feat/y is gone from the remote: publish feat/y to push it again');
    expect(names()).toEqual([]);
  });

  test('no upstream at all, with a remote: Sync opens Publish, Pull says to publish first (as the split button); nothing runs', async () => {
    useApp.setState({ scmRepos: [entry({ branch: 'feat/new', upstream: null })], scmRefs: {} });
    await startSync('/p/a');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'publish', root: '/p/a' });
    useApp.setState({ gitSheet: null });
    await startPull('/p/a');
    expect(useApp.getState().gitSheet).toBeNull();
    expect(toast()?.text).toBe('This branch has no upstream yet: publish it first');
    expect(names()).toEqual([]);
  });
});

describe('Pull and Sync ask first', () => {
  test('diverged: the rebase sheet, nothing pulled yet', async () => {
    useApp.setState({ scmRepos: [entry({ ahead: 2, behind: 1 })] });
    await startPull('/p/a');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'pullRebase', root: '/p/a', sync: false });
    await startSync('/p/a');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'pullRebase', root: '/p/a', sync: true });
    expect(names()).toEqual([]);
  });

  test('behind: a live session on an incoming file opens the overlap sheet; without overlap the pull just runs', async () => {
    useApp.setState({ scmRepos: [entry({ behind: 1 })], terminals: [term('t1', 'auth-refactor')], attributions: [attr('/p/a/src/cart.ts', 't1', 'auth-refactor')] });
    answers.incoming = ['src/cart.ts', 'README.md'];
    await startPull('/p/a');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'pullOverlap', root: '/p/a', files: ['src/cart.ts'], rebase: false, sync: false });
    expect(names()).toEqual(['incoming']);

    useApp.setState({ gitSheet: null });
    answers.incoming = ['README.md'];
    await startPull('/p/a');
    expect(useApp.getState().gitSheet).toBeNull();
    expect(calls.at(-1)).toEqual(['pull', { root: '/p/a', rebase: false }]);
  });

  test('a session that is not in a turn is not live: no sheet', async () => {
    useApp.setState({ scmRepos: [entry({ behind: 1 })], terminals: [term('t1', 'auth-refactor', { state: 'idle' })], attributions: [attr('/p/a/src/cart.ts', 't1', 'auth-refactor')] });
    answers.incoming = ['src/cart.ts'];
    await startSync('/p/a');
    expect(useApp.getState().gitSheet).toBeNull();
    expect(calls.at(-1)).toEqual(['sync', { root: '/p/a', rebase: false }]);
  });

  test('a fast-forward git refused (the branch diverged since the last fetch): the rebase sheet instead of an error, opened by that answer', async () => {
    // byResult: not a click, so Cancel takes the focus (an Enter meant for something else never rebases).
    answers.pull = { outcome: 'error', message: 'fatal: Not possible to fast-forward, aborting.' };
    await git.pull('/p/a', { rebase: false });
    expect(useApp.getState().gitSheet).toEqual({ kind: 'pullRebase', root: '/p/a', sync: false, byResult: true });
    expect(toast()).toBeNull();
    expect(useApp.getState().gitResult['/p/a']).toBeUndefined();
    answers.sync = { outcome: 'state', message: 'Your branch and its upstream have diverged: rebase your 2 commits first' };
    await git.sync('/p/a', { rebase: false });
    expect(useApp.getState().gitSheet).toEqual({ kind: 'pullRebase', root: '/p/a', sync: true, byResult: true });
    // Once rebasing, a failure is a failure.
    answers.pull = { outcome: 'error', message: 'fatal: Not possible to fast-forward, aborting.' };
    useApp.setState({ gitSheet: null });
    await git.pull('/p/a', { rebase: true });
    expect(useApp.getState().gitSheet).toBeNull();
    expect(toast()?.text).toContain('Pull failed');
  });

  test('Sync in sync: fetches first, then syncs; a failed fetch stops there', async () => {
    await startSync('/p/a');
    // No live session: the incoming files have nothing to be compared with, and aren't read.
    expect(names()).toEqual(['fetchRepo', 'sync']);
    calls = [];
    answers.fetchRepo = { outcome: 'network' };
    await startSync('/p/a');
    expect(names()).toEqual(['fetchRepo']);
  });

  test('Pull Then Push (the rejected sheet): a sync that rebases', async () => {
    await pullThenPush('/p/a');
    expect(calls.at(-1)).toEqual(['sync', { root: '/p/a', rebase: true }]);
  });
});

describe('Push and Publish', () => {
  test('auth: the sign-in message with Open in Terminal, which types git push in the repo without running it', async () => {
    answers.push = { outcome: 'auth', message: "Push needs sign-in: git asked for a password Atelier can't type" } satisfies GitOpResult;
    await git.push('/p/a');
    expect(toast()?.text).toBe("Push needs sign-in: git asked for a password Atelier can't type");
    expect(actionsOf().map((a) => a.label)).toEqual(['Open in Terminal']);
    actionsOf()[0]!.run();
    await tick();
    expect(typed).toEqual([['git push', '/p/a', false]]);
  });

  test('a pull that needs sign-in types git pull', async () => {
    answers.pull = { outcome: 'auth', message: "Pull needs sign-in: git asked for a password Atelier can't type" };
    await git.pull('/p/a', { rebase: false });
    actionsOf()[0]!.run();
    await tick();
    expect(typed).toEqual([['git pull', '/p/a', false]]);
  });

  test('publish: pushes to the remote, then opens the compare page for a github.com remote when asked; the choice is remembered', async () => {
    useApp.setState({ gitFacts: { '/p/a': facts({ branch: 'feat/x', upstream: null, githubRepos: { origin: 'https://github.com/acme/store' } }) } });
    await publish('/p/a', 'origin', true);
    expect(calls).toEqual([['push', { root: '/p/a', publish: { remote: 'origin' } }], ['openUrl', 'https://github.com/acme/store/compare/feat/x?expand=1']]);
    expect(loadGitPrefs().openPr).toBe(true);
  });

  test('publish: no compare page when not asked, for another host, or when the push failed', async () => {
    useApp.setState({ gitFacts: { '/p/a': facts({ branch: 'feat/x', upstream: null, githubRepos: { origin: 'https://github.com/acme/store' } }) } });
    await publish('/p/a', 'origin', false);
    expect(loadGitPrefs().openPr).toBe(false);
    // Not offered for another host: the remembered choice stays.
    await publish('/p/a', 'gl', true);
    expect(loadGitPrefs().openPr).toBe(false);
    answers.push = { outcome: 'network' };
    await publish('/p/a', 'origin', true);
    expect(names()).toEqual(['push', 'push', 'push']);
  });
});

describe('Sync All and live sessions', () => {
  test('a behind repository whose incoming files a live session is changing is never pulled without asking: skipped, then a guarded Pull…', async () => {
    const b: ScmRepoEntry = { ...entry({ behind: 2 }), root: '/p/b', name: 'billing' };
    const c: ScmRepoEntry = { ...entry({ ahead: 1 }), root: '/p/c', name: 'checkout' };
    useApp.setState({ scmRepos: [entry({ behind: 1 }), b, c], terminals: [term('t1', 'auth-refactor')], attributions: [attr('/p/a/src/cart.ts', 't1', 'auth-refactor')] });
    answers.incoming = (root: string) => (root === '/p/a' ? ['src/cart.ts', 'README.md'] : ['src/cart.ts']);
    answers.syncAll = [{ root: '/p/a', result: null, needsYou: 'live' }, { root: '/p/b', result: { outcome: 'ok' } }, { root: '/p/c', result: { outcome: 'ok' } }];
    await git.syncAll();
    // Only the behind ones are compared; main is told to leave /p/a alone.
    expect(calls).toEqual([['incoming', '/p/a'], ['incoming', '/p/b'], ['syncAll', { skip: ['/p/a'] }]]);
    expect(toast()?.text).toBe('Synced 2 · 1 needs you');
    // Its row in the list says why and offers Pull…, which asks first: the overlap sheet, nothing pulled.
    const row = syncAllRow({ root: '/p/a', result: null, needsYou: 'live' });
    expect(row).toEqual({ ok: false, text: 'Needs you · a session is working on files this pull changes', action: 'pull' });
    calls = [];
    await startPull('/p/a');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'pullOverlap', root: '/p/a', files: ['src/cart.ts'], rebase: false, sync: false });
    expect(names()).toEqual(['incoming']);
  });

  test('the comparisons before Sync All run a few at once, and the skip list keeps the repositories\' order', async () => {
    const roots = ['/p/a', '/p/b', '/p/c', '/p/d', '/p/e'];
    useApp.setState({
      scmRepos: roots.map((root) => ({ ...entry({ behind: 1 }), root, name: root.slice(3) })),
      terminals: [term('t1', 'auth-refactor')], attributions: roots.map((root) => attr(`${root}/src/cart.ts`, 't1', 'auth-refactor'))
    });
    const ends: (() => void)[] = [];
    answers.incoming = () => new Promise((resolve) => { ends.push(() => resolve(['src/cart.ts'])); });
    answers.syncAll = [];
    const run = git.syncAll();
    await tick(); await tick();
    expect(names()).toEqual(['incoming', 'incoming', 'incoming', 'incoming']);
    // The last one asked answers first: the list still follows the repositories.
    ends[3]!(); ends[1]!(); ends[0]!(); ends[2]!();
    await tick(); await tick();
    ends[4]!();
    await run;
    expect(calls.at(-1)).toEqual(['syncAll', { skip: roots }]);
  });

  test("Sync All's toast counts as its list does: synced with a hook that failed after it needs you", async () => {
    answers.syncAll = [{ root: '/p/a', result: { outcome: 'ok', warning: 'The post-merge hook failed' } }, { root: '/p/b', result: { outcome: 'ok' } }];
    await git.syncAll();
    expect(toast()?.text).toBe('Synced 1 · 1 needs you');
  });

  test('no live session: nothing to compare, nothing skipped', async () => {
    useApp.setState({ scmRepos: [entry({ behind: 1 })] });
    answers.syncAll = [{ root: '/p/a', result: { outcome: 'ok' } }];
    await git.syncAll();
    expect(calls).toEqual([['syncAll', { skip: [] }]]);
  });

  test("the list's rows: done, diverged, a failure in git's words, a live overlap with its own Pull…", () => {
    expect(syncAllRow({ root: '/p/a', result: { outcome: 'ok' } })).toEqual({ ok: true, text: 'In sync', action: null });
    expect(syncAllRow({ root: '/p/a', result: null, needsYou: 'diverged' })).toEqual({ ok: false, text: 'Diverged: Sync it from its card to rebase', action: 'show' });
    expect(syncAllRow({ root: '/p/a', result: { outcome: 'network' } })).toEqual({ ok: false, text: "Couldn't reach the remote.", action: 'show' });
  });

  test("Pull All's and Push All's rows name their own op: done, and in a failure", () => {
    const r = { root: '/p/a', result: { outcome: 'error' as const, message: 'boom' } };
    expect(syncAllRow(r).text).toBe('Sync failed: boom');
    expect(syncAllRow(r, 'pull').text).toBe('Pull failed: boom');
    expect(syncAllRow(r, 'push').text).toBe('Push failed: boom');
    const done = { root: '/p/a', result: { outcome: 'ok' as const } };
    expect(syncAllRow(done, 'pull')).toEqual({ ok: true, text: 'Pulled', action: null });
    expect(syncAllRow(done, 'push')).toEqual({ ok: true, text: 'Pushed', action: null });
  });

  test('a pull that went through while the hook after it failed needs you: its row says what git reported', () => {
    const r = { root: '/p/a', result: { outcome: 'ok' as const, warning: 'The post-merge hook failed: npm ERR! code ERESOLVE' } };
    expect(syncAllRow(r, 'pull')).toEqual({ ok: false, text: 'Pulled, but the post-merge hook failed: npm ERR! code ERESOLVE', action: 'show' });
    expect(syncAllRow(r)).toEqual({ ok: false, text: 'Synced, but the post-merge hook failed: npm ERR! code ERESOLVE', action: 'show' });
  });

  test("sign-in needed: a pull's row says it in main's words (never \"Push needs sign-in\")", () => {
    const pullAuth = { root: '/p/a', result: { outcome: 'auth' as const, message: "Pull needs sign-in: git asked for a password Atelier can't type" } };
    expect(syncAllRow(pullAuth, 'pull').text).toBe("Pull needs sign-in: git asked for a password Atelier can't type");
    expect(syncAllRow({ root: '/p/a', result: { outcome: 'auth' } }, 'push').text).toBe("Push needs sign-in: git asked for a password Atelier can't type");
  });
});

test("the remote's commits in a sheet: the first three, and \"and N more\" from main's total (it lists at most 20)", () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ oid: `${i}`.repeat(7), subject: `feat: ${i}`, author: 'Ada' }));
  expect(commitsShown(list, 25)).toEqual({ shown: list.slice(0, 3), more: 22 });
  expect(commitsShown(list.slice(0, 2), 2)).toEqual({ shown: list.slice(0, 2), more: 0 });
  // An older main without a total: the list's length.
  expect(commitsShown(list.slice(0, 5), undefined)).toEqual({ shown: list.slice(0, 3), more: 2 });
});

test('sheet titles start with a capital when the upstream is unknown ("the remote")', () => {
  expect(sentence('the remote moved on')).toBe('The remote moved on');
  expect(sentence('origin/main moved on')).toBe('origin/main moved on');
  expect(sentence('')).toBe('');
});

test('Read-only: none of the flows asks main anything', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' }, scmRepos: [entry({ behind: 1 })] });
  await startPull('/p/a');
  await startSync('/p/a');
  await pullThenPush('/p/a');
  await publish('/p/a', 'origin', true);
  expect(calls).toEqual([]);
  expect(useApp.getState().gitSheet).toBeNull();
});

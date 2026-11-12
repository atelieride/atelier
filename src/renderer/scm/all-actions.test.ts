import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Attribution } from '@shared/attribution';
import type { RepoStatus } from '@shared/git';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import type { ScmRepoEntry } from '@shared/scm';
import { BULK_GIT_PARALLEL } from '@shared/lanes';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from '../store';
import { pullAll, pushAll } from './all-actions';

// Sync All's ▾ in the All Repositories view: Pull All and Push All go a few repositories at
// a time (a repository's worktrees one after another) and end with one toast. Nothing stops the run: what needs you
// (a failure, a live session working on files the pull changes, a branch that diverged) is counted, and Show lists it.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: [string, ...unknown[]][];
let answers: Record<string, unknown>;

const st = (root: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root, name: root.split('/').pop()!, branch: 'main', detached: false, ahead: 0, behind: 0, upstream: 'origin/main', changes: [], oid: 'a'.repeat(40), checkedAt: 1, truncated: 0, ...o
});
const entry = (s: RepoStatus, common = `${s.root}/.git`): ScmRepoEntry => ({
  root: s.root, rel: s.root.slice(3), name: s.name, worktreeOf: s.worktreeOf ?? null, nestedIn: null, common, status: { ...s, upstream: s.upstream ?? null, changes: 0 }
});
const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: 's1', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, lastMessageAt: 100, ...o });
const term = (id: string, title: string): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title, name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: session() });
const attr = (path: string, terminalId: string, title: string): Attribution => ({ path, terminalId, sessionId: 's1', color: '#c0ffee', title, at: 150 });

beforeEach(() => {
  calls = []; answers = {};
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  const method = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); const a = answers[name]; return typeof a === 'function' ? (a as (...x: unknown[]) => unknown)(...args) : a ?? { outcome: 'ok' }; };
  g.window = { atelier: { git: Object.fromEntries(['pull', 'push', 'sync', 'facts', 'incoming'].map((n) => [n, method(n)])) } };
  answers.incoming = [];
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' }, scmRepos: null, scmBulk: null,
    repos: [st('/p/a', { behind: 1 }), st('/p/b', { behind: 2 }), st('/p/c', { ahead: 1, behind: 1 }), st('/p/d', { ahead: 2 })],
    gitFacts: {}, gitOps: {}, gitResult: {}, gitSheet: null, toast: null, terminals: [], attributions: [],
    gitStageIntents: [], gitReposSeen: [], gitSyncIntents: []
  });
});
afterEach(() => { delete g.window; delete g.localStorage; });

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const toast = () => useApp.getState().toast;
const rootsOf = (op: string) => calls.filter((c) => c[0] === op).map((c) => (c[1] as { root: string }).root);
/** The toast's Show, pressed: the list it opens. */
const shown = () => { toast()!.action!.run(); return useApp.getState().gitSheet; };

/** Pulls that end when the test says. */
function heldPulls() {
  const ends = new Map<string, () => void>();
  answers.pull = (o: { root: string }) => new Promise((resolve) => { ends.set(o.root, () => resolve({ outcome: 'ok' })); });
  return async (root: string) => { ends.get(root)!(); await flush(); };
}

test('Pull All: only the repositories just behind, then one toast that names the diverged one left', async () => {
  await pullAll();
  expect(rootsOf('pull')).toEqual(['/p/a', '/p/b']);
  expect(calls.find((c) => c[0] === 'pull')![1]).toEqual({ root: '/p/a', rebase: false });
  expect(toast()?.text).toBe('Pulled 2 repositories · 1 diverged: sync it on its own');
  expect(toast()?.action).toBeUndefined();
});

test(`Pull All: up to ${BULK_GIT_PARALLEL} repositories at once; a repository's worktrees one after another`, async () => {
  const a = st('/p/a', { behind: 1 });
  const wt = st('/p/a-wt', { behind: 1, worktreeOf: '/p/a' });
  const others = ['/p/b', '/p/c', '/p/d', '/p/e'].map((r) => st(r, { behind: 1 }));
  useApp.setState({ repos: [a, wt, ...others], scmRepos: [entry(a), entry(wt, '/p/a/.git'), ...others.map((s) => entry(s))] });
  const end = heldPulls();
  const run = pullAll();
  await flush();
  expect(rootsOf('pull')).toEqual(['/p/a', '/p/b', '/p/c', '/p/d']);
  await end('/p/c');
  expect(rootsOf('pull')).toEqual(['/p/a', '/p/b', '/p/c', '/p/d', '/p/e']);
  await end('/p/a');
  expect(rootsOf('pull').at(-1)).toBe('/p/a-wt');
  for (const r of ['/p/b', '/p/d', '/p/e', '/p/a-wt']) await end(r);
  await run;
  expect(toast()?.text).toBe('Pulled 6 repositories');
});

test("Pull All before Source Control's list is read: a worktree still waits for its repository (Changes' status names it)", async () => {
  const a = st('/p/a', { behind: 1 });
  const wt = st('/p/a-wt', { behind: 1, worktreeOf: '/p/a' });
  const others = ['/p/b', '/p/c', '/p/d', '/p/e'].map((r) => st(r, { behind: 1 }));
  useApp.setState({ repos: [a, wt, ...others], scmRepos: null });
  const end = heldPulls();
  const run = pullAll();
  await flush();
  expect(rootsOf('pull')).toEqual(['/p/a', '/p/b', '/p/c', '/p/d']);
  for (const r of ['/p/a', '/p/b', '/p/c', '/p/d', '/p/e', '/p/a-wt']) await end(r);
  await run;
});

test('Pull All: a pull that went through while the hook after it failed needs you; Show says what git reported', async () => {
  answers.pull = (o: { root: string }) => (o.root === '/p/a' ? { outcome: 'ok', warning: 'The post-merge hook failed: npm ERR!' } : { outcome: 'ok' });
  await pullAll();
  expect(toast()?.text).toBe('Pulled 1 repository · 2 need you');
  expect(shown()).toMatchObject({ rows: [{ root: '/p/a', result: { outcome: 'ok', warning: 'The post-merge hook failed: npm ERR!' } }, { root: '/p/b' }, { root: '/p/c' }] });
});

test('Read-only turned on mid-run: the repositories not started yet never run, and none of them is listed as failed', async () => {
  useApp.setState({ repos: ['/p/a', '/p/b', '/p/c', '/p/d', '/p/e'].map((r) => st(r, { behind: 1 })) });
  const end = heldPulls();
  const run = pullAll();
  await flush();
  expect(rootsOf('pull')).toHaveLength(BULK_GIT_PARALLEL);
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  for (const r of ['/p/a', '/p/b', '/p/c', '/p/d']) await end(r);
  await run;
  expect(rootsOf('pull')).not.toContain('/p/e');
  expect(useApp.getState().gitResult['/p/e']).toBeUndefined();
  expect(toast()?.text).toBe('Pulled 4 repositories');
});

test('Pull All: a failure stops nothing; the toast counts what needs you, and Show lists every repository it touched', async () => {
  answers.pull = (o: { root: string }) => (o.root === '/p/a' ? { outcome: 'network', message: 'Could not resolve host' } : { outcome: 'ok' });
  await pullAll();
  expect(rootsOf('pull')).toEqual(['/p/a', '/p/b']);
  expect(toast()?.text).toBe('Pulled 1 repository · 2 need you');
  expect(toast()?.action?.label).toBe('Show');
  expect(useApp.getState().gitSheet).toBeNull();
  expect(shown()).toEqual({
    kind: 'syncAll', run: 'pull', rows: [
      { root: '/p/a', result: { outcome: 'network', message: 'Could not resolve host' } },
      { root: '/p/b', result: { outcome: 'ok' } },
      { root: '/p/c', result: null, needsYou: 'diverged' }
    ]
  });
  // The failure stays on its block, as a single pull's would.
  expect(useApp.getState().gitResult['/p/a']).toBeDefined();
});

test('Pull All: a repository whose incoming files a live session is changing is left for you: never pulled, no question mid-run', async () => {
  useApp.setState({ terminals: [term('t1', 'auth-refactor')], attributions: [attr('/p/a/src/cart.ts', 't1', 'auth-refactor')] });
  answers.incoming = (root: string) => (root === '/p/a' ? ['src/cart.ts'] : []);
  await pullAll();
  expect(rootsOf('pull')).toEqual(['/p/b']);
  expect(toast()?.text).toBe('Pulled 1 repository · 2 need you');
  expect(shown()).toMatchObject({ kind: 'syncAll', run: 'pull', rows: [{ root: '/p/a', result: null, needsYou: 'live' }, { root: '/p/b' }, { root: '/p/c' }] });
});

test('Pull All: a pull git turns down as diverged since the last look is listed as diverged, without the rebase question', async () => {
  answers.pull = (o: { root: string }) => (o.root === '/p/b' ? { outcome: 'error', message: 'fatal: Not possible to fast-forward, aborting.' } : { outcome: 'ok' });
  await pullAll();
  expect(useApp.getState().gitSheet).toBeNull();
  expect(useApp.getState().gitResult['/p/b']).toBeUndefined();
  expect(toast()?.text).toBe('Pulled 1 repository · 2 need you');
  expect(shown()).toMatchObject({ rows: [{ root: '/p/a' }, { root: '/p/b', result: null, needsYou: 'diverged' }, { root: '/p/c', needsYou: 'diverged' }] });
});

test('Push All: only the repositories just ahead, then one toast', async () => {
  await pushAll();
  expect(rootsOf('push')).toEqual(['/p/d']);
  expect(calls.find((c) => c[0] === 'push')![1]).toEqual({ root: '/p/d' });
  expect(toast()?.text).toBe('Pushed 1 repository · 1 diverged: sync it on its own');
});

test('Push All: a rejected push is listed, without the rejected question mid-run', async () => {
  answers.push = { outcome: 'rejected', message: 'the remote has commits you do not' };
  await pushAll();
  expect(useApp.getState().gitSheet).toBeNull();
  expect(toast()?.text).toBe('Nothing pushed · 2 need you');
  expect(shown()).toEqual({
    kind: 'syncAll', run: 'push', rows: [
      { root: '/p/c', result: null, needsYou: 'diverged' },
      { root: '/p/d', result: { outcome: 'rejected', message: 'the remote has commits you do not' } }
    ]
  });
});

test('a pull or push cancelled says nothing more: every one cancelled (the live demo answers so), no toast', async () => {
  answers.pull = { outcome: 'cancelled', message: 'Cancelled.' };
  await pullAll();
  expect(toast()).toBeNull();
  answers.pull = (o: { root: string }) => (o.root === '/p/a' ? { outcome: 'cancelled' } : { outcome: 'ok' });
  await pullAll();
  expect(toast()?.text).toBe('Pulled 1 repository · 1 diverged: sync it on its own');
});

test('Read-only: nothing runs and nothing is said', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  await pullAll();
  await pushAll();
  expect(calls).toEqual([]);
  expect(toast()).toBeNull();
});

test('one run at a time: a second Pull All while the first runs does nothing; the run shows in the store', async () => {
  const end = heldPulls();
  const first = pullAll();
  await flush();
  expect(useApp.getState().scmBulk).toBe('pull');
  await pullAll();
  expect(rootsOf('pull')).toEqual(['/p/a', '/p/b']);
  await end('/p/a');
  await end('/p/b');
  await first;
  expect(useApp.getState().scmBulk).toBeNull();
});

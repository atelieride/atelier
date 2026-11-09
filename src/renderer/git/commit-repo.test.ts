import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { GitFacts } from '@shared/git-write';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { Attribution } from '@shared/attribution';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { commitRepo, repoCommitState, stageThenCommitRepo } from './commit-repo';

// A commit from a block of Source Control's All Repositories view:
// the drawer's rules — what is staged, the draft, Co-authored-by, and the "When nothing is staged" setting.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: [string, ...unknown[]][];
let answers: Record<string, unknown>;

const ch = (rel: string, stage: FileChange['stage'], kind: FileChange['kind'] = 'M'): FileChange => ({ path: `/p/a/${rel}`, rel, kind, stage, added: 1, removed: 0 });
const repo = (...changes: FileChange[]): RepoStatus => ({ root: '/p/a', name: 'api', branch: 'dev', detached: false, ahead: 0, behind: 0, upstream: 'origin/dev', changes, oid: 'a'.repeat(40), checkedAt: 1, truncated: 0 });
const facts = (o: Partial<GitFacts> = {}): GitFacts => ({
  root: '/p/a', identity: true, state: null, detached: false, branch: 'dev', head: 'h', upstream: 'origin/dev', headPushed: false, headIsMerge: false,
  headHasParent: true, headMessage: 'x', hooks: { preCommit: false, commitMsg: false, prePush: false }, gpgProgram: null, signs: false, gitVersion: [2, 50, 1],
  undo: null, remotes: ['origin'], ...o
});
const session: Attribution = { path: '/p/a/a.ts', terminalId: 't1', sessionId: 's1', color: '#fff', title: 'auth', at: 1 };

beforeEach(() => {
  calls = []; answers = {};
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  const method = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); const a = answers[name]; return typeof a === 'function' ? (a as () => unknown)() : a ?? { outcome: 'ok' }; };
  g.window = { atelier: { git: Object.fromEntries(['stage', 'commit', 'push', 'facts'].map((n) => [n, method(n)])), settings: { set: async () => {} } } };
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' }, repos: [repo(ch('a.ts', 'all'), ch('b.ts', 'none'))],
    gitDrafts: { '/p/a': 'feat: tokens' }, gitFacts: { '/p/a': facts() }, gitOps: {}, gitResult: {}, gitDrawer: { open: false, height: null, unfolded: [], openedFor: null },
    gitStageIntents: [], gitReposSeen: [], gitSyncIntents: [], attributions: [], toast: null, gitWrite: null, gitTarget: null, changesScope: 'all', ws: null
  });
});
afterEach(() => { delete g.window; delete g.localStorage; });

describe('repoCommitState', () => {
  test('staged files with a message: nothing in the way', () => {
    expect(repoCommitState('/p/a')).toMatchObject({ staged: 1, offered: false, block: null, name: 'api' });
  });

  test('no message, a rebase in progress, no identity: the drawer\'s reasons', () => {
    useApp.setState({ gitDrafts: {} });
    expect(repoCommitState('/p/a').block).toMatch(/message/i);
    useApp.setState({ gitDrafts: { '/p/a': 'x' }, gitFacts: { '/p/a': facts({ state: 'rebase' }) } });
    expect(repoCommitState('/p/a').block).toMatch(/rebase/);
    useApp.setState({ gitFacts: { '/p/a': facts({ identity: false }) } });
    expect(repoCommitState('/p/a').block).toBeTruthy();
  });

  test('nothing staged: offered unless the setting says Don\'t commit', () => {
    useApp.setState({ repos: [repo(ch('a.ts', 'none'), ch('n.ts', 'none', '?'))] });
    expect(repoCommitState('/p/a')).toMatchObject({ staged: 0, offered: true, block: null, plan: { what: 'all', changes: 2, newFiles: 1 } });
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, commitNothingStaged: 'never' } });
    expect(repoCommitState('/p/a')).toMatchObject({ offered: false, block: 'Nothing staged in api' });
  });
});

describe('commitRepo', () => {
  test('commits what is staged with the draft; Commit and Push pushes after', async () => {
    await commitRepo('/p/a', { push: true });
    expect(calls.filter((c) => c[0] === 'commit')).toEqual([['commit', { root: '/p/a', message: 'feat: tokens', amend: false, coAuthor: false, noVerify: false }]]);
    expect(calls.some((c) => c[0] === 'push')).toBe(true);
  });

  test("Co-authored-by: the setting's, when a staged file is surely a session's", async () => {
    useApp.setState({ attributions: [session] });
    await commitRepo('/p/a', {});
    expect(calls.find((c) => c[0] === 'commit')?.[1]).toMatchObject({ coAuthor: true });
    // A commit clears the draft it used (the drawer's rule): a new one for the next commit.
    expect(useApp.getState().gitDrafts['/p/a']).toBeUndefined();
    calls = [];
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, commitCoAuthor: false }, gitDrafts: { '/p/a': 'fix: again' } });
    await commitRepo('/p/a', {});
    expect(calls.find((c) => c[0] === 'commit')?.[1]).toMatchObject({ coAuthor: false });
  });

  test('nothing staged: Ask answers ask and runs nothing; Stage all stages everything, then commits', async () => {
    useApp.setState({ repos: [repo(ch('a.ts', 'none'))] });
    expect(await commitRepo('/p/a', {})).toBe('ask');
    expect(calls).toEqual([]);
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, commitNothingStaged: 'stage-all' } });
    await commitRepo('/p/a', {});
    expect(calls.map((c) => c[0])).toEqual(['stage', 'commit']);
    expect(calls[0]).toEqual(['stage', '/p/a', 'all']);
  });

  test('a second Commit while the first runs runs nothing (a double click)', async () => {
    answers.commit = () => new Promise((r) => setTimeout(() => r({ outcome: 'ok' }), 20));
    await Promise.all([commitRepo('/p/a', {}), commitRepo('/p/a', {})]);
    expect(calls.filter((c) => c[0] === 'commit')).toHaveLength(1);
  });

  test('while ✦ writes this message, Commit waits for it', () => {
    useApp.setState({ gitWrite: { root: '/p/a', phase: 'writing', id: 'w', text: 'feat', apply: null, staged: '', startedAt: 1, tweak: null, used: [] } });
    expect(repoCommitState('/p/a').block).toBe(t.git.write.busy);
  });

  test("Changes showing This workspace: Stage All takes only its rows, as the drawer's", () => {
    useApp.setState({
      repos: [repo(ch('mine.ts', 'none'), ch('theirs.ts', 'none'))], changesScope: 'ws',
      ws: { on: true, active: 'w1', list: [{ id: 'w1', name: 'One', color: 1, folder: null }, { id: 'w2', name: 'Two', color: 2, folder: null }] as never, members: { t2: 'w2' } } as never,
      attributions: [{ ...session, path: '/p/a/theirs.ts', terminalId: 't2' }]
    });
    expect(repoCommitState('/p/a').plan).toMatchObject({ what: ['mine.ts'], changes: 1 });
  });

  test("a commit from a block leaves the drawer where it is, on another repository's draft", async () => {
    // The drawer is on billing, being written, nothing staged there yet: it stays open on it.
    useApp.setState({ repos: [repo(ch('a.ts', 'all')), { ...repo(ch('b.ts', 'none')), root: '/p/b', name: 'billing' }], gitDrawer: { open: true, height: null, unfolded: [], openedFor: null }, gitTarget: '/p/b' });
    await commitRepo('/p/a', {});
    expect(useApp.getState()).toMatchObject({ gitDrawer: { open: true }, gitTarget: '/p/b' });
  });

  test('a stage that failed stops there; a blocked commit runs nothing', async () => {
    useApp.setState({ repos: [repo(ch('a.ts', 'none'))] });
    answers.stage = { outcome: 'error', message: 'index.lock' };
    await stageThenCommitRepo('/p/a', {});
    expect(calls.map((c) => c[0])).toEqual(['stage']);
    calls = [];
    useApp.setState({ repos: [repo(ch('a.ts', 'all'))], gitDrafts: {} });
    expect(await commitRepo('/p/a', {})).toBeNull();
    expect(calls).toEqual([]);
  });
});

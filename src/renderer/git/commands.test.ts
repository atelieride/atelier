import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Attribution } from '@shared/attribution';
import type { FileChange, RepoStatus } from '@shared/git';
import { MENU_SPEC, menuItems } from '@shared/menu-spec';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from '../store';
import { commandRepo, gitPaletteCommands, runGitCommand, sessionWork, type GitPaletteInput } from './commands';

// The Git menu's and the palette's git commands: what they act on, what they open, and which
// of them the palette offers.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: [string, ...unknown[]][];

function fakeGit() {
  const method = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return name === 'syncAll' ? [] : name === 'incoming' ? [] : { outcome: 'ok' }; };
  return Object.fromEntries(['stage', 'push', 'pull', 'sync', 'syncAll', 'incoming', 'facts', 'running', 'undoCommit'].map((n) => [n, method(n)]));
}

const ch = (rel: string, stage: FileChange['stage'] = 'none'): FileChange => ({ path: `/p/a/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0 });
const repo = (root: string, name: string, changes: FileChange[] = []): RepoStatus => ({
  root, name, branch: 'main', detached: false, ahead: 0, behind: 0, changes, oid: 'a'.repeat(40), checkedAt: 0, truncated: 0, upstream: 'origin/main'
});
const by = (path: string, terminalId: string, o: Partial<Attribution> = {}): Attribution => ({ path, terminalId, sessionId: `s-${terminalId}`, color: '#fff', title: terminalId, at: 1, ...o });
const entry = (root: string, name: string) => ({ root, rel: root.slice(3), name, worktreeOf: null, common: `${root}/.git`, status: null });

beforeEach(() => {
  calls = [];
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = { atelier: { git: fakeGit(), scm: { refs: async () => null } } };
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' },
    repos: [repo('/p/a', 'acme-store', [ch('x.ts')]), repo('/p/b', 'billing')],
    scmRepos: [entry('/p/a', 'acme-store'), entry('/p/b', 'billing')] as never, scmRepo: '/p/b',
    scmRefs: { '/p/a': { hasRemote: true } as never, '/p/b': { hasRemote: true } as never },
    gitDrawer: { open: false, height: null, unfolded: [], openedFor: null }, gitTarget: null, gitLastStaged: null, gitDrafts: {}, gitOps: {}, gitResult: {},
    gitSheet: null, commitAll: null, gitFacts: {}, toast: null, refPicker: null, attributions: [], showChanges: true
  });
});
afterEach(() => { delete g.window; delete g.localStorage; });

describe('commandRepo: the repository a Git command acts on', () => {
  test("Source Control's selected one, else the commit target, else the first with changes, else the first", () => {
    const s = () => useApp.getState();
    expect(commandRepo(s())).toBe('/p/b');
    useApp.setState({ scmRepo: null, gitTarget: '/p/b' });
    expect(commandRepo(s())).toBe('/p/b');
    useApp.setState({ gitTarget: null });
    expect(commandRepo(s())).toBe('/p/a');
    useApp.setState({ repos: [repo('/p/a', 'acme-store'), repo('/p/b', 'billing')] });
    expect(commandRepo(s())).toBe('/p/a');
    useApp.setState({ repos: [] });
    expect(commandRepo(s())).toBeNull();
  });
});

describe('runGitCommand', () => {
  test('Push, Pull, Sync on the selected repository; New Branch and Stash open their sheets there; Switch opens the picker', async () => {
    await runGitCommand('git-push');
    expect(calls).toContainEqual(['push', { root: '/p/b' }]);
    await runGitCommand('git-sync-all');
    expect(calls.map((c) => c[0])).toContain('syncAll');
    await runGitCommand('git-pull');
    expect(calls).toContainEqual(['pull', { root: '/p/b', rebase: false }]);
    await runGitCommand('git-new-branch');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'newBranch', root: '/p/b' });
    await runGitCommand('git-stash');
    expect(useApp.getState().gitSheet).toEqual({ kind: 'stash', root: '/p/b' });
    await runGitCommand('git-switch-branch');
    expect(useApp.getState().refPicker).toEqual({ mode: 'switch' });
  });

  test('Commit…: the drawer; Commit All Repositories…: the sheet with the staged ones, or a notice when nothing is staged', async () => {
    await runGitCommand('git-commit');
    expect(useApp.getState().gitDrawer.open).toBe(true);
    await runGitCommand('git-commit-all');
    expect(useApp.getState().commitAll).toBeNull();
    expect(useApp.getState().toast?.text).toBe('Nothing is staged in this project');
    useApp.setState({ repos: [repo('/p/a', 'acme-store', [ch('x.ts', 'all')]), repo('/p/b', 'billing', [ch('y.ts', 'all')])] });
    await runGitCommand('git-commit-all');
    expect(useApp.getState().commitAll?.cards.map((c) => c.root)).toEqual(['/p/a', '/p/b']);
  });

  test('Read-only: nothing runs, nothing opens', async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
    for (const c of ['git-commit', 'git-commit-all', 'git-push', 'git-pull', 'git-sync', 'git-sync-all', 'git-new-branch', 'git-switch-branch', 'git-stash'] as const) await runGitCommand(c);
    expect(calls).toEqual([]);
    const s = useApp.getState();
    expect([s.gitDrawer.open, s.commitAll, s.gitSheet, s.refPicker, s.toast]).toEqual([false, null, null, null, null]);
  });
});

describe('sessionWork: the files a session surely changed', () => {
  test('its sure rows that can stage, in every repository; unsure ones and other sessions left out', () => {
    useApp.setState({
      repos: [repo('/p/a', 'acme-store', [ch('x.ts'), ch('y.ts'), ch('z.ts')]), repo('/p/b', 'billing', [{ ...ch('w.ts'), path: '/p/b/w.ts' }])],
      attributions: [by('/p/a/x.ts', 't1'), by('/p/a/y.ts', 't1', { unclear: ['t1', 't2'] }), by('/p/a/z.ts', 't2'), by('/p/b/w.ts', 't1')]
    });
    expect(sessionWork(useApp.getState(), 't1').map((r) => `${r.repo}/${r.rel}`)).toEqual(['/p/a/x.ts', '/p/b/w.ts']);
    expect(sessionWork(useApp.getState(), 't3')).toEqual([]);
  });

  test('the palette asks on every store change: the answer is kept until the repositories, the attributions or the session change', () => {
    useApp.setState({ repos: [repo('/p/a', 'acme-store', [ch('x.ts')])], attributions: [by('/p/a/x.ts', 't1')] });
    const s = useApp.getState();
    const first = sessionWork(s, 't1');
    expect(first).toHaveLength(1);
    // Another part of the store changed (a toast, a terminal's title): the same answer, not computed again.
    expect(sessionWork({ repos: s.repos, attributions: s.attributions }, 't1')).toBe(first);
    expect(sessionWork({ repos: [...s.repos], attributions: s.attributions }, 't1')).not.toBe(first);
    expect(sessionWork({ repos: s.repos, attributions: [...s.attributions] }, 't1')).not.toBe(first);
    expect(sessionWork({ repos: s.repos, attributions: s.attributions }, 't2')).toEqual([]);
  });
});

describe('gitPaletteCommands (the same commands as the Git menu, plus "Commit <session>\'s Work…")', () => {
  const ON: GitPaletteInput = {
    hasRepos: true, writes: true, messages: true, undo: false, repo: { root: '/p/a', name: 'acme-store' }, remote: true, anyRemote: true, work: null
  };
  const keys = (o: Partial<GitPaletteInput> = {}) => gitPaletteCommands({ ...ON, ...o }).map((c) => c.key);

  test('the write commands with Git actions on, labelled as the menu labels them', () => {
    expect(keys()).toEqual(['git-commit', 'git-commit-all', 'git-write-message', 'git-push', 'git-pull', 'git-sync', 'git-sync-all', 'git-new-branch', 'git-switch-branch', 'git-stash']);
    const menu = new Map(menuItems(MENU_SPEC).flatMap((i) => ('command' in i ? [[i.command as string, i.label]] : [])));
    for (const c of gitPaletteCommands({ ...ON, undo: true })) expect(c.label).toBe(menu.get(c.command));
    const push = gitPaletteCommands(ON).find((c) => c.key === 'git-push')!;
    expect(push.hint).toBe('acme-store');
    expect(gitPaletteCommands(ON).find((c) => c.key === 'git-commit')!.hint).toBe('⌘⌥K');
  });

  test('none without a repository or in Read-only; ✦ only with messages on; Undo only while offered', () => {
    expect(keys({ hasRepos: false })).toEqual([]);
    expect(keys({ writes: false, undo: true, work: { id: 't1', title: 'auth', files: 2 } })).toEqual([]);
    expect(keys({ messages: false })).not.toContain('git-write-message');
    expect(keys({ undo: true })).toContain('git-undo-commit');
    expect(keys()).not.toContain('git-undo-commit');
  });

  test('Push, Pull and Sync need a remote on that repository; Sync All one anywhere', () => {
    expect(keys({ remote: false })).not.toEqual(expect.arrayContaining(['git-push']));
    expect(keys({ remote: false })).toContain('git-sync-all');
    expect(keys({ remote: false, anyRemote: false })).not.toContain('git-sync-all');
  });

  test("Commit <session>'s Work…: the focused session's, when it surely changed files", () => {
    const work = gitPaletteCommands({ ...ON, work: { id: 't1', title: 'auth-refactor', files: 2 } }).find((c) => c.key === 'git-commit-work');
    expect(work).toMatchObject({ label: "Commit auth-refactor's Work…", hint: '2 files', command: 'commit-work' });
  });
});

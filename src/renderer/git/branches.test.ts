import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Attribution } from '@shared/attribution';
import type { FileChange } from '@shared/git';
import type { TerminalInfo } from '@shared/protocol';
import type { ScmRef, ScmStash } from '@shared/scm';
import type { SessionInfo } from '@shared/session';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { branchCreate, stashApply, switchTo, worktreeAdd } from './actions';
import { branchItems, deepestRoot, defaultWorktreePath, DOUBLE_CLICK_MS, localName, rowClicks, stashFileCount, stashItems, startSwitch, workingIn, worktreeSlug } from './branches';

// Branches and stashes from Source Control: who works in a working tree, the new worktree's
// default folder, a stash's file count, the rows' git items, and a switch that asks only when it must.

type Entry = Exclude<MenuItem, 'sep'>;
const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: unknown[][];
const tick = () => new Promise((r) => setTimeout(r, 0));
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '—' : i.id));
const item = (items: MenuItem[], id: string) => items.find((i): i is Entry => i !== 'sep' && i.id === id)!;

const session = (o: Partial<SessionInfo>): SessionInfo => ({
  sessionId: 's1', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, lastMessageAt: 100, ...o
});
const term = (id: string, cwd: string, s: Partial<SessionInfo> | null): TerminalInfo => ({
  id, projectRoot: '/p', cwd, title: `${id}-title`, name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: s ? session(s) : null
});
const attr = (path: string, terminalId: string, at = 150): Attribution => ({ path, terminalId, sessionId: 's1', color: '#c0ffee', title: `${terminalId}-title`, at });
const ref = (name: string, o: Partial<ScmRef> = {}): ScmRef => {
  const kind = name.startsWith('refs/heads/') ? 'head' : name.startsWith('refs/tags/') ? 'tag' : 'remote';
  const short = name.replace(/^refs\/(heads|tags|remotes)\//, '');
  return { name, short, kind, ...(kind === 'remote' ? { remote: short.split('/')[0] } : {}), oid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, gone: false, current: false, date: 0, ...o } as ScmRef;
};
const ch = (rel: string, kind: FileChange['kind'], stage: FileChange['stage'] = 'none'): FileChange => ({ path: `/p/${rel}`, rel, kind, stage, added: 1, removed: 0 });

beforeEach(() => {
  calls = [];
  const ok = (name: string) => async (...a: unknown[]) => { calls.push([name, ...a]); return { outcome: 'ok' }; };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.window = { atelier: { git: { switchTo: ok('switchTo'), stashApply: ok('stashApply'), stashDrop: ok('stashDrop'), branchDelete: ok('branchDelete') }, clipboard: { write: async () => true } } };
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' }, terminals: [], attributions: [], toast: null, gitSheet: null,
    repos: [], scmRepos: null, scmRepo: '/p', scmRefs: {}, gitFacts: {}
  });
});
afterEach(() => { delete g.window; delete g.localStorage; });

test('the deepest working tree holds a path: a nested repository or a linked worktree is not its parent', () => {
  const roots = ['/p', '/p/plugins/pay', '/p/.claude/worktrees/feat-x'];
  expect(deepestRoot('/p/src/a.ts', roots)).toBe('/p');
  expect(deepestRoot('/p', roots)).toBe('/p');
  expect(deepestRoot('/p/plugins/pay/x.ts', roots)).toBe('/p/plugins/pay');
  expect(deepestRoot('/p/.claude/worktrees/feat-x', roots)).toBe('/p/.claude/worktrees/feat-x');
  expect(deepestRoot('/pp/a.ts', roots)).toBeNull();
});

test('who works in a working tree: sessions in their turn there, and sessions editing its files; idle ones and other trees never', () => {
  const roots = ['/p', '/p/.claude/worktrees/x'];
  const terminals = [
    term('t1', '/p/src', { state: 'running' }),
    term('t2', '/p', { state: 'idle' }),
    term('t3', '/p/.claude/worktrees/x', { state: 'running' }),
    term('t4', '/elsewhere', { state: 'running' }),
    term('t5', '/p', null)
  ];
  expect(workingIn('/p', roots, terminals, []).map((w) => w.terminalId)).toEqual(['t1']);
  expect(workingIn('/p/.claude/worktrees/x', roots, terminals, []).map((w) => w.terminalId)).toEqual(['t3']);
  // t4 runs elsewhere but is editing a file here: it works here too (once, even with several files).
  const attributions = [attr('/p/a.ts', 't4'), attr('/p/b.ts', 't4'), attr('/p/.claude/worktrees/x/c.ts', 't4')];
  expect(workingIn('/p', roots, terminals, attributions)).toEqual([
    { terminalId: 't1', title: 't1-title', color: '#fff' },
    { terminalId: 't4', title: 't4-title', color: '#c0ffee' }
  ]);
});

test("a new worktree's default folder: <repo>/.claude/worktrees/<branch slug>, never hidden, never empty", () => {
  expect(worktreeSlug('feat/x')).toBe('feat-x');
  expect(worktreeSlug('Fix/üñí code//two')).toBe('Fix-code-two');
  expect(worktreeSlug('.hidden')).toBe('hidden');
  expect(worktreeSlug('///')).toBe('worktree');
  expect(defaultWorktreePath('/p', 'feat/x')).toBe('/p/.claude/worktrees/feat-x');
});

test("a remote branch's local name drops its remote; a local branch keeps its name", () => {
  expect(localName(ref('refs/remotes/origin/feat/x'))).toBe('feat/x');
  expect(localName(ref('refs/heads/feat/x'))).toBe('feat/x');
});

test("a stash's file count: everything with new files, tracked ones without, only the staged ones with --staged", () => {
  const changes = [ch('a.ts', 'M', 'all'), ch('b.ts', 'M', 'partial'), ch('c.ts', 'M'), ch('n.ts', '?')];
  expect(stashFileCount(changes, { untracked: true, staged: false })).toBe(4);
  expect(stashFileCount(changes, { untracked: false, staged: false })).toBe(3);
  expect(stashFileCount(changes, { untracked: true, staged: true })).toBe(2);
});

test('a local branch: Switch, New Branch from Here…, Open in New Worktree…, Rename…, Delete Branch…', () => {
  const items = branchItems('/p', ref('refs/heads/feat/x'), { elsewhere: false, rename: () => {} });
  expect(ids(items)).toEqual(['git-switch', 'git-new-branch', 'git-worktree', 'git-rename', 'git-delete', '—']);
  expect(items.filter((i): i is Entry => i !== 'sep').map((i) => i.label)).toEqual(['Switch to feat/x', 'New Branch from Here…', 'Open in New Worktree…', 'Rename…', 'Delete Branch…']);
  expect(item(items, 'git-delete').danger).toBe(true);
});

test('the current branch: no Switch, no Delete; checked out in another worktree: no Rename, no Delete, a worktree only as a new branch; a remote branch tracks, a tag only branches', () => {
  expect(ids(branchItems('/p', ref('refs/heads/main', { current: true }), { elsewhere: false, rename: () => {} }))).toEqual(['git-new-branch', 'git-worktree', 'git-rename', '—']);
  expect(ids(branchItems('/p', ref('refs/heads/wt'), { elsewhere: true, rename: () => {} }))).toEqual(['git-switch', 'git-new-branch', 'git-worktree', '—']);
  const remote = branchItems('/p', ref('refs/remotes/origin/feat/y'), { elsewhere: false });
  expect(ids(remote)).toEqual(['git-switch', 'git-new-branch', 'git-worktree', '—']);
  expect(item(remote, 'git-switch').label).toBe('Switch to feat/y');
  expect(ids(branchItems('/p', ref('refs/tags/v1'), { elsewhere: false }))).toEqual(['git-new-branch', '—']);
});

test('the items open their sheets: New Branch from the ref, the worktree for the ref; Delete asks main first', async () => {
  const items = branchItems('/p', ref('refs/heads/feat/x'), { elsewhere: false });
  item(items, 'git-new-branch').run();
  expect(useApp.getState().gitSheet).toEqual({ kind: 'newBranch', root: '/p', from: 'refs/heads/feat/x' });
  item(items, 'git-worktree').run();
  expect(useApp.getState().gitSheet).toEqual({ kind: 'worktree', root: '/p', ref: 'refs/heads/feat/x' });
  item(items, 'git-delete').run();
  await tick();
  expect(calls).toEqual([['branchDelete', { root: '/p', ref: 'refs/heads/feat/x', force: false }]]);
});

test('Read-only: no branch or stash item', () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  expect(branchItems('/p', ref('refs/heads/feat/x'), { elsewhere: false })).toEqual([]);
  expect(stashItems('/p', { index: 0, oid: 'b'.repeat(40), message: 'On main: wip', at: 0 })).toEqual([]);
});

test('a stash: Apply, Pop, Drop, Copy Message, each on that exact stash (index and oid)', async () => {
  const s: ScmStash = { index: 2, oid: 'b'.repeat(40), message: 'On main: wip', at: 0 };
  const items = stashItems('/p', s);
  expect(ids(items)).toEqual(['git-stash-apply', 'git-stash-pop', 'git-stash-drop', '—', 'git-stash-copy']);
  expect(items.filter((i): i is Entry => i !== 'sep').map((i) => i.label)).toEqual(['Apply', 'Pop', 'Drop', 'Copy Message']);
  item(items, 'git-stash-apply').run();
  item(items, 'git-stash-pop').run();
  item(items, 'git-stash-drop').run();
  await tick();
  expect(calls).toEqual([
    ['stashApply', { root: '/p', index: 2, oid: s.oid, pop: false }],
    ['stashApply', { root: '/p', index: 2, oid: s.oid, pop: true }],
    ['stashDrop', { root: '/p', index: 2, oid: s.oid }]
  ]);
});

test('Switch: straight to main when nobody works there (main refuses a dirty tree); a session in its turn there opens the sheet', async () => {
  await startSwitch('/p', 'refs/heads/feat/x');
  expect(calls).toEqual([['switchTo', { root: '/p', ref: 'refs/heads/feat/x', carry: 'none' }]]);
  expect(useApp.getState().gitSheet).toBeNull();
  calls = [];
  useApp.setState({ terminals: [term('t1', '/p/src', { state: 'running' })] });
  await startSwitch('/p', 'refs/heads/feat/x');
  expect(calls).toEqual([]);
  expect(useApp.getState().gitSheet).toEqual({ kind: 'switch', root: '/p', ref: 'refs/heads/feat/x' });
  // An idle session there doesn't count.
  useApp.setState({ gitSheet: null, terminals: [term('t1', '/p/src', { state: 'idle' })] });
  await startSwitch('/p', 'refs/heads/feat/x');
  expect(calls).toEqual([['switchTo', { root: '/p', ref: 'refs/heads/feat/x', carry: 'none' }]]);
});

// What the actions say once main answered.

function answer(name: string, result: Record<string, unknown>) {
  (g.window as { atelier: { git: Record<string, unknown> } }).atelier.git[name] = async (...a: unknown[]) => { calls.push([name, ...a]); return result; };
}

test('switched: an info toast naming the branch (a remote one by its local name), the stash named when it stashed', async () => {
  await switchTo('/p', 'refs/remotes/origin/feat/x', 'none');
  expect(useApp.getState().toast).toMatchObject({ text: 'Switched to feat/x', tone: 'info' });
  answer('switchTo', { outcome: 'ok', stash: { oid: 'c'.repeat(40), message: 'On main: Atelier: changes on main' } });
  await switchTo('/p', 'refs/heads/feat/x', 'stash');
  expect(useApp.getState().toast?.text).toBe('Switched to feat/x. Your changes are stashed as “On main: Atelier: changes on main”');
});

test("bring my changes that clash: the sheet again with git's files, no toast; carry none on a dirty tree: the sheet", async () => {
  answer('switchTo', { outcome: 'conflict', dirty: true, files: ['src/a.ts', 'src/b.ts'], message: 'would be overwritten' });
  await switchTo('/p', 'refs/heads/feat/x', 'bring');
  expect(useApp.getState().gitSheet).toEqual({ kind: 'switch', root: '/p', ref: 'refs/heads/feat/x', clash: ['src/a.ts', 'src/b.ts'] });
  expect(useApp.getState().toast).toBeNull();
  await switchTo('/p', 'refs/heads/feat/x', 'none');
  expect(useApp.getState().gitSheet).toEqual({ kind: 'switch', root: '/p', ref: 'refs/heads/feat/x' });
});

test('a new branch: created (and switched) says so', async () => {
  answer('branchCreate', { outcome: 'ok' });
  await branchCreate({ root: '/p', name: 'feat/y', switch: true });
  expect(useApp.getState().toast).toMatchObject({ text: 'Switched to new branch feat/y', tone: 'info' });
  await branchCreate({ root: '/p', name: 'feat/z', switch: false });
  expect(useApp.getState().toast?.text).toBe('Created feat/z');
});

test('a new worktree: the toast names its folder in the project and offers New Claude Session Here in it', async () => {
  answer('worktreeAdd', { outcome: 'ok' });
  await worktreeAdd({ root: '/p', path: '/p/.claude/worktrees/feat-x', ref: 'refs/heads/feat/x' });
  const toast = useApp.getState().toast!;
  expect(toast).toMatchObject({ text: 'Worktree ready at .claude/worktrees/feat-x', tone: 'info' });
  expect(toast.action?.label).toBe('New Claude Session Here');
  toast.action!.run();
  expect(useApp.getState().folderSheet).toEqual({ kind: 'session', cwd: '/p/.claude/worktrees/feat-x' });
});

test('a stash applied or popped says which', async () => {
  answer('stashApply', { outcome: 'ok' });
  await stashApply({ root: '/p', index: 0, oid: 'b'.repeat(40), pop: true, message: 'On main: wip' });
  expect(useApp.getState().toast).toMatchObject({ text: 'Popped “On main: wip”', tone: 'info' });
});

test('Switch in Read-only does nothing', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  await startSwitch('/p', 'refs/heads/feat/x');
  expect(calls).toEqual([]);
  expect(useApp.getState().gitSheet).toBeNull();
});

test("a branch row's click: History at once where a double-click does nothing else; where it switches, History only once no second click follows", () => {
  vi.useFakeTimers();
  try {
    let shown = 0;
    let delay = true;
    const click = rowClicks({ single: () => { shown++; }, delay: () => delay });
    // A double-click (switch): its first click waits, its second cancels it, no History.
    click(1); click(2);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(shown).toBe(0);
    // One click: History, once the double-click time has passed.
    click(1);
    expect(shown).toBe(0);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(shown).toBe(1);
    // The current branch, a tag, Read-only: nothing to switch, History at once.
    delay = false;
    click(1);
    expect(shown).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

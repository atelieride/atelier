import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { goToAttention } from './attention-nav';
import { SIDEBAR_HIDDEN_KEY, readSidebarHidden } from './sidebar-hidden';

// Hiding the sidebar: the view in front clicked again hides it; ⌘B
// toggles it; opening a view shows it, a jump to a session leaves it hidden.

const g = globalThis as { window?: unknown; localStorage?: unknown };
const saved = new Map<string, string>();
let had: unknown;
let hadStorage: unknown;
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = { addEventListener: () => {}, atelier: {} };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

const project = { root: '/p', realRoot: '/p', name: 'p' } as unknown as ReturnType<typeof useApp.getState>['project'];
const waiting = (id: string): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 0,
  session: { sessionId: id, state: 'waiting', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 }
});

beforeEach(() => {
  saved.clear();
  useApp.setState(useApp.getInitialState(), true);
  useApp.setState({ project, activity: 'sessions', sidebarHidden: false, activeTab: 'term', openFiles: [], treeReveal: null });
});

const st = () => useApp.getState();

test('the view in front clicked again hides the sidebar and keeps its view; clicked once more, it shows it again', () => {
  useApp.setState({ activity: 'files' });
  st().clickActivity('files');
  expect(st()).toMatchObject({ activity: 'files', sidebarHidden: true });
  st().clickActivity('files');
  expect(st()).toMatchObject({ activity: 'files', sidebarHidden: false });
});

test('while hidden, any item shows the sidebar on its own view; shown, another item only switches the view', () => {
  st().clickActivity('sessions');
  expect(st().sidebarHidden).toBe(true);
  st().clickActivity('scm');
  expect(st()).toMatchObject({ activity: 'scm', sidebarHidden: false });
  st().clickActivity('sessions');
  expect(st()).toMatchObject({ activity: 'sessions', sidebarHidden: false });
});

test('View › Sidebar (⌘B) hides and shows it on the view it had, and the choice is remembered for the next window', () => {
  useApp.setState({ activity: 'scm' });
  st().toggleSidebar();
  expect(st()).toMatchObject({ activity: 'scm', sidebarHidden: true });
  expect(saved.get(SIDEBAR_HIDDEN_KEY)).toBe('1');
  expect(readSidebarHidden()).toBe(true);
  st().toggleSidebar();
  expect(st()).toMatchObject({ activity: 'scm', sidebarHidden: false });
  expect(readSidebarHidden()).toBe(false);
  // The activity bar's click is remembered the same way.
  st().clickActivity('scm');
  expect(readSidebarHidden()).toBe(true);
});

test('nothing saved, or no storage at all: the sidebar shows', () => {
  expect(readSidebarHidden()).toBe(false);
  const was = g.localStorage;
  g.localStorage = undefined;
  try { expect(readSidebarHidden()).toBe(false); } finally { g.localStorage = was; }
});

test('a pop-out has no sidebar: the key changes nothing there', () => {
  useApp.setState({ popout: { key: 't:a' } as unknown as ReturnType<typeof useApp.getState>['popout'] });
  st().toggleSidebar();
  expect(st().sidebarHidden).toBe(false);
  expect(saved.has(SIDEBAR_HIDDEN_KEY)).toBe(false);
});

test('opening a view shows the sidebar: the view keys, Reveal in Files, a new file in the tree, Dismiss All, the branch switcher', () => {
  const opens: [string, () => void][] = [
    ['view key', () => st().setActivity('files')],
    ['collapse folders', () => st().setActivity('files', { reveal: false })],
    ['reveal in Files', () => st().revealInTree('/p/a.ts')],
    ['new file in the tree', () => st().startTreeEdit({ mode: 'new-file', dir: '/p' })],
    ['dismiss all', () => st().askDismissAll()],
    ['branch switcher', () => st().setScmSwitcherOpen(true)],
    ['rename in the row', () => st().setRenaming({ id: 'gone', at: 'tab' })]
  ];
  for (const [what, open] of opens) {
    useApp.setState({ sidebarHidden: true, activity: 'sessions' });
    open();
    expect(st().sidebarHidden, what).toBe(false);
  }
});

test('while hidden, another space\'s item brings that space forward with its sidebar shown', () => {
  st().clickActivity('sessions');
  st().clickActivity('automations');
  expect(st()).toMatchObject({ space: 'automations', activity: 'automations', sidebarHidden: false });
  st().clickActivity('automations');
  expect(st()).toMatchObject({ space: 'automations', sidebarHidden: true });
  st().clickActivity('sessions');
  expect(st()).toMatchObject({ space: 'sessions', activity: 'sessions', sidebarHidden: false });
});

test('Files shown again, by ⌘B or its item, shows the project file in front there, as entering Files does', () => {
  useApp.setState({ activity: 'files', activeTab: '/p/src/a.ts', treeReveal: null });
  st().toggleSidebar();
  expect(st().treeReveal).toBeNull();
  st().toggleSidebar();
  expect(st().treeReveal).toMatchObject({ path: '/p/src/a.ts', quiet: true });
  useApp.setState({ treeReveal: null });
  st().clickActivity('files');
  st().clickActivity('files');
  expect(st().treeReveal).toMatchObject({ path: '/p/src/a.ts', quiet: true });
});

test('hiding puts away what only the sidebar draws; a question or a rename shown elsewhere stays', () => {
  const pending = { restartAsk: { id: 'a', at: 'row' as const }, dismissAllAsk: true, renaming: { id: 'a', at: 'row' as const }, treeEdit: { mode: 'new-file' as const, dir: '/p' }, wsRenaming: 'w1', scmSwitcherOpen: true };
  useApp.setState(pending);
  st().toggleSidebar();
  expect(st()).toMatchObject({ sidebarHidden: true, restartAsk: null, dismissAllAsk: false, renaming: null, treeEdit: null, wsRenaming: null, scmSwitcherOpen: false });
  useApp.setState({ sidebarHidden: false, ...pending });
  st().clickActivity('sessions');
  expect(st()).toMatchObject({ sidebarHidden: true, restartAsk: null, dismissAllAsk: false, renaming: null, treeEdit: null, wsRenaming: null, scmSwitcherOpen: false });
  // The session panel's question and a rename in a tab or the session bar are not the sidebar's.
  useApp.setState({ sidebarHidden: false, restartAsk: { id: 'a', at: 'panel' }, renaming: { id: 'a', at: 'tab' } });
  st().toggleSidebar();
  expect(st()).toMatchObject({ restartAsk: { id: 'a', at: 'panel' }, renaming: { id: 'a', at: 'tab' } });
});

test('a jump to a session keeps the sidebar hidden (⌘J): Sessions comes forward, the session is selected', () => {
  useApp.setState({ sidebarHidden: true, activity: 'files', terminals: [waiting('a')], tabOrder: ['t:a'], selectedId: null });
  goToAttention();
  expect(st()).toMatchObject({ activity: 'sessions', selectedId: 'a', sidebarHidden: true });
  st().setActivity('scm', { keepHidden: true });
  expect(st()).toMatchObject({ activity: 'scm', sidebarHidden: true });
});

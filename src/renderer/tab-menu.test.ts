import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sessionRowMenu, tabMenu } from './menus';
import type { MenuItem } from './menu-model';
import { useApp } from './store';
import { single } from './split';
import type { TerminalInfo } from '@shared/protocol';
import { initPlatform, resetPlatformForTests } from '@shared/platform';

const term = (id: string, claude: boolean): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 0,
  session: claude ? { sessionId: id, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } : null
});
const item = (items: MenuItem[], id: string) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id);
const close = vi.fn(async () => {});
const g = globalThis as { window?: unknown; document?: unknown };

beforeEach(() => {
  g.window = { atelier: { terminals: { close } } };
  close.mockClear();
  useApp.setState({ project: null, terminals: [term('s', true), term('t', false)], tabOrder: ['t:s', 't:t'], selectedId: 's', activeTab: 'term', hidden: [], openFiles: [], closing: {} });
});
afterEach(() => { delete g.window; delete g.document; });

test('a terminal tab menu: "Close Tab" (⌘W) only hides the tab; "Close Session…" asks under the tab, an idle shell closes at once', () => {
  const items = tabMenu('t:s');
  const hide = item(items, 'close');
  expect(hide?.label).toBe('Close Tab');
  expect(hide?.hint).toBe('⌘W');
  hide?.run();
  expect(close).not.toHaveBeenCalled();
  expect(useApp.getState().tabOrder).toEqual(['t:t']);
  expect(useApp.getState().terminals).toHaveLength(2);

  const real = item(items, 'close-terminal');
  expect(real?.label).toBe('Close Session…');
  expect(real?.danger).toBe(true);
  real?.run();
  // A Claude session stops: asked under its tab, closed only on Close.
  expect(close).not.toHaveBeenCalled();
  expect(useApp.getState().closeAsk).toEqual({ id: 's', at: 'tab', stops: { kind: 'claude', doing: 'idle' }, note: 'history' });
  useApp.getState().confirmClose();
  expect(close).toHaveBeenCalledWith('s');
  const shell = item(tabMenu('t:t'), 'close-terminal');
  expect(shell?.label).toBe('Close Terminal…');
  shell?.run();
  expect(close).toHaveBeenCalledWith('t');
  expect(useApp.getState().closeAsk).toBeNull();
});

// Tab pop-out windows: Move to New Window from the tab and the row; a popped-out row's menu
// brings its window forward or moves it back.
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '-' : i.id));
// Nothing measurable on screen here: the default pop-out size.
const noLayout = () => { g.document = { querySelector: () => null }; };

test('a tab menu: "Move to New Window" (⌘⇧O) first when no pane move applies, popping the tab out as big as it is shown', () => {
  const popOut = vi.fn(async () => {});
  noLayout();
  useApp.setState({ popOut, split: single(), tabOrder: [] });
  for (const k of ['t:s', 't:t'] as const) {
    const menu = tabMenu(k);
    expect(ids(menu)[0]).toBe('move-window');
    expect(item(menu, 'move-window')).toMatchObject({ label: 'Move to New Window', icon: 'window', hint: '⌘⇧O' });
  }
  useApp.setState({ openFiles: [{ path: '/p/a.ts', rel: 'a.ts', line: null, nonce: 1, mode: 'margin' }], tabOrder: ['t:s', 'f:/p/a.ts'] });
  item(tabMenu('f:/p/a.ts'), 'move-window')!.run();
  expect(popOut).toHaveBeenCalledWith('f:/p/a.ts', 'cascade', { width: 900, height: 620 });
});

test('a session or terminal row: "Move to New Window" after Open to the Side', () => {
  const popOut = vi.fn(async () => {});
  noLayout();
  useApp.setState({ popOut, poppedOut: [] });
  const row = sessionRowMenu(term('s', true));
  expect(ids(row).slice(0, 2)).toEqual(['open-to-side', 'move-window']);
  expect(item(row, 'show-window')).toBeUndefined();
  expect(item(row, 'move-back')).toBeUndefined();
  item(row, 'move-window')!.run();
  expect(popOut).toHaveBeenCalledWith('t:s', 'cascade', { width: 900, height: 620 });
  expect(ids(sessionRowMenu(term('t', false))).slice(0, 2)).toEqual(['open-to-side', 'move-window']);
});

test('a popped-out row: "Show Window" and "Move Back to Main Window" first, no Open to the Side or Move to New Window', () => {
  const focus = vi.fn(async () => {});
  const recall = vi.fn(async () => {});
  g.window = { atelier: { terminals: { close }, popout: { focus, recall } } };
  useApp.setState({ poppedOut: ['t:s', 't:t'] });
  try {
    for (const x of [term('s', true), term('t', false)]) {
      const row = sessionRowMenu(x);
      expect(ids(row).slice(0, 3)).toEqual(['show-window', 'move-back', '-']);
      expect(item(row, 'show-window')).toMatchObject({ label: 'Show Window', icon: 'window' });
      expect(item(row, 'move-back')).toMatchObject({ label: 'Move Back to Main Window', icon: 'dock' });
      expect(item(row, 'open-to-side')).toBeUndefined();
      expect(item(row, 'move-window')).toBeUndefined();
      // The usual entries follow.
      expect(item(row, 'rename')).toBeDefined();
      expect(item(row, 'close')).toBeDefined();
    }
    expect(item(sessionRowMenu(term('s', true)), 'show-background')).toBeDefined();
    item(sessionRowMenu(term('s', true)), 'show-window')!.run();
    expect(focus).toHaveBeenCalledWith('t:s');
    item(sessionRowMenu(term('t', false)), 'move-back')!.run();
    expect(recall).toHaveBeenCalledWith('t:t');
  } finally { useApp.setState({ poppedOut: [] }); }
});

test('a session row menu has "Show Background" (keyboard access to the inspector), a plain terminal row does not', () => {
  const show = item(sessionRowMenu(term('s', true)), 'show-background');
  expect(show?.label).toBe('Show Background');
  expect(item(sessionRowMenu(term('t', false)), 'show-background')).toBeUndefined();
  const open = vi.fn();
  useApp.setState({ openBackground: open });
  show?.run();
  expect(open).toHaveBeenCalledWith({ terminalId: 's' });
});

test('file tabs have no close-for-real entry; sidebar rows say Close Session… / Close Terminal…', () => {
  useApp.setState({ openFiles: [{ path: '/p/a.ts', rel: 'a.ts', line: null, nonce: 1, mode: 'margin' }], tabOrder: ['t:s', 'f:/p/a.ts'] });
  expect(item(tabMenu('f:/p/a.ts'), 'close')?.label).toBe('Close Tab');
  expect(item(tabMenu('f:/p/a.ts'), 'close-terminal')).toBeUndefined();
  expect(item(sessionRowMenu(term('s', true)), 'close')?.label).toBe('Close Session…');
  const row = item(sessionRowMenu(term('t', false)), 'close');
  expect(row?.label).toBe('Close Terminal…');
  row?.run();
  expect(close).toHaveBeenCalledWith('t');
});

test('a session started from a task: Open Task in ClickUp, Copy Task Link, Unlink Task — in its row and tab menus', () => {
  const openTask = vi.fn(async () => true);
  const write = vi.fn(async () => true);
  g.window = { atelier: { terminals: { close }, connectors: { openTask }, clipboard: { write } } };
  // No task: none of them.
  expect(item(sessionRowMenu(term('s', true)), 'task-open')).toBeUndefined();
  useApp.setState({ taskLinks: { s: { source: 'clickup', taskId: '86a', displayId: 'ENG-101', title: 'Fix it', url: 'https://app.clickup.com/9015/v/t/86a' } } });
  try {
    const row = sessionRowMenu(term('s', true));
    expect(['task-open', 'task-copy', 'task-unlink'].map((id) => item(row, id)?.label)).toEqual(['Open Task in ClickUp', 'Copy Task Link', 'Unlink Task']);
    expect(item(tabMenu('t:s'), 'task-open')).toBeDefined();
    // Opened by main from the source and id (never a URL from the renderer).
    item(row, 'task-open')!.run();
    expect(openTask).toHaveBeenCalledWith('clickup', '86a');
    // Copied through main's clipboard path (logged in tests, never the real clipboard).
    item(row, 'task-copy')!.run();
    expect(write).toHaveBeenCalledWith('https://app.clickup.com/9015/v/t/86a');
    item(row, 'task-unlink')!.run();
    expect(useApp.getState().taskLinks).toEqual({});
    expect(item(sessionRowMenu(term('s', true)), 'task-open')).toBeUndefined();
  } finally { useApp.setState({ taskLinks: {} }); }
});

test('Session Panel: in a session\'s row and tab menus, never a plain terminal\'s; it opens on that session', () => {
  vi.useFakeTimers();
  try {
    useApp.setState({ sessionPanel: null, selectedId: 't' });
    const entry = item(sessionRowMenu(term('s', true)), 'session-panel');
    expect(entry?.label).toBe('Session Panel');
    expect(item(tabMenu('t:s'), 'session-panel')?.label).toBe('Session Panel');
    expect(item(sessionRowMenu(term('t', false)), 'session-panel')).toBeUndefined();
    expect(item(tabMenu('t:t'), 'session-panel')).toBeUndefined();
    entry!.run();
    vi.runAllTimers();
    expect(useApp.getState().selectedId).toBe('s');
    expect(useApp.getState().sessionPanel).toBe('s');
  } finally { vi.useRealTimers(); useApp.setState({ sessionPanel: null }); }
});

test('Context Usage…: right after Restart Session in a session\'s row and tab menus, never a plain terminal\'s; it opens the sheet on that session', () => {
  vi.useFakeTimers();
  try {
    useApp.setState({ contextSheet: null, selectedId: 't' });
    for (const items of [sessionRowMenu(term('s', true)), tabMenu('t:s')]) {
      const ids = items.map((i) => (i === 'sep' ? '-' : i.id));
      expect(ids[ids.indexOf('restart-session') + 1]).toBe('context-usage');
      expect(item(items, 'context-usage')?.label).toBe('Context Usage…');
    }
    expect(item(sessionRowMenu(term('t', false)), 'context-usage')).toBeUndefined();
    expect(item(tabMenu('t:t'), 'context-usage')).toBeUndefined();
    item(sessionRowMenu(term('s', true)), 'context-usage')!.run();
    vi.runAllTimers();
    expect(useApp.getState().selectedId).toBe('s');
    expect(useApp.getState().contextSheet).toBe('s');
  } finally { vi.useRealTimers(); useApp.setState({ contextSheet: null }); }
});

test('Ask About This Session: right after Session Panel in a session\'s row and tab menus, ⌘I; never a plain terminal\'s or a popped-out tab\'s', () => {
  const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '-' : i.id));
  for (const items of [sessionRowMenu(term('s', true)), tabMenu('t:s')]) {
    const list = ids(items);
    expect(list[list.indexOf('session-panel') + 1]).toBe('ask-session');
    expect(item(items, 'ask-session')).toMatchObject({ label: 'Ask About This Session', icon: 'ask', hint: '⌘I' });
  }
  expect(item(sessionRowMenu(term('t', false)), 'ask-session')).toBeUndefined();
  expect(item(tabMenu('t:t'), 'ask-session')).toBeUndefined();
  try {
    useApp.setState({ poppedOut: ['t:s'] });
    expect(item(sessionRowMenu(term('s', true)), 'ask-session')).toBeUndefined();
  } finally { useApp.setState({ poppedOut: [] }); }
});

test('Windows: Ask About This Session is there too, right after Session Panel, on Ctrl+Shift+I', () => {
  const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '-' : i.id));
  try {
    initPlatform('win32');
    for (const items of [sessionRowMenu(term('s', true)), tabMenu('t:s')]) {
      const list = ids(items);
      expect(list[list.indexOf('session-panel') + 1]).toBe('ask-session');
      expect(item(items, 'ask-session')).toMatchObject({ label: 'Ask About This Session', icon: 'ask', hint: 'Ctrl+Shift+I' });
    }
  } finally { resetPlatformForTests(); }
});

test('Show History of <branch>: the branch of the working tree the session is in, hidden worktrees included', () => {
  const wt = '/p/.worktrees/sc';
  const st = (branch: string) => ({ branch, detached: false, oid: 'a'.repeat(40), ahead: 0, behind: 0, upstream: null, changes: 0 });
  useApp.setState({
    terminals: [{ ...term('w', true), cwd: `${wt}/src` }, term('r', true)],
    repos: [{ root: '/p', name: 'p', branch: 'main', detached: false, ahead: 0, behind: 0, oid: 'a'.repeat(40), changes: [], checkedAt: 0, truncated: 0 }],
    scmRepos: [{ root: '/p', rel: '', name: 'p', worktreeOf: null, nestedIn: null, common: '/p/.git', status: st('main') }, { root: wt, rel: '.worktrees/sc', name: 'sc', nestedIn: null, worktreeOf:'/p', common: '/p/.git', status: st('feat/source-control') }]
  });
  expect(item(sessionRowMenu(useApp.getState().terminals[0]!), 'show-branch-history')?.label).toBe('Show History of feat/source-control');
  expect(item(sessionRowMenu(useApp.getState().terminals[1]!), 'show-branch-history')?.label).toBe('Show History of main');
  item(sessionRowMenu(useApp.getState().terminals[0]!), 'show-branch-history')?.run();
  expect(useApp.getState().historyTab).toMatchObject({ repo: wt, scope: { kind: 'refs', refs: 'refs/heads/feat/source-control' } });
});

test('a terminal already closing: its Close entries in the tab and row menus are disabled, saying so', () => {
  useApp.setState({ closing: { s: true } });
  for (const items of [tabMenu('t:s'), sessionRowMenu(useApp.getState().terminals[0]!)]) {
    const real = items.find((i) => i !== 'sep' && i.label === 'Close Session…');
    expect(real && real !== 'sep' && [real.disabled, real.tip]).toEqual([true, 'Closing…']);
  }
  const shell = item(tabMenu('t:t'), 'close-terminal');
  expect(shell?.disabled).toBeFalsy();
});

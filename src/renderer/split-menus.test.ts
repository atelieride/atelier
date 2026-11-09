import { afterEach, beforeEach, expect, test } from 'vitest';
import { paneMenu, sessionRowMenu, tabMenu, treeMenu } from './menus';
import type { MenuItem } from './menu-model';
import { useApp } from './store';
import { single } from './split';
import type { TerminalInfo } from '@shared/protocol';
import { initPlatform, resetPlatformForTests } from '@shared/platform';

// Split view with tab groups in the context menus: a tab moves between panes from its
// menu; Open to the Side stays on rows and files; the pane's own menu.

const term = (id: string, createdAt: number): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt, session: null
});
type Entry = Exclude<MenuItem, 'sep'>;
const item = (items: MenuItem[], id: string) => items.find((i): i is Entry => i !== 'sep' && i.id === id);
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '-' : i.id));
const st = () => useApp.getState();
const tabs = () => st().split.panes.map((p) => p.tabs);
const g = globalThis as { window?: unknown };

beforeEach(() => {
  g.window = { atelier: { terminals: { close: async () => {} } } };
  useApp.setState({ project: null, terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], hidden: [], pins: [], openFiles: [], preview: null, pendingAnchor: null, split: single(), toast: null, dirty: {} });
  st().setTerminals([term('a', 1), term('b', 2)]);
});
afterEach(() => { delete g.window; resetPlatformForTests(); });

/** a, b, c; panes [a c | b], focus on b. */
function twoPanes() {
  st().setTerminals([term('a', 1), term('b', 2), term('c', 3)]);
  st().select('c');
  st().splitRight();
  st().select('b');
  expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
}

test('a tab in the first of two panes: Move to Right Pane (⌃⌘→) and Move to New Pane Right; no Open to the Side, no Unsplit', () => {
  twoPanes();
  const menu = tabMenu('t:a');
  expect(item(menu, 'move-left')).toBeUndefined();
  expect(item(menu, 'move-right')).toMatchObject({ label: 'Move to Right Pane', hint: '⌃⌘→' });
  expect(item(menu, 'move-new-right')).toMatchObject({ label: 'Move to New Pane Right' });
  expect(item(menu, 'move-new-right')!.hint).toBeUndefined();
  expect(item(menu, 'open-to-side')).toBeUndefined();
  expect(item(menu, 'unsplit')).toBeUndefined();
  item(menu, 'move-right')!.run();
  expect(tabs()).toEqual([['t:c'], ['t:b', 't:a']]);
});

test('a tab in the last pane: Move to Left Pane (⌃⌘←); Move to New Pane Right carries ⌃⌘→ — only with company', () => {
  twoPanes();
  st().openFile('/p/x.ts', 'x.ts');
  expect(tabs()).toEqual([['t:a', 't:c'], ['t:b', 'f:/p/x.ts']]);
  const menu = tabMenu('t:b');
  expect(item(menu, 'move-left')).toMatchObject({ label: 'Move to Left Pane', hint: '⌃⌘←' });
  expect(item(menu, 'move-right')).toBeUndefined();
  expect(item(menu, 'move-new-right')).toMatchObject({ label: 'Move to New Pane Right', hint: '⌃⌘→' });
  item(menu, 'move-new-right')!.run();
  expect(tabs()).toEqual([['t:a', 't:c'], ['f:/p/x.ts'], ['t:b']]);
  // Alone in its pane: nothing new to make.
  expect(item(tabMenu('t:b'), 'move-new-right')).toBeUndefined();
  // Three panes: no room.
  expect(item(tabMenu('t:a'), 'move-new-right')).toBeUndefined();
  item(tabMenu('t:b'), 'move-left')!.run();
  expect(tabs()).toEqual([['t:a', 't:c'], ['f:/p/x.ts', 't:b']]);
});

test('one pane: Move to New Pane Right (⌃⌘→) splits the tab out; alone, nothing', () => {
  const menu = tabMenu('t:a');
  expect(ids(menu)).not.toContain('move-left');
  expect(ids(menu)).not.toContain('move-right');
  expect(item(menu, 'move-new-right')).toMatchObject({ label: 'Move to New Pane Right', hint: '⌃⌘→' });
  item(menu, 'move-new-right')!.run();
  expect(tabs()).toEqual([['t:b'], ['t:a']]);
  st().setTerminals([term('a', 1)]);
  expect(item(tabMenu('t:a'), 'move-new-right')).toBeUndefined();
});

test('Windows: the moves show the Windows keys', () => {
  initPlatform('win32');
  twoPanes();
  expect(item(tabMenu('t:a'), 'move-right')!.hint).toBe('Ctrl+Alt+Shift+→');
});

test('a session or terminal row\'s menu: Open to the Side', () => {
  item(sessionRowMenu(st().terminals[0]!), 'open-to-side')!.run();
  expect(tabs()).toEqual([['t:b'], ['t:a']]);
});

test('the file tree: Open to the Side on files only', () => {
  expect(item(treeMenu({ path: '/p/src', rel: 'src', dir: true }, () => {}), 'open-to-side')).toBeUndefined();
  item(treeMenu({ path: '/p/x.md', rel: 'x.md', dir: false }, () => {}), 'open-to-side')!.run();
  expect(tabs()).toEqual([['t:a', 't:b'], ['f:/p/x.md']]);
});

test('a pane\'s menu (its strip): Split Right, Equal Widths, Unsplit, Unsplit All (a terminal in front adds Rename)', () => {
  twoPanes();
  const menu = paneMenu(0);
  expect(ids(menu)).toEqual(['rename', '-', 'split-right', 'equalize', '-', 'close-pane', 'close-other-panes']);
  expect(item(menu, 'close-pane')!.label).toBe('Unsplit');
  expect(item(menu, 'close-other-panes')!.label).toBe('Unsplit All');
  item(menu, 'close-pane')!.run();
  expect(st().split).toEqual(single());
  expect(st().tabOrder).toEqual(['t:a', 't:c', 't:b']);
});

test('a session pane\'s menu: Ask About This Session after Rename', () => {
  st().setTerminals([term('a', 1), { ...term('b', 2), session: { sessionId: 'sb', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } }]);
  st().openToSide('t:a');
  const pane = st().split.panes.findIndex((p) => p.front === 't:b');
  expect(ids(paneMenu(pane)).slice(0, 3)).toEqual(['rename', 'ask-session', '-']);
  expect(item(paneMenu(pane), 'ask-session')).toMatchObject({ label: 'Ask About This Session', icon: 'ask', hint: '⌘I' });
  expect(ids(paneMenu(1 - pane))).not.toContain('ask-session');
  // Rename: in its tab, right above (a pane's session bar has no name).
  item(paneMenu(pane), 'rename')!.run();
  expect(st().renaming).toEqual({ id: 'b', at: 'tab' });
});

test('Close Others / to the Right / Files / All in a split act on that tab\'s strip only', () => {
  twoPanes();
  st().openFile('/p/x.ts', 'x.ts');
  expect(tabs()).toEqual([['t:a', 't:c'], ['t:b', 'f:/p/x.ts']]);
  item(tabMenu('t:a'), 'close-right')!.run();
  expect(tabs()).toEqual([['t:a'], ['t:b', 'f:/p/x.ts']]);
  expect(item(tabMenu('t:a'), 'close-files')!.disabled).toBe(true);
  item(tabMenu('t:b'), 'close-others')!.run();
  expect(tabs()).toEqual([['t:a'], ['t:b']]);
});

test('Close All from a pane\'s tab closes that strip, and the emptied pane with it', () => {
  twoPanes();
  item(tabMenu('t:b'), 'close-all')!.run();
  expect(st().split).toEqual(single());
  expect(st().tabOrder).toEqual(['t:a', 't:c']);
});

test('at three panes Split Right is disabled and says why', () => {
  st().splitRight();
  st().splitRight();
  expect(st().split.panes).toHaveLength(3);
  const split = item(paneMenu(0), 'split-right')!;
  expect(split.disabled).toBe(true);
  expect(split.tip).toBe('Up to three panes side by side');
});

import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { single } from './split';
import type { MenuItem } from './menu-model';
import { sessionPlusMenu } from './menus';
import { askCloseWsActivity, moveToWorkspaceItems, newWsActivityHere, toggleWsActivities, workspaceMenu, wsActivityMenu } from './workspace-menus';
import type { WorkspacesState } from './workspaces';
import { ContextMenu } from './components/ContextMenu';

// Menus with activities: the "+" menus, the workspace's and the activity's menus, Move to ›.

const term = (id: string, createdAt: number): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt, session: null });
const WS = (): WorkspacesState => ({
  on: true, active: 'A',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:a'], active: 't:a', layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:b'], active: 't:b', layout: null },
    { id: 'a1', parent: 'A', name: 'SSO', color: 3, folder: null, order: ['t:o'], active: 't:o', layout: null },
    { id: 'a2', parent: 'A', name: 'Reset', color: 4, folder: null, order: [], active: null, layout: null }
  ],
  members: { a: 'A', b: 'B', o: 'a1' }, ownColors: true
});
const st = () => useApp.getState();
type Entry = Exclude<MenuItem, 'sep'>;
const item = (items: MenuItem[], id: string) => items.find((i): i is Entry => i !== 'sep' && i.id === id);
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '—' : i.id));
const noop = () => {};

beforeEach(() => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, terminals: [], tabOrder: [], selectedId: null, activeTab: 'term', hidden: [], split: single(), ws: WS(), wsRenaming: null, wsSheet: null, wsCloseAsk: null, wsActCloseAsk: null, menu: null, toast: null });
  useApp.setState({ settings: { ...st().settings, wsActivities: true } });
  st().setTerminals([term('a', 1), term('b', 2), term('o', 3)]);
});

test('the "+" menu: New Terminal and New Activity… only when given, after a separator for the activity', () => {
  expect(ids(sessionPlusMenu({ session: noop, folder: noop }))).toEqual(['new-session', 'session-in-folder']);
  expect(ids(sessionPlusMenu({ session: noop, folder: noop, terminal: noop }))).toEqual(['new-session', 'session-in-folder', 'new-terminal']);
  const all = sessionPlusMenu({ session: noop, folder: noop, terminal: noop, activity: { run: noop } });
  expect(ids(all)).toEqual(['new-session', 'session-in-folder', 'new-terminal', '—', 'new-ws-activity']);
  expect(item(all, 'new-terminal')!.hint).toContain('T');
  expect(item(all, 'new-terminal')!.label).toBe('New Terminal');
  expect(item(all, 'new-ws-activity')!.label).toBe('New Activity…');
  const full = item(sessionPlusMenu({ session: noop, folder: noop, terminal: noop, activity: { run: noop, disabled: 'full' } }), 'new-ws-activity')!;
  expect([full.disabled, full.tip]).toEqual([true, 'full']);
});

test('the workspace\'s menu gains New Activity… after New Terminal Here; Move Up/Down count workspaces', () => {
  const m = workspaceMenu('A');
  expect(ids(m)).toEqual(['ws-rename', 'ws-color', '—', 'ws-new-session', 'ws-new-terminal', 'ws-new-activity', '—', 'ws-up', 'ws-down', '—', 'ws-new', 'ws-close']);
  // A is first, B last: activities in the list don't count.
  expect(item(workspaceMenu('B'), 'ws-down')!.disabled).toBe(true);
  expect(item(workspaceMenu('B'), 'ws-close')!.disabled).toBe(false);
  item(m, 'ws-new-activity')!.run();
  expect(st().ws!.list.filter((w) => w.parent === 'A')).toHaveLength(3);
  expect(st().wsRenaming).toBe(st().ws!.active);
});

test('New Activity… is disabled at twenty, with why; the menu is today\'s with activities off', () => {
  for (let i = 0; i < 18; i++) st().newWsActivity('A');
  const full = item(workspaceMenu('A'), 'ws-new-activity')!;
  expect(full.disabled).toBe(true);
  expect(full.tip).toBe('Auth has 20 activities: close one first.');
  useApp.setState({ settings: { ...st().settings, wsActivities: false } });
  expect(item(workspaceMenu('B'), 'ws-new-activity')).toBeUndefined();
});

test('the activity\'s menu: new here, rename, Color ›, Move to Workspace ›, close', () => {
  const m = wsActivityMenu('a1');
  expect(ids(m)).toEqual(['wsa-new-session', 'wsa-new-terminal', '—', 'wsa-rename', 'wsa-color', 'wsa-move', '—', 'wsa-close']);
  const sub = item(m, 'wsa-move')!.submenu!;
  expect(sub.map((i) => i !== 'sep' && i.label)).toEqual(['Billing']);
  item(m, 'wsa-rename')!.run();
  expect(st().wsRenaming).toBe('a1');
  (sub[0] as Entry).run();
  expect(st().ws!.list.find((w) => w.id === 'a1')!.parent).toBe('B');
});

test('Color ›: the eight swatches, the activity\'s own checked; picking one recolors it alone', () => {
  const color = item(wsActivityMenu('a1'), 'wsa-color')!;
  expect(color.swatch).toBe('var(--ws-3)');
  const sub = color.submenu!;
  expect(sub.map((i) => i !== 'sep' && i.swatch)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((c) => `var(--ws-${c})`));
  expect(sub.filter((i) => i !== 'sep' && i.checked).map((i) => i !== 'sep' && i.id)).toEqual(['wsa-color:3']);
  (sub[6] as Entry).run();
  const colors = Object.fromEntries(st().ws!.list.map((w) => [w.id, w.color]));
  expect(colors).toEqual({ A: 1, B: 2, a1: 7, a2: 4 });
});

test('Close Activity…: an empty one closes at once; one with something in it asks', () => {
  askCloseWsActivity('a2');
  expect(st().ws!.list.some((w) => w.id === 'a2')).toBe(false);
  expect(st().wsActCloseAsk).toBeNull();
  askCloseWsActivity('a1');
  expect(st().wsActCloseAsk).toBe('a1');
  expect(st().ws!.list.some((w) => w.id === 'a1')).toBe(true);
});

test('Move to ›: every workspace and, indented, its activities; a check where it is; then New Activity… and New Workspace…', () => {
  const [m] = moveToWorkspaceItems('t:a');
  expect((m as Entry).label).toBe('Move to');
  const sub = (m as Entry).submenu!;
  expect(sub.map((i) => (i === 'sep' ? '—' : `${i.label}${i.indent ? ' (in)' : ''}${i.checked ? ' ✓' : ''}`))).toEqual([
    'Auth ✓', 'SSO (in)', 'Reset (in)', 'Billing', '—', 'New Activity…', 'New Workspace…'
  ]);
  expect((sub[1] as Entry).icon).toBe('wsActivity');
  expect((sub[3] as Entry).icon).toBe('workspace');
  // A row of an activity: the check is on it.
  const [r] = moveToWorkspaceItems('t:o');
  expect((r as Entry).submenu!.filter((i) => i !== 'sep' && i.checked).map((i) => i !== 'sep' && i.label)).toEqual(['SSO']);
  // New Activity… makes it in the row's workspace with the row inside.
  ((r as Entry).submenu!.find((i) => i !== 'sep' && i.id === 'move-ws-new-act') as Entry).run();
  const made = st().ws!.list.at(-1)!;
  expect(made).toMatchObject({ parent: 'A', name: 'New activity' });
  expect(st().ws!.members.o).toBe(made.id);
});

test('activities off: today\'s Move to Workspace ›', () => {
  useApp.setState({ settings: { ...st().settings, wsActivities: false }, ws: { ...WS(), list: WS().list.filter((w) => !w.parent), members: { a: 'A', b: 'B' } } });
  const [m] = moveToWorkspaceItems('t:a');
  expect((m as Entry).label).toBe('Move to Workspace');
});

test('File › New Activity… makes one in the workspace in front, from one of its activities too', () => {
  st().switchWorkspace('a1');
  newWsActivityHere();
  const made = st().ws!.list.at(-1)!;
  expect(made.parent).toBe('A');
  expect(st().ws!.active).toBe(made.id);
});

test('View › Activities Inside Workspaces switches the setting for every project', () => {
  const g = globalThis as { window?: unknown };
  const had = g.window;
  const patches: unknown[] = [];
  g.window = { atelier: { settings: { set: async (p: unknown) => { patches.push(p); } } } };
  try {
    toggleWsActivities();
    useApp.setState({ settings: { ...st().settings, wsActivities: false } });
    toggleWsActivities();
  } finally { g.window = had; }
  expect(patches).toEqual([{ wsActivities: false }, { wsActivities: true }]);
});

test('the context menu draws a color choice as its swatch, ringed and checked when worn', () => {
  useApp.setState({ menu: { x: 0, y: 0, items: [
    { id: 'c1', label: 'Violet', swatch: 'var(--ws-1)', checked: false, radio: true, run: noop },
    { id: 'c2', label: 'Teal', swatch: 'var(--ws-2)', checked: true, radio: true, run: noop }
  ] } });
  Object.assign(useApp.getInitialState(), useApp.getState());
  const out = renderToStaticMarkup(createElement(ContextMenu));
  const [violet, teal] = out.split('</button>');
  expect(violet).toMatch(/class="ctx-swatch" style="--sw:var\(--ws-1\)"/);
  expect(violet).not.toMatch(/ctx-check/);
  expect(teal).toMatch(/role="menuitemradio" aria-checked="true"/);
  expect(teal).toMatch(/class="ctx-swatch is-on" style="--sw:var\(--ws-2\)"/);
  expect(teal).toMatch(/class="ctx-check"/);
  useApp.setState({ menu: null });
});

test('the context menu draws an indented item indented', () => {
  useApp.setState({ menu: { x: 0, y: 0, items: [{ id: 'x', label: 'Top', run: noop }, { id: 'y', label: 'Inside', indent: true, run: noop }] } });
  Object.assign(useApp.getInitialState(), useApp.getState());
  const out = renderToStaticMarkup(createElement(ContextMenu));
  expect(out).toMatch(/class="ctx-item[^"]*is-indent[^"]*"[^>]*>(?:(?!<\/button>).)*Inside/s);
  expect(out).not.toMatch(/class="ctx-item[^"]*is-indent[^"]*"[^>]*>(?:(?!<\/button>).)*Top/s);
  useApp.setState({ menu: null });
});

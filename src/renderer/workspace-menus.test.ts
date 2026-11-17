import { createElement } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { single } from './split';
import type { MenuItem } from './menu-model';
import { askCloseWorkspace, closeWorkspaceInFront, moveToWorkspaceItems, workspaceMenu } from './workspace-menus';
import { Palette } from './components/Palette';
import { renderLive } from './databases/test-render';
import type { WorkspacesState } from './workspaces';

// The workspace's menu (right-click on its head or card) and Move to Workspace ›.

const term = (id: string, createdAt: number): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt, session: null });
const WS: WorkspacesState = {
  on: true, active: 'A',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:a'], active: 't:a', layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:b'], active: 't:b', layout: null },
    { id: 'C', name: 'Docs', color: 4, folder: null, order: [], active: null, layout: null }
  ],
  members: { a: 'A', b: 'B' }
};
const st = () => useApp.getState();
const item = (items: MenuItem[], id: string) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id);
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '—' : i.id));

beforeEach(() => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, terminals: [], tabOrder: [], selectedId: null, activeTab: 'term', hidden: [], split: single(), ws: WS, wsRenaming: null, wsSheet: null, wsCloseAsk: null, menu: null });
  st().setTerminals([term('a', 1), term('b', 2)]);
});

afterEach(() => useApp.setState({ paletteQuery: '' }));

test('the workspace menu: rename, color, new here, move up/down, new, close', () => {
  expect(ids(workspaceMenu('B'))).toEqual(['ws-rename', 'ws-color', '—', 'ws-new-session', 'ws-new-terminal', '—', 'ws-up', 'ws-down', '—', 'ws-new', 'ws-close']);
  expect(item(workspaceMenu('A'), 'ws-up')!.disabled).toBe(true);
  expect(item(workspaceMenu('C'), 'ws-down')!.disabled).toBe(true);
  expect(item(workspaceMenu('B'), 'ws-up')!.disabled).toBeFalsy();
});

test('Color lists the eight colors with their swatches, the workspace\'s checked; picking one recolors it', () => {
  const color = item(workspaceMenu('B'), 'ws-color')!;
  expect(color.swatch).toBe('var(--ws-2)');
  const sub = color.submenu!;
  expect(sub).toHaveLength(8);
  expect(sub.map((i) => i !== 'sep' && i.swatch)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((c) => `var(--ws-${c})`));
  expect(sub.every((i) => i !== 'sep' && i.radio)).toBe(true);
  expect(sub.filter((i) => i !== 'sep' && i.checked).map((i) => i !== 'sep' && i.id)).toEqual(['ws-color:2']);
  (sub[5] as Exclude<MenuItem, 'sep'>).run();
  expect(st().ws!.list[1]!.color).toBe(6);
});

test('Rename edits the name in place; Close asks; New Session Here brings the workspace forward first', () => {
  item(workspaceMenu('B'), 'ws-rename')!.run();
  expect(st().wsRenaming).toBe('B');
  item(workspaceMenu('B'), 'ws-close')!.run();
  expect(st().wsCloseAsk).toBe('B');
  item(workspaceMenu('B'), 'ws-new-session')!.run();
  expect(st().ws!.active).toBe('B');
  expect(st().newSessionOpen).toBe(true);
});

test('Close on an empty workspace closes it without asking', async () => {
  item(workspaceMenu('C'), 'ws-close')!.run();
  await Promise.resolve();
  expect(st().wsCloseAsk).toBeNull();
  expect(st().ws!.list.map((w) => w.id)).toEqual(['A', 'B']);
});

test('Close on the workspace in front with only file tabs opened since it came forward: it asks', async () => {
  st().switchWorkspace('C');
  st().openFile('/p/a.md', 'a.md');
  st().openFile('/p/b.md', 'b.md');
  item(workspaceMenu('C'), 'ws-close')!.run();
  await Promise.resolve();
  expect(st().wsCloseAsk).toBe('C');
  expect(st().ws!.list.map((w) => w.id)).toEqual(['A', 'B', 'C']);
});

test('the last workspace\'s Close is disabled and says why', () => {
  useApp.setState({ ws: { ...WS, list: [WS.list[0]!] } });
  const close = item(workspaceMenu('A'), 'ws-close')!;
  expect(close.disabled).toBe(true);
  expect(close.tip).toBeTruthy();
});

test('the last workspace asks nothing when told to close: there is nowhere for what it holds to go', async () => {
  useApp.setState({ ws: { ...WS, list: [WS.list[0]!], members: { a: 'A' } } });
  askCloseWorkspace('A');
  closeWorkspaceInFront();
  await Promise.resolve();
  expect(st().wsCloseAsk).toBeNull();
  expect(st().ws!.list.map((w) => w.id)).toEqual(['A']);
});

/** The palette's command labels as it opens on `>workspace`. */
const paletteWorkspaceCommands = () => {
  useApp.setState({ paletteQuery: '>workspace' });
  const html = renderLive(createElement(Palette, { onNewSession: () => {}, onNewTerminal: () => {} }));
  return [...html.matchAll(/<span class="palette-label[^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]!);
};

test('the palette offers Close Workspace… only while there is another workspace to close into', () => {
  expect(paletteWorkspaceCommands()).toContain('Close Workspace…');
  useApp.setState({ ws: { ...WS, list: [WS.list[0]!], members: { a: 'A' } } });
  expect(paletteWorkspaceCommands()).not.toContain('Close Workspace…');
  expect(paletteWorkspaceCommands()).toContain('Rename Workspace…');
});

test('Move to Workspace ›: the other workspaces, then New Workspace…; none for project views or with workspaces off', () => {
  const [move] = moveToWorkspaceItems('t:a') as Exclude<MenuItem, 'sep'>[];
  expect(move!.id).toBe('move-workspace');
  expect(ids(move!.submenu!)).toEqual(['move-ws:B', 'move-ws:C', '—', 'move-ws-new']);
  (move!.submenu![0] as Exclude<MenuItem, 'sep'>).run();
  expect(st().ws!.members.a).toBe('B');
  // Another space's tab or a project view: no workspace holds it.
  for (const key of ['dk:overview', 'rd:keys', 'au:all', 'db:c0123456789ab', 'review'] as const) expect(moveToWorkspaceItems(key)).toEqual([]);
  useApp.setState({ ws: { ...WS, on: false } });
  expect(moveToWorkspaceItems('t:a')).toEqual([]);
});

test('Move to Workspace › on a row of a workspace not in front lists every workspace but its own, the one in front too', () => {
  const [move] = moveToWorkspaceItems('t:b') as Exclude<MenuItem, 'sep'>[];
  expect(ids(move!.submenu!)).toEqual(['move-ws:A', 'move-ws:C', '—', 'move-ws-new']);
  (move!.submenu![0] as Exclude<MenuItem, 'sep'>).run();
  expect(st().ws!.members.b).toBe('A');
  expect(st().tabOrder).toContain('t:b');
});

test('Move to Workspace › New Workspace… opens the sheet for that tab', () => {
  const [move] = moveToWorkspaceItems('t:a') as Exclude<MenuItem, 'sep'>[];
  (move!.submenu!.at(-1) as Exclude<MenuItem, 'sep'>).run();
  expect(st().wsSheet).toEqual({ move: 't:a' });
});

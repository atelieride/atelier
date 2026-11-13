import { beforeEach, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from '../store';
import { single } from '../split';
import type { WorkspacesState } from '../workspaces';
import { workspaceSections } from './Palette';
import { wsActivityCommands } from '../workspace-menus';

// The palette with activities: "#" lists each workspace and, under it, its activities; two commands.

const term = (id: string): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 1, session: null });
const WS = (): WorkspacesState => ({
  on: true, active: 'A',
  list: [
    { id: 'A', name: 'Auth & sessions', color: 1, folder: null, order: ['t:a'], active: 't:a', layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:b'], active: 't:b', layout: null },
    { id: 'a1', parent: 'A', name: 'SSO with Okta', color: 1, folder: null, order: ['t:o'], active: 't:o', layout: null }
  ],
  members: { a: 'A', b: 'B', o: 'a1' }
});
const st = () => useApp.getState();

beforeEach(() => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, terminals: [], tabOrder: [], selectedId: null, activeTab: 'term', hidden: [], split: single(), ws: WS(), openFiles: [], revFiles: [], resumables: [], toast: null });
  useApp.setState({ settings: { ...st().settings, wsActivities: true } });
  st().setTerminals([term('a'), term('b'), term('o')]);
});

test('"#": each workspace, then its activities as "Workspace › Activity"; keys count workspaces only', () => {
  const [g] = workspaceSections('');
  expect(g!.items.map((i) => [i.label, i.hint ?? ''])).toEqual([
    ['Auth & sessions', expect.stringContaining('1')], ['Auth & sessions › SSO with Okta', ''], ['Billing', expect.stringContaining('2')]
  ]);
  expect(g!.items[1]!.ws).toMatchObject({ color: 1, activity: true });
});

test('Enter on an activity brings it forward; on a workspace, where it was left', () => {
  const [g] = workspaceSections('');
  g!.items[1]!.run();
  expect(st().ws!.active).toBe('a1');
  workspaceSections('')[0]!.items[2]!.run();
  expect(st().ws!.active).toBe('B');
  workspaceSections('')[0]!.items[0]!.run();
  expect(st().ws!.active).toBe('a1');
});

test('⌥Enter moves the tab in front into the activity', () => {
  const [g] = workspaceSections('');
  g!.items[1]!.side!();
  expect(st().ws!.members.a).toBe('a1');
});

test('a name only an activity has still offers New Workspace "name"', () => {
  const [g] = workspaceSections('SSO with Okta');
  expect(g!.items.some((i) => i.key === 'ws-new')).toBe(true);
});

test('activities off: the workspaces only, as today', () => {
  useApp.setState({ settings: { ...st().settings, wsActivities: false }, ws: { ...WS(), list: WS().list.filter((w) => !w.parent), members: { a: 'A', b: 'B' } } });
  expect(workspaceSections('')[0]!.items.map((i) => i.label)).toEqual(['Auth & sessions', 'Billing']);
});

test('commands: New Activity… while activities are on, the switch while workspaces are on', () => {
  expect(wsActivityCommands().map((c) => [c.key, c.label])).toEqual([['ws-new-act', 'New Activity…'], ['ws-acts-toggle', 'Activities Inside Workspaces']]);
  useApp.setState({ settings: { ...st().settings, wsActivities: false } });
  expect(wsActivityCommands().map((c) => c.key)).toEqual(['ws-acts-toggle']);
  useApp.setState({ ws: { ...WS(), on: false } });
  expect(wsActivityCommands()).toEqual([]);
});

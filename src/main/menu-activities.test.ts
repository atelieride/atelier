import { expect, test, vi } from 'vitest';
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';
import type { MenuState } from '@shared/api';

vi.mock('electron', () => ({ app: { name: 'Atelier', isPackaged: true }, Menu: { buildFromTemplate: vi.fn() } }));
const { menuTemplate } = await import('./menu');

// Activities inside workspaces in the application menu: File › New Activity… while they are on in a window whose
// workspaces are on; View › Activities Inside Workspaces, a checkbox, enabled while the front window's workspaces are on.

const WIN = { fake: 'window' } as unknown as BaseWindow;
const BASE: MenuState = { gitUndo: false, hasRepos: true, gitWrites: true, messages: true, project: true };
const WS = { names: ['Auth', 'Billing'], active: 0 };
const sent: string[] = [];
const actions = { openFolder() {}, newWindow() {}, restartDaemon() {}, checkForUpdates() {}, command: (c: string) => { sent.push(c); } };
const sub = (state: MenuState, label: string) => menuTemplate(actions, null, { appName: 'Atelier', isPackaged: true }, [], state).find((m) => m.label === label)!.submenu as MenuItemConstructorOptions[];
const find = (state: MenuState, menu: string, label: string) => sub(state, menu).find((i) => i.label === label)!;

test('File › New Activity…: after New Workspace…, no key; shown only with activities and workspaces on', () => {
  const file = sub({ ...BASE, workspaces: WS, wsActivities: true }, 'File').map((i) => i.label);
  expect(file.indexOf('New Activity…')).toBe(file.indexOf('New Workspace…') + 1);
  const on = find({ ...BASE, workspaces: WS, wsActivities: true }, 'File', 'New Activity…');
  expect(on.visible).not.toBe(false);
  expect(on.accelerator).toBeUndefined();
  (on.click as (...a: unknown[]) => void)({}, WIN, {});
  expect(sent.at(-1)).toBe('new-ws-activity');
  expect(find({ ...BASE, workspaces: WS }, 'File', 'New Activity…').visible).toBe(false);
  expect(find({ ...BASE, wsActivities: true }, 'File', 'New Activity…').visible).toBe(false);
});

test('View › Activities Inside Workspaces: after the workspaces toggle, a checkbox of the setting, enabled while workspaces are on', () => {
  const view = sub({ ...BASE, workspaces: WS }, 'View').map((i) => i.label);
  expect(view.indexOf('Activities Inside Workspaces')).toBe(view.indexOf('Toggle Workspaces for This Project') + 1);
  const item = find({ ...BASE, workspaces: WS, wsActivities: true }, 'View', 'Activities Inside Workspaces');
  expect(item).toMatchObject({ type: 'checkbox', checked: true, enabled: true });
  expect(item.accelerator).toBeUndefined();
  expect(find({ ...BASE, workspaces: WS }, 'View', 'Activities Inside Workspaces')).toMatchObject({ type: 'checkbox', checked: false, enabled: true });
  expect(find(BASE, 'View', 'Activities Inside Workspaces').enabled).toBe(false);
  const flipped = { checked: false };
  (item.click as (...a: unknown[]) => void)(flipped, WIN, {});
  expect(sent.at(-1)).toBe('toggle-ws-activities');
  expect(flipped.checked).toBe(true);
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sessionRowMenu } from './menus';
import type { MenuItem } from './menu-model';
import { useApp } from './store';
import type { TerminalInfo } from '@shared/protocol';
import type { Band } from './row-order';

// Move Up / Move Down in a sidebar row's menu: the keyboard way to the order a drag gives.

type Entry = Exclude<MenuItem, 'sep'>;
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '-' : i.id));
const item = (items: MenuItem[], id: string) => items.find((i): i is Entry => i !== 'sep' && i.id === id);
const term = (id: string): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 0, session: null });
const band: Band = { kind: 'terminals', pinned: false, ids: ['a', 'b', 'c'] };
const g = globalThis as { window?: unknown };

beforeEach(() => {
  g.window = { atelier: {} };
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, poppedOut: [], ws: null, terminals: ['a', 'b', 'c'].map(term) });
});
afterEach(() => { delete g.window; vi.restoreAllMocks(); });

test('only with a band; right after the Move to items, before the separator', () => {
  expect(ids(sessionRowMenu(term('b')))).not.toContain('row-up');
  const menu = ids(sessionRowMenu(term('b'), band));
  expect(menu.indexOf('row-down')).toBe(menu.indexOf('row-up') + 1);
  expect(menu.indexOf('row-up')).toBe(menu.indexOf('move-window') + 1);
  expect(menu[menu.indexOf('row-down') + 1]).toBe('-');
  expect(item(sessionRowMenu(term('b'), band), 'row-up')).toMatchObject({ label: 'Move Up', icon: 'arrowUp' });
  expect(item(sessionRowMenu(term('b'), band), 'row-down')).toMatchObject({ label: 'Move Down', icon: 'arrowDown' });
});

test('a row in a window of its own keeps Move Up / Move Down (it is still in the sidebar, and draggable)', () => {
  useApp.setState({ poppedOut: ['t:b'] });
  const menu = ids(sessionRowMenu(term('b'), band));
  expect(menu).toContain('move-back');
  expect(menu.indexOf('row-up')).toBe(menu.indexOf('move-back') + 1);
  expect(menu.indexOf('row-down')).toBe(menu.indexOf('row-up') + 1);
});

test('disabled at the band\'s ends; they step the row', () => {
  expect(item(sessionRowMenu(term('a'), band), 'row-up')?.disabled).toBe(true);
  expect(item(sessionRowMenu(term('a'), band), 'row-down')?.disabled).toBe(false);
  expect(item(sessionRowMenu(term('c'), band), 'row-down')?.disabled).toBe(true);
  const step = vi.spyOn(useApp.getState(), 'moveRowStep').mockImplementation(() => {});
  item(sessionRowMenu(term('b'), band), 'row-up')!.run();
  item(sessionRowMenu(term('b'), band), 'row-down')!.run();
  expect(step.mock.calls).toEqual([[band, 'b', -1], [band, 'b', 1]]);
});

import { afterEach, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { currentProjectColor, projectColorItems, recentProjectMenu } from './project-color-menu';
import { useApp } from './store';
import type { MenuItem } from './menu-model';

const root = '/work/p3';
const at = (projectColors: Settings['projectColors']) =>
  useApp.setState({ project: { root, name: 'p3', realRoot: root }, settings: { ...DEFAULT_SETTINGS, projectColors }, settingsLoaded: true });
const g = globalThis as { window?: unknown };
const sent: unknown[] = [];
const stubSettings = () => { g.window = { atelier: { settings: { set: (p: unknown) => { sent.push(p); return Promise.resolve(null); } } } }; };
const item = (items: MenuItem[], id: string) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id)!;

afterEach(() => {
  delete g.window;
  sent.length = 0;
  useApp.setState({ project: null, settings: DEFAULT_SETTINGS, settingsLoaded: false });
});

test("choosing a color sends only that project's color (and the tint on), never the window's copy of the others", () => {
  stubSettings();
  // The window's copy holds other projects; main may have saved more since. Only the chosen root goes.
  at({ '/work/alpha': 1, '/work/beta': 2 });
  item(projectColorItems(), 'project-color:5').run();
  // A recent project in the welcome window, chosen from its row's menu.
  item(item(recentProjectMenu('/work/gamma'), 'project-color').submenu!, 'project-color:7').run();
  expect(sent).toEqual([{ projectTint: true, projectColors: { [root]: 5 } }, { projectTint: true, projectColors: { '/work/gamma': 7 } }]);
});

test("the window's project color with none saved is its folder's steady one, whatever the other projects have", () => {
  at({});
  const steady = currentProjectColor();
  for (const c of [1, 2, 3, 4, 5, 6, 7, 8]) {
    at({ '/work/alpha': c, '/work/beta': c });
    expect(currentProjectColor(), `beside ${c}`).toBe(steady);
  }
  at({ [root]: 4 });
  expect(currentProjectColor()).toBe(4);
  useApp.setState({ project: null });
  expect(currentProjectColor()).toBeNull();
});

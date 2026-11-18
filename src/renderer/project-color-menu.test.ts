import { afterEach, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { currentProjectColor } from './project-color-menu';
import { useApp } from './store';

const root = '/work/p3';
const at = (projectColors: Settings['projectColors']) =>
  useApp.setState({ project: { root, name: 'p3', realRoot: root }, settings: { ...DEFAULT_SETTINGS, projectColors }, settingsLoaded: true });

afterEach(() => useApp.setState({ project: null, settings: DEFAULT_SETTINGS, settingsLoaded: false }));

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

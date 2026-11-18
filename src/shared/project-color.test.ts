import { expect, test } from 'vitest';
import { normalizeProjectColors, pickProjectColor, PROJECT_COLOR_COUNT, PROJECT_COLORS_MAX, projectColorOf, withProjectColor } from './project-color';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';

// A project's color: one of the eight workspace hues, kept by project root, worn by the project's window so several
// windows side by side tell apart at a glance.

test('a project keeps the color it has', () => {
  expect(pickProjectColor({ '/work/alpha': 5 }, ['/work/beta'], '/work/alpha')).toBe(5);
});

test('a new project takes a color no open window wears', () => {
  const colors = { '/work/a': 1, '/work/b': 2, '/work/c': 3 };
  const got = pickProjectColor(colors, ['/work/a', '/work/b', '/work/c'], '/work/new');
  expect([4, 5, 6, 7, 8]).toContain(got);
});

test('eight projects opened one after the other wear eight different colors', () => {
  let colors: Record<string, number> = {};
  const open: string[] = [];
  for (let i = 0; i < PROJECT_COLOR_COUNT; i++) {
    const root = `/work/p${i}`;
    colors = withProjectColor(colors, root, pickProjectColor(colors, open, root));
    open.push(root);
  }
  expect(new Set(Object.values(colors)).size).toBe(PROJECT_COLOR_COUNT);
});

test('what the open windows wear counts before what the closed projects have', () => {
  // The only open window wears 5; the closed projects hold every other color twice, so 5 is the rarest overall. A
  // new window still takes another color: telling apart the windows on screen is what the color is for.
  const colors: Record<string, number> = { '/x': 5 };
  for (const c of [1, 2, 3, 4, 6, 7, 8]) { colors[`/closed/${c}a`] = c; colors[`/closed/${c}b`] = c; }
  for (const root of ['/new', '/work/beta', '/work/gamma']) expect(pickProjectColor(colors, ['/x'], root)).not.toBe(5);
});

test('among the colors free in the open windows, the one fewest known projects have comes first', () => {
  // Nothing open wears 2…8; closed projects already have 2…7: 8 is the rarest.
  const colors = { '/o': 1, '/a': 2, '/b': 3, '/c': 4, '/d': 5, '/e': 6, '/f': 7 };
  expect(pickProjectColor(colors, ['/o'], '/new')).toBe(8);
});

test('with nothing to tell colors apart, a folder always gets the same one', () => {
  const a = pickProjectColor({}, [], '/work/alpha');
  expect(pickProjectColor({}, [], '/work/alpha')).toBe(a);
  expect(a).toBeGreaterThanOrEqual(1);
  expect(a).toBeLessThanOrEqual(PROJECT_COLOR_COUNT);
});

test('the saved colors keep absolute folders with a color from 1 to 8, nothing else', () => {
  expect(normalizeProjectColors({ '/work/a': 3, 'relative': 2, '/work/b': 9, '/work/c': 0, '/work/d': 1.5, '/work/e': '2' })).toEqual({ '/work/a': 3 });
  for (const bad of [null, undefined, 3, 'x', [1, 2]]) expect(normalizeProjectColors(bad)).toEqual({});
});

test('past the limit, the projects colored longest ago are forgotten', () => {
  let colors: Record<string, number> = {};
  for (let i = 0; i < PROJECT_COLORS_MAX + 2; i++) colors = withProjectColor(colors, `/work/p${i}`, 1 + (i % 8));
  expect(Object.keys(colors).length).toBe(PROJECT_COLORS_MAX);
  expect(colors['/work/p0']).toBeUndefined();
  expect(colors[`/work/p${PROJECT_COLORS_MAX + 1}`]).toBeDefined();
});

test('recoloring a project keeps the others and makes it the latest', () => {
  const colors = withProjectColor({ '/a': 1, '/b': 2 }, '/a', 4);
  expect(colors).toEqual({ '/b': 2, '/a': 4 });
  expect(Object.keys(colors)).toEqual(['/b', '/a']);
});

test('a window wears its project\'s color; none with the tint off or without a project', () => {
  const s = { ...DEFAULT_SETTINGS, projectColors: { '/work/alpha': 6 } };
  expect(projectColorOf(s, '/work/alpha')).toBe(6);
  expect(projectColorOf({ ...s, projectTint: false }, '/work/alpha')).toBeNull();
  expect(projectColorOf(s, null)).toBeNull();
  // A project the app never colored (settings not saved yet) still gets its steady color.
  expect(projectColorOf(s, '/work/other')).toBe(pickProjectColor({}, [], '/work/other'));
});

test('settings: the tint is on by default and damaged colors are dropped', () => {
  expect(DEFAULT_SETTINGS.projectTint).toBe(true);
  expect(DEFAULT_SETTINGS.projectColors).toEqual({});
  expect(normalizeSettings({ projectColors: { '/work/a': 2, nope: 1 }, projectTint: false })).toMatchObject({ projectTint: false, projectColors: { '/work/a': 2 } });
});

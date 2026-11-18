import { expect, test } from 'vitest';
import { normalizeProjectColors, pickProjectColor, PROJECT_COLOR_COUNT, PROJECT_COLORS_MAX, projectColorOf, projectColorOnOpen, withProjectColor } from './project-color';
import { applyPatch, DEFAULT_SETTINGS, normalizeSettings } from './settings';

// A project's color: one of the eight workspace hues, kept by project root, worn by the project's window so several
// windows side by side can be told apart at a glance.

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

test('a window opening saves a color for a project that has none, and nothing for one that has it while there is room', () => {
  const colors = { '/work/a': 1, '/work/b': 2 };
  expect(projectColorOnOpen(colors, ['/work/a'], '/work/new')).toEqual({ '/work/new': pickProjectColor(colors, ['/work/a'], '/work/new') });
  expect(projectColorOnOpen(colors, [], '/work/a')).toBeNull();
});

test('with the colors full, a window opening saves its color again: the projects in use stay, the ones unopened longest go', () => {
  const full = Object.fromEntries(Array.from({ length: PROJECT_COLORS_MAX }, (_, i) => [`/work/p${i}`, 1 + (i % 8)]));
  // p0 was colored first but is opened now: its color is saved again, as the latest.
  expect(projectColorOnOpen(full, [], '/work/p0')).toEqual({ '/work/p0': 1 });
  // Already the latest: no write.
  expect(projectColorOnOpen(full, [], `/work/p${PROJECT_COLORS_MAX - 1}`)).toBeNull();
  // Opened over time, the projects in use outlive the ones not opened since: p0 and p5 stay, p1 and p2 go.
  let s = { ...DEFAULT_SETTINGS, projectColors: full };
  for (const root of ['/work/p0', '/work/p5', '/work/new1', '/work/new2']) {
    const save = projectColorOnOpen(s.projectColors, [], root);
    if (save) s = applyPatch(s, { projectColors: save });
  }
  const roots = Object.keys(s.projectColors);
  expect(roots).toHaveLength(PROJECT_COLORS_MAX);
  expect(roots.slice(-4)).toEqual(['/work/p0', '/work/p5', '/work/new1', '/work/new2']);
  expect(s.projectColors['/work/p0']).toBe(1);
  expect(s.projectColors['/work/p5']).toBe(6);
  expect(s.projectColors['/work/p1']).toBeUndefined();
  expect(s.projectColors['/work/p2']).toBeUndefined();
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
});

test('a project with no saved color wears its folder\'s steady color, whatever the other projects have', () => {
  const tint = { projectTint: true };
  for (const root of ['/work/p3', '/work/other', '/srv/app']) {
    const steady = projectColorOf({ ...tint, projectColors: {} }, root);
    expect(steady).toBeGreaterThanOrEqual(1);
    expect(steady).toBeLessThanOrEqual(PROJECT_COLOR_COUNT);
    for (const c of [1, 2, 3, 4, 5, 6, 7, 8]) expect(projectColorOf({ ...tint, projectColors: { '/work/alpha': c, '/work/beta': c } }, root), `${root} beside ${c}`).toBe(steady);
    // The same color main picks for it when nothing else tells the colors apart.
    expect(pickProjectColor({}, [], root)).toBe(steady);
  }
});

test('settings: the tint is on by default and damaged colors are dropped', () => {
  expect(DEFAULT_SETTINGS.projectTint).toBe(true);
  expect(DEFAULT_SETTINGS.projectColors).toEqual({});
  expect(normalizeSettings({ projectColors: { '/work/a': 2, nope: 1 }, projectTint: false })).toMatchObject({ projectTint: false, projectColors: { '/work/a': 2 } });
});

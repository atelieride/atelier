import { expect, test } from 'vitest';
import { CHANGES_PREFS_DEFAULTS, MAX_COLLAPSED, groupKey, parseChangesPrefs, toggleAllGroups, toggleGroup } from './changes-prefs';

test('group keys are namespaced by grouping, so a repo and a session never share a state', () => {
  expect(groupKey('repo', '/p/app')).toBe('repo:/p/app');
  expect(groupKey('session', 't1')).toBe('session:t1');
});

test('saved prefs: missing, broken or wrong values fall back to the defaults', () => {
  expect(CHANGES_PREFS_DEFAULTS).toEqual({ compact: false, collapsed: [], grouping: 'repo' });
  expect(parseChangesPrefs(null)).toEqual(CHANGES_PREFS_DEFAULTS);
  expect(parseChangesPrefs('broken')).toEqual(CHANGES_PREFS_DEFAULTS);
  expect(parseChangesPrefs('[1,2]')).toEqual(CHANGES_PREFS_DEFAULTS);
  expect(parseChangesPrefs(JSON.stringify({ compact: 'yes', collapsed: 'repo:/a' }))).toEqual(CHANGES_PREFS_DEFAULTS);
  expect(parseChangesPrefs(JSON.stringify({ compact: true, collapsed: ['repo:/a', 3, '', 'repo:/a', 'session:t1'] })))
    .toEqual({ compact: true, collapsed: ['repo:/a', 'session:t1'], grouping: 'repo' });
});

test('saved prefs: rows with their folder are the default, whatever was saved when compact rows were', () => {
  expect(parseChangesPrefs(JSON.stringify({ expanded: false, grouping: 'session' }))).toEqual({ compact: false, collapsed: [], grouping: 'session' });
});

test('saved prefs: the grouping (By repo / By session) is kept, anything else reads as By repo', () => {
  expect(parseChangesPrefs(JSON.stringify({ grouping: 'session' })).grouping).toBe('session');
  expect(parseChangesPrefs(JSON.stringify({ grouping: 'repo' })).grouping).toBe('repo');
  expect(parseChangesPrefs(JSON.stringify({ grouping: 'author' })).grouping).toBe('repo');
});

test('saved prefs: at most MAX_COLLAPSED keys, the most recent ones', () => {
  const many = Array.from({ length: MAX_COLLAPSED + 5 }, (_, i) => `session:t${i}`);
  const parsed = parseChangesPrefs(JSON.stringify({ compact: false, collapsed: many }));
  expect(parsed.collapsed).toHaveLength(MAX_COLLAPSED);
  expect(parsed.collapsed.at(-1)).toBe(`session:t${MAX_COLLAPSED + 4}`);
  expect(parsed.collapsed[0]).toBe('session:t5');
});

test('toggling a group collapses it, toggling again expands it; the list never grows past the cap', () => {
  expect(toggleGroup([], 'repo:/a')).toEqual(['repo:/a']);
  expect(toggleGroup(['repo:/a', 'repo:/b'], 'repo:/a')).toEqual(['repo:/b']);
  const full = Array.from({ length: MAX_COLLAPSED }, (_, i) => `session:t${i}`);
  const next = toggleGroup(full, 'repo:/new');
  expect(next).toHaveLength(MAX_COLLAPSED);
  expect(next.at(-1)).toBe('repo:/new');
  expect(next).not.toContain('session:t0');
});

test('⌥-click: every group of the grouping takes the opposite state of the clicked one, others are kept', () => {
  const keys = ['repo:/a', 'repo:/b', 'repo:/c'];
  // Clicked group open: collapse them all.
  expect(toggleAllGroups(['session:t1', 'repo:/b'], keys, 'repo:/a').sort()).toEqual(['repo:/a', 'repo:/b', 'repo:/c', 'session:t1']);
  // Clicked group collapsed: expand them all, the other grouping's keys stay.
  expect(toggleAllGroups(['session:t1', 'repo:/b', 'repo:/c'], keys, 'repo:/b')).toEqual(['session:t1']);
});

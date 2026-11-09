import { expect, test } from 'vitest';
import { MAX_PINNED_PROJECTS, parsePins, pinnedFirst, prunePins, relinkPin, togglePin, withProjectPins } from './pins';

const row = (id: string) => ({ id });

test('saved pins: missing, broken or wrong values give no pins', () => {
  expect(parsePins(null)).toEqual({});
  expect(parsePins('broken')).toEqual({});
  expect(parsePins('[1,2]')).toEqual({});
  expect(parsePins(JSON.stringify({ '/p': 'a', '/q': [1, '', 'b', 'b', 'c'] }))).toEqual({ '/q': ['b', 'c'] });
});

test('pinning appends to the pinned list, pinning again unpins', () => {
  expect(togglePin([], 'a')).toEqual(['a']);
  expect(togglePin(['a'], 'b')).toEqual(['a', 'b']);
  expect(togglePin(['a', 'b'], 'a')).toEqual(['b']);
});

test('pinned rows come first in pin order, the others keep their order', () => {
  const list = ['t1', 't2', 't3', 't4'].map(row);
  expect(pinnedFirst(list, ['t3', 't1']).map((x) => x.id)).toEqual(['t3', 't1', 't2', 't4']);
  expect(pinnedFirst(list, []).map((x) => x.id)).toEqual(['t1', 't2', 't3', 't4']);
  // Pins of the other list (sessions vs terminals) or of closed terminals are ignored.
  expect(pinnedFirst(list, ['zz', 't4']).map((x) => x.id)).toEqual(['t4', 't1', 't2', 't3']);
});

test('pins of terminals that no longer exist are dropped, but an empty list (not arrived yet) drops nothing', () => {
  expect(prunePins(['a', 'b', 'c'], ['c', 'a', 'x'])).toEqual(['a', 'c']);
  expect(prunePins(['a', 'b'], [])).toEqual(['a', 'b']);
});

test('pins are stored per project root; an empty list removes the project, and the oldest projects are forgotten past the cap', () => {
  expect(withProjectPins({ '/p': ['a'] }, '/q', ['b'])).toEqual({ '/p': ['a'], '/q': ['b'] });
  expect(withProjectPins({ '/p': ['a'], '/q': ['b'] }, '/p', [])).toEqual({ '/q': ['b'] });
  const many = Object.fromEntries(Array.from({ length: MAX_PINNED_PROJECTS }, (_, i) => [`/p${i}`, ['x']]));
  const next = withProjectPins(many, '/new', ['y']);
  expect(Object.keys(next)).toHaveLength(MAX_PINNED_PROJECTS);
  expect(next['/p0']).toBeUndefined();
  expect(next['/new']).toEqual(['y']);
  // Updating a project makes it the most recent one.
  expect(Object.keys(withProjectPins({ '/a': ['1'], '/b': ['2'] }, '/a', ['1', '3']))).toEqual(['/b', '/a']);
});

test('a resumed session keeps its place among the pins under its new id; an unpinned one changes nothing', () => {
  expect(relinkPin(['a', 'b', 'c'], 'b', 'z')).toEqual(['a', 'z', 'c']);
  const pins = ['a'];
  expect(relinkPin(pins, 'x', 'y')).toBe(pins);
});

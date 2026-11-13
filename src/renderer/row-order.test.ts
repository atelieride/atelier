import { expect, test } from 'vitest';
import { MAX_PINNED_PROJECTS } from './pins';
import {
  EMPTY_ORDER, arrangeUnpinned, bandAttr, bandWith, bandsOf, sameBand, sameOrder, landingAt, moveInBand, parseOrder, placeBand, pruneOrder, relinkOrder,
  stepBefore, unplace, withProjectOrder, type ManualOrder
} from './row-order';

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const rowsOf = (...xs: string[]) => xs.map((id) => ({ id }));

test('saved order: missing, broken or wrong values give no order', () => {
  expect(parseOrder(null)).toEqual({});
  expect(parseOrder('broken')).toEqual({});
  expect(parseOrder('[1]')).toEqual({});
  expect(parseOrder(JSON.stringify({ '/p': ['a'], '/q': { sessions: [1, '', 'b', 'b'], terminals: 'x' } })))
    .toEqual({ '/q': { sessions: ['b'], terminals: [] } });
  // A project with nothing valid in either list is no project.
  expect(parseOrder(JSON.stringify({ '/p': { sessions: [], terminals: [2] } }))).toEqual({});
});

test('order is stored per project; an empty one removes the project; the oldest go past the cap', () => {
  const one: ManualOrder = { sessions: ['a'], terminals: [] };
  expect(withProjectOrder({ '/p': one }, '/p', EMPTY_ORDER)).toEqual({});
  expect(withProjectOrder({ '/p': one }, '/q', { sessions: [], terminals: ['t'] })).toEqual({ '/p': one, '/q': { sessions: [], terminals: ['t'] } });
  const many = Object.fromEntries(Array.from({ length: MAX_PINNED_PROJECTS }, (_, i) => [`/p${i}`, one]));
  const next = withProjectOrder(many, '/new', one);
  expect(Object.keys(next)).toHaveLength(MAX_PINNED_PROJECTS);
  expect(next['/p0']).toBeUndefined();
  // Updating a project makes it the most recent one.
  expect(Object.keys(withProjectOrder({ '/a': one, '/b': one }, '/a', { sessions: ['a', 'b'], terminals: [] }))).toEqual(['/b', '/a']);
});

test('placed rows in manual order; unplaced keep their order, after (ungrouped) or before (Idle)', () => {
  const rows = rowsOf('a', 'b', 'c', 'd');
  expect(ids(arrangeUnpinned(rows, [], 'last'))).toEqual(['a', 'b', 'c', 'd']);
  expect(ids(arrangeUnpinned(rows, ['c', 'zz', 'a'], 'last'))).toEqual(['c', 'a', 'b', 'd']);
  expect(ids(arrangeUnpinned(rows, ['c', 'a'], 'first'))).toEqual(['b', 'd', 'c', 'a']);
});

test('a move inside a band: the new band order, or null where the row stays put', () => {
  expect(moveInBand(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  expect(moveInBand(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  expect(moveInBand(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
  expect(moveInBand(['a', 'b', 'c'], 'b', 'b')).toBeNull();
  expect(moveInBand(['a', 'b', 'c'], 'b', 'c')).toBeNull();
  expect(moveInBand(['a', 'b', 'c'], 'c', null)).toBeNull();
  // Not in the band, or a target outside it.
  expect(moveInBand(['a', 'b'], 'x', 'a')).toBeNull();
  expect(moveInBand(['a', 'b'], 'a', 'x')).toBeNull();
});

test('a band written into a list: its order, the others keep theirs, one block where its first placed id was', () => {
  expect(placeBand(['x', 'c', 'y', 'a', 'z'], ['a', 'n', 'c'])).toEqual(['x', 'a', 'n', 'c', 'y', 'z']);
  // None placed yet: at the end.
  expect(placeBand(['x'], ['a', 'b'])).toEqual(['x', 'a', 'b']);
  expect(placeBand([], ['a', 'b'])).toEqual(['a', 'b']);
});

test('Move Up / Move Down: the row to land before, null for the end, undefined at the band ends', () => {
  expect(stepBefore(['a', 'b', 'c'], 'b', -1)).toBe('a');
  expect(stepBefore(['a', 'b', 'c'], 'b', 1)).toBeNull();
  expect(stepBefore(['a', 'b', 'c'], 'a', 1)).toBe('c');
  expect(stepBefore(['a', 'b', 'c'], 'a', -1)).toBeUndefined();
  expect(stepBefore(['a', 'b', 'c'], 'c', 1)).toBeUndefined();
  expect(stepBefore(['a', 'b', 'c'], 'x', 1)).toBeUndefined();
});

test('resume relinks in both lists; prune drops the gone (an empty alive list drops nothing); a move un-places', () => {
  const o: ManualOrder = { sessions: ['a', 'b'], terminals: ['b'] };
  expect(relinkOrder(o, 'b', 'z')).toEqual({ sessions: ['a', 'z'], terminals: ['z'] });
  expect(relinkOrder(o, 'q', 'z')).toBe(o);
  expect(pruneOrder(o, ['a'])).toEqual({ sessions: ['a'], terminals: [] });
  expect(pruneOrder(o, [])).toBe(o);
  expect(pruneOrder(o, ['a', 'b'])).toBe(o);
  expect(unplace(o, 'b')).toEqual({ sessions: ['a'], terminals: [] });
  expect(unplace(o, 'q')).toBe(o);
});

test('bands: pinned and unpinned of a list, only with two rows or more', () => {
  const rows = rowsOf('p1', 'p2', 'a', 'b', 'c');
  expect(bandsOf('sessions', rows, ['p2', 'p1'])).toEqual([
    { kind: 'sessions', pinned: true, ids: ['p1', 'p2'] }, { kind: 'sessions', pinned: false, ids: ['a', 'b', 'c'] }
  ]);
  expect(bandsOf('terminals', rowsOf('p1', 'a'), ['p1'])).toEqual([]);
  expect(bandWith(bandsOf('sessions', rows, ['p1']), 'b')?.ids).toEqual(['p2', 'a', 'b', 'c']);
  expect(bandWith([], 'b')).toBeNull();
  expect(bandWith(bandsOf('sessions', rows, []), null)).toBeNull();
});

test('two orders are the same when both lists hold the same ids in the same order', () => {
  expect(sameOrder({ sessions: ['a', 'b'], terminals: ['t'] }, { sessions: ['a', 'b'], terminals: ['t'] })).toBe(true);
  expect(sameOrder({ sessions: ['a', 'b'], terminals: [] }, { sessions: ['b', 'a'], terminals: [] })).toBe(false);
  expect(sameOrder({ sessions: [], terminals: ['t'] }, { sessions: [], terminals: [] })).toBe(false);
});

test('a row re-renders when its band changes, and names it for the drop target', () => {
  const band = { kind: 'sessions' as const, pinned: false, ids: ['a', 'b'] };
  expect(sameBand(band, { ...band, ids: ['a', 'b'] })).toBe(true);
  expect(sameBand(band, { ...band, ids: ['b', 'a'] })).toBe(false);
  expect(sameBand(band, { ...band, pinned: true })).toBe(false);
  expect(sameBand(undefined, undefined)).toBe(true);
  expect(sameBand(band, undefined)).toBe(false);
  expect(bandAttr(band)).toEqual({ 'data-band': 'sessions:unpinned' });
  expect(bandAttr({ kind: 'terminals', pinned: true, ids: [] })).toEqual({ 'data-band': 'terminals:pinned' });
  expect(bandAttr(undefined)).toEqual({});
});

test('landing: before the first row whose middle is below the pointer, the end past the last, none outside', () => {
  const rows = [{ id: 'a', top: 0, height: 40 }, { id: 'b', top: 40, height: 40 }];
  expect(landingAt(rows, 10)).toEqual({ before: 'a' });
  expect(landingAt(rows, 30)).toEqual({ before: 'b' });
  expect(landingAt(rows, 70)).toEqual({ before: null });
  expect(landingAt(rows, -1)).toBeNull();
  expect(landingAt(rows, 80)).toBeNull();
  expect(landingAt([], 5)).toBeNull();
});

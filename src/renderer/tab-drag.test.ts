import { expect, test } from 'vitest';
import { edgeScroll, ghostColor, ghostIcon, insideViewport, releaseOf, sameSpot, sameTarget } from './tab-drag';
import type { DockTarget } from './store';

// Tab tear-off: what releasing a dragged tab does, from where the pointer is.

const VIEW = { width: 1200, height: 800 };

test('inside the viewport: its own pixels only (0 to width-1, 0 to height-1)', () => {
  expect(insideViewport({ x: 0, y: 0 }, VIEW)).toBe(true);
  expect(insideViewport({ x: 1199.5, y: 799 }, VIEW)).toBe(true);
  expect(insideViewport({ x: -1, y: 300 }, VIEW)).toBe(false);
  expect(insideViewport({ x: 1200, y: 300 }, VIEW)).toBe(false);
  expect(insideViewport({ x: 300, y: -0.5 }, VIEW)).toBe(false);
  expect(insideViewport({ x: 300, y: 800 }, VIEW)).toBe(false);
});

test('released outside the window: out (a pop-out where the ghost is); inside: the target under it, or nothing', () => {
  const strip: DockTarget = { kind: 'strip', pane: 0, before: 't:b' };
  expect(releaseOf({ x: -40, y: 300 }, VIEW, () => strip)).toEqual({ kind: 'out' });
  expect(releaseOf({ x: 400, y: 60 }, VIEW, () => strip)).toEqual({ kind: 'drop', target: strip });
  expect(releaseOf({ x: 100, y: 400 }, VIEW, () => null)).toEqual({ kind: 'none' });
});

test('a strip drop that leaves the tab where it is (before itself or before the next tab) is no move', () => {
  const order = ['t:a', 't:b', 't:c'] as const;
  expect(sameSpot([...order], 't:b', { kind: 'strip', pane: 0, before: 't:b' })).toBe(true);
  expect(sameSpot([...order], 't:b', { kind: 'strip', pane: 0, before: 't:c' })).toBe(true);
  expect(sameSpot([...order], 't:c', { kind: 'strip', pane: 0, before: null })).toBe(true);
  expect(sameSpot([...order], 't:b', { kind: 'strip', pane: 0, before: 't:a' })).toBe(false);
  expect(sameSpot([...order], 't:a', { kind: 'strip', pane: 0, before: null })).toBe(false);
  expect(sameSpot([...order], 't:a', { kind: 'pane', pane: 0, zone: 'right' })).toBe(false);
  // Split view: another pane's strip (the tab isn't in its order) always moves it.
  expect(sameSpot(['t:x', 't:y'], 't:b', { kind: 'strip', pane: 1, before: 't:x' })).toBe(false);
});

test('the ghost gets a session colour only when it is a plain hex colour', () => {
  expect(ghostColor('#B794F6')).toBe('#B794F6');
  expect(ghostColor('#fff')).toBe('#fff');
  expect(ghostColor('red; x: y')).toBeUndefined();
  expect(ghostColor(undefined)).toBeUndefined();
});

test('the ghost\'s glyph: a session\'s avatar, or its tile with avatars off (a starting one too); terminals, files, views', () => {
  expect(ghostIcon('t:a', { session: true, starting: false }, true)).toBe('session');
  expect(ghostIcon('t:a', { session: true, starting: false }, false)).toBe('session-tile');
  expect(ghostIcon('t:a', { session: false, starting: true }, false)).toBe('session-tile');
  expect(ghostIcon('t:a', { session: false, starting: false }, false)).toBe('terminal');
  expect(ghostIcon('f:/p/a.ts', undefined, false)).toBe('file');
  expect(ghostIcon('history', undefined, false)).toBe('view');
});

test('an overflowing strip scrolls with the pointer near its edges, while there is room that way', () => {
  const strip = { left: 300, right: 900 };
  expect(edgeScroll(310, strip, { left: 40, max: 400 })).toBe(-1);
  expect(edgeScroll(310, strip, { left: 0, max: 400 })).toBe(0);
  expect(edgeScroll(890, strip, { left: 40, max: 400 })).toBe(1);
  expect(edgeScroll(890, strip, { left: 400, max: 400 })).toBe(0);
  expect(edgeScroll(600, strip, { left: 40, max: 400 })).toBe(0);
  expect(edgeScroll(950, strip, { left: 40, max: 400 })).toBe(0);
});

test('two targets are the same when they land the tab at the same place (the strip re-renders only on a change)', () => {
  expect(sameTarget({ kind: 'strip', pane: 0, before: 't:a' }, { kind: 'strip', pane: 0, before: 't:a' })).toBe(true);
  expect(sameTarget({ kind: 'strip', pane: 0, before: 't:a' }, { kind: 'strip', pane: 0, before: null })).toBe(false);
  expect(sameTarget({ kind: 'strip', pane: 0, before: null }, { kind: 'strip', pane: 1, before: null })).toBe(false);
  expect(sameTarget({ kind: 'pane', pane: 1, zone: 'right' }, { kind: 'pane', pane: 1, zone: 'right' })).toBe(true);
  expect(sameTarget({ kind: 'pane', pane: 1, zone: 'right' }, { kind: 'pane', pane: 1, zone: 'middle' })).toBe(false);
  expect(sameTarget({ kind: 'pane', pane: 0, zone: 'middle' }, { kind: 'strip', pane: 0, before: null })).toBe(false);
  expect(sameTarget(null, null)).toBe(true);
  expect(sameTarget(null, { kind: 'strip', pane: 0, before: null })).toBe(false);
  expect(sameTarget({ kind: 'shelf', before: '/p/a' }, { kind: 'shelf', before: '/p/a' })).toBe(true);
  expect(sameTarget({ kind: 'shelf', before: '/p/a' }, { kind: 'shelf', before: null })).toBe(false);
  expect(sameTarget({ kind: 'shelf', before: null }, { kind: 'strip', pane: 0, before: null })).toBe(false);
  // A workspace's card.
  expect(sameTarget({ kind: 'workspace', id: 'B' }, { kind: 'workspace', id: 'B' })).toBe(true);
  expect(sameTarget({ kind: 'workspace', id: 'B' }, { kind: 'workspace', id: 'C' })).toBe(false);
  expect(sameTarget({ kind: 'workspace', id: 'B' }, { kind: 'shelf', before: null })).toBe(false);
  expect(sameTarget({ kind: 'pane', pane: 0, zone: 'middle' }, { kind: 'workspace', id: 'B' })).toBe(false);
  expect(sameTarget({ kind: 'strip', pane: 0, before: null }, { kind: 'shelf', before: null })).toBe(false);
});

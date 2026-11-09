import { expect, test } from 'vitest';
import { changeBlocks, dragScroll, markTip, placeMarks, pressMoved, releaseMissed, scrollFor, thumbOf } from './ruler-model';

// The editor's overview ruler: where you are, the changes, Find's matches. Pure geometry.

test('changes become blocks of one kind, consecutive lines together, in order', () => {
  expect(changeBlocks([])).toEqual([]);
  expect(changeBlocks([{ line: 7, kind: 'add' }, { line: 3, kind: 'mod' }, { line: 8, kind: 'add' }, { line: 9, kind: 'mod' }, { line: 12, kind: 'add' }]))
    .toEqual([{ kind: 'mod', first: 3, last: 3 }, { kind: 'add', first: 7, last: 8 }, { kind: 'mod', first: 9, last: 9 }, { kind: 'add', first: 12, last: 12 }]);
});

test('blocks placed on the track: proportional, at least 3 px tall, neighbours of one kind closer than 3 px merged', () => {
  // 100 lines of 20 px (2000 px of content) on a 500 px track: a line is 5 px there.
  const top = (line: number) => (line - 1) * 20;
  const marks = placeMarks([{ kind: 'add', first: 1, last: 1 }, { kind: 'add', first: 2, last: 4 }, { kind: 'del', first: 50, last: 50 }, { kind: 'mod', first: 100, last: 100 }], top, (l) => top(l) + 20, 2000, 500);
  expect(marks).toEqual([
    { kind: 'add', y: 0, h: 20, first: 1, last: 4, n: 4 },
    { kind: 'del', y: 245, h: 5, first: 50, last: 50, n: 1 },
    { kind: 'mod', y: 495, h: 5, first: 100, last: 100, n: 1 }
  ]);
  // A long file: a line is a fraction of a pixel; a single line still gets 3 px, and never runs off the track.
  const long = placeMarks([{ kind: 'add', first: 10_000, last: 10_000 }], (l) => (l - 1) * 20, (l) => l * 20, 200_000, 500);
  expect(long[0]!.h).toBe(3);
  expect(long[0]!.y).toBeLessThanOrEqual(497);
  expect(placeMarks([{ kind: 'add', first: 1, last: 1 }], top, (l) => top(l) + 20, 0, 500)).toEqual([]);
});

test('a changed row in the Diff view — a removed row right above an added one — gets two marks that never overlap', () => {
  // 400 rows of 20 px on a 500 px track: a row is 1.25 px there, less than a mark's 3 px.
  const marks = placeMarks([{ kind: 'del', first: 100, last: 100 }, { kind: 'add', first: 101, last: 101 }], (l) => (l - 1) * 20, (l) => l * 20, 8000, 500);
  expect(marks.map((m) => m.kind)).toEqual(['del', 'add']);
  expect(marks[1]!.y).toBeGreaterThanOrEqual(marks[0]!.y + marks[0]!.h);
  expect(marks[0]!.h).toBe(3);
  // On whole pixels: the page snaps boxes, so fractional neighbours would still overlap where the pointer lands.
  expect(marks.every((m) => Number.isInteger(m.y) && Number.isInteger(m.h))).toBe(true);
});

test('a block ending on a wrapped line reaches that line\'s bottom', () => {
  // Line 10 wraps over five rows (100 px): the block 9–10 runs from 160 to 280 px of 2000, on a 500 px track.
  const top = (l: number) => (l <= 10 ? (l - 1) * 20 : 280 + (l - 11) * 20);
  const bottom = (l: number) => (l === 10 ? 280 : top(l) + 20);
  expect(placeMarks([{ kind: 'add', first: 9, last: 10 }], top, bottom, 2000, 500)).toEqual([{ kind: 'add', y: 40, h: 30, first: 9, last: 10, n: 2 }]);
});

test('the thumb: the visible part of the content, at least 18 px; none when everything fits', () => {
  expect(thumbOf(0, 500, 500, 500)).toBeNull();
  expect(thumbOf(0, 500, 2000, 500)).toEqual({ y: 0, h: 125 });
  expect(thumbOf(1500, 500, 2000, 500)).toEqual({ y: 375, h: 125 });
  expect(thumbOf(0, 500, 100_000, 500)).toEqual({ y: 0, h: 18 });
  // Its bottom meets the track's when scrolled to the end, small or not.
  const t = thumbOf(99_500, 500, 100_000, 500)!;
  expect(t.y + t.h).toBeCloseTo(500, 5);
});

test('a click centers that point; a drag moves the content by the track\'s scale; both stay in range', () => {
  expect(scrollFor(250, 500, 500, 2000)).toBe(750);
  expect(scrollFor(0, 500, 500, 2000)).toBe(0);
  expect(scrollFor(500, 500, 500, 2000)).toBe(1500);
  expect(dragScroll(400, 25, 500, 500, 2000)).toBe(500);
  expect(dragScroll(400, -200, 500, 500, 2000)).toBe(0);
  expect(dragScroll(1400, 300, 500, 500, 2000)).toBe(1500);
});

test('a mark says what it is', () => {
  expect(markTip('add', 11, [54, 64])).toBe('Lines 54–64 · 11 added');
  expect(markTip('add', 1, [7, 7])).toBe('Line 7 · added');
  expect(markTip('mod', 1, [43, 43])).toBe('Line 43 · modified');
  expect(markTip('mod', 2, [43, 44])).toBe('Lines 43–44 · 2 modified');
  expect(markTip('del', 1, [12, 12])).toBe('Removed above line 12');
  expect(markTip('del', 2, null)).toBe('2 removed');
  expect(markTip('add', 3, null)).toBe('3 added');
});

test('a press on a change: released in place it goes there, moved 3 px it drags the thumb', () => {
  expect(pressMoved(0)).toBe(false);
  expect(pressMoved(2)).toBe(false);
  expect(pressMoved(-2.5)).toBe(false);
  expect(pressMoved(3)).toBe(true);
  expect(pressMoved(-3)).toBe(true);
});

test('a move with the primary button up over the window is a release that never came; out of it, not yet', () => {
  const view = { width: 800, height: 600 };
  expect(releaseMissed(0, { x: 400, y: 300 }, view)).toBe(true);
  // Only the secondary button held: the primary one is up.
  expect(releaseMissed(2, { x: 400, y: 300 }, view)).toBe(true);
  expect(releaseMissed(1, { x: 400, y: 300 }, view)).toBe(false);
  expect(releaseMissed(3, { x: 0, y: 0 }, view)).toBe(false);
  // Out of the window macOS may report no button while one is held: the drag goes on.
  expect(releaseMissed(0, { x: 400, y: -10 }, view)).toBe(false);
  expect(releaseMissed(0, { x: 800, y: 300 }, view)).toBe(false);
});

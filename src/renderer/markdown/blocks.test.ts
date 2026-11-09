import { expect, test } from 'vitest';
import { blockMarks, currentHeading, lineAtOffset, offsetOfLine, parseSrc, spanOf } from './blocks';

test('data-src reads as a 1-based line range', () => {
  expect(parseSrc('3-7')).toEqual({ start: 3, end: 7 });
  expect(parseSrc('12-12')).toEqual({ start: 12, end: 12 });
  expect(parseSrc('7-3')).toBeNull();
  expect(parseSrc('x')).toBeNull();
  expect(parseSrc(undefined)).toBeNull();
  expect(parseSrc('0-2')).toBeNull();
});

test('the lines behind a selection: from the first block to the last', () => {
  expect(spanOf([{ start: 10, end: 12 }, { start: 3, end: 4 }])).toEqual({ start: 3, end: 12 });
  expect(spanOf([null, { start: 5, end: 5 }])).toEqual({ start: 5, end: 5 });
  expect(spanOf([null])).toBeNull();
});

test('change bars: the strongest mark inside a block; a removal at a block start is a wedge', () => {
  const marks = new Map([[2, 'mod'], [5, 'add'], [6, 'add'], [9, 'del'], [12, 'del']] as const);
  const blocks = [{ start: 1, end: 3 }, { start: 5, end: 6 }, { start: 7, end: 8 }, { start: 9, end: 10 }, { start: 11, end: 13 }];
  expect(blockMarks(blocks, new Map(marks))).toEqual([
    { bar: 'mod', removedBefore: false },
    { bar: 'add', removedBefore: false },
    { bar: null, removedBefore: false },
    { bar: null, removedBefore: true },
    // Lines removed from the middle of a block changed it.
    { bar: 'mod', removedBefore: false }
  ]);
  // A block with added and modified lines is modified.
  expect(blockMarks([{ start: 1, end: 2 }], new Map([[1, 'add'], [2, 'mod']] as const))).toEqual([{ bar: 'mod', removedBefore: false }]);
  expect(blockMarks(blocks, null).every((b) => b.bar === null && !b.removedBefore)).toBe(true);
});

const geo = [
  { start: 1, end: 1, top: 0, height: 40 },
  { start: 3, end: 6, top: 60, height: 120 },
  { start: 8, end: 8, top: 200, height: 20 }
];

test('scroll sync: a source line maps to a page offset, interpolated inside its block', () => {
  expect(offsetOfLine(geo, 1)).toBe(0);
  expect(offsetOfLine(geo, 3)).toBe(60);
  expect(offsetOfLine(geo, 4.5)).toBe(105);
  // Between blocks (line 7 is blank): interpolated across the gap.
  expect(offsetOfLine(geo, 7)).toBe(180);
  expect(offsetOfLine(geo, 7.5)).toBe(190);
  expect(offsetOfLine(geo, 20)).toBe(200);
  expect(offsetOfLine([], 5)).toBe(0);
});

test('scroll sync: a page offset maps back to a source line', () => {
  expect(lineAtOffset(geo, 0)).toBe(1);
  expect(lineAtOffset(geo, 60)).toBe(3);
  expect(lineAtOffset(geo, 105)).toBe(4.5);
  expect(lineAtOffset(geo, 190)).toBe(7.5);
  expect(lineAtOffset(geo, 500)).toBe(8);
  expect(lineAtOffset([], 50)).toBe(1);
});

test('the current heading is the last one above the reading line', () => {
  expect(currentHeading([0, 300, 900], 0, 80)).toBe(0);
  expect(currentHeading([100, 300, 900], 0, 80)).toBe(0);
  expect(currentHeading([0, 300, 900], 250, 80)).toBe(1);
  expect(currentHeading([0, 300, 900], 2000, 80)).toBe(2);
  expect(currentHeading([], 0, 80)).toBe(-1);
});

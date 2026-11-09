import { expect, test } from 'vitest';
import { changePosition, diffChangedLines, runStarts, stepChange } from './change-nav';
import { unifiedDoc } from './linediff';

test('a change starts where a run of changed lines begins', () => {
  expect(runStarts([])).toEqual([]);
  expect(runStarts([3, 4, 5, 9, 12, 13])).toEqual([3, 9, 12]);
  expect(runStarts([13, 3, 4])).toEqual([3, 13]);
});

test('Diff view: the changed rows are the added and removed ones', () => {
  const d = unifiedDoc('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\nf\n')!;
  // a, b(del), B(add), c, d, e, f(add)
  expect(diffChangedLines(d.lines)).toEqual([2, 3, 7]);
  expect(runStarts(diffChangedLines(d.lines))).toEqual([2, 7]);
});

test('next and previous change from the cursor line, wrapping around the file', () => {
  const starts = [3, 9, 12];
  expect(stepChange(starts, 1, 1)).toBe(3);
  expect(stepChange(starts, 3, 1)).toBe(9);
  expect(stepChange(starts, 10, 1)).toBe(12);
  expect(stepChange(starts, 12, 1)).toBe(3);
  expect(stepChange(starts, 10, -1)).toBe(9);
  expect(stepChange(starts, 9, -1)).toBe(3);
  expect(stepChange(starts, 3, -1)).toBe(12);
  expect(stepChange(starts, 1, -1)).toBe(12);
  expect(stepChange([], 5, 1)).toBeNull();
});

test('position: the change the cursor is in or past, 0 before the first', () => {
  const starts = [3, 9, 12];
  expect(changePosition(starts, 1)).toBe(0);
  expect(changePosition(starts, 3)).toBe(1);
  expect(changePosition(starts, 11)).toBe(2);
  expect(changePosition(starts, 400)).toBe(3);
});

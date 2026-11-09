import { expect, test } from 'vitest';
import { moveSelection, rangeOf, rowBounds, rowSelection, rowWindow, type Sel } from './selection';

// Display order: data rows 4, 2, 0 shown; columns 0, 2, 3 visible (1 hidden).
const rows = [4, 2, 0];
const cols = [0, 2, 3];
const sel = (ar: number, ac: number, fr = ar, fc = ac): Sel => ({ a: { row: ar, col: ac }, f: { row: fr, col: fc } });

test('a selection kept in data coordinates becomes a rectangle of display positions', () => {
  expect(rangeOf(sel(2, 2), rows, cols)).toEqual({ r0: 1, c0: 1, r1: 1, c1: 1 });
  expect(rangeOf(sel(0, 3, 4, 0), rows, cols)).toEqual({ r0: 0, c0: 0, r1: 2, c1: 2 });
  // An anchor filtered out or hidden: the range shrinks to the focus.
  expect(rangeOf(sel(1, 0, 2, 2), rows, cols)).toEqual({ r0: 1, c0: 1, r1: 1, c1: 1 });
  expect(rangeOf(sel(2, 1, 2, 3), rows, cols)).toEqual({ r0: 1, c0: 2, r1: 1, c1: 2 });
  // The focus gone too: nothing.
  expect(rangeOf(sel(1, 1), rows, cols)).toBeNull();
  expect(rangeOf(null, rows, cols)).toBeNull();
});

test('arrows move the focus (and the anchor) in display order; shift extends; ends and pages', () => {
  const m = (s: Sel | null, key: string, o: { shift?: boolean; mod?: boolean } = {}) => moveSelection(s, key, { shift: !!o.shift, mod: !!o.mod, page: 2 }, rows, cols);
  expect(m(sel(4, 0), 'ArrowDown')).toEqual(sel(2, 0));
  expect(m(sel(4, 0), 'ArrowUp')).toEqual(sel(4, 0));
  expect(m(sel(4, 0), 'ArrowRight')).toEqual(sel(4, 2));
  expect(m(sel(4, 3), 'ArrowRight')).toEqual(sel(4, 3));
  expect(m(sel(4, 0), 'ArrowDown', { shift: true })).toEqual(sel(4, 0, 2, 0));
  expect(m(sel(4, 0, 2, 2), 'ArrowRight', { shift: true })).toEqual(sel(4, 0, 2, 3));
  expect(m(sel(2, 2), 'Home')).toEqual(sel(2, 0));
  expect(m(sel(2, 2), 'End')).toEqual(sel(2, 3));
  expect(m(sel(2, 2), 'ArrowDown', { mod: true })).toEqual(sel(0, 2));
  expect(m(sel(2, 2), 'ArrowUp', { mod: true })).toEqual(sel(4, 2));
  expect(m(sel(4, 0), 'PageDown')).toEqual(sel(0, 0));
  expect(m(sel(0, 0), 'PageUp', { shift: true })).toEqual(sel(0, 0, 4, 0));
  // Nothing selected: the first cell.
  expect(m(null, 'ArrowDown')).toEqual(sel(4, 0));
  expect(m(sel(4, 0), 'x')).toBeNull();
  expect(moveSelection(null, 'ArrowDown', { shift: false, mod: false, page: 2 }, [], cols)).toBeNull();
});

test('a row number selects the whole row; with shift, the rows up to it', () => {
  expect(rowSelection(null, 2, false, cols)).toEqual(sel(2, 0, 2, 3));
  expect(rowSelection(sel(4, 2), 0, true, cols)).toEqual(sel(4, 0, 0, 3));
});

test('a range\'s lowest and highest data rows, without spreading a huge array', () => {
  const many = Array.from({ length: 200_000 }, (_, i) => 200_000 - i);
  expect(rowBounds(many, { r0: 0, c0: 0, r1: many.length - 1, c1: 0 })).toEqual({ min: 1, max: 200_000 });
  expect(rowBounds(rows, { r0: 0, c0: 0, r1: 1, c1: 0 })).toEqual({ min: 2, max: 4 });
});

test('the virtual window: never past the rows a filter left', () => {
  // Scrolled to row 30 000, then a filter leaves 5 rows: the window shows them.
  expect(rowWindow({ top: 30_000 * 28, height: 600, head: 46, row: 28, count: 5, overscan: 10 })).toEqual({ first: 0, last: 5 });
  expect(rowWindow({ top: 0, height: 600, head: 46, row: 28, count: 1000, overscan: 10 })).toEqual({ first: 0, last: 32 });
  expect(rowWindow({ top: 28_000, height: 560, head: 46, row: 28, count: 1000, overscan: 10 })).toEqual({ first: 988, last: 1000 });
});

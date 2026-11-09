import { expect, test } from 'vitest';
import { filterFor } from './CsvColumnMenu';
import type { ColumnProfile } from './types';

const status = {
  index: 4, top: ['delivered', 'shipped', 'pending', 'refunded', 'cancelled'].map((value, i) => ({ value, count: 6 - i }))
} as unknown as ColumnProfile;

test('the column menu\'s checked values become the shortest filter', () => {
  expect(filterFor(status, new Set(['delivered', 'shipped', 'pending', 'refunded', 'cancelled']))).toBeNull();
  expect(filterFor(status, new Set(['delivered', 'shipped']))).toEqual({ col: 4, mode: 'in', values: ['delivered', 'shipped'] });
  expect(filterFor(status, new Set(['delivered', 'shipped', 'pending', 'refunded']))).toEqual({ col: 4, mode: 'out', values: ['cancelled'] });
  expect(filterFor(status, new Set())).toEqual({ col: 4, mode: 'in', values: [] });
});

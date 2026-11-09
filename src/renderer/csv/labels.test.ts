import { expect, test } from 'vitest';
import { binHeights, shortNumber, summaryText, tintOf, typeLabel } from './labels';
import type { ColumnProfile } from './types';

const P = (o: Partial<ColumnProfile>): ColumnProfile => ({
  index: 0, letter: 'A', name: 'x', type: 'text', unique: false, places: null, count: 10, empty: 0, distinct: 10, min: null, max: null,
  mean: null, sum: null, bins: null, top: [], codes: false, bars: false, width: 100, rawWidth: 8, extra: false, ...o
});

test('the type under a header', () => {
  expect(typeLabel(P({ unique: true }))).toBe('text · unique');
  expect(typeLabel(P({}))).toBe('text');
  expect(typeLabel(P({ type: 'category', distinct: 5 }))).toBe('category · 5');
  expect(typeLabel(P({ type: 'decimal', places: 2 }))).toBe('decimal · 2 places');
  expect(typeLabel(P({ type: 'decimal' }))).toBe('decimal');
  expect(typeLabel(P({ type: 'json' }))).toBe('JSON');
  expect(typeLabel(P({ type: 'boolean', empty: 1 }))).toBe('boolean · 1 empty');
  expect(typeLabel(P({ type: 'empty', count: 0, empty: 4 }))).toBe('empty');
  expect(typeLabel(P({ extra: true, count: 1 }))).toBe('extra · 1 row');
});

test('a category value\'s tint follows its frequency rank; unknown values get the last one', () => {
  const p = P({ type: 'category', top: [{ value: 'delivered', count: 6 }, { value: 'shipped', count: 4 }] });
  expect(tintOf(p, 'delivered')).toBe(0);
  expect(tintOf(p, 'shipped')).toBe(1);
  expect(tintOf(p, 'nope')).toBe(7);
  expect(tintOf(P({ type: 'category', top: Array.from({ length: 10 }, (_, i) => ({ value: `v${i}`, count: 1 })) }), 'v9')).toBe(1);
});

test('the header summary line', () => {
  expect(summaryText(P({ type: 'decimal', min: 49, max: 2310 }), ',')).toBe('49 – 2\u2009310');
  expect(summaryText(P({ type: 'integer', min: 1, max: 15 }), '.')).toBe('1 – 15');
  expect(summaryText(P({ type: 'date', min: Date.UTC(2026, 6, 1), max: Date.UTC(2026, 6, 11) }), '.')).toBe('2026-07-01 → 2026-07-11');
  expect(summaryText(P({ type: 'category', distinct: 5, top: [{ value: 'delivered', count: 6 }, { value: 'shipped', count: 4 }, { value: 'pending', count: 2 }] }), '.'))
    .toBe('delivered 6 · shipped 4 · +3');
  expect(summaryText(P({ type: 'boolean', distinct: 2, top: [{ value: 'true', count: 11 }, { value: 'false', count: 3 }] }), '.')).toBe('true 11 · false 3');
  expect(summaryText(P({ distinct: 1284 }), '.')).toBe('1\u2009284 distinct');
  expect(summaryText(P({ type: 'empty' }), '.')).toBe('');
});

test('histogram bars: heights scaled to the tallest bin, at least 2 px for a non-empty one', () => {
  expect(binHeights([0, 5, 10], 20)).toEqual([0, 10, 20]);
  expect(binHeights([1, 100], 20)).toEqual([2, 20]);
  expect(binHeights([0, 0], 20)).toEqual([0, 0]);
});

test('a tiny negative mean shows as 0, not -0 (review)', () => {
  expect(shortNumber(-0.001, '.')).toBe('0');
  expect(shortNumber(-1.5, ',')).toBe('-1,5');
});

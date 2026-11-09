import { describe, expect, test } from 'vitest';
import { aggregates, filterLabel, nextSort, normRange, problemRows, visibleRows } from './view';
import { profile } from './profile';
import type { CsvData, ViewQuery } from './types';

function csvData(header: string[] | null, rows: string[][]): CsvData {
  const first = header ? 2 : 1;
  const width = Math.max(header?.length ?? 0, ...rows.map((r) => r.length), 0);
  const expected = header?.length ?? width;
  return {
    header, headerLine: header ? 1 : null, rows,
    lines: rows.map((_, i) => first + i), endLines: rows.map((_, i) => first + i), width, expected,
    problems: rows.flatMap((r, i) => (r.length !== expected ? [{ kind: 'fields' as const, row: i, line: first + i, count: r.length }] : []))
  };
}

const ORDERS = csvData(['id', 'at', 'customer', 'status', 'items', 'total', 'paid'], [
  ['A-1', '2026-07-03', 'Bottega Rossi', 'delivered', '3', '284.50', 'true'],
  ['A-2', '2026-07-01', 'Nordlicht GmbH', 'delivered', '12', '1284.00', 'true'],
  ['A-3', '2026-07-02', 'Atelier Lumière', 'shipped', '5', '', 'false'],
  ['A-4', '2026-07-05', 'casa verde', 'pending', '1', '49.00', 'false'],
  ['A-5', '', 'Hafen & Co', 'shipped', '2', '98.60', 'true'],
  ['A-10', '2026-07-04', 'item 10', 'refunded', '12', '130.00', 'true']
]);
const P = profile(ORDERS, '.');
const q = (o: Partial<ViewQuery>): ViewQuery => ({ query: '', filters: [], problemsOnly: false, sort: [], ...o });
const ids = (rows: number[]) => rows.map((r) => ORDERS.rows[r]![0]);

describe('visibleRows: filters', () => {
  test('everything in file order without a query', () => {
    expect(visibleRows(ORDERS, P, q({}), '.')).toEqual([0, 1, 2, 3, 4, 5]);
  });
  test('the query matches any cell, case-insensitive, trimmed', () => {
    expect(ids(visibleRows(ORDERS, P, q({ query: '  SHIPPED ' }), '.'))).toEqual(['A-3', 'A-5']);
    expect(ids(visibleRows(ORDERS, P, q({ query: 'gmbh' }), '.'))).toEqual(['A-2']);
    expect(visibleRows(ORDERS, P, q({ query: 'nothing like it' }), '.')).toEqual([]);
  });
  test('value filters keep (in) or drop (out) values, combined with the query', () => {
    expect(ids(visibleRows(ORDERS, P, q({ filters: [{ col: 3, mode: 'in', values: ['delivered', 'shipped'] }] }), '.'))).toEqual(['A-1', 'A-2', 'A-3', 'A-5']);
    expect(ids(visibleRows(ORDERS, P, q({ filters: [{ col: 3, mode: 'out', values: ['delivered'] }] }), '.'))).toEqual(['A-3', 'A-4', 'A-5', 'A-10']);
    expect(ids(visibleRows(ORDERS, P, q({ query: 'true', filters: [{ col: 3, mode: 'in', values: ['shipped'] }] }), '.'))).toEqual(['A-5']);
  });
  test('an empty value and a missing field are the same ""', () => {
    const d = csvData(['a', 'b'], [['1', ''], ['2'], ['3', 'x']]);
    expect(visibleRows(d, profile(d, '.'), q({ filters: [{ col: 1, mode: 'in', values: [''] }] }), '.')).toEqual([0, 1]);
  });
  test('problems only: rows that do not match the header', () => {
    const d = csvData(['a', 'b'], [['1', '2'], ['3'], ['4', '5'], ['6', '7', '8']]);
    expect(visibleRows(d, profile(d, '.'), q({ problemsOnly: true }), '.')).toEqual([1, 3]);
    expect([...problemRows(d)]).toEqual([1, 3]);
  });
});

describe('visibleRows: sort', () => {
  test('numbers numerically, empties last in both directions', () => {
    expect(ids(visibleRows(ORDERS, P, q({ sort: [{ col: 5, dir: 'asc' }] }), '.'))).toEqual(['A-4', 'A-5', 'A-10', 'A-1', 'A-2', 'A-3']);
    expect(ids(visibleRows(ORDERS, P, q({ sort: [{ col: 5, dir: 'desc' }] }), '.'))).toEqual(['A-2', 'A-1', 'A-10', 'A-5', 'A-4', 'A-3']);
  });
  test('dates in time order, empties last', () => {
    expect(ids(visibleRows(ORDERS, P, q({ sort: [{ col: 1, dir: 'asc' }] }), '.'))).toEqual(['A-2', 'A-3', 'A-1', 'A-10', 'A-4', 'A-5']);
    expect(ids(visibleRows(ORDERS, P, q({ sort: [{ col: 1, dir: 'desc' }] }), '.'))).toEqual(['A-4', 'A-10', 'A-1', 'A-3', 'A-2', 'A-5']);
  });
  test('text: natural numbers inside, case-insensitive', () => {
    expect(ids(visibleRows(ORDERS, P, q({ sort: [{ col: 0, dir: 'asc' }] }), '.'))).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-10']);
    expect(ids(visibleRows(ORDERS, P, q({ sort: [{ col: 2, dir: 'asc' }] }), '.'))).toEqual(['A-3', 'A-1', 'A-4', 'A-5', 'A-10', 'A-2']);
  });
  test('booleans: false before true; stable within equal keys', () => {
    expect(ids(visibleRows(ORDERS, P, q({ sort: [{ col: 6, dir: 'asc' }] }), '.'))).toEqual(['A-3', 'A-4', 'A-1', 'A-2', 'A-5', 'A-10']);
  });
  test('several keys: the second breaks the first’s ties', () => {
    expect(ids(visibleRows(ORDERS, P, q({ sort: [{ col: 3, dir: 'asc' }, { col: 4, dir: 'desc' }] }), '.')))
      .toEqual(['A-2', 'A-1', 'A-4', 'A-10', 'A-3', 'A-5']);
  });
  test('decimal comma numbers sort as numbers', () => {
    const d = csvData(['t'], [['1.284,50'], ['49,00'], ['284,50']]);
    expect(visibleRows(d, profile(d, ','), q({ sort: [{ col: 0, dir: 'asc' }] }), ',')).toEqual([1, 2, 0]);
  });
});

describe('nextSort', () => {
  test('a click: asc → desc → off on that column, alone', () => {
    expect(nextSort([], 2, false)).toEqual([{ col: 2, dir: 'asc' }]);
    expect(nextSort([{ col: 2, dir: 'asc' }], 2, false)).toEqual([{ col: 2, dir: 'desc' }]);
    expect(nextSort([{ col: 2, dir: 'desc' }], 2, false)).toEqual([]);
    expect(nextSort([{ col: 1, dir: 'asc' }, { col: 2, dir: 'desc' }], 3, false)).toEqual([{ col: 3, dir: 'asc' }]);
  });
  test('⌥-click: adds the column as a further key, or steps it in place', () => {
    expect(nextSort([{ col: 1, dir: 'asc' }], 3, true)).toEqual([{ col: 1, dir: 'asc' }, { col: 3, dir: 'asc' }]);
    expect(nextSort([{ col: 1, dir: 'asc' }, { col: 3, dir: 'asc' }], 1, true)).toEqual([{ col: 1, dir: 'desc' }, { col: 3, dir: 'asc' }]);
    expect(nextSort([{ col: 1, dir: 'desc' }, { col: 3, dir: 'asc' }], 1, true)).toEqual([{ col: 3, dir: 'asc' }]);
  });
});

describe('ranges and totals', () => {
  test('normRange: any corner order', () => {
    expect(normRange({ row: 8, col: 6 }, { row: 2, col: 5 })).toEqual({ r0: 2, c0: 5, r1: 8, c1: 6 });
    expect(normRange({ row: 1, col: 1 }, { row: 1, col: 1 })).toEqual({ r0: 1, c0: 1, r1: 1, c1: 1 });
  });
  test('aggregates per numeric column of the range, skipping empties and text columns', () => {
    const rows = [0, 1, 2, 3, 4, 5];
    const cols = [0, 1, 2, 3, 4, 5, 6];
    const a = aggregates(ORDERS, P, rows, cols, { r0: 0, c0: 3, r1: 2, c1: 5 }, '.');
    expect(a).toEqual([
      { col: 4, count: 3, sum: 20, avg: 20 / 3, min: 3, max: 12 },
      { col: 5, count: 2, sum: 1568.5, avg: 784.25, min: 284.5, max: 1284 }
    ]);
  });
  test('the range is over display positions: sorted rows and hidden columns', () => {
    const rows = [3, 0];
    const cols = [0, 5];
    expect(aggregates(ORDERS, P, rows, cols, { r0: 0, c0: 1, r1: 1, c1: 1 }, '.')).toEqual([{ col: 5, count: 2, sum: 333.5, avg: 166.75, min: 49, max: 284.5 }]);
  });
});

describe('filterLabel', () => {
  test('name and values; ≠ for out; more than three summed up', () => {
    expect(filterLabel({ col: 3, mode: 'in', values: ['delivered', 'shipped'] }, P[3]!)).toBe('status delivered, shipped');
    expect(filterLabel({ col: 3, mode: 'out', values: ['shipped'] }, P[3]!)).toBe('status ≠ shipped');
    expect(filterLabel({ col: 3, mode: 'in', values: ['a', 'b', 'c', 'd', 'e'] }, P[3]!)).toBe('status a, b, c +2');
  });
  test('the letter without a name, (empty) for ""', () => {
    const d = csvData(null, [['1', 'x']]);
    expect(filterLabel({ col: 1, mode: 'in', values: [''] }, profile(d, '.')[1]!)).toBe('B (empty)');
  });
});

describe('performance', () => {
  test('60 000 rows × 8 columns: a numeric sort and a query filter run quickly', () => {
    const rows = Array.from({ length: 60_000 }, (_, i) => [
      `A-${10000 + i}`, `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`, `Customer ${i % 900}`, ['IT', 'DE', 'FR', 'ES'][i % 4]!,
      ['delivered', 'shipped', 'pending'][i % 3]!, String(i % 15), `${((i * 7919) % 2310).toFixed(2)}`, i % 5 ? 'true' : 'false'
    ]);
    const d = csvData(['id', 'at', 'customer', 'country', 'status', 'items', 'total', 'paid'], rows);
    const ps = profile(d, '.');
    let t0 = performance.now();
    const sorted = visibleRows(d, ps, q({ sort: [{ col: 6, dir: 'desc' }] }), '.');
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(sorted).toHaveLength(60_000);
    t0 = performance.now();
    const found = visibleRows(d, ps, q({ query: 'customer 42' }), '.');
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(found.length).toBeGreaterThan(0);
  });
});

test('the query looks at the shown columns only when they are given (hidden ones don\'t match, review)', () => {
  expect(ids(visibleRows(ORDERS, P, q({ query: 'delivered' }), '.'))).toEqual(['A-1', 'A-2']);
  expect(ids(visibleRows(ORDERS, P, q({ query: 'delivered', columns: [0, 1, 2] }), '.'))).toEqual([]);
});

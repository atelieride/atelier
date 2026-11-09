import { describe, expect, test } from 'vitest';
import { profile } from './profile';
import type { CsvData } from './types';

/** A parsed file by hand: header on line 1, one line per row. */
function csvData(header: string[] | null, rows: string[][]): CsvData {
  const first = header ? 2 : 1;
  const counts = rows.map((r) => r.length);
  const width = Math.max(header?.length ?? 0, ...counts, 0);
  const expected = header?.length ?? width;
  return {
    header, headerLine: header ? 1 : null, rows,
    lines: rows.map((_, i) => first + i), endLines: rows.map((_, i) => first + i),
    width, expected,
    problems: rows.flatMap((r, i) => (r.length !== expected ? [{ kind: 'fields' as const, row: i, line: first + i, count: r.length }] : []))
  };
}

const col = (values: string[], name = 'x') => profile(csvData([name], values.map((v) => [v])), '.')[0]!;

describe('types', () => {
  test('integer, decimal (with places), boolean', () => {
    expect(col(['3', '12', '-5']).type).toBe('integer');
    const d = col(['284.50', '1284.00', '49.10']);
    expect(d.type).toBe('decimal');
    expect(d.places).toBe(2);
    expect(col(['1.5', '2.25']).places).toBeNull();
    expect(col(['1.5', '2']).type).toBe('decimal');
    expect(col(['true', 'FALSE', 'Yes', 'no']).type).toBe('boolean');
  });
  test('decimal comma with the file’s separator', () => {
    const p = profile(csvData(['total'], [['284,50'], ['1.284,00'], ['49,10']]), ',')[0]!;
    expect(p.type).toBe('decimal');
    expect(p.places).toBe(2);
    expect(p.max).toBe(1284);
  });
  test('leading zeros make text (zip codes, ids)', () => {
    expect(col(['00123', '00456', '01999']).type).toBe('text');
    expect(col(['0', '0.5', '10']).type).toBe('decimal');
  });
  test('mixed values are text; empties do not count', () => {
    expect(col(['1', 'two', '3', '4', 'five', 'six']).type).toBe('text');
    expect(col(['1', '', '3']).type).toBe('integer');
    const e = col(['', ' ', '']);
    expect(e.type).toBe('empty');
    expect(e.empty).toBe(3);
    expect(e.count).toBe(0);
  });
  test('dates and datetimes (ISO, space or T, seconds, fraction, zone); mixed date + datetime is datetime', () => {
    expect(col(['2026-07-01', '2026-07-11']).type).toBe('date');
    expect(col(['2026-07-01 09:14', '2026-07-11T10:20:05.118Z', '2026-07-02T16:40:00+02:00']).type).toBe('datetime');
    expect(col(['2026-07-01', '2026-07-01 09:14']).type).toBe('datetime');
    expect(col(['2026-13-01', '2026-07-01']).type).toBe('text');
  });
  test('json when every value is an object or array that parses', () => {
    expect(col(['{"a":1}', '[1,2]', '{}']).type).toBe('json');
    expect(col(['{"a":1}', '{broken']).type).toBe('text');
  });
  test('category: 2–12 distinct values that repeat (distinct ≤ count / 2)', () => {
    const s = col(['delivered', 'shipped', 'delivered', 'pending', 'shipped', 'delivered']);
    expect(s.type).toBe('category');
    expect(s.codes).toBe(false);
    expect(col(['a', 'b', 'c', 'd']).type).toBe('text');
    expect(col(['a', 'a', 'a', 'a']).type).toBe('text');
    const many = Array.from({ length: 13 }, (_, i) => `v${i}`);
    expect(col([...many, ...many]).type).toBe('text');
  });
  test('codes: a category of 1–3 upper-case letters or digits', () => {
    expect(col(['IT', 'DE', 'IT', 'FR', 'DE', 'IT']).codes).toBe(true);
    expect(col(['It', 'De', 'It', 'De']).codes).toBe(false);
  });
});

describe('fields', () => {
  test('letter, name, index; no header → empty names', () => {
    const ps = profile(csvData(null, [['1', 'a'], ['2', 'b']]), '.');
    expect(ps.map((p) => [p.index, p.letter, p.name])).toEqual([[0, 'A', ''], [1, 'B', '']]);
    expect(profile(csvData(['id', 'name'], [['1', 'a']]), '.').map((p) => p.name)).toEqual(['id', 'name']);
  });
  test('extra columns beyond the header; a missing field counts as empty', () => {
    const ps = profile(csvData(['a', 'b'], [['1', '2'], ['3', '4', 'x'], ['5']]), '.');
    expect(ps).toHaveLength(3);
    expect(ps.map((p) => p.extra)).toEqual([false, false, true]);
    expect(ps[1]!.empty).toBe(1);
    expect(ps[2]!.empty).toBe(2);
    expect(ps[2]!.count).toBe(1);
  });
  test('stats for numbers: count, distinct, min, max, mean, sum', () => {
    const p = col(['3', '12', '5', '3', '']);
    expect([p.count, p.empty, p.distinct, p.min, p.max, p.sum, p.mean]).toEqual([4, 1, 3, 3, 12, 23, 5.75]);
    expect(p.unique).toBe(false);
    expect(col(['a', 'b']).unique).toBe(true);
    expect(col(['a']).unique).toBe(false);
    expect(col(['a', 'b']).min).toBeNull();
  });
  test('dates: min / max as epoch ms, no sum', () => {
    const p = col(['2026-07-11', '2026-07-01']);
    expect(p.min).toBe(Date.UTC(2026, 6, 1));
    expect(p.max).toBe(Date.UTC(2026, 6, 11));
    expect(p.sum).toBeNull();
    expect(p.bins).toHaveLength(12);
  });
  test('12 bins between min and max, the max in the last; one value in the first', () => {
    const p = col(['0', '1', '6', '12', '12']);
    expect(p.bins).toHaveLength(12);
    expect(p.bins![0]).toBe(1);
    expect(p.bins![1]).toBe(1);
    expect(p.bins![6]).toBe(1);
    expect(p.bins![11]).toBe(2);
    expect(p.bins!.reduce((a, b) => a + b, 0)).toBe(5);
    expect(col(['7', '7']).bins![0]).toBe(2);
    expect(col(['a', 'b']).bins).toBeNull();
  });
  test('top values by count, ties by first appearance; none over 500 distinct', () => {
    const p = col(['b', 'a', 'a', 'c', 'b', 'a']);
    expect(p.top).toEqual([{ value: 'a', count: 3 }, { value: 'b', count: 2 }, { value: 'c', count: 1 }]);
    expect(col(Array.from({ length: 501 }, (_, i) => `v${i}`)).top).toEqual([]);
    expect(col(Array.from({ length: 500 }, (_, i) => `v${i}`)).top).toHaveLength(500);
  });
  test('bars: not for a handful of repeated numbers (status codes, flags)', () => {
    expect(col(['200', '200', '504', '200', '404']).bars).toBe(false);
    expect(col(['3', '12', '3', '7', '9']).bars).toBe(true);
  });
  test('bars: non-negative numbers that are not unique integers (ids)', () => {
    expect(col(['3', '12', '3', '5', '8']).bars).toBe(true);
    expect(col(['1', '2', '3']).bars).toBe(false);
    expect(col(['1.5', '2.5', '0.5', '4.25']).bars).toBe(true);
    expect(col(['-1', '2', '2']).bars).toBe(false);
    expect(col(['a', 'b']).bars).toBe(false);
  });
  test('width from the content, clamped 64–340; bars add room', () => {
    expect(col(['a', 'b'], 'x').width).toBe(95);
    expect(col(['x'.repeat(200)]).width).toBe(340);
    const plain = col(['abc123', 'abc123'], 'n');
    const barred = col(['123456', '123455', '123456', '123457', '123458'], 'n');
    expect(barred.width).toBeGreaterThan(plain.width);
    expect(col(['a'], 'a_rather_long_header_name').width).toBeGreaterThan(64);
  });
  test('width leaves room for the header\'s letter chip, sort arrow and menu, and for a whole datetime', () => {
    // A header: its name plus the letter chip, the arrow and the ▾ (about 88 px around the name).
    expect(col(['IT', 'DE'], 'country').width).toBeGreaterThanOrEqual(7 * 7.2 + 88);
    // A value: 16 mono characters at 12 px plus the cell's padding, never cut.
    expect(col(['2026-07-04 14:22'], 'at').width).toBeGreaterThanOrEqual(16 * 7.2 + 24 + 4);
  });
  test('rawWidth: the widest raw field (quotes counted), at most 40', () => {
    expect(col(['abc', 'abcdef'], 'id').rawWidth).toBe(6);
    expect(col(['a,b'], 'id').rawWidth).toBe(5);
    expect(col(['say "hi"'], 'id').rawWidth).toBe(12);
    expect(col(['x'.repeat(90)], 'id').rawWidth).toBe(40);
    expect(col(['a'], 'header').rawWidth).toBe(6);
  });
});

describe('performance', () => {
  test('60 000 rows × 8 columns profile quickly', () => {
    const rows = Array.from({ length: 60_000 }, (_, i) => [
      `A-${10000 + i}`, `2026-07-${String(1 + (i % 28)).padStart(2, '0')} 09:14`, `Customer ${i % 900}`, ['IT', 'DE', 'FR', 'ES'][i % 4]!,
      ['delivered', 'shipped', 'pending'][i % 3]!, String(i % 15), `${(i % 2310).toFixed(2)}`, i % 5 ? 'true' : 'false'
    ]);
    const t0 = performance.now();
    const ps = profile(csvData(['id', 'at', 'customer', 'country', 'status', 'items', 'total', 'paid'], rows), '.');
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(ps.map((p) => p.type)).toEqual(['text', 'datetime', 'text', 'category', 'category', 'integer', 'decimal', 'boolean']);
  });
});

test('rawWidth quotes only what the file\'s delimiter makes quoted (review)', () => {
  const data = csvData(['x'], [['a;b'], ['cc']]);
  expect(profile(data, '.', ',')[0]!.rawWidth).toBe(3);
  expect(profile(data, '.', ';')[0]!.rawWidth).toBe(5);
  expect(profile(csvData(['x'], [['say "hi"']]), '.', ',')[0]!.rawWidth).toBe(12);
});

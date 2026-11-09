import { describe, expect, test } from 'vitest';
import { buildTable, nextSort, tableMeta, tableTarget } from './table';
import { parseJson, type JsonNode } from './parse';

const parse = (v: unknown): JsonNode => { const r = parseJson(JSON.stringify(v), { jsonc: false }); if (!r.ok) throw new Error('bad'); return r.root; };

const REGIONS = [
  { code: 'eu-south-1', name: 'Milan', latencyMs: 18, active: true, tags: ['primary', 'gdpr'], limits: { rps: 900, burst: 1800 } },
  { code: 'eu-north-1', name: 'Stockholm', latencyMs: 41, active: false, tags: ['standby'] },
  { code: 'us-east-1', name: 'N. Virginia', latencyMs: 96, active: true, tags: [], limits: { rps: 2000, burst: 4000 } }
];

describe('tableTarget', () => {
  const doc = parse({ name: 'x', features: [{ id: 'a' }, { id: 'b' }], mixed: [{ id: 1 }, 2], empty: [] });
  test('the selection when it is an array of objects, else its nearest such ancestor', () => {
    expect(tableTarget(doc, ['features'])).toEqual(['features']);
    expect(tableTarget(doc, ['features', 1, 'id'])).toEqual(['features']);
  });
  test('none for mixed or empty arrays and outside any; the root when it is one', () => {
    expect(tableTarget(doc, ['mixed', 0])).toBeNull();
    expect(tableTarget(doc, ['empty'])).toBeNull();
    expect(tableTarget(doc, ['name'])).toBeNull();
    expect(tableTarget(parse(REGIONS), [])).toEqual([]);
    expect(tableTarget(parse(REGIONS), [2, 'code'])).toEqual([]);
  });
});

describe('buildTable', () => {
  const arr = parse(REGIONS);
  test('columns in first-appearance order with types and presence; numeric bars', () => {
    const t = buildTable(arr, { query: '', sort: null });
    expect(t.columns.map((c) => [c.key, c.type, c.present, c.label])).toEqual([
      ['code', 'string', 3, 'string'], ['name', 'string', 3, 'string'], ['latencyMs', 'number', 3, 'number'],
      ['active', 'boolean', 3, 'boolean'], ['tags', 'array', 3, 'array'], ['limits', 'object', 2, 'object · 2/3']
    ]);
    expect(t.columns[2]!.numeric).toBe(true);
    expect(t.columns[0]!.numeric).toBe(false);
  });

  test('cells: literals, chips with previews, missing, bars relative to the column maximum', () => {
    const t = buildTable(arr, { query: '', sort: null });
    const [milan, stockholm] = t.rows;
    expect(milan!.cells.map((c) => c.kind)).toEqual(['string', 'string', 'number', 'boolean', 'box', 'box']);
    expect(milan!.cells[0]).toMatchObject({ text: '"eu-south-1"' });
    expect(milan!.cells[2]).toMatchObject({ text: '18', bar: 18 / 96 });
    expect(milan!.cells[4]).toMatchObject({ chip: '[2]', text: '"primary", "gdpr"' });
    expect(milan!.cells[5]).toMatchObject({ chip: '{2}', text: 'rps: 900, burst: 1800' });
    expect(stockholm!.cells[5]).toMatchObject({ kind: 'missing', text: '—', node: null });
    expect(milan).toMatchObject({ index: 0, line: 1 });
  });

  test('mixed column types', () => {
    const t = buildTable(parse([{ a: 1 }, { a: 'x' }]), { query: '', sort: null });
    expect(t.columns[0]).toMatchObject({ type: 'mixed', numeric: false });
  });

  test('sorting: ascending, descending, missing values last either way', () => {
    const asc = buildTable(arr, { query: '', sort: { key: 'latencyMs', dir: 'desc' } });
    expect(asc.rows.map((r) => r.index)).toEqual([2, 1, 0]);
    const names = buildTable(arr, { query: '', sort: { key: 'name', dir: 'asc' } });
    expect(names.rows.map((r) => r.index)).toEqual([0, 2, 1]);
    for (const dir of ['asc', 'desc'] as const) {
      expect(buildTable(arr, { query: '', sort: { key: 'limits', dir } }).rows.at(-1)!.index).toBe(1);
    }
  });

  test('filter rows on any cell', () => {
    const t = buildTable(arr, { query: 'gdpr', sort: null });
    expect(t.rows.map((r) => r.index)).toEqual([0]);
    expect(t.total).toBe(3);
  });

  test('the header click cycle and the meta line', () => {
    expect(nextSort(null, 'a')).toEqual({ key: 'a', dir: 'asc' });
    expect(nextSort({ key: 'a', dir: 'asc' }, 'a')).toEqual({ key: 'a', dir: 'desc' });
    expect(nextSort({ key: 'a', dir: 'desc' }, 'a')).toBeNull();
    expect(nextSort({ key: 'a', dir: 'desc' }, 'b')).toEqual({ key: 'b', dir: 'asc' });
    expect(tableMeta({ shown: 10, total: 10, columns: 6, sort: { key: 'latencyMs', dir: 'asc' } })).toBe('10 rows · 6 columns · sorted by latencyMs');
    expect(tableMeta({ shown: 3, total: 10, columns: 1, sort: null })).toBe('3 of 10 rows · 1 column');
    expect(tableMeta({ shown: 1, total: 1, columns: 2, sort: null })).toBe('1 row · 2 columns');
  });
});

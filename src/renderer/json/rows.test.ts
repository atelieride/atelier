import { describe, expect, test } from 'vitest';
import { allIds, buildRows, chunkSize, initialExpanded, pathKey, revealIds, rowPath, subtreeIds, type Row } from './rows';
import { parseJson, type JsonNode } from './parse';

const DATA = {
  name: 'orbit-api',
  server: { host: '0.0.0.0', port: 8080, cors: { origins: ['https://app.orbit.dev', 'http://localhost:5173'], credentials: true } },
  database: { url: 'postgres://orbit@db:5432/orbit', pool: { min: 2, max: 20, idleMs: 30000 }, replicas: null },
  cache: { driver: 'redis', url: 'redis://cache:6379/0', ttl: 3600, extra: 1 },
  workers: ['mailer', 'indexer', 'thumbnails', 'webhooks', 'search'],
  empty: {}
};
const TEXT = JSON.stringify(DATA, null, 2);
const parse = (t: string): JsonNode => { const r = parseJson(t, { jsonc: false }); if (!r.ok) throw new Error('bad'); return r.root; };
const ROOT = parse(TEXT);
const id = (...p: (string | number)[]) => pathKey(p);
const label = (r: Row) => (r.kind === 'chunk' ? `#${r.from}-${r.to}` : String(r.key));

describe('buildRows: expansion', () => {
  test('collapsed: the root\'s children with chips and previews, lines', () => {
    const { rows } = buildRows(ROOT, { expanded: new Set(), query: '' });
    expect(rows.map(label)).toEqual(['name', 'server', 'database', 'cache', 'workers', 'empty']);
    const [name, server, database, cache, workers, empty] = rows as Extract<Row, { kind: 'node' }>[];
    expect(name).toMatchObject({ depth: 0, box: false, value: '"orbit-api"', line: 2 });
    expect(server).toMatchObject({ box: true, open: false, chip: '{3}', preview: 'host: "0.0.0.0", port: 8080, cors: {…}' });
    expect(database!.preview).toBe('url: "postgres://orbit@db…", pool: {…}, replicas: null');
    expect(cache!.preview).toBe('driver: "redis", url: "redis://cache:6379/0", ttl: 3600, extra: 1');
    expect(workers).toMatchObject({ chip: '[5]', preview: '"mailer", "indexer", "thumbnails", "webhooks", …' });
    expect(empty).toMatchObject({ chip: '{0}', preview: '' });
  });

  test('open containers show their children one level deeper; indices as keys', () => {
    const { rows } = buildRows(ROOT, { expanded: new Set([id('server'), id('server', 'cors'), id('server', 'cors', 'origins')]), query: '' });
    expect(rows.map((r) => [label(r), r.depth])).toEqual([
      ['name', 0], ['server', 0], ['host', 1], ['port', 1], ['cors', 1], ['origins', 2], ['0', 3], ['1', 3], ['credentials', 2],
      ['database', 0], ['cache', 0], ['workers', 0], ['empty', 0]
    ]);
    const server = rows[1] as Extract<Row, { kind: 'node' }>;
    expect(server).toMatchObject({ open: true, preview: null, parent: null });
    expect(rows[6]).toMatchObject({ key: 0, parent: id('server', 'cors', 'origins'), path: ['server', 'cors', 'origins', 0] });
  });

  test('a scalar root is one row without a key', () => {
    const { rows } = buildRows(parse('"hi"'), { expanded: new Set(), query: '' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'node', key: null, value: '"hi"', path: [] });
  });

  test('long values are cut for display', () => {
    const { rows } = buildRows(parse(JSON.stringify({ s: 'x'.repeat(500) })), { expanded: new Set(), query: '' });
    const v = (rows[0] as Extract<Row, { kind: 'node' }>).value!;
    expect(v.length).toBe(301);
    expect(v.endsWith('…')).toBe(true);
  });
});

describe('buildRows: filter', () => {
  test('matches on keys and scalar values, ancestors open and dimmed, counted', () => {
    const { rows, matches } = buildRows(ROOT, { expanded: new Set(), query: 'REDIS' });
    expect(matches).toBe(2);
    expect(rows.map((r) => [label(r), (r as Extract<Row, { kind: 'node' }>).miss])).toEqual([['cache', true], ['driver', false], ['url', false]]);
    const driver = rows[1] as Extract<Row, { kind: 'node' }>;
    expect(driver.valueHits).toEqual([[1, 6]]);
    expect(driver.keyHits).toEqual([]);
  });

  test('a matching key highlights the key; a matching closed container stays closed', () => {
    const { rows, matches } = buildRows(ROOT, { expanded: new Set(), query: 'pool' });
    expect(matches).toBe(1);
    expect(rows.map(label)).toEqual(['database', 'pool']);
    expect(rows[1]).toMatchObject({ open: false, miss: false, keyHits: [[0, 4]] });
  });

  test('a matching container the user opens shows all its entries', () => {
    const { rows } = buildRows(ROOT, { expanded: new Set([id('database', 'pool')]), query: 'pool' });
    expect(rows.map(label)).toEqual(['database', 'pool', 'min', 'max', 'idleMs']);
    expect(rows[2]).toMatchObject({ miss: false });
  });

  test('no match: no rows', () => {
    expect(buildRows(ROOT, { expanded: new Set(), query: 'zzz' })).toMatchObject({ rows: [], matches: 0 });
  });

  test('several hits in one value', () => {
    const { rows } = buildRows(parse('{"a": "abab"}'), { expanded: new Set(), query: 'ab' });
    expect((rows[0] as Extract<Row, { kind: 'node' }>).valueHits).toEqual([[1, 3], [3, 5]]);
  });
});

describe('chunks', () => {
  const big = (n: number) => parse(JSON.stringify({ list: Array.from({ length: n }, (_, i) => `v${i}`) }));
  test('the bucket size: 100, then 10 000, so a level never has more than 100 rows', () => {
    expect(chunkSize(100)).toBe(0);
    expect(chunkSize(101)).toBe(100);
    expect(chunkSize(10_000)).toBe(100);
    expect(chunkSize(10_001)).toBe(10_000);
  });

  test('over 100 entries: chunk rows with their range and the first and last item as preview', () => {
    const root = big(250);
    const { rows } = buildRows(root, { expanded: new Set([id('list')]), query: '' });
    expect(rows.map(label)).toEqual(['list', '#0-99', '#100-199', '#200-249']);
    expect(rows[1]).toMatchObject({ kind: 'chunk', depth: 1, open: false, preview: '"v0" … "v99"', label: '0 … 99' });
    const open = buildRows(root, { expanded: new Set([id('list'), (rows[2] as Extract<Row, { kind: 'chunk' }>).id]), query: '' }).rows;
    expect(open.map(label).slice(0, 5)).toEqual(['list', '#0-99', '#100-199', '100', '101']);
    expect(open[3]).toMatchObject({ depth: 2, path: ['list', 100] });
  });

  test('chunk labels group thousands; nested chunks', () => {
    const root = big(12_345);
    const { rows } = buildRows(root, { expanded: new Set([id('list')]), query: '' });
    expect(rows.map((r) => (r.kind === 'chunk' ? r.label : label(r)))).toEqual(['list', '0 … 9 999', '10 000 … 12 344']);
    const inner = buildRows(root, { expanded: new Set([id('list'), (rows[2] as Extract<Row, { kind: 'chunk' }>).id]), query: '' }).rows;
    expect(inner.slice(3, 5).map((r) => (r.kind === 'chunk' ? r.label : '?'))).toEqual(['10 000 … 10 099', '10 100 … 10 199']);
  });

  test('object chunks preview their first and last key', () => {
    const o: Record<string, number> = {};
    for (let i = 0; i < 150; i++) o[`node_modules/p${i}`] = i;
    const { rows } = buildRows(parse(JSON.stringify({ packages: o })), { expanded: new Set([id('packages')]), query: '' });
    expect(rows[1]).toMatchObject({ kind: 'chunk', preview: 'node_modules/p0 … node_modules/p99' });
  });

  test('filtering opens only the chunks with matches', () => {
    const { rows, matches } = buildRows(big(250), { expanded: new Set(), query: 'v123' });
    expect(matches).toBe(1);
    expect(rows.map(label)).toEqual(['list', '#100-199', '123']);
  });
});

describe('review fixes', () => {
  test('a key with "#" is a node, not a chunk: its path comes back from its id', () => {
    expect(rowPath(id('#comment', 'a#b'))).toEqual(['#comment', 'a#b']);
    const root = parse(JSON.stringify({ list: Array.from({ length: 150 }, (_, i) => i) }));
    const chunk = buildRows(root, { expanded: new Set([id('list')]), query: '' }).rows[1]!;
    expect(chunk.kind).toBe('chunk');
    expect(rowPath(chunk.id)).toBeNull();
  });
  test('no highlight when lower-casing changes the length (offsets would shift)', () => {
    const { rows, matches } = buildRows(parse('{"a": "İstanbul x"}'), { expanded: new Set(), query: 'x' });
    expect(matches).toBe(1);
    expect((rows[0] as Extract<Row, { kind: 'node' }>).valueHits).toEqual([]);
  });
});

describe('ids', () => {
  test('initial: small files open two levels, large ones nothing', () => {
    expect([...initialExpanded(ROOT, 30)].sort()).toEqual([id('cache'), id('database'), id('database', 'pool'), id('empty'), id('server'), id('server', 'cors'), id('workers')].sort());
    expect(initialExpanded(ROOT, 500).size).toBe(0);
  });
  test('all containers and chunks; a subtree', () => {
    expect(allIds(ROOT)).toContain(id('server', 'cors', 'origins'));
    expect(allIds(ROOT)).not.toContain(id('name'));
    expect(subtreeIds(ROOT, ['server']).sort()).toEqual([id('server'), id('server', 'cors'), id('server', 'cors', 'origins')].sort());
  });
  test('reveal: every ancestor and chunk on the way to a path', () => {
    const root = parse(JSON.stringify({ list: Array.from({ length: 250 }, (_, i) => ({ v: i })) }));
    const ids = revealIds(root, ['list', 150, 'v']);
    const { rows } = buildRows(root, { expanded: new Set(ids), query: '' });
    expect(rows.some((r) => r.kind === 'node' && r.id === id('list', 150, 'v'))).toBe(true);
  });
});

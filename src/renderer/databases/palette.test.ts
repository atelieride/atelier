import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DbCatalog, DbConnState, DbConnView, DbConnection, DbRel, DbRelName } from '@shared/databases';
import { useApp } from '../store';
import { paletteNote, paletteTables, TABLES_SHOWN } from './palette';

// The palette's table results: the tables, views and materialized views of every
// schema of the connected catalog this window shows, found by name ("orders · acme_dev · table"); Enter a preview,
// ⌘Enter kept, ⌥Enter to the side, each in its own schema. Loaded with the palette, never the first paint.
// Which connection that is (Never: none): view.ts.

const C = 'c0123456789ab';
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme_dev', user: 'app',
  tls: 'prefer', ssh: null, scope: { kind: 'project', root: '/p' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const live = (state: DbConnState = 'connected', o: Partial<DbConnection> = {}): DbConnView => ({ conn: conn(o), state, problem: null, server: null, hasPassword: true, provider: null, held: false });
const name = (n: string, kind: DbRelName['kind'] = 'table', schema = 'public'): DbRelName => ({ schema, name: n, kind });
/**
 * A catalog as main sends it: the sidebar's schema (`rels`, public here) and every schema's relations by name (`names`,
 * main's order: public first, then by schema and name).
 */
const catalog = (names: DbRelName[], o: { connId?: string; more?: boolean } = {}): DbCatalog => ({
  connId: o.connId ?? C, database: 'acme', databases: ['acme'], noRels: names.length === 0, schemas: [...new Set(names.map((r) => r.schema))], schema: 'public',
  rels: names.filter((r) => r.schema === 'public').map((r): DbRel => ({ ...r, estimate: null })), enums: [], functions: [], readAt: 1,
  names, namesMore: o.more ?? false
});
const ACME = catalog([
  name('active_customers', 'view'), name('customers'), name('daily_revenue', 'matview'), name('order_items'), name('orders'),
  name('page_views', 'table', 'analytics'), name('orders', 'table', 'archive')
]);

let open: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
beforeEach(() => { open = vi.fn(); useApp.setState({ openDbTab: open }); });
afterEach(() => useApp.setState(useApp.getInitialState(), true));

describe('the rows', () => {
  test('by name, the connection and the kind as the hint, the kind\'s icon (board: "orders · acme_dev · table")', () => {
    const rows = paletteTables(ACME, live(), 'order_');
    // The palette's footer says what ⌘Enter does on it.
    expect(rows[0]).toMatchObject({ kind: 'command', label: 'order_items', hint: 'acme_dev · table', icon: 'dbTable', sendLabel: 'keep open' });
    expect(paletteTables(ACME, live(), 'active')[0]).toMatchObject({ label: 'active_customers', hint: 'acme_dev · view', icon: 'view' });
    expect(paletteTables(ACME, live(), 'revenue')[0]).toMatchObject({ label: 'daily_revenue', hint: 'acme_dev · materialized view', icon: 'matview' });
  });

  test('every schema, not only the sidebar\'s: another schema\'s table is found and opened in its own schema', () => {
    const row = paletteTables(ACME, live(), 'page_views')[0]!;
    expect(row).toMatchObject({ label: 'page_views', hint: 'acme_dev · table' });
    row.run();
    expect(open).toHaveBeenLastCalledWith({ connId: C, schema: 'analytics', name: 'page_views', kind: 'table', view: 'data' }, { preview: true });
  });

  test('two of the same name in different schemas: each hint leads with its schema, each opens its own', () => {
    const rows = paletteTables(ACME, live(), 'orders');
    expect(rows.slice(0, 2).map((r) => [r.label, r.hint])).toEqual([['orders', 'public · acme_dev · table'], ['orders', 'archive · acme_dev · table']]);
    rows[1]!.run();
    expect(open).toHaveBeenLastCalledWith({ connId: C, schema: 'archive', name: 'orders', kind: 'table', view: 'data' }, { preview: true });
    // A name alone in its schema keeps the short hint.
    expect(rows.find((r) => r.label === 'order_items')?.hint).toBe('acme_dev · table');
  });

  test('no names from main (their read failed): the sidebar\'s schema is searched instead', () => {
    const fallback: DbCatalog = { ...ACME, names: [] };
    const row = paletteTables(fallback, live(), 'customers')[0]!;
    expect(row).toMatchObject({ label: 'customers', hint: 'acme_dev · table' });
    row.run();
    expect(open).toHaveBeenLastCalledWith({ connId: C, schema: 'public', name: 'customers', kind: 'table', view: 'data' }, { preview: true });
    // Only what the sidebar shows: another schema's table isn't there — and the group says so.
    expect(paletteTables(fallback, live(), 'page_views')).toEqual([]);
    expect(paletteNote(fallback)).toBe('Searching public only');
    expect(paletteNote({ ...fallback, schema: 'billing' })).toBe('Searching billing only');
    // A database with nothing in it: nothing failed, nothing to say.
    expect(paletteNote({ ...fallback, rels: [] })).toBeNull();
  });

  test('keys are unique across connections, schemas and the palette\'s other rows', () => {
    const keys = paletteTables(ACME, live(), 'orders').map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const k of keys) expect(k.startsWith('dbt-')).toBe(true);
  });

  test('Enter opens a preview, ⌘Enter a kept tab, ⌥Enter to the side — in the table\'s Data view', () => {
    const row = paletteTables(ACME, live(), 'customers')[0]!;
    expect(row.label).toBe('customers');
    const ref = { connId: C, schema: 'public', name: 'customers', kind: 'table', view: 'data' };
    row.run();
    expect(open).toHaveBeenLastCalledWith(ref, { preview: true });
    row.send(false);
    expect(open).toHaveBeenLastCalledWith(ref, { preview: false });
    row.side();
    expect(open).toHaveBeenLastCalledWith(ref, { preview: false, side: true });
    // ⌘⌥Enter: kept, to the side.
    row.send(true);
    expect(open).toHaveBeenLastCalledWith(ref, { preview: false, side: true });
    paletteTables(ACME, live(), 'daily')[0]!.run();
    expect(open).toHaveBeenLastCalledWith({ connId: C, schema: 'public', name: 'daily_revenue', kind: 'matview', view: 'data' }, { preview: true });
  });
});

describe('what it lists', () => {
  test('only while searching: an empty query lists nothing', () => {
    expect(paletteTables(ACME, live(), '')).toEqual([]);
  });

  test('only a connected connection\'s own catalog: none, another connection\'s, or one not connected (any more) lists nothing', () => {
    expect(paletteTables(ACME, null, 'orders')).toEqual([]);
    expect(paletteTables(null, live(), 'orders')).toEqual([]);
    expect(paletteTables(catalog([name('orders')], { connId: 'cother0000000' }), live(), 'orders')).toEqual([]);
    for (const s of ['idle', 'connecting', 'password', 'error'] as const) expect(paletteTables(ACME, live(s), 'orders'), s).toEqual([]);
  });

  test('capped: 10,000 tables give the best few, the closest match first', () => {
    const names = Array.from({ length: 10_000 }, (_, i) => name(`table_${String(i).padStart(5, '0')}`));
    names.splice(5000, 0, name('orders'));
    const big = catalog(names);
    expect(paletteTables(big, live(), 'table')).toHaveLength(TABLES_SHOWN);
    expect(paletteTables(big, live(), 'orders')[0]!.label).toBe('orders');
    expect(TABLES_SHOWN).toBeLessThanOrEqual(8);
    expect(paletteTables(big, live(), 'table', 3)).toHaveLength(3);
  });

  test('past main\'s cap, the group says how many it searched; otherwise nothing', () => {
    const names = Array.from({ length: 10_000 }, (_, i) => name(`t${i}`));
    expect(paletteNote(catalog(names, { more: true }))).toBe('Searched the first 10,000 tables');
    expect(paletteNote(catalog(names))).toBeNull();
    expect(paletteNote(null)).toBeNull();
  });
});

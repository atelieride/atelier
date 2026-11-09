import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbCatalog, type DbCell, type DbConnView, type DbConnection, type DbFk, type DbPage, type DbPeek } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { useApp } from '../store';
import { useInsp, type RowReads, type TabReads } from './inspector-data';
import { INSPECTOR_DEFAULT } from './inspector-model';
import { useInspectorWidth } from './inspector-width';
import { useDb, type DbTabState } from './store';
import { TableView } from './TableView';
import { useTableUi } from './table-view';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// The record view (Tab on a row): the rows' box shows one row, every
// column — the grid's in its order, its JSON columns, then those the chooser hides (read by the row's key) — one field a
// line, name and type on the left, the value whole on the right; JSON as the inspector's lossless tree, the FK
// peek card, Load full value, every mask as the inspector's. The grid stays mounted, hidden; the side inspector too.
// Markup only (the model: record.test.ts; the keys and the layout at every width: the databases e2e).

const C = 'c0123456789ab';
const KEY = `db:${C}/public/orders` as DbTabRef['key'];
const ORDERS: DbTabRef = { key: KEY, connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'data' };
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme', user: 'me', tls: 'prefer', ssh: null,
  scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (c: DbConnection): DbConnView => ({ conn: c, state: 'connected', problem: null, server: null, hasPassword: false, provider: null, held: false });
const CATALOG: DbCatalog = { connId: C, database: 'acme', databases: ['acme'], noRels: false, schemas: ['public'], schema: 'public', rels: [{ schema: 'public', name: 'orders', kind: 'table', estimate: 48210 }], enums: [], functions: [], names: [], namesMore: false, readAt: 1 };
const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});

const ID = col('id', 'int8', 'N', { type: 'bigint', isPk: true, isKey: true, nullable: false });
const CUSTOMER = col('customer_id', 'int8', 'N', { type: 'bigint', isKey: true, nullable: false, fk: { schema: 'public', table: 'customers', column: 'id' } });
const STATUS = col('status', 'order_status', 'E', { typeSchema: 'public', enumValues: ['pending', 'paid', 'shipped', 'refunded', 'failed'] });
const TOTAL = col('total', 'numeric', 'N', { type: 'numeric(10,2)' });
const METADATA = col('metadata', 'jsonb', 'U');
const TAGS = col('tags', 'text', 'S', { type: 'text[]', isArray: true });
const PAID = col('paid_at', 'timestamptz', 'D', { type: 'timestamp with time zone' });
const NOTES = col('notes', 'text', 'S');
const SHOWN = [ID, CUSTOMER, STATUS, TOTAL, METADATA];
const TABLE = [...SHOWN, TAGS, PAID];
const cells = (...v: (string | null)[]): DbCell[] => v.map((x) => ({ v: x }));
const META = '{"source": "checkout", "big": 12345678901234567890, "discount": {"code": "AUTUMN10", "percent": 10}, "email": "mara@lindqvist.example"}';
const ROWS = [cells('10482', '2041', 'paid', '248.00', META), cells('10483', '2041', 'pending', '12.50', '{}'), cells('10484', '2041', 'shipped', '99.00', '{}')];
const ROW_ID = '{"id":"10482"}';
const FK_CUSTOMER: DbFk = { name: 'orders_customer_id_fkey', from: { schema: 'public', table: 'orders', columns: ['customer_id'] }, to: { schema: 'public', table: 'customers', columns: ['id'] }, indexed: true };
const CUSTOMERS: DbPeek = {
  columns: [ID, col('name', 'text', 'S'), col('plan', 'plan_tier', 'E', { enumValues: ['free', 'pro', 'team', 'enterprise'] })],
  row: cells('2041', 'Mara Lindqvist', 'pro')
};
// The row read whole by its key: every column of the table, the hidden ones' values among them.
const READ: DbPeek = { columns: TABLE, row: cells('10482', '2041', 'paid', '248.00', META, '{gift-wrap,priority}', '2026-11-04 18:30:00+01') };

const page = (o: Partial<DbPage> = {}): DbPage => ({ columns: SHOWN, hidden: [], derived: [], rows: ROWS, ms: 3, sql: 'SELECT 1', pk: ['id'], kind: 'table', ...o, rowKey: o.rowKey ?? o.pk ?? ['id'] });
const ok = <T>(v: T) => ({ s: 'ok' as const, id: 1, v });
const row = (r: Partial<RowReads> = {}): RowReads => ({ peeks: { [FK_CUSTOMER.name]: ok(CUSTOMERS) }, full: {}, more: ok(READ), ...r });

function render(o: { st?: Partial<DbTabState>; reads?: Partial<TabReads>; rows?: Record<string, RowReads>; c?: DbConnection } = {}): string {
  const c = o.c ?? conn();
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(c)], catalog: CATALOG, selected: C } });
  const p = o.st?.data ?? page();
  useDb.getState().patchTab(KEY, {
    data: p, rows: p.rows, more: 'end', selection: [0], focus: { row: 0, col: 0 }, columns: SHOWN.map((x) => x.name), tableCols: TABLE, view: 'record', record: 0, ...o.st
  });
  useInsp.setState({ tabs: { [KEY]: { gen: 1, rels: ok({ out: [FK_CUSTOMER], in: [] }), rows: o.rows ?? { [ROW_ID]: row() }, ...o.reads } } });
  return live(createElement(TableView, { tab: ORDERS, conn: c, visible: true, focused: true }));
}
/** The text a reader sees: tags out. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
/** The record view's own markup. */
const rec = (html: string) => html.slice(html.indexOf('<div class="dbrv"'));
/** The field names in order. */
const names = (html: string) => [...rec(html).matchAll(/<span class="dbi-fn-t">([^<]*)<\/span>/g)].map((m) => m[1]);

beforeEach(() => useApp.setState({ dbTabs: [ORDERS], settings: { ...useApp.getState().settings, dbTimes: 'stored' } }));
afterEach(() => {
  useDb.setState(useDb.getInitialState(), true);
  useInsp.setState(useInsp.getInitialState(), true);
  useTableUi.setState(useTableUi.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
  useInspectorWidth.setState({ width: INSPECTOR_DEFAULT });
});

describe('the record view in the rows\' box', () => {
  test('its head: "Row 1 of 3 loaded", the row\'s key; previous disabled on the first row, next not', () => {
    const html = rec(render());
    expect(html).toMatch(/^<div class="dbrv"/);
    expect(text(html)).toContain('Row 1 of 3 loaded');
    expect(html).toMatch(/<span class="dbrv-key mono" data-tip="10482">10482<\/span>/);
    expect(html).toMatch(/<button type="button" class="icon-btn dbrv-ib" aria-label="Previous Row"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button type="button" class="icon-btn dbrv-ib" aria-label="Next Row"[^>]*disabled=""/);
    // The last row: next disabled.
    const last = rec(render({ st: { record: 2 }, rows: { '{"id":"10484"}': row() } }));
    expect(text(last)).toContain('Row 3 of 3 loaded');
    expect(last).toMatch(/aria-label="Next Row"[^>]*disabled=""/);
  });

  test('its body takes the keyboard (in the tab order where the grid was), its text selectable', () => {
    const html = rec(render());
    expect(html).toMatch(/<div class="dbrv-body" tabindex="0" role="group" aria-label="Row 1, every column"/);
  });

  test('the grid stays mounted, hidden (its place comes back with it); the side inspector too, as it was', () => {
    const html = render({ st: { inspector: true } });
    expect(html).toMatch(/<div class="dbt-gridbox" style="display:none">/);
    expect(html).toMatch(/class="dbi" role="complementary" aria-label="Row inspector" tabindex="-1" style="width:340px;display:none"/);
    // On the grid: no record view, the grid and the inspector shown.
    const grid = render({ st: { inspector: true, view: 'grid' } });
    expect(grid).not.toContain('class="dbrv"');
    expect(grid).toMatch(/<div class="dbt-gridbox">/);
    expect(grid).toMatch(/class="dbi" role="complementary" aria-label="Row inspector" tabindex="-1" style="width:340px"/);
  });

  test('every column: the grid\'s in its order, then the ones the chooser hides (read by the row\'s key) under their own label', () => {
    const html = render();
    expect(names(html)).toEqual(['id', 'customer_id', 'status', 'total', 'metadata', 'tags', 'paid_at']);
    const t = text(rec(html));
    expect(t.indexOf('Hidden from the grid')).toBeGreaterThan(t.indexOf('metadata'));
    expect(t.indexOf('Hidden from the grid')).toBeLessThan(t.indexOf('tags'));
    // Their values, as the inspector shows them.
    expect(t).toContain('gift-wrap');
    expect(t).toContain('2 items');
    expect(t).toContain('2026-11-04 18:30:00+01');
    expect(t).toContain('int8 · primary key');
    expect(t).toContain('248.00');
    // Nothing folded: no "N more fields" button.
    expect(html).not.toContain('class="dbi-more"');
  });

  test('every column chosen: no hidden section', () => {
    const t = text(rec(render({ st: { columns: null, tableCols: SHOWN } })));
    expect(t).not.toContain('Hidden from the grid');
  });

  test('the hidden fields being read: each says so in its place', () => {
    const t = text(rec(render({ rows: { [ROW_ID]: row({ more: { s: 'wait', id: 2 } }) } })));
    expect(t.split('Reading…').length - 1).toBe(2);
  });

  test('the hidden fields\' read failed: why, with Retry, in its place', () => {
    const html = rec(render({ rows: { [ROW_ID]: row({ more: { s: 'err', id: 2, p: { kind: 'lost', message: 'The connection was lost' } } }) } }));
    expect(text(html)).toContain('Couldn’t read: The connection was lost');
    expect(html).toMatch(/class="dbi-err" role="alert"/);
  });

  test('no key to read them by: only the fields loaded, and the inspector\'s note', () => {
    const p = page({ pk: [] });
    const html = render({ st: { data: p }, rows: { '#0': row({ more: undefined }) } });
    expect(names(html)).toEqual(['id', 'customer_id', 'status', 'total', 'metadata']);
    expect(text(rec(html))).toContain('No key to read these fields');
    expect(text(rec(html))).not.toContain('not read');
  });

  test('JSON as the inspector\'s lossless tree, with Copy; no JSON view here (it lives in the side inspector)', () => {
    const html = rec(render());
    expect(html).toContain('class="rd-json mono" role="tree"');
    expect(html).toMatch(/<span class="rd-jk">&quot;big&quot;<\/span><span class="rd-jp">: <\/span><span class="rd-j-num">12345678901234567890<\/span>/);
    expect(html).not.toContain('12345678901234567000');
    expect(html).toContain('aria-label="Copy JSON"');
    expect(html).not.toContain('aria-label="Open in JSON View"');
  });

  test('a foreign key\'s value with its peek card (label, chip, Open ›)', () => {
    const html = rec(render());
    expect(html).toMatch(/<span class="dbi-peek-label" data-tip="Mara Lindqvist">Mara Lindqvist<\/span>/);
    expect(html).toMatch(/<button type="button" class="dbi-peek-open" data-tip="Open customers filtered on this row">Open ›<\/button>/);
  });

  test('a cut value: "Showing 64 KB of 12 MB" and Load full value, as the inspector', () => {
    const p = page({ columns: [ID, NOTES], rows: [[{ v: '10482' }, { v: 'x'.repeat(200), cut: 12 * 1024 * 1024 }]] });
    const t = text(rec(render({ st: { data: p, columns: null, tableCols: [ID, NOTES] } })));
    expect(t).toContain('Showing 64 KB of 12 MB');
    expect(t).toContain('Load full value');
  });

  test('Mask values: a masked column, a key inside JSON — as the inspector masks them', () => {
    const EMAIL = col('email', 'text', 'S');
    const p = page({ columns: [...SHOWN, EMAIL], rows: [[...ROWS[0]!, { v: 'ops@acme.test' }]] });
    const t = text(rec(render({ c: conn({ mask: true }), st: { data: p, columns: null, tableCols: [...SHOWN, EMAIL] } })));
    expect(t).toContain('••••••••');
    expect(t).not.toContain('ops@acme.test');
    expect(t).not.toContain('mara@lindqvist.example');
    expect(t).toContain('12345678901234567890');
  });

  test('a row index past the rows loaded (a new first page with fewer rows): the last one', () => {
    expect(text(rec(render({ st: { record: 40 }, rows: { '{"id":"10484"}': row() } })))).toContain('Row 3 of 3 loaded');
  });
});

describe('the toolbar\'s Grid / Record toggle', () => {
  test('a radio group on Data: Grid and Record, icon and label, the one shown checked; ⇥ in their tooltips', () => {
    const html = render();
    expect(html).toContain('role="radiogroup" aria-label="Show the rows as"');
    expect(html).toMatch(/role="radio" aria-checked="false" tabindex="-1" data-value="grid" aria-label="Grid"[^>]*data-kbd="⇥"/);
    expect(html).toMatch(/role="radio" aria-checked="true" tabindex="0" data-value="record" aria-label="Record"[^>]*data-kbd="⇥"/);
    expect(html).toContain('<span class="dbt-rv-label">Grid</span>');
    expect(html).toContain('<span class="dbt-rv-label">Record</span>');
    const grid = render({ st: { view: undefined } });
    expect(grid).toMatch(/role="radio" aria-checked="true" tabindex="0" data-value="grid"/);
  });

  test('not on Structure or Relations (no rows there)', () => {
    useApp.setState({ dbTabs: [{ ...ORDERS, view: 'structure' }] });
    useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(conn())], catalog: CATALOG, selected: C } });
    const html = live(createElement(TableView, { tab: { ...ORDERS, view: 'structure' }, conn: conn(), visible: true, focused: true }));
    expect(html).not.toContain('aria-label="Show the rows as"');
  });
});

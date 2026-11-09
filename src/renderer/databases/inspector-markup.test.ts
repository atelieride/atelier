import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbCatalog, type DbCell, type DbConnView, type DbConnection, type DbFk, type DbPage, type DbPeek, type DbRefCount } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { useApp } from '../store';
import { useInsp, type RowReads, type TabReads } from './inspector-data';
import { INSPECTOR_DEFAULT } from './inspector-model';
import { setInspectorWidth, useInspectorWidth } from './inspector-width';
import { useDb, type DbTabState } from './store';
import { TableView } from './TableView';
import { useTableUi } from './table-view';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// The row inspector beside the grid: fields with their type
// lines and values, the FK peek card, Referenced by, "N more fields" and the hidden fields' read, JSON as a lossless
// tree, Load full value, masks, each section's failure in its place; markup only (the reads: inspector-data.test.ts;
// the helpers: inspector.test.ts; the layout at every width: the e2e layout check on top of the CSS guard here).

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
const CREATED = col('created_at', 'timestamptz', 'D', { type: 'timestamp with time zone' });
const METADATA = col('metadata', 'jsonb', 'U');
const TAGS = col('tags', 'text', 'S', { type: 'text[]', isArray: true });
const PAID = col('paid_at', 'timestamptz', 'D', { type: 'timestamp with time zone' });
const COUPON = col('coupon_code', 'text', 'S', { fk: { schema: 'public', table: 'coupons', column: 'code' } });
const SHOWN = [ID, CUSTOMER, STATUS, TOTAL, CREATED, METADATA];
const TABLE = [...SHOWN, TAGS, PAID, COUPON];
const cells = (...v: (string | null)[]): DbCell[] => v.map((x) => ({ v: x }));
const META = '{"source": "checkout", "cart_id": "c_8f2a91c4", "big": 12345678901234567890, "discount": {"code": "AUTUMN10", "percent": 10}, "gift": false, "email": "mara@lindqvist.example"}';
const ROW = cells('10482', '2041', 'paid', '248.00', '2026-11-04 18:22:07.413+01', META);
const ROW_ID = '{"id":"10482"}';

const FK_CUSTOMER: DbFk = { name: 'orders_customer_id_fkey', from: { schema: 'public', table: 'orders', columns: ['customer_id'] }, to: { schema: 'public', table: 'customers', columns: ['id'] }, indexed: true };
const FK_COUPON: DbFk = { name: 'orders_coupon_code_fkey', from: { schema: 'public', table: 'orders', columns: ['coupon_code'] }, to: { schema: 'public', table: 'coupons', columns: ['code'] }, indexed: true };
const incoming = (table: string, count: number | null, why?: DbRefCount['why']): DbRefCount => ({
  fk: { name: `${table}_order_id_fkey`, from: { schema: 'public', table, columns: ['order_id'] }, to: { schema: 'public', table: 'orders', columns: ['id'] }, indexed: why !== 'no-index' },
  count, ...(why ? { why } : {})
});
const REFS = [incoming('order_items', 3), incoming('payments', 1), incoming('shipments', 1), incoming('refunds', 0)];
const CUSTOMERS: DbPeek = {
  columns: [ID, col('name', 'text', 'S'), col('email', 'text', 'S'), col('plan', 'plan_tier', 'E', { enumValues: ['free', 'pro', 'team', 'enterprise'] }), CREATED],
  row: cells('2041', 'Mara Lindqvist', 'mara@lindqvist.example', 'pro', '2025-03-12 09:00:00+00')
};

const page = (o: Partial<DbPage> = {}): DbPage => ({ columns: SHOWN, hidden: [], derived: [], rows: [ROW], ms: 3, sql: 'SELECT 1', pk: ['id'], kind: 'table', ...o, rowKey: o.rowKey ?? o.pk ?? ['id'] });
const ok = <T>(v: T) => ({ s: 'ok' as const, id: 1, v });
const row = (r: Partial<RowReads> = {}): RowReads => ({ peeks: { [FK_CUSTOMER.name]: ok(CUSTOMERS) }, full: {}, refs: ok(REFS), ...r });

function render(o: { st?: Partial<DbTabState>; reads?: Partial<TabReads>; rows?: Record<string, RowReads>; c?: DbConnection } = {}): string {
  const c = o.c ?? conn();
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(c)], catalog: CATALOG, selected: C } });
  const p = o.st?.data ?? page();
  useDb.getState().patchTab(KEY, {
    data: p, rows: p.rows, more: 'end', inspector: true, selection: [0], focus: { row: 0, col: 0 }, columns: SHOWN.map((x) => x.name), tableCols: TABLE, ...o.st
  });
  useInsp.setState({ tabs: { [KEY]: { gen: 1, rels: ok({ out: [FK_CUSTOMER, FK_COUPON], in: [] }), rows: o.rows ?? { [ROW_ID]: row() }, ...o.reads } } });
  return live(createElement(TableView, { tab: ORDERS, conn: c, visible: true, focused: true }));
}
/** The text a reader sees: tags out. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
/** The inspector's own markup. */
const insp = (html: string) => html.slice(html.indexOf('class="dbi'));

// Times as stored: the same text on every machine.
beforeEach(() => useApp.setState({ dbTabs: [ORDERS], settings: { ...useApp.getState().settings, dbTimes: 'stored' } }));
afterEach(() => {
  useDb.setState(useDb.getInitialState(), true);
  useInsp.setState(useInsp.getInitialState(), true);
  useTableUi.setState(useTableUi.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
  useInspectorWidth.setState({ width: INSPECTOR_DEFAULT });
});

describe('a selected orders row', () => {
  test('the panel: its name, the row\'s key, Fields · JSON, previous and next, close; the splitter 280–560 px', () => {
    const html = insp(render());
    expect(html).toMatch(/^class="dbi" role="complementary" aria-label="Row inspector" tabindex="-1" style="width:340px"/);
    expect(html).toMatch(/role="separator" aria-orientation="vertical" aria-label="Inspector width" tabindex="0" aria-valuenow="340" aria-valuemin="280" aria-valuemax="560"/);
    expect(text(html)).toContain('Row10482');
    expect(html).toMatch(/role="radiogroup" aria-label="Show the row as"/);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Fields</);
    expect(html).toContain('aria-label="Previous Row"');
    expect(html).toContain('aria-label="Next Row"');
    expect(html).toContain('aria-label="Close Inspector"');
  });

  test('fields with their type lines, in the grid\'s order; "3 more fields · tags, paid_at, coupon_code" folded; Referenced by with its counts', () => {
    const html = insp(render());
    const t = text(html);
    expect(t).toContain('int8 · primary key');
    expect(t).toContain('int8 → customers');
    expect(t).toContain('order_status');
    expect(t).toContain('numeric(10,2)');
    expect(t.indexOf('customer_id')).toBeLessThan(t.indexOf('status'));
    expect(t).toContain('3 more fields · tags, paid_at, coupon_code');
    expect(html).toMatch(/<button type="button" class="dbi-more" aria-expanded="false"/);
    expect(t).toContain('Referenced by');
    expect(t).toContain('order_items.order_id3 rows ›');
    expect(t).toContain('payments.order_id1 row ›');
    expect(t).toContain('refunds.order_idnone');
    // "none": nothing to open, its name whole in the tooltip all the same (aria-disabled: a tooltip still shows).
    expect(html).toMatch(/<button type="button" class="dbi-ref is-none" aria-disabled="true" data-tip="refunds.order_id"/);
  });

  test('values as opened: exact digits, the enum\'s chip, the time whole with UTC and unix, every name ellipsized with its tooltip', () => {
    const html = insp(render());
    const t = text(html);
    expect(t).toContain('248.00');
    expect(html).toMatch(/class="dbt-en t1">paid</);
    expect(t).toContain('2026-11-04 18:22:07.413+01');
    expect(t).toMatch(/2026-11-04 17:22:07\.413 UTC · unix 1793812927/);
    expect(html).toMatch(/<span class="dbi-fn"[^>]*data-tip="customer_id"/);
    expect(html).toMatch(/<span class="dbi-ft" data-tip="int8 → customers">/);
  });

  test('the FK peek card: the label, the enum\'s chip, Open ›, the next label and the table under it', () => {
    const html = insp(render());
    expect(html).toMatch(/<span class="dbi-peek-label" data-tip="Mara Lindqvist">Mara Lindqvist<\/span>/);
    expect(html).toMatch(/<span class="dbt-en t1 dbi-peek-chip" data-tip="pro">pro<\/span>/);
    expect(html).toMatch(/<button type="button" class="dbi-peek-open" data-tip="Open customers filtered on this row">Open ›<\/button>/);
    expect(html).toMatch(/<div class="dbi-peek-sub" data-tip="mara@lindqvist.example">/);
    expect(text(html)).toContain('customers · since 2025-03-12');
  });

  test('a JSON value as a tree (depth 3 open) with Copy; every number exactly as Postgres printed it', () => {
    const html = insp(render());
    expect(html).toContain('class="rd-json mono" role="tree"');
    expect(html).toMatch(/<span class="rd-jk">&quot;big&quot;<\/span><span class="rd-jp">: <\/span><span class="rd-j-num">12345678901234567890<\/span>/);
    expect(html).not.toContain('12345678901234567000');
    expect(html).toMatch(/<span class="rd-jk">&quot;percent&quot;<\/span><span class="rd-jp">: <\/span><span class="rd-j-num">10<\/span>/);
    expect(html).toContain('aria-label="Copy JSON"');
    // Its size beside its type ("jsonb · 214 B").
    expect(text(html)).toMatch(/jsonb · \d+ B/);
  });

  test('the JSON view: the whole row as a tree, numbers and JSON as printed, Copy', () => {
    const html = insp(render({ st: { insp: { view: 'json', more: false } } }));
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>JSON</);
    expect(html).toMatch(/<span class="rd-jk">&quot;total&quot;<\/span><span class="rd-jp">: <\/span><span class="rd-j-num">248.00<\/span>/);
    expect(html).toMatch(/<span class="rd-jk">&quot;id&quot;<\/span><span class="rd-jp">: <\/span><span class="rd-j-num">10482<\/span>/);
    expect(html).toContain('aria-label="Copy JSON"');
    expect(text(html)).not.toContain('Referenced by');
  });

  test('no row selected: says so, the panel stays where it is', () => {
    const html = insp(render({ st: { selection: [], focus: null } }));
    expect(html).toMatch(/^class="dbi"/);
    expect(text(html)).toContain('Select a row to see its fields');
    expect(text(html)).not.toContain('Referenced by');
  });

  test('closed, or on Structure: no panel', () => {
    expect(render({ st: { inspector: false } })).not.toContain('class="dbi"');
    useApp.setState({ dbTabs: [{ ...ORDERS, view: 'structure' }] });
    expect(live(createElement(TableView, { tab: { ...ORDERS, view: 'structure' }, conn: conn(), visible: true, focused: true }))).not.toContain('class="dbi"');
  });
});

describe('"N more fields" and the hidden fields\' read', () => {
  const READ: DbPeek = { columns: TABLE, row: cells('10482', '2041', 'paid', '248.00', null, '{}', '{gift-wrap,priority}', '2026-11-04 18:30:00+01', 'AUTUMN10') };
  const COUPONS: DbPeek = { columns: [col('code', 'text', 'S', { isPk: true }), col('percent', 'int4', 'N')], row: cells('AUTUMN10', '10') };

  test('opened, read: the other fields with their values; a hidden foreign key\'s card works after that read', () => {
    const html = insp(render({ st: { insp: { view: 'fields', more: true } }, rows: { [ROW_ID]: row({ more: ok(READ), peeks: { [FK_CUSTOMER.name]: ok(CUSTOMERS), [FK_COUPON.name]: ok(COUPONS) } }) } }));
    expect(html).toMatch(/<button type="button" class="dbi-more" aria-expanded="true"/);
    const t = text(html);
    expect(t).toContain('gift-wrap');
    expect(t).toContain('2 items');
    expect(t).toContain('2026-11-04 18:30:00+01');
    expect(t).toContain('text → coupons');
    // coupons' label column is its code.
    expect(html).toMatch(/<span class="dbi-peek-label" data-tip="AUTUMN10">AUTUMN10<\/span>/);
  });

  test('opened, reading: each field says so in its place', () => {
    const t = text(insp(render({ st: { insp: { view: 'fields', more: true } }, rows: { [ROW_ID]: row({ more: { s: 'wait', id: 2 } }) } })));
    expect(t.split('Reading…').length - 1).toBe(3);
  });

  test('opened, failed: the section says why with Retry (never a global error)', () => {
    const html = insp(render({ st: { insp: { view: 'fields', more: true } }, rows: { [ROW_ID]: row({ more: { s: 'err', id: 2, p: { kind: 'lost', message: 'The connection was lost' } } }) } }));
    expect(text(html)).toContain('Couldn’t read: The connection was lost');
    expect(html).toMatch(/class="dbi-err" role="alert"/);
    expect(html).toMatch(/>Retry<\/button>/);
  });

  test('a table without a primary key: nothing to read them by — said so', () => {
    const t = text(insp(render({ st: { data: page({ pk: [] }), insp: { view: 'fields', more: true } }, rows: { '#0': row() } })));
    expect(t).toContain('No key to read these fields');
  });
});

describe('each section\'s failure in its place (never a global error)', () => {
  test('Referenced by failed: its section says so with Retry; the fields and the card stay', () => {
    const html = insp(render({ rows: { [ROW_ID]: row({ refs: { s: 'err', id: 3, p: { kind: 'canceled', message: 'Stopped after 15 s' } } }) } }));
    expect(text(html)).toContain('Couldn’t count what points at this row');
    expect(text(html)).toContain('Mara Lindqvist');
    expect(html.match(/role="alert"/g)).toHaveLength(1);
  });

  test('the peek failed: the card says so with Retry (a role that can\'t read that table: no Retry, it would fail again)', () => {
    const html = insp(render({ rows: { [ROW_ID]: row({ peeks: { [FK_CUSTOMER.name]: { s: 'err', id: 3, p: { kind: 'lost', message: 'The connection was lost' } } } }) } }));
    expect(text(html)).toContain('Couldn’t read customers');
    expect(text(html)).toContain('The connection was lost');
    expect(html).toMatch(/class="dbi-peek is-err"/);
    expect(html).toMatch(/class="dbi-peek-open"[^>]*>Retry<\/button>/);
    const denied = insp(render({ rows: { [ROW_ID]: row({ peeks: { [FK_CUSTOMER.name]: { s: 'err', id: 3, p: { kind: 'denied', message: 'permission denied for table customers' } } } }) } }));
    expect(text(denied)).toContain('permission denied for table customers');
    expect(denied).not.toMatch(/>Retry<\/button>/);
  });

  test('a dangling key: the card says no row has it', () => {
    expect(text(insp(render({ rows: { [ROW_ID]: row({ peeks: { [FK_CUSTOMER.name]: ok({ ...CUSTOMERS, row: null }) } }) } })))).toContain('No row of customers has this key');
  });

  test('not counted: "Open ›" without a number, the reason in its tooltip', () => {
    const html = insp(render({ rows: { [ROW_ID]: row({ refs: ok([incoming('audit_log', null, 'no-index')]) }) } }));
    expect(text(html)).toContain('audit_log.order_idOpen ›');
    expect(html).toContain('data-tip="Not counted: no index finds these rows"');
  });
});

describe('a cut value (Load full value)', () => {
  const NOTES = col('notes', 'text', 'S');
  const cut = (pk: string[]) => page({ columns: [ID, NOTES], pk, rows: [[{ v: '10482' }, { v: 'x'.repeat(200), cut: 12 * 1024 * 1024 }]] });

  test('"Showing 64 KB of 12 MB" and Load full value', () => {
    const t = text(insp(render({ st: { data: cut(['id']), columns: null, tableCols: [ID, NOTES] } })));
    expect(t).toContain('Showing 64 KB of 12 MB');
    expect(t).toContain('Load full value');
  });

  test('loaded: the whole value, no mark', () => {
    const full = 'whole value '.repeat(10);
    const t = text(insp(render({ st: { data: cut(['id']), columns: null, tableCols: [ID, NOTES] }, rows: { [ROW_ID]: row({ full: { notes: ok(full) } }) } })));
    expect(t).toContain(full);
    expect(t).not.toContain('Showing 64 KB');
  });

  test('no key: "No key to read the whole value"', () => {
    const t = text(insp(render({ st: { data: cut([]), columns: null, tableCols: [ID, NOTES] }, rows: { '#0': row() } })));
    expect(t).toContain('No key to read the whole value');
    expect(t).not.toContain('Load full value');
  });

  test("a bytea: its size is the server's (DbCell.cut), never the cut hex's", () => {
    const BLOB = col('blob', 'bytea', 'U');
    const hex = '\\x' + '89504e470d0a1a0a'.padEnd(2 * 65536, '0');
    const p = page({ columns: [ID, BLOB], rows: [[{ v: '10482' }, { v: hex, cut: 3 * 1024 * 1024 }]] });
    const html = insp(render({ st: { data: p, columns: null, tableCols: [ID, BLOB] } }));
    expect(html).toContain('class="dbt-size">3 MB<');
    expect(html).not.toContain('class="dbt-size">64 KB<');
  });

  test('M4: a cut image is never previewed (half a PNG); after Load full value it is', () => {
    const BLOB = col('blob', 'bytea', 'U');
    const bytes = 100 * 1024;
    const whole = '\\x' + '89504e470d0a1a0a'.padEnd(2 * bytes, '0');
    const p = page({ columns: [ID, BLOB], rows: [[{ v: '10482' }, { v: whole.slice(0, 2 + 2 * 65536), cut: bytes }]] });
    const st = { data: p, columns: null, tableCols: [ID, BLOB] };
    const cutHtml = insp(render({ st }));
    expect(cutHtml).not.toContain('class="dbi-img"');
    expect(text(cutHtml)).toContain('Load full value');
    expect(cutHtml).toContain('PNG');
    const loaded = insp(render({ st, rows: { [ROW_ID]: row({ full: { blob: ok(whole) } }) } }));
    expect(loaded).toContain('<img class="dbi-img" alt="" src="data:image/png;base64,');
    expect(text(loaded)).not.toContain('Load full value');
  });
});

describe('Mask values: everywhere the inspector shows a value', () => {
  test('a masked column\'s field, the card\'s masked lines, a key inside JSON, the JSON view', () => {
    const EMAIL = col('email', 'text', 'S');
    const p = page({ columns: [...SHOWN, EMAIL], rows: [[...ROW, { v: 'ops@acme.test' }]] });
    const fields = text(insp(render({ c: conn({ mask: true }), st: { data: p, columns: null, tableCols: [...SHOWN, EMAIL] } })));
    expect(fields).toContain('••••••••');
    expect(fields).not.toContain('ops@acme.test');
    expect(fields).not.toContain('mara@lindqvist.example');
    expect(fields).toContain('Mara Lindqvist');
    const json = text(insp(render({ c: conn({ mask: true }), st: { data: p, columns: null, tableCols: [...SHOWN, EMAIL], insp: { view: 'json', more: false } } })));
    expect(json).not.toContain('ops@acme.test');
    expect(json).not.toContain('lindqvist');
    expect(json).toContain('12345678901234567890');
  });
});

describe('a composite foreign key (item_notes → order_items)', () => {
  test('one card under its first column, Open › once', () => {
    const NOTE_ID = col('id', 'int4', 'N', { isPk: true, isKey: true });
    const LINE = col('item_line', 'int4', 'N', { isKey: true, fk: { schema: 'public', table: 'order_items', column: 'line' } });
    const ORDER = col('item_order', 'int8', 'N', { isKey: true, fk: { schema: 'public', table: 'order_items', column: 'order_id' } });
    const ITEM: DbFk = { name: 'item_notes_item_fkey', from: { schema: 'public', table: 'item_notes', columns: ['item_line', 'item_order'] }, to: { schema: 'public', table: 'order_items', columns: ['line', 'order_id'] }, indexed: true };
    const ITEMS: DbPeek = { columns: [col('order_id', 'int8', 'N'), col('line', 'int4', 'N'), col('name', 'text', 'S')], row: cells('1', '2', 'Gift wrap') };
    const p = page({ columns: [NOTE_ID, LINE, ORDER], rows: [cells('9', '2', '1')] });
    const html = insp(render({
      st: { data: p, columns: null, tableCols: [NOTE_ID, LINE, ORDER] },
      reads: { rels: ok({ out: [ITEM], in: [] }) }, rows: { '{"id":"9"}': row({ peeks: { [ITEM.name]: ok(ITEMS) }, refs: ok([]) }) }
    }));
    expect(html.match(/class="dbi-peek-open"/g)).toHaveLength(1);
    expect(text(html)).toContain('Gift wrap');
    expect(text(html)).toContain('int4 → order_items');
    // No foreign key points at item_notes: no Referenced by.
    expect(text(html)).not.toContain('Referenced by');
  });
});

describe('the inspector, in detail', () => {
  test('item 1: Mask values on, a masked key column\'s value in the head reads as dots, in its text and its tooltip', () => {
    const EMAIL = col('email', 'text', 'S', { isPk: true, isKey: true, nullable: false });
    const p = page({ columns: [EMAIL, STATUS], pk: ['email'], rows: [cells('ops@acme.test', 'paid')] });
    const html = insp(render({ c: conn({ mask: true }), st: { data: p, columns: null, tableCols: [EMAIL, STATUS] }, rows: { '{"email":"ops@acme.test"}': row({ refs: ok([]) }) } }));
    expect(html).not.toContain('ops@acme.test');
    expect(html).toMatch(/<span class="dbi-key mono" data-tip="••••••••">••••••••<\/span>/);
  });

  test('item 2: a tab too narrow for both — the panel goes over the rows only: the toolbar, the filter bar and the footer stay outside it, on top', () => {
    useTableUi.setState({ widths: { [KEY]: 500 } });
    const html = render();
    const rows = html.indexOf('class="dbt-rows"');
    const panel = html.indexOf('class="dbi is-over"');
    expect(rows).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(rows);
    // In the rows' box: after the bar and the filter bar, before the footer.
    expect(html.indexOf('class="dbt-bar"')).toBeLessThan(rows);
    expect(html.indexOf('class="dbt-fbar')).toBeLessThan(rows);
    expect(html.indexOf('class="dbt-foot"')).toBeGreaterThan(panel);
    // Wide enough: beside the grid, in the same box.
    useTableUi.setState({ widths: { [KEY]: 1200 } });
    const wide = render();
    expect(wide).not.toContain('is-over');
    expect(wide.indexOf('class="dbi"')).toBeLessThan(wide.indexOf('class="dbt-foot"'));
  });

  test('R76: a JSON column shows in Fields after the table\'s, named by its path with its type line, its value as JSON', () => {
    const p = page({
      columns: [ID, METADATA], derived: [{ column: 'metadata', path: ['discount'] }, { column: 'metadata', path: ['big'] }],
      rows: [[...cells('10482', META), { v: '{"code": "AUTUMN10", "percent": 10}' }, { v: '12345678901234567890' }]]
    });
    const html = insp(render({ st: { data: p, columns: null, tableCols: [ID, METADATA] } }));
    const t = text(html);
    expect(t.indexOf('metadata.discount')).toBeGreaterThan(t.indexOf('jsonb'));
    expect(html).toMatch(/<span class="dbi-ft" data-tip="metadata → discount">metadata → discount · \d+ B<\/span>/);
    expect(html).toMatch(/<span class="dbi-ft" data-tip="metadata → big">metadata → big<\/span>/);
    expect(html).toMatch(/<span class="rd-jk">&quot;code&quot;<\/span><span class="rd-jp">: <\/span><span class="rd-j-str">&quot;AUTUMN10&quot;<\/span>/);
    expect(t).toContain('metadata.big');
    expect(t).toContain('12345678901234567890');
  });

  test('R77: Mask values on, a JSON value cut at 64 KB (not whole JSON: no key to mask by) reads as dots, and offers nothing to load', () => {
    const p = page({ rows: [[...ROW.slice(0, 5), { v: '{"email": "ops@acme.test", "note": "' + 'x'.repeat(200), cut: 70_000 }]] });
    const html = insp(render({ c: conn({ mask: true }), st: { data: p } }));
    expect(html).not.toContain('ops@acme.test');
    expect(html).toMatch(/<span class="dbt-mask">••••••••<\/span>/);
  });

  test('item 8: a row gone since (the hidden fields\' read finds none): said once, no Retry, no endless Reading…', () => {
    const t = text(insp(render({ st: { insp: { view: 'fields', more: true } }, rows: { [ROW_ID]: row({ more: ok({ columns: TABLE, row: null }) }) } })));
    expect(t).toContain('This row no longer exists');
    expect(t).not.toContain('Reading…');
    expect(t).not.toContain('Retry');
  });

  test('item 11: no Retry where reading again can\'t help — over 16 MB, a row gone, a role that can\'t read', () => {
    const NOTES = col('notes', 'text', 'S');
    const p = page({ columns: [ID, NOTES], rows: [[{ v: '10482' }, { v: 'x'.repeat(100), cut: 20 * 1024 * 1024 }]] });
    for (const [kind, message] of [['toolarge', 'This value is over 16 MB'], ['norow', 'This row no longer exists'], ['denied', 'permission denied']] as const) {
      const html = insp(render({ st: { data: p, columns: null, tableCols: [ID, NOTES] }, rows: { [ROW_ID]: row({ full: { notes: { s: 'err', id: 4, p: { kind, message } } } }) } }));
      expect(text(html)).toContain(message);
      expect(html, kind).not.toMatch(/>Retry<\/button>/);
    }
    const lost = insp(render({ st: { data: p, columns: null, tableCols: [ID, NOTES] }, rows: { [ROW_ID]: row({ full: { notes: { s: 'err', id: 4, p: { kind: 'lost', message: 'The connection was lost' } } } }) } }));
    expect(lost).toMatch(/>Retry<\/button>/);
  });

  test('item 14: the peek card\'s error line ellipsizes in its own span', () => {
    const html = insp(render({ rows: { [ROW_ID]: row({ peeks: { [FK_CUSTOMER.name]: { s: 'err', id: 3, p: { kind: 'lost', message: 'The connection was lost' } } } }) } }));
    expect(html).toMatch(/<div class="dbi-peek-sub" data-tip="The connection was lost"><span class="dbi-peek-subt">The connection was lost<\/span><\/div>/);
  });

  test('item 15: Mask values on, a masked enum\'s chip shows dots in a neutral tint (no tint from the hidden value)', () => {
    const TOKEN = col('token_state', 'token_state', 'E', { enumValues: ['live', 'revoked', 'expired', 'pending'] });
    const peek = { ...CUSTOMERS, columns: [...CUSTOMERS.columns.slice(0, 3), TOKEN, CREATED], row: cells('2041', 'Mara Lindqvist', 'mara@lindqvist.example', 'expired', null) };
    const html = insp(render({ c: conn({ mask: true }), rows: { [ROW_ID]: row({ peeks: { [FK_CUSTOMER.name]: ok(peek) } }) } }));
    expect(html).not.toContain('expired');
    expect(html).toMatch(/<span class="dbt-en dbi-peek-chip is-masked" data-tip="••••••••">••••••••<\/span>/);
    expect(html).not.toMatch(/class="dbt-en t\d dbi-peek-chip/);
  });

  test('item 9: a foreign key whose value was too long to send says so in its row, the others counted', () => {
    const html = insp(render({ rows: { [ROW_ID]: row({ refs: ok([incoming('order_items', 3), incoming('notes_by_hash', null, 'value')]) }) } }));
    const t = text(html);
    expect(t).toContain('order_items.order_id3 rows ›');
    expect(t).toContain('notes_by_hash.order_idCan’t count: value too long');
  });
});

describe('the inspector, derived columns and more', () => {
  const DERIVED = { column: 'metadata', path: ['discount'] };
  const LABEL = 'metadata.discount';
  const cutPage = () => page({ columns: [ID, METADATA], derived: [DERIVED], rows: [[...cells('10482', META), { v: '{"code": "AUTUMN10", "api_key": "k-1", "percent": [1, 2', cut: 70_000 }]] });

  test('item 1: a JSON column\'s value cut at 64 KB offers Load full value; loaded whole, it shows as a tree', () => {
    const cut = text(insp(render({ st: { data: cutPage(), columns: null, tableCols: [ID, METADATA] } })));
    expect(cut).toContain('Showing 64 KB of');
    expect(cut).toContain('Load full value');
    const whole = insp(render({ st: { data: cutPage(), columns: null, tableCols: [ID, METADATA] }, rows: { [ROW_ID]: row({ full: { [LABEL]: ok('{"tier": "gold", "seats": [1, 2]}') } }) } }));
    const field = whole.slice(whole.indexOf(`data-tip="${LABEL}"`));
    expect(field).toMatch(/^[^]*?class="rd-json mono" role="tree"/);
    expect(field).toMatch(/<span class="rd-jk">&quot;tier&quot;<\/span><span class="rd-jp">: <\/span><span class="rd-j-str">&quot;gold&quot;<\/span>/);
    expect(text(whole)).not.toContain('Load full value');
  });

  test('item 2: Mask values on, a JSON column\'s object cut at 64 KB reads as dots, nothing to load', () => {
    const html = insp(render({ c: conn({ mask: true }), st: { data: cutPage(), columns: null, tableCols: [ID, METADATA] } }));
    expect(html).not.toContain('k-1');
    expect(text(html)).not.toContain('Load full value');
    expect(html.split('<span class="dbt-mask">••••••••</span>').length - 1).toBeGreaterThanOrEqual(1);
  });

  test('item 4: one place in the tab for the panel — inside the rows\' box — beside the grid or over it, so a flip never mounts it again', () => {
    for (const w of [500, 1200]) {
      useTableUi.setState({ widths: { [KEY]: w } });
      const html = render();
      const rows = html.indexOf('class="dbt-rows"');
      const panel = html.indexOf('class="dbi');
      expect(rows, String(w)).toBeGreaterThan(-1);
      expect(panel, String(w)).toBeGreaterThan(rows);
      // Nested in it: the box's div still open where the panel starts.
      let depth = 0;
      for (const m of html.slice(html.lastIndexOf('<', rows), panel).matchAll(/<(\/?)div\b/g)) depth += m[1] ? -1 : 1;
      expect(depth, String(w)).toBeGreaterThan(0);
      expect(html.includes('is-over'), String(w)).toBe(w === 500);
    }
  });
});

describe('the layout at every width (its CSS: tests/integration/databases-inspector.test.ts)', () => {
  test('the peek card at 280 px with a long name and a plan chip: the label whole in its tooltip, the chip in the head and (for a card under ~300 px) the line under it, Open › its own', () => {
    const long = 'Mara Lindqvist-Haraldsdottir of the Very Long Customer Name Studio';
    setInspectorWidth(280);
    const html = insp(render({ rows: { [ROW_ID]: row({ peeks: { [FK_CUSTOMER.name]: ok({ ...CUSTOMERS, row: cells('2041', long, 'mara@lindqvist.example', 'enterprise', null) }) } }) } }));
    expect(html).toMatch(/style="width:280px"/);
    expect(html).toContain(`<span class="dbi-peek-label" data-tip="${long}">${long}</span>`);
    // The chip twice: in the head, and in the first line under it for a card narrower than ~300 px (CSS shows one).
    expect(html.match(/class="dbt-en t3 dbi-peek-chip"/g)).toHaveLength(1);
    expect(html.match(/class="dbt-en t3 dbi-peek-chip is-sub"/g)).toHaveLength(1);
    // The order in the head: label, chip, Open ›; the sub line: the chip before its text (both ellipsize in CSS).
    expect(html).toMatch(/<div class="dbi-peek-head"><span class="dbi-peek-label"[^>]*>[^<]*<\/span><span class="dbt-en t3 dbi-peek-chip"[^>]*>enterprise<\/span><button type="button" class="dbi-peek-open"/);
    expect(html).toMatch(/<div class="dbi-peek-sub" data-tip="mara@lindqvist.example"><span class="dbt-en t3 dbi-peek-chip is-sub"[^>]*>enterprise<\/span><span class="dbi-peek-subt">mara@lindqvist.example<\/span><\/div>/);
  });

  test('a long unbroken value (a hash) stays in the value area, whole: nothing cut it in the markup (CSS breaks it there)', () => {
    const hash = 'a'.repeat(300);
    const NOTE = col('note', 'text', 'S');
    const p = page({ columns: [ID, NOTE], rows: [cells('10482', hash)] });
    setInspectorWidth(280);
    const html = insp(render({ st: { data: p, columns: null, tableCols: [ID, NOTE] } }));
    expect(html).toMatch(new RegExp(`<div class="dbi-fv"><span class="dbi-text">${hash}</span></div>`));
  });
});

describe('the width is the app\'s, not a tab\'s', () => {
  test('the width last chosen in any tab is the one this tab draws — a tab opened since (no state of its own) too', () => {
    expect(insp(render())).toMatch(/^class="dbi"[^>]*style="width:340px"/);
    setInspectorWidth(412);
    expect(insp(render())).toMatch(/^class="dbi"[^>]*style="width:412px"/);
    // The tab closed and opened again: nothing of its own, the app's width.
    useDb.getState().dropTab(KEY);
    expect(useDb.getState().tabs[KEY]).toBeUndefined();
    expect(insp(render())).toMatch(/^class="dbi"[^>]*style="width:412px"/);
    // Its separator says it too.
    expect(insp(render())).toMatch(/role="separator"[^>]*aria-valuenow="412"/);
  });
});

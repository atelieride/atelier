import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbCatalog, type DbCell, type DbConnView, type DbConnection, type DbPage } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { useApp } from '../store';
import { closeColumnMenu, openColumnMenu, useColMenu } from './ColumnMenu';
import { useFilterUi } from './filter-actions';
import { useDb, type DbTabState } from './store';
import { TableView } from './TableView';
import { useTableUi } from './table-view';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// The column menu: a header's chevron or right-click; a JSON column's
// starts with "Keys in these N rows" — each key's path, kind, presence, "+ Column" on hover or focus, "column ✓" when it
// is one —, then Filter by Key…, Sort by Key…, the sorts, Hide Column, Copy Column Name, Copy Column as JSON Lines, Wrap
// Cells; others Sort Ascending, Sort Descending, Filter…, Hide / Remove Column, Copy Column Name. One popover at a time.

const C = 'c0123456789ab';
const KEY = `db:${C}/public/webhook_events` as DbTabRef['key'];
const TAB: DbTabRef = { key: KEY, connId: C, schema: 'public', name: 'webhook_events', kind: 'table', view: 'data' };
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme', user: 'me', tls: 'prefer', ssh: null,
  scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (c: DbConnection): DbConnView => ({ conn: c, state: 'connected', problem: null, server: null, hasPassword: false, provider: null, held: false });
const CATALOG: DbCatalog = { connId: C, database: 'acme', databases: ['acme'], noRels: false, schemas: ['public'], schema: 'public', rels: [{ schema: 'public', name: 'webhook_events', kind: 'table', estimate: 41 }], enums: [], functions: [], names: [], namesMore: false, readAt: 1 };
const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const ID = col('id', 'int8', 'N', { type: 'bigint', isPk: true, isKey: true, nullable: false });
const TYPE = col('type', 'text', 'S');
const PAYLOAD = col('payload', 'jsonb', 'U');
const COLS = [ID, TYPE, PAYLOAD];
const cells = (...v: (string | null)[]): DbCell[] => v.map((x) => ({ v: x }));
const ROWS = [
  cells('1', 'invoice.paid', '{"id": "e1", "created": 1793813327, "data": {"object": {"status": "paid", "customer_email": "a@x.test"}}}'),
  cells('2', 'invoice.open', '{"id": "e2", "created": 1793813400, "data": {"object": {"status": "open"}}, "request": {"id": "r"}}')
];
const page = (o: Partial<DbPage> = {}): DbPage => ({ columns: COLS, hidden: [], derived: [], rows: ROWS, ms: 3, sql: 'SELECT 1', pk: ['id'], kind: 'table', ...o, rowKey: ['id'] });

function render(o: { st?: Partial<DbTabState>; c?: DbConnection; col?: number } = {}): string {
  const c = o.c ?? conn();
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(c)], catalog: CATALOG, selected: C } });
  const p = o.st?.data ?? page();
  useDb.getState().patchTab(KEY, { data: p, rows: p.rows, more: 'end', tableCols: COLS, ...o.st });
  useColMenu.setState({ open: o.col === undefined ? null : { key: KEY, col: o.col } });
  return live(createElement(TableView, { tab: TAB, conn: c, visible: true, focused: true }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const menu = (html: string) => { const i = html.indexOf('class="dbj-cm"'); return i < 0 ? '' : html.slice(i); };

beforeEach(() => useApp.setState({ dbTabs: [TAB] }));
afterEach(() => {
  useDb.setState(useDb.getInitialState(), true);
  useColMenu.setState(useColMenu.getInitialState(), true);
  useFilterUi.setState(useFilterUi.getInitialState(), true);
  useTableUi.setState(useTableUi.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
});

describe('the header opens it', () => {
  test('each header names its column\'s place and has its menu button; a JSON column\'s shows always (its keys live there)', () => {
    const html = render();
    expect(html).toMatch(/<th scope="col" class="dbt-th is-json"[^>]* data-col="2"/);
    expect(html.match(/class="dbt-th-menu" tabindex="-1" aria-label="Column Menu" aria-haspopup="menu" aria-expanded="false"/g)).toHaveLength(3);
    expect(menu(html)).toBe('');
  });
  test('one popover at a time: opening it closes the statement\'s, a filter\'s, the Columns checklist; the same one again closes it', () => {
    useTableUi.setState({ sql: KEY });
    useFilterUi.setState({ pop: { key: KEY, anchor: 'add', edit: null, target: null }, cols: KEY });
    openColumnMenu(KEY, 2);
    expect(useColMenu.getState().open).toEqual({ key: KEY, col: 2 });
    expect(useTableUi.getState().sql).toBeNull();
    expect(useFilterUi.getState()).toMatchObject({ pop: null, cols: null });
    openColumnMenu(KEY, 2);
    expect(useColMenu.getState().open).toBeNull();
    openColumnMenu(KEY, 1);
    closeColumnMenu(KEY);
    expect(useColMenu.getState().open).toBeNull();
  });
  test('open: its header says so', () => {
    expect(render({ col: 2 })).toMatch(/<th scope="col" class="dbt-th is-json is-menu"/);
  });
});

describe('a JSON column\'s menu: "Keys in these N rows" first', () => {
  test('each key: its path (the prefix dim), its kind (unix time too), its presence; "+ Column" for the hover and the keyboard', () => {
    const html = menu(render({ col: 2 }));
    expect(html).toMatch(/^class="dbj-cm" role="menu" aria-label="Column payload"/);
    const t = text(html);
    expect(t).toContain('Keys in these 2 rows');
    expect(t).toContain('present in');
    expect(html).toMatch(/<span class="dbj-cm-path"><span class="dbj-cm-pre">data\.object\.<\/span>status<\/span><span class="dbj-cm-kind">string<\/span><span class="dbj-cm-add">\+ Column<\/span>/);
    expect(html).toMatch(/>created<\/span><span class="dbj-cm-kind">unix time</);
    // Presence: 2 of 2, 1 of 2 — a bar, its count in the tooltip.
    expect(html).toMatch(/data-tip="In 2 of 2 values"><i style="width:100%"/);
    expect(html).toMatch(/data-tip="In 1 of 2 values"><i style="width:50%"/);
  });

  test('a key already a column says so, and adds nothing', () => {
    const p = page({ derived: [{ column: 'payload', path: ['data', 'object', 'status'] }], rows: ROWS.map((r) => [...r, { v: 'paid' }]) });
    const html = menu(render({ col: 2, st: { data: p, rows: p.rows, derived: [{ column: 'payload', path: ['data', 'object', 'status'] }] } }));
    expect(html).toMatch(/aria-disabled="true"[^>]*><span class="dbj-cm-path"><span class="dbj-cm-pre">data\.object\.<\/span>status<\/span><span class="dbj-cm-kind is-shown">column ✓<\/span>/);
  });

  test('a key main would refuse as a column is off, with why; a key "a.b" reads ["a.b"]', () => {
    const long = 'k'.repeat(300);
    const p = page({ rows: [cells('1', 'x', `{"${long}": 1, "a.b": 2, "a": {"b": 3}}`)] });
    const html = menu(render({ col: 2, st: { data: p, rows: p.rows } }));
    expect(html).toMatch(/aria-disabled="true"[^>]*data-tip="A key holds at most 256 characters"><span class="dbj-cm-path"><span class="dbj-cm-pre"><\/span>k{300}<\/span><span class="dbj-cm-kind">number<\/span><span/);
    expect(html).toMatch(/<span class="dbj-cm-path"><span class="dbj-cm-pre"><\/span>\[&quot;a\.b&quot;\]<\/span><span class="dbj-cm-kind">number<\/span><span class="dbj-cm-add">\+ Column/);
    expect(html).toMatch(/<span class="dbj-cm-path"><span class="dbj-cm-pre">a\.<\/span>b<\/span>/);
  });

  test('then its items: Filter by Key…, Sort by Key…, the sorts, Hide Column, Copy Column Name, Copy Column as JSON Lines, Wrap Cells ⌥Z', () => {
    const t = text(menu(render({ col: 2 })));
    const order = ['Filter by Key…', 'Sort by Key…', 'Sort Ascending', 'Sort Descending', 'Hide Column', 'Copy Column Name', 'Copy Column as JSON Lines', 'Wrap Cells'];
    for (let i = 1; i < order.length; i++) expect(t.indexOf(order[i - 1]!), order[i]).toBeLessThan(t.indexOf(order[i]!));
    expect(t).toContain('Wrap Cells⌥Z');
    expect(t).not.toContain('Filter…');
  });

  test('Mask values on: a secret key\'s kind is dots; a masked column has no profile at all', () => {
    const html = menu(render({ col: 2, c: conn({ mask: true }) }));
    expect(html).toMatch(/customer_email<\/span><span class="dbj-cm-kind">••••<\/span>/);
    const SECRET = col('secret_payload', 'jsonb', 'U');
    const p = page({ columns: [ID, TYPE, SECRET] });
    const masked = menu(render({ col: 2, c: conn({ mask: true }), st: { data: p, rows: p.rows, tableCols: [ID, TYPE, SECRET] } }));
    expect(text(masked)).toContain('Values are masked');
    expect(masked).not.toContain('dbj-cm-key');
  });

  test('no object in the rows: said, the items still there', () => {
    const p = page({ rows: [cells('1', 'x', '[1, 2]'), cells('2', 'y', null)] });
    const t = text(menu(render({ col: 2, st: { data: p, rows: p.rows } })));
    expect(t).toContain('No object in these rows');
    expect(t).toContain('Filter by Key…');
  });
});

describe('any other column\'s menu', () => {
  test('Sort Ascending, Sort Descending, Filter…, Hide Column, Copy Column Name, Wrap Cells; no key profile', () => {
    const t = text(menu(render({ col: 1 })));
    expect(t).not.toContain('Keys in');
    const order = ['Sort Ascending', 'Sort Descending', 'Filter…', 'Hide Column', 'Copy Column Name', 'Wrap Cells'];
    for (let i = 1; i < order.length; i++) expect(t.indexOf(order[i - 1]!), order[i]).toBeLessThan(t.indexOf(order[i]!));
  });
  test('a JSON column added from a key: Remove Column (not Hide)', () => {
    const p = page({ derived: [{ column: 'payload', path: ['id'] }], rows: ROWS.map((r) => [...r, { v: 'e1' }]) });
    const t = text(menu(render({ col: 3, st: { data: p, rows: p.rows, derived: [{ column: 'payload', path: ['id'] }] } })));
    expect(t).toContain('Remove Column');
    expect(t).not.toContain('Hide Column');
  });
  test('the only column shown can\'t be hidden: the item says why', () => {
    const p = page({ columns: [TYPE], rows: [cells('a')], pk: [], rowKey: [] });
    const html = menu(render({ col: 0, st: { data: p, rows: p.rows, columns: ['type'] } }));
    expect(html).toMatch(/disabled="" data-tip="The only column shown can’t be hidden"/);
  });
});

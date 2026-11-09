import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbCatalog, type DbCell, type DbConnView, type DbConnection, type DbPage } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { MASK } from '@shared/pg-format';
import { useApp } from '../store';
import { useInsp, type RowReads } from './inspector-data';
import { jsonClosing, openJsonView, takeOpened } from './JsonInspector';
import { JsonRaw } from './JsonRaw';
import { parseJson } from './json-text';
import { secretKey, type JsonNode } from './json';
import { useDb, type DbTabState } from './store';
import { TableView } from './TableView';
import { useTableUi } from './table-view';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// The JSON view, in the row inspector's place: head, find, breadcrumb, the
// tree (virtualized: only the lines on screen), unix times, URLs, strings holding JSON, numbers exactly as printed,
// masks, the bottom bar's Path and SQL, the value's states (NULL, masked, cut with Load full value, no row, not
// loaded), Open in JSON View in the fields. Markup only; the model: json.test.ts; the layout at every width: the CSS guard
// (tests/integration/databases-json.test.ts) and the e2e layout check.

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

const BOARD = '{"id": "evt_1Q8f2aK9", "type": "invoice.paid", "created": 1793813327, "livemode": false, "big": 12345678901234567890, "note": "{\\"gift\\":true}", '
  + '"data": {"object": {"id": "in_1Q8f29K9", "status": "paid", "amount_due": 4900, "customer_email": "mara@lindqvist.example", '
  + '"invoice_pdf": "https://pay.example.com/in_1Q8f29K9/pdf", "lines": {"data": [{"id": "il_1", "price": {"unit_amount": 4900}}, {"id": "il_2", "price": {"unit_amount": 0}}]}}}}';
const cells = (...v: (string | null)[]): DbCell[] => v.map((x) => ({ v: x }));
const ROW = cells('88213', 'invoice.paid', BOARD);
const ROW_ID = '{"id":"88213"}';
const page = (o: Partial<DbPage> = {}): DbPage => ({ columns: COLS, hidden: [], derived: [], rows: [ROW], ms: 3, sql: 'SELECT 1', pk: ['id'], kind: 'table', ...o, rowKey: o.rowKey ?? ['id'] });

function render(o: { st?: Partial<DbTabState>; rows?: Record<string, RowReads>; c?: DbConnection; json?: DbTabState['json'] } = {}): string {
  const c = o.c ?? conn();
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(c)], catalog: CATALOG, selected: C } });
  const p = o.st?.data ?? page();
  useDb.getState().patchTab(KEY, {
    data: p, rows: p.rows, more: 'end', inspector: true, selection: [0], focus: { row: 0, col: 0 }, tableCols: COLS,
    json: o.json === undefined ? { column: 'payload', path: [], from: 'grid' } : o.json, ...o.st
  });
  useInsp.setState({ tabs: { [KEY]: { gen: 1, rels: { s: 'ok', id: 1, v: { out: [], in: [] } }, rows: o.rows ?? { [ROW_ID]: { peeks: {}, full: {}, refs: { s: 'ok', id: 1, v: [] } } } } } });
  return live(createElement(TableView, { tab: TAB, conn: c, visible: true, focused: true }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
const panel = (html: string) => html.slice(html.indexOf('class="dbi'));
const lines = (html: string) => html.match(/role="treeitem"/g)?.length ?? 0;

beforeEach(() => useApp.setState({ dbTabs: [TAB], settings: { ...useApp.getState().settings, dbTimes: 'utc' } }));
afterEach(() => {
  useDb.setState(useDb.getInitialState(), true);
  useInsp.setState(useInsp.getInitialState(), true);
  useTableUi.setState(useTableUi.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
});

describe('the JSON view in the inspector\'s place', () => {
  test('its head: Back, the column, the row and the size, Tree · Table · Raw, Close; the fields are gone', () => {
    const html = panel(render());
    expect(html).toContain('class="dbj"');
    expect(html).not.toContain('class="dbi-head"');
    expect(html).toContain('aria-label="Back to Fields"');
    expect(html).toMatch(/class="dbj-name mono"[^>]*>payload</);
    expect(text(html)).toMatch(/row 88213 · \d+ B/);
    expect(html).toMatch(/role="radiogroup" aria-label="Show the value as"/);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Tree</);
    expect(html).toContain('aria-label="Close Inspector"');
    // Find, Expand all, the breadcrumb.
    expect(html).toContain('placeholder="Find a key or value"');
    expect(text(html)).toContain('Expand all');
    expect(html).toMatch(/<nav class="dbj-crumbs mono" aria-label="Path of the selected node">/);
  });

  test('the tree: keys and values as written, a unix time in their zone, a URL a link with its real target, a string of JSON offers Parse', () => {
    const html = panel(render());
    const t = text(html);
    expect(t).toContain('"big": 12345678901234567890');
    expect(t).not.toContain('12345678901234567000');
    expect(t).toContain('"created": 1793813327');
    expect(t).toContain('2026-11-04 17:28 · unix time');
    expect(html).toMatch(/class="dbj-v is-s dbj-url" data-tip="Open https:\/\/pay\.example\.com\/in_1Q8f29K9\/pdf in your browser"/);
    expect(t).toContain('JSON in a string · Parse');
    // Depth 3 folded at first, with its preview.
    expect(t).toMatch(/"lines": \{…\}▸ 1 key/);
    expect(html).toMatch(/role="tree" tabindex="0" aria-label="payload as a tree"/);
    expect(html).toMatch(/role="treeitem" aria-level="1" aria-selected="true" aria-expanded="true"/);
  });

  test('only the lines on screen are drawn: a value of 900 keys draws a window of them, the scroller holds its full height', () => {
    const wide = `{${Array.from({ length: 900 }, (_, i) => `"k${i}": ${i}`).join(', ')}}`;
    const html = panel(render({ st: { data: page({ rows: [cells('88213', 'x', wide)] }), rows: [cells('88213', 'x', wide)] } }));
    expect(lines(html)).toBeGreaterThan(20);
    expect(lines(html)).toBeLessThan(60);
    expect(html).toContain(`style="height:${902 * 20}px"`);
  });

  test('the bottom bar: Path and SQL of the selected node, each with Copy; the breadcrumb ends with it', () => {
    const html = panel(render({ json: { column: 'payload', path: ['data', 'object', 'amount_due'], from: 'grid' } }));
    const t = text(html);
    expect(t).toContain('Pathdata.object.amount_due');
    expect(t).toContain(`SQL"payload" #>> '{data,object,amount_due}'`);
    expect(html).toContain('aria-label="Copy Path"');
    expect(html).toContain('aria-label="Copy SQL"');
    expect(html).toMatch(/class="dbj-ci is-leaf" style="order:0">.*aria-current="location"[^>]*>amount_due</);
    expect(html).toMatch(/class="dbj-ci" style="order:3"><button[^>]*>payload</);
    // The root: the column itself.
    const root = text(panel(render()));
    expect(root).toContain('Paththe whole value');
    expect(root).toContain('SQL"payload"');
  });

  test('a JSON column\'s object: named by its path, its Path and SQL from the column', () => {
    const p = page({ derived: [{ column: 'payload', path: ['data', 'object'] }], rows: [[...ROW, { v: '{"status": "paid", "amount_due": 4900}' }]] });
    const html = panel(render({ st: { data: p, rows: p.rows }, json: { column: 'payload', base: ['data', 'object'], path: ['status'], from: 'fields' } }));
    const t = text(html);
    expect(html).toMatch(/class="dbj-name mono"[^>]*>payload\.data\.object</);
    expect(t).toContain('Pathdata.object.status');
    expect(t).toContain(`SQL"payload" #>> '{data,object,status}'`);
  });

  test('Mask values on: a secret key\'s value is dots, nowhere in the view the email it hides', () => {
    const html = panel(render({ c: conn({ mask: true }) }));
    expect(html).not.toContain('mara@');
    expect(text(html)).toContain(`"customer_email": "${MASK}"`);
  });

  test('Mask values on: a table under a secret key is off, with why; nothing it hides is drawn', () => {
    const v = '{"api_keys": [{"name": "prod", "key": "sk_live_123"}]}';
    const p = page({ rows: [cells('88213', 'x', v)] });
    const html = panel(render({ c: conn({ mask: true }), st: { data: p, rows: p.rows }, json: { column: 'payload', path: ['api_keys', 0, 'name'], from: 'grid' } }));
    expect(html).toMatch(/data-value="table" disabled="" data-tip="Values are masked: turn Mask values off to see this table"/);
    expect(html).not.toContain('sk_live');
    // Mask off: offered.
    const off = panel(render({ st: { data: p, rows: p.rows }, json: { column: 'payload', path: ['api_keys', 0, 'name'], from: 'grid' } }));
    expect(off).toMatch(/data-value="table"(?! disabled)/);
  });

  test('Table: offered for an array of objects (the selected node or one around it), else off with why', () => {
    const off = panel(render());
    expect(off).toMatch(/role="radio" aria-checked="false" tabindex="-1" data-value="table" disabled="" data-tip="Table needs an array of objects"/);
    const on = panel(render({ json: { column: 'payload', path: ['data', 'object', 'lines', 'data', 0, 'id'], from: 'grid' } }));
    expect(on).toMatch(/data-value="table"(?! disabled)/);
  });
});

describe('a json column keeps what was stored', () => {
  const DUP = '{"a": 1, "plan": "free", "plan": "pro"}';
  const JSONCOL = col('payload', 'json', 'U');
  test('the tree: the last of a repeated key, and a line that says so; none without one', () => {
    const p = page({ columns: [ID, TYPE, JSONCOL], rows: [cells('88213', 'x', DUP)] });
    const html = panel(render({ st: { data: p, rows: p.rows, tableCols: [ID, TYPE, JSONCOL] } }));
    expect(text(html)).toContain('Duplicate keys: the last one counts');
    expect(text(html)).toContain('"plan": "pro"');
    expect(text(html)).not.toContain('"free"');
    expect(text(panel(render()))).not.toContain('Duplicate keys');
  });
  test('Raw: a json column\'s text as stored (repeated keys too), masked as the grid\'s; a jsonb one pretty-printed', () => {
    const tree = parseJson(DUP) as JsonNode;
    expect(text(live(createElement(JsonRaw, { tree, stored: DUP, secret: null })))).toContain(DUP);
    const secretOne = '{"token": "abc",\n  "plan": "pro"}';
    const masked = text(live(createElement(JsonRaw, { tree: parseJson(secretOne) as JsonNode, stored: secretOne, secret: secretKey })));
    expect(masked).toContain(`{"token": "${MASK}",\n  "plan": "pro"}`);
    expect(masked).not.toContain('abc');
    expect(text(live(createElement(JsonRaw, { tree, stored: null, secret: null })))).toContain('{\n  "a": 1,\n  "plan": "pro"\n}');
  });
  test('Raw of a big value: its start, and Copy all', () => {
    const big = `[${Array.from({ length: 60_000 }, (_, i) => i).join(', ')}]`;
    const html = text(live(createElement(JsonRaw, { tree: parseJson(big) as JsonNode, stored: big, secret: null })));
    expect(html).toContain('Showing the first 256 KB');
    expect(html).toContain('Copy all');
    expect(html.length).toBeLessThan(300 * 1024);
  });
});

describe('the value\'s states', () => {
  test('NULL; masked by its column\'s name; no row; a column not loaded', () => {
    expect(text(panel(render({ st: { data: page({ rows: [cells('88213', 'x', null)] }), rows: [cells('88213', 'x', null)] } })))).toContain('This row’s value is NULL');
    const SECRET = col('secret_payload', 'jsonb', 'U');
    const p = page({ columns: [ID, TYPE, SECRET] });
    const masked = panel(render({ c: conn({ mask: true }), st: { data: p, rows: p.rows }, json: { column: 'secret_payload', path: [] } }));
    expect(text(masked)).toContain('Values are masked: turn Mask values off to read this one');
    expect(masked).not.toContain('evt_1Q8f2aK9');
    expect(text(panel(render({ st: { selection: [], focus: null } })))).toContain('Select a row to see its value');
    expect(text(panel(render({ json: { column: 'gone', path: [] } })))).toContain('This column isn’t in the rows loaded');
  });

  test('cut at 64 KB: how much shows and Load full value; read whole, the tree; Mask values on: dots, nothing to load', () => {
    const cut: DbCell[] = [{ v: '88213' }, { v: 'x' }, { v: '{"a": "', cut: 70_000 }];
    const p = page({ rows: [cut] });
    const html = panel(render({ st: { data: p, rows: [cut] } }));
    expect(text(html)).toContain('Showing 64 KB of 68 KB');
    expect(html).toMatch(/<button type="button" class="btn-ghost sm">Load full value<\/button>/);
    const whole = panel(render({ st: { data: p, rows: [cut] }, rows: { [ROW_ID]: { peeks: {}, full: { payload: { s: 'ok', id: 1, v: BOARD } }, refs: { s: 'ok', id: 1, v: [] } } } }));
    expect(text(whole)).toContain('"big": 12345678901234567890');
    expect(text(whole)).toContain('row 88213 · 68 KB');
    const hidden = panel(render({ c: conn({ mask: true }), st: { data: p, rows: [cut] } }));
    expect(text(hidden)).toContain('Values are masked');
    expect(hidden).not.toContain('Load full value');
  });
});

describe('Open in JSON View', () => {
  test('a JSON field has its button beside Copy JSON (a cut one too: the view reads it whole)', () => {
    const html = panel(render({ json: null }));
    expect(html).toMatch(/aria-label="Open in JSON View" data-tip="Open in JSON View" data-json-open="payload"/);
    const cut: DbCell[] = [{ v: '88213' }, { v: 'x' }, { v: '{"a": "', cut: 70_000 }];
    expect(panel(render({ json: null, st: { data: page({ rows: [cut] }), rows: [cut] } }))).toContain('data-json-open="payload"');
    // Not on text.
    expect(panel(render({ json: null }))).not.toContain('data-json-open="type"');
  });

  test('the keyboard comes to the view when it opens, never when it is drawn again', () => {
    openJsonView(KEY, { column: 'payload' }, 'grid');
    expect(takeOpened(KEY)).toBe(true);
    expect(takeOpened(KEY)).toBe(false);
    // Drawn again (a move between windows, a tab shown again): no open, no focus.
    expect(takeOpened('db:other/public/x')).toBe(false);
  });

  test('openJsonView on the view already open on that value leaves no mark: no later redraw takes the keyboard', () => {
    openJsonView(KEY, { column: 'payload' }, 'grid');
    expect(takeOpened(KEY)).toBe(true);
    // The same value again (Open in JSON View pressed in the fields): the view stays mounted (keyed by its value), so a
    // mark would wait for some later mount.
    openJsonView(KEY, { column: 'payload' }, 'fields');
    expect(takeOpened(KEY)).toBe(false);
    // Another value: another view mounts, and takes the keyboard.
    openJsonView(KEY, { column: 'payload', base: ['data'] }, 'fields');
    expect(takeOpened(KEY)).toBe(true);
    openJsonView(KEY, { column: 'payload', base: ['data'] }, 'grid');
    expect(takeOpened(KEY)).toBe(false);
    // Closed, then opened on the same value: a new view, marked again.
    useDb.getState().patchTab(KEY, { json: null });
    openJsonView(KEY, { column: 'payload', base: ['data'] }, 'grid');
    expect(takeOpened(KEY)).toBe(true);
  });

  test('openJsonView: the inspector shows (opened by it, if it was closed), the root selected, where it came from kept', () => {
    openJsonView(KEY, { column: 'payload' }, 'grid');
    expect(useDb.getState().tab(KEY)).toMatchObject({ inspector: true, json: { column: 'payload', path: [], from: 'grid', opened: true } });
    useDb.getState().patchTab(KEY, { json: null });
    openJsonView(KEY, { column: 'payload', base: ['data'] }, 'fields');
    expect(useDb.getState().tab(KEY).json).toEqual({ column: 'payload', base: ['data'], path: [], from: 'fields', opened: false });
  });

  test('closing: Back to the fields; Close shuts the inspector; Esc goes back where it came from (and shuts what it opened)', () => {
    expect(jsonClosing({ column: 'p', path: [], from: 'fields' }, 'back')).toEqual({ patch: { json: null }, focus: 'panel' });
    expect(jsonClosing({ column: 'p', path: [], from: 'grid', opened: true }, 'back')).toEqual({ patch: { json: null }, focus: 'panel' });
    expect(jsonClosing({ column: 'p', path: [], from: 'fields' }, 'close')).toEqual({ patch: { json: null, inspector: false }, focus: 'grid' });
    expect(jsonClosing({ column: 'p', path: [], from: 'fields' }, 'esc')).toEqual({ patch: { json: null }, focus: 'panel' });
    expect(jsonClosing({ column: 'p', path: [], from: 'grid', opened: false }, 'esc')).toEqual({ patch: { json: null }, focus: 'grid' });
    expect(jsonClosing({ column: 'p', path: [], from: 'grid', opened: true }, 'esc')).toEqual({ patch: { json: null, inspector: false }, focus: 'grid' });
  });
});

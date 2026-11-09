import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbCatalog, type DbConnView, type DbConnection, type DbFk, type DbRelations, type DbStructure } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { useApp } from '../store';
import { useDb } from './store';
import { useStruct, type TabStruct } from './structure-data';
import { TableView } from './TableView';
import { useTableUi } from './table-view';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// Structure and Relations: the columns table with its badges and
// FK links, the indexes ("never used" in amber, a partial index's WHERE), constraints and triggers, the Size card, the
// Relations card (nodes as buttons over the edges), the DDL card; a view's definition instead of indexes and
// constraints; each part's failure in its place; the Relations view. Markup only (the reads: structure-data.test.ts).

const C = 'c0123456789ab';
const KEY = `db:${C}/public/orders` as DbTabRef['key'];
const ORDERS: DbTabRef = { key: KEY, connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'structure' };
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme', user: 'me', tls: 'prefer', ssh: null,
  scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (c: DbConnection): DbConnView => ({ conn: c, state: 'connected', problem: null, server: null, hasPassword: false, provider: null, held: false });
const CATALOG: DbCatalog = { connId: C, database: 'acme', databases: ['acme'], noRels: false, schemas: ['public'], schema: 'public', rels: [{ schema: 'public', name: 'orders', kind: 'table', estimate: 48210 }], enums: [], functions: [], names: [], namesMore: false, readAt: 1 };

type StCol = DbStructure['columns'][number];
const col = (name: string, type: string, typeName: string, o: Partial<StCol> = {}): StCol => ({
  name, type, typeSchema: 'pg_catalog', typeName, typeCat: 'S', isArray: false, nullable: false, isPk: false, isKey: false,
  comment: null, identity: false, generated: null, check: null, ...o
});
const MB = 1024 * 1024;
const NOW = Date.now();
const STRUCT: DbStructure = {
  schema: 'public', name: 'orders', kind: 'table', owner: 'app', comment: 'One row per checkout',
  columns: [
    col('id', 'bigint', 'int8', { isPk: true, isKey: true, identity: true }),
    col('customer_id', 'bigint', 'int8', { isKey: true, fk: { schema: 'public', table: 'customers', column: 'id' } }),
    col('status', 'order_status', 'order_status', { typeSchema: 'public', typeCat: 'E', enumValues: ['pending', 'paid', 'shipped', 'refunded', 'failed'], default: "'pending'::order_status" }),
    col('total', 'numeric(10,2)', 'numeric', { default: '0', check: 'CHECK ((total >= (0)::numeric))' }),
    col('metadata', 'jsonb', 'jsonb', { default: "'{}'::jsonb" }),
    col('coupon_code', 'text', 'text', { nullable: true, fk: { schema: 'public', table: 'coupons', column: 'code' } }),
    col('created_at', 'timestamp with time zone', 'timestamptz', { default: 'now()' }),
    col('notes', 'text', 'text', { nullable: true, comment: 'Shown on the packing slip' })
  ],
  indexes: [
    { name: 'orders_pkey', def: 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)', method: 'btree', bytes: 1.1 * MB, scans: 2_100_000, unique: true, primary: true, partial: null, neverUsed: false },
    { name: 'orders_metadata_gin', def: 'CREATE INDEX orders_metadata_gin ON public.orders USING gin (metadata jsonb_path_ops)', method: 'gin', bytes: 2.4 * MB, scans: 0, unique: false, primary: false, partial: null, neverUsed: true },
    { name: 'orders_pending_idx', def: "CREATE INDEX orders_pending_idx ON public.orders USING btree (created_at) WHERE (status = 'pending'::order_status)", method: 'btree', bytes: 40 * 1024, scans: 8200, unique: false, primary: false, partial: "(status = 'pending'::order_status)", neverUsed: false }
  ],
  constraints: [
    { name: 'orders_pkey', kind: 'p', def: 'PRIMARY KEY (id)' },
    { name: 'orders_customer_id_fkey', kind: 'f', def: 'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT' },
    { name: 'orders_total_check', kind: 'c', def: 'CHECK ((total >= (0)::numeric))' },
    { name: 'orders_set_updated_at', kind: 't', def: 'CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION set_updated_at()' }
  ],
  size: { table: 11.2 * MB, indexes: 6.3 * MB, toast: 0.8 * MB, total: 18.3 * MB, measured: true },
  stats: { estimate: 48210, dead: 587, lastAnalyze: new Date(NOW - 2 * 3_600_000).toISOString(), lastVacuum: new Date(NOW - 3 * 3_600_000).toISOString() },
  partitions: [], viewDef: null
};
const fk = (name: string, from: [string, string], to: [string, string]): DbFk => ({
  name, from: { schema: 'public', table: from[0], columns: [from[1]] }, to: { schema: 'public', table: to[0], columns: [to[1]] }, indexed: true
});
const RELS: DbRelations = {
  out: [fk('orders_coupon_code_fkey', ['orders', 'coupon_code'], ['coupons', 'code']), fk('orders_customer_id_fkey', ['orders', 'customer_id'], ['customers', 'id'])],
  in: ['order_items', 'payments', 'refunds', 'shipments'].map((t) => fk(`${t}_order_id_fkey`, [t, 'order_id'], ['orders', 'id']))
};
const DDL = "CREATE TABLE public.orders (\n    id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n    status order_status DEFAULT 'pending'::order_status NOT NULL\n);\n";
const ok = <T>(v: T, id = 1) => ({ id, loading: false, v, at: NOW - 12_000 });

function render(o: { tab?: DbTabRef; parts?: TabStruct; width?: number; c?: DbConnection; held?: boolean } = {}): string {
  const c = o.c ?? conn();
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ ...view(c), held: o.held ?? false }], catalog: CATALOG, selected: C } });
  useStruct.setState({ tabs: { [KEY]: o.parts ?? { structure: ok(STRUCT), relations: ok(RELS), ddl: ok(DDL) } } });
  useTableUi.setState({ widths: { [KEY]: o.width ?? 1180 } });
  return live(createElement(TableView, { tab: o.tab ?? ORDERS, conn: c, visible: true, focused: true }));
}
/** The text a reader sees: tags out. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
/** Where the first element with class token `cls` opens (-1: none). */
const at = (html: string, cls: string) => {
  const i = html.search(new RegExp(`class="(?:[^"]* )?${cls}[ "]`));
  return i < 0 ? -1 : html.lastIndexOf('<', i);
};
const has = (html: string, cls: string) => at(html, cls) >= 0;
/** The markup from the first element with class `cls` to the first with class `until` after it (or the end). */
const block = (html: string, cls: string, until?: string) => {
  const i = at(html, cls);
  if (i < 0) throw new Error(`no .${cls}`);
  const rest = html.slice(i);
  const j = until ? at(rest, until) : -1;
  return j < 0 ? rest : rest.slice(0, j);
};

beforeEach(() => useApp.setState({ dbTabs: [ORDERS] }));
afterEach(() => {
  useDb.setState(useDb.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
  useTableUi.setState(useTableUi.getInitialState(), true);
  useStruct.setState(useStruct.getInitialState(), true);
});

describe('Structure', () => {
  test('in place of the old card: the structure, the rows still mounted and hidden', () => {
    const html = render();
    expect(has(html, 'dbs')).toBe(true);
    expect(html).not.toContain('dk-state-title">Structure<');
    expect(html).toMatch(/<div class="dbt-data" style="display:none">/);
  });

  test('the head: kind, owner and the table\'s comment; a long owner name ellipsizes, whole in its tooltip', () => {
    const html = render();
    expect(text(html)).toContain('table · owner app · “One row per checkout”');
    expect(html).toContain('<span class="dbs-head-owner" data-tip="app">app</span>');
  });

  test('columns: name with its badges, the short type (format_type in the tooltip), null, default, notes', () => {
    const html = render();
    const cols = block(html, 'dbs-cols', 'dbs-idx');
    expect(text(cols)).toMatch(/^Columns8/);
    expect(cols).toMatch(/<span class="dbs-name"[^>]*>id<\/span><span class="dbs-badge is-pk"[^>]*>PK<\/span>/);
    expect(cols).toMatch(/<span class="dbs-name"[^>]*>customer_id<\/span><span class="dbs-badge is-fk"[^>]*>FK<\/span>/);
    expect(cols).toMatch(/<span class="dbs-name"[^>]*>metadata<\/span><span class="dbs-badge is-ix" data-tip="Leads a gin index">GIN<\/span>/);
    expect(cols).toMatch(/<span class="dbs-name"[^>]*>created_at<\/span><span class="dbs-badge is-ix"[^>]*>IDX<\/span>/);
    expect(cols).toContain('data-tip="timestamp with time zone">timestamptz<');
    expect(cols).toContain('data-tip="bigint">int8<');
    expect(text(cols)).toContain('enum · 5 values');
    expect(text(cols)).toContain('check total >= (0)::numeric');
    expect(text(cols)).toContain('“Shown on the packing slip”');
    // An identity's default says so; a long default ellipsizes with its whole text in the tooltip.
    expect(cols).toContain('>identity<');
    expect(cols).toContain('data-tip="&#x27;pending&#x27;::order_status"');
    // Null: "no" quiet, "yes" plain.
    expect(cols).toMatch(/<td class="dbs-null">no<\/td>/);
    expect(cols).toMatch(/<td class="dbs-null is-yes">yes<\/td>/);
  });

  test('300 columns: the table is memoized on its structure (a resize or another part\'s read draws none of its rows again)', async () => {
    const { ColumnsTable } = await import('./StructureView');
    expect((ColumnsTable as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
    const wide: DbStructure = { ...STRUCT, columns: Array.from({ length: 300 }, (_, i) => col(`c${i}`, 'text', 'text')) };
    const html = render({ parts: { structure: ok(wide), relations: ok(RELS), ddl: ok(DDL) } });
    expect(block(html, 'dbs-cols', 'dbs-idx').match(/<tr>/g)).toHaveLength(301);
  });

  test('an FK links to its table: a button (Tab, Enter keeps, Space previews), its target in the tooltip', () => {
    const cols = block(render(), 'dbs-cols');
    expect(cols).toMatch(/<button type="button" class="dbs-fk"[^>]*data-tip="Open customers · ⌥-click to the side"[^>]*>→ customers\.id<\/button>/);
    expect(cols).toMatch(/<button type="button" class="dbs-fk"[^>]*>→ coupons\.code<\/button>/);
  });

  test('indexes: keys, method, size, scans — "never used" in amber for the GIN index, the partial index\'s WHERE', () => {
    const idx = block(render(), 'dbs-idx', 'dbs-con');
    expect(text(idx)).toMatch(/^Indexes3/);
    // Sizes from the statistics: estimates, said so.
    expect(idx).toMatch(/orders_metadata_gin[\s\S]*?\(metadata jsonb_path_ops\)[\s\S]*?gin[\s\S]*?<td class="dbs-num dbs-dim" data-tip="From the statistics[^"]*">~2\.4 MB<\/td>[\s\S]*?<td class="dbs-scans is-never"[^>]*>never used<\/td>/);
    expect(idx).toMatch(/orders_pending_idx[\s\S]*?\(created_at\) <span class="dbs-dim">WHERE status = &#x27;pending&#x27;::order_status<\/span>/);
    expect(idx).toMatch(/orders_pkey<\/span><span class="dbs-badge is-uq"[^>]*>UNIQUE<\/span>/);
    expect(text(idx)).toContain('2.1M scans');
    expect(idx.match(/is-never/g)).toHaveLength(1);
  });

  test('constraints and triggers: the kind\'s words dimmed, a trigger as when → what', () => {
    const con = text(block(render(), 'dbs-con', 'dbs-side'));
    expect(con).toMatch(/^Constraints and triggers4/);
    expect(con).toContain('orders_customer_id_fkeyFOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT');
    expect(con).toContain('orders_set_updated_atTRIGGER BEFORE UPDATE → set_updated_at()');
  });

  test('the Size card: the total, the stacked bar (table, indexes, TOAST), rows and dead rows with when', () => {
    const size = block(render(), 'dbs-size', 'dbs-rel');
    expect(text(size)).toMatch(/^Size18\.3 MB/);
    expect(size).toMatch(/<span class="dbs-bar-part is-table" style="width:61\.2%"[^>]*><\/span><span class="dbs-bar-part is-indexes" style="width:34\.4%"[^>]*><\/span><span class="dbs-bar-part is-toast" style="width:4\.4%"/);
    expect(text(size)).toContain('Table ~11.2 MB');
    expect(text(size)).toContain('Indexes ~6.3 MB');
    // Under a megabyte in kilobytes.
    expect(text(size)).toContain('TOAST ~819 KB');
    expect(text(size)).toContain('Rows~48,210 · analyzed 2 h ago');
    expect(text(size)).toContain('Dead rows1.2% · vacuumed 3 h ago');
  });

  test('the Relations card: nodes are buttons (Tab order: left, then right), this table in the middle, edges behind; Open diagram', () => {
    const rel = block(render(), 'dbs-rel', 'dbs-ddl');
    expect(rel).toMatch(/<button type="button" class="dbs-link"[^>]*>Open diagram ›<\/button>/);
    expect(rel).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(rel.match(/<path /g)).toHaveLength(6);
    const nodes = [...rel.matchAll(/<button type="button" class="dbr-node is-(left|right)"[^>]*>[\s\S]*?<span class="dbr-node-name">([^<]+)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(nodes).toEqual(['left:coupons', 'left:customers', 'right:order_items', 'right:payments', 'right:refunds', 'right:shipments']);
    expect(rel).toMatch(/<div class="dbr-node is-center"[^>]*><span class="dbr-node-name">orders<\/span>/);
    expect(rel).toContain('aria-label="Open order_items · order_items.order_id → orders.id"');
  });

  test('the DDL card: Copy (never wrapping), then Send Schema (the table tab hands it over), the code colored, sideways scroll', () => {
    const ddl = block(render(), 'dbs-ddl');
    expect(ddl).toMatch(/<button type="button" class="btn-ghost sm dbs-copy"[^>]*>[\s\S]*?Copy<\/button><button type="button" class="btn-ghost sm dbs-send"/);
    expect(ddl).toMatch(/<pre class="dbs-code mono"/);
    expect(ddl).toContain('<span class="sq-kw">CREATE</span> <span class="sq-kw">TABLE</span>');
    expect(ddl).toContain('<span class="sq-str">&#x27;pending&#x27;</span>');
    // No session open in this window: named as Redis's item, its press says why.
    expect(ddl).toContain('<span class="dk-ellipsis">Send Schema to Session</span>');
  });

  test('the DDL card says what it is in one quiet line under the code: a readable approximation', () => {
    const ddl = block(render(), 'dbs-ddl');
    const note = 'A readable approximation: storage options, tablespaces and privileges are left out.';
    expect(ddl).toMatch(new RegExp(`</pre><p class="dbs-ddl-note" data-tip="${note}">${note}</p>`));
    // Only with the DDL: nothing under a skeleton or a failure.
    expect(block(render({ parts: { structure: ok(STRUCT), relations: ok(RELS) } }), 'dbs-ddl')).not.toContain('dbs-ddl-note');
  });

  test('a view: its definition in place of indexes and constraints; no Size card, no Relations card (no foreign keys either way)', () => {
    const v: DbStructure = { ...STRUCT, name: 'paid_orders', kind: 'view', indexes: [], constraints: [], size: { table: 0, indexes: 0, toast: 0, total: 0, measured: false }, stats: { estimate: null, dead: null, lastAnalyze: null, lastVacuum: null }, viewDef: " SELECT id,\n    total\n   FROM orders\n  WHERE status = 'paid'::order_status;" };
    const html = render({ parts: { structure: ok(v), relations: ok({ out: [], in: [] }), ddl: ok('CREATE VIEW public.paid_orders AS\n SELECT id;') } });
    expect(text(block(html, 'dbs-def', 'dbs-side'))).toContain("WHERE status = 'paid'::order_status;");
    expect(has(html, 'dbs-idx')).toBe(false);
    expect(has(html, 'dbs-con')).toBe(false);
    expect(has(html, 'dbs-size')).toBe(false);
    expect(has(html, 'dbs-rel')).toBe(false);
    expect(text(html)).toContain('view · owner app');
  });

  test('a materialized view: its definition and its indexes (real ones: the Size card counts them); no constraints, no Relations card', () => {
    const mv = render({ parts: { structure: ok({ ...STRUCT, kind: 'matview', constraints: [], viewDef: ' SELECT 1;' }), relations: ok({ out: [], in: [] }), ddl: ok(DDL) } });
    expect(has(mv, 'dbs-def')).toBe(true);
    expect(text(block(mv, 'dbs-idx', 'dbs-side'))).toMatch(/^Indexes3/);
    expect(has(mv, 'dbs-size')).toBe(true);
    expect(has(mv, 'dbs-con')).toBe(false);
    expect(has(mv, 'dbs-rel')).toBe(false);
    expect(mv.indexOf('class="dbs-sec dbs-def"')).toBeLessThan(mv.indexOf('class="dbs-sec dbs-idx"'));
  });

  test('a partitioned table: its partitions with their bounds, one in another schema named with it; a partitioned index: sizes on the partitions', () => {
    const p: DbStructure = {
      ...STRUCT,
      indexes: [{ ...STRUCT.indexes[0]!, bytes: null }],
      partitions: [
        { schema: 'public', name: 'measurements_2026_10', bound: "FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')" },
        { schema: 'archive', name: 'measurements_2026_10', bound: "FOR VALUES FROM ('2025-10-01') TO ('2025-11-01')" }
      ]
    };
    const html = render({ parts: { structure: ok(p), relations: ok(RELS), ddl: ok(DDL) } });
    const parts = text(block(html, 'dbs-parts', 'dbs-idx'));
    expect(parts).toMatch(/^Partitions2/);
    expect(parts).toContain("measurements_2026_10FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')");
    expect(parts).toContain("archive.measurements_2026_10FOR VALUES FROM ('2025-10-01')");
    expect(block(html, 'dbs-idx', 'dbs-con')).toMatch(/<td class="dbs-num dbs-dim" data-tip="Partitioned: the sizes are on its partitions">—<\/td>/);
  });

  test('never analyzed nor vacuumed: "Not measured yet" in place of the sizes (the bar, the legend, the indexes\')', () => {
    const fresh: DbStructure = { ...STRUCT, size: { ...STRUCT.size, measured: false }, stats: { ...STRUCT.stats, lastAnalyze: null, lastVacuum: null } };
    const html = render({ parts: { structure: ok(fresh), relations: ok(RELS), ddl: ok(DDL) } });
    const size = block(html, 'dbs-size', 'dbs-rel');
    expect(text(size)).toMatch(/^Size—/);
    expect(text(size)).toContain('Not measured yet: ANALYZE fills it in');
    expect(has(size, 'dbs-bar')).toBe(false);
    expect(has(size, 'dbs-legend')).toBe(false);
    expect(text(size)).toContain('never analyzed');
    expect(block(html, 'dbs-idx', 'dbs-con')).not.toMatch(/~[\d.]+ (KB|MB)/);
  });

  test('no indexes, no primary key: the sections stay with their 0 and say so — "No primary key" in amber', () => {
    const bare: DbStructure = { ...STRUCT, indexes: [], constraints: [] };
    const html = render({ parts: { structure: ok(bare), relations: ok(RELS), ddl: ok(DDL) } });
    expect(text(block(html, 'dbs-idx', 'dbs-con'))).toMatch(/^Indexes0No indexes/);
    const con = block(html, 'dbs-con', 'dbs-side');
    expect(text(con)).toMatch(/^Constraints and triggers0No primary key/);
    expect(con).toMatch(/<p class="dbs-empty is-warn"[^>]*>No primary key<\/p>/);
    // Constraints but no primary key: the list, then the amber note.
    const nopk = render({ parts: { structure: ok({ ...STRUCT, constraints: STRUCT.constraints.filter((c) => c.kind !== 'p') }), relations: ok(RELS), ddl: ok(DDL) } });
    expect(text(block(nopk, 'dbs-con', 'dbs-side'))).toMatch(/^Constraints and triggers3[\s\S]*No primary key/);
    // With one: no note.
    expect(text(block(render(), 'dbs-con', 'dbs-side'))).not.toContain('No primary key');
  });

  test('narrow (below ~720 px): one column, the cards under the tables; wide: the side column at its width', () => {
    expect(render({ width: 430 })).toMatch(/<div class="dbs-grid is-stacked">/);
    expect(render({ width: 1180 })).toMatch(/<div class="dbs-grid"><div class="dbs-main">[\s\S]*<div class="dbs-side" style="width:420px">/);
  });

  test('first read: quiet placeholders in each place, no error', () => {
    const html = render({ parts: { structure: { id: 1, loading: true }, relations: { id: 2, loading: true }, ddl: { id: 3, loading: true } } });
    expect(html).toContain('dbs-skel');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="alert"');
  });

  test('each part\'s failure in its place, with Retry where reading again can help (never for a role that can\'t read)', () => {
    const html = render({ parts: {
      structure: { id: 1, loading: false, p: { kind: 'denied', message: 'This role can\'t read public.orders', code: '42501' } },
      relations: { id: 2, loading: false, p: { kind: 'lost', message: 'Reconnecting…' } },
      ddl: ok(DDL)
    } });
    expect(html.match(/role="alert"/g)).toHaveLength(2);
    const main = block(html, 'dbs-main', 'dbs-side');
    expect(text(main)).toContain('Couldn’t read the structure · This role can\'t read public.orders');
    expect(main).not.toContain('>Retry<');
    const rel = block(html, 'dbs-rel', 'dbs-ddl');
    expect(text(rel)).toContain('Couldn’t read the relations');
    expect(rel).toMatch(/<button type="button" class="dbt-link"[^>]*>Retry<\/button>/);
    // The DDL read fine: it shows.
    expect(block(html, 'dbs-ddl')).toContain('sq-kw');
  });

  test('a connection the user disconnected (main\'s hold): the Disconnected card until their Connect; what was read stays shown', () => {
    const held = render({ parts: { relations: ok(RELS) }, held: true });
    expect(held).toContain('>Disconnected</h2>');
    expect(held).toMatch(/<button type="button" class="btn-primary sm"[^>]*>Connect<\/button>/);
    expect(has(held, 'dbs')).toBe(false);
    // Not held: the view as it is.
    expect(has(render({ parts: { relations: ok(RELS) } }), 'dbs')).toBe(true);
    // Every part of the view already read: shown as it is (nothing to read, nothing to hold back).
    expect(has(render({ held: true }), 'dbs-cols')).toBe(true);
    expect(has(render({ tab: { ...ORDERS, view: 'relations' }, parts: { relations: ok(RELS) }, held: true }), 'dbr-view')).toBe(true);
  });

  test('Send Schema to <session>: the seam T29 fills (an optional action), beside Copy', async () => {
    const { StructureView } = await import('./StructureView');
    useStruct.setState({ tabs: { [KEY]: { structure: ok(STRUCT), relations: ok(RELS), ddl: ok(DDL) } } });
    const html = live(createElement(StructureView, { tab: ORDERS, width: 1180, sendSchema: { label: 'db-migration', run: () => {} } }));
    // The session's name ellipsizes: the label in its own span, the whole of it in the tooltip.
    expect(block(html, 'dbs-ddl')).toMatch(/<button type="button" class="btn-ghost sm dbs-send" data-tip="Send Schema to db-migration: the DDL and the relations, typed into its prompt">[\s\S]*?<span class="dk-ellipsis">Send Schema to db-migration<\/span><\/button>/);
    // No session: named as Redis's menu item, the tooltip says why (its press shows the same toast, with Copy).
    const none = live(createElement(StructureView, { tab: ORDERS, width: 1180, sendSchema: { label: null, run: () => {} } }));
    expect(block(none, 'dbs-ddl')).toMatch(/class="btn-ghost sm dbs-send" data-tip="No Claude session to send to: start one first\.">[\s\S]*?<span class="dk-ellipsis">Send Schema to Session<\/span>/);
  });
});

test('a table link (a node, an FK): a click previews, ⌥-click to the side, a double click or Enter keeps; Space is the button\'s own click', async () => {
  // One module for both views' shared pieces.
  const { tableLink } = await import('./structure-ui');
  const open = vi.fn();
  useApp.setState({ openDbTab: open });
  const h = tableLink(C, { schema: 'billing', name: 'plans' });
  const ref = { connId: C, schema: 'billing', name: 'plans', kind: 'table', view: 'data' };
  h.onClick({ altKey: false } as never);
  expect(open).toHaveBeenLastCalledWith(ref, { preview: true });
  h.onClick({ altKey: true } as never);
  expect(open).toHaveBeenLastCalledWith(ref, { preview: false, side: true });
  h.onDoubleClick();
  expect(open).toHaveBeenLastCalledWith(ref, { preview: false });
  const enter = { key: 'Enter', preventDefault: vi.fn() };
  h.onKeyDown(enter as never);
  expect(enter.preventDefault).toHaveBeenCalled();
  expect(open).toHaveBeenCalledTimes(4);
  expect(open).toHaveBeenLastCalledWith(ref, { preview: false });
  const space = { key: ' ', preventDefault: vi.fn() };
  h.onKeyDown(space as never);
  expect(space.preventDefault).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledTimes(4);
});

describe('Relations view (the same layout, bigger)', () => {
  test('the diagram on its own: column heads, nodes with their columns inside, the self loop flagged', () => {
    const self = fk('orders_parent_fkey', ['orders', 'parent_id'], ['orders', 'id']);
    const html = render({ tab: { ...ORDERS, view: 'relations' }, parts: { relations: ok({ out: [...RELS.out, self], in: [...RELS.in, self] }) } });
    const rv = block(html, 'dbr-view');
    expect(text(rv)).toContain('References2');
    expect(text(rv)).toContain('Referenced by4');
    expect(rv).toMatch(/<span class="dbr-node-name">customers<\/span><span class="dbr-node-via">customer_id<\/span>/);
    expect(rv).toMatch(/<path [^>]*class="dbr-edge is-self"/);
    expect(rv).toContain('dbr-node is-center');
    // Nothing of Structure's.
    expect(has(html, 'dbs-cols')).toBe(false);
  });

  test('no relations; a failure with Retry; the first read quiet', () => {
    expect(text(render({ tab: { ...ORDERS, view: 'relations' }, parts: { relations: ok({ out: [], in: [] }) } }))).toContain('No foreign keys point to or from this table.');
    // A view (or a materialized view) can't hold a foreign key, nor be pointed at.
    for (const kind of ['view', 'matview'] as const) {
      expect(text(render({ tab: { ...ORDERS, kind, view: 'relations' }, parts: { relations: ok({ out: [], in: [] }) } }))).toContain('Views have no foreign keys.');
    }
    const failed = render({ tab: { ...ORDERS, view: 'relations' }, parts: { relations: { id: 1, loading: false, p: { kind: 'other', message: 'boom' } } } });
    expect(failed).toContain('role="alert"');
    expect(failed).toMatch(/>Retry</);
    expect(render({ tab: { ...ORDERS, view: 'relations' }, parts: { relations: { id: 1, loading: true } } })).toContain('aria-busy="true"');
  });
});

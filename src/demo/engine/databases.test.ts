import { describe, expect, test } from 'vitest';
import type { DbCell, DbPage, DbPageRequest, DbTableRef } from '@shared/databases';
import type { DbFilter, DbSort } from '@shared/databases-filters';
import { acmeDatabase } from '../world/databases';
import { createDbReads, DbRefusal } from './databases';
import { atJson, cmpDecimal, cmpJson, cmpText, parseJson } from './databases-rows';

// The Databases view's reads in the live demo: what main's DbQueries answers,
// mirrored in plain JS over the world's arrays — pages (columns, hidden keys, derived JSON columns, filters, sorts,
// LIMIT/OFFSET, the 64 KB cut), estimates and counts, the inspector's peeks, references and full values, structure,
// relations and DDL. Values stay text end to end.

const NOW = Date.parse('2026-11-06T09:42:15.877Z');
const db = acmeDatabase(NOW);
const reads = createDbReads(db, { now: () => NOW, rand: () => 0.5 });
const CONN = 'c4cbe2d0a7f13';
const ref = (name: string, schema = 'public'): DbTableRef => ({ connId: CONN, schema, name });
const req = (name: string, o: Partial<DbPageRequest> = {}): DbPageRequest => ({ ref: ref(name), columns: [], derived: [], filters: [], sort: [], page: 0, size: 100, ...o });
const cells = (p: DbPage, name: string) => p.rows.map((r) => r[p.columns.findIndex((c) => c.name === name)]!.v);
const sorted = (name: string, sort: DbSort[], filters: DbFilter[] = []) => reads.page(req(name, { sort, filters, size: 500 }));
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof DbRefusal) return e.problem; throw e; } throw new Error('no refusal'); };

describe('catalog', () => {
  test('public first: its tables and view by name, the enum, the function; every schema\'s names for the palette', () => {
    const c = reads.catalog(null, CONN);
    expect(c).toMatchObject({ connId: CONN, schemas: ['public', 'analytics'], schema: 'public', namesMore: false, readAt: NOW });
    expect(c.rels.map((r) => [r.name, r.kind])).toEqual([
      ['customers', 'table'], ['order_items', 'table'], ['orders', 'table'], ['paid_orders', 'view'], ['payments', 'table'], ['products', 'table'], ['webhook_events', 'table']
    ]);
    expect(c.rels.find((r) => r.name === 'paid_orders')!.estimate).toBeNull();
    expect(c.rels.find((r) => r.name === 'orders')!.estimate).toBe(db.relations.find((r) => r.name === 'orders')!.rows.length);
    expect(c.enums).toEqual([{ schema: 'public', name: 'order_status', values: ['pending', 'paid', 'shipped', 'refunded', 'failed'] }]);
    expect(c.functions).toEqual([{ schema: 'public', name: 'order_total', args: 'bigint', returns: 'numeric', oid: expect.any(Number) }]);
    expect(c.names.map((n) => `${n.schema}.${n.name}`)).toEqual([...c.rels.map((r) => `public.${r.name}`), 'analytics.daily_revenue']);
  });

  test('the database it reads and the server\'s, as main lists them (acme and the maintenance postgres); it holds tables', () => {
    expect(reads.catalog(null, CONN)).toMatchObject({ database: 'acme', databases: ['acme', 'postgres'], noRels: false });
  });

  test('another schema when asked; one that holds nothing falls back to public', () => {
    expect(reads.catalog('analytics', CONN)).toMatchObject({ schema: 'analytics', rels: [{ schema: 'analytics', name: 'daily_revenue', kind: 'table' }], enums: [], functions: [] });
    expect(reads.catalog('nope', CONN).schema).toBe('public');
  });
});

describe('page', () => {
  test('every column as the catalog reads it: types, keys, the enum labels, the foreign key, defaults', () => {
    const p = reads.page(req('orders'));
    const c = (name: string) => p.columns.find((x) => x.name === name);
    expect(c('id')).toEqual({ name: 'id', type: 'bigint', typeSchema: 'pg_catalog', typeName: 'int8', typeCat: 'N', isArray: false, nullable: false, isPk: true, isKey: true });
    expect(c('customer_id')).toMatchObject({ type: 'bigint', isPk: false, isKey: true, fk: { schema: 'public', table: 'customers', column: 'id' } });
    expect(c('status')).toMatchObject({ type: 'order_status', typeSchema: 'public', typeName: 'order_status', typeCat: 'E', enumValues: ['pending', 'paid', 'shipped', 'refunded', 'failed'], default: "'pending'::order_status" });
    expect(c('metadata')).toMatchObject({ type: 'jsonb', typeName: 'jsonb', typeCat: 'U', default: "'{}'::jsonb" });
    expect(c('total')).toMatchObject({ type: 'numeric(10,2)', typeName: 'numeric', isKey: false });
    expect(c('tags')).toMatchObject({ type: 'text[]', typeName: 'text', isArray: true, nullable: true });
    expect(p).toMatchObject({ hidden: [], derived: [], pk: ['id'], rowKey: ['id'], kind: 'table', sql: '' });
    expect(typeof p.ms).toBe('number');
  });

  test('LIMIT/OFFSET by the row key: pages follow one another, none repeated, the last one short', () => {
    const n = db.relations.find((r) => r.name === 'orders')!.rows.length;
    const ids: string[] = [];
    for (let page = 0; page * 100 < n; page++) ids.push(...cells(reads.page(req('orders', { page })), 'id') as string[]);
    expect(ids).toHaveLength(n);
    expect(new Set(ids).size).toBe(n);
    expect(ids).toEqual([...ids].sort((a, b) => cmpDecimal(a, b)));
    expect(reads.page(req('orders', { page: Math.floor(n / 100) })).rows.length).toBe(n % 100);
    expect(reads.page(req('orders', { size: 900 })).rows.length).toBe(Math.min(n, 500));
    expect(refusal(() => reads.page(req('orders', { page: -1 })))).toEqual({ kind: 'other', message: 'A page is a whole number from 0, its size 1–500 rows' });
  });

  test('chosen columns: the row key and every column a foreign key references come along, hidden, last', () => {
    const p = reads.page(req('orders', { columns: ['status', 'total'] }));
    expect(p.columns.map((c) => c.name)).toEqual(['status', 'total', 'id']);
    expect(p.hidden).toEqual(['id']);
    expect(p.rows[0]).toHaveLength(3);
    const items = reads.page(req('order_items', { columns: ['quantity'] }));
    expect(items.hidden).toEqual(['order_id', 'line']);
    expect(items.rowKey).toEqual(['order_id', 'line']);
    expect(refusal(() => reads.page(req('orders', { columns: ['nope'] })))).toEqual({ kind: 'unknown-table', message: 'No column nope in public.orders' });
    expect(refusal(() => reads.page(req('nope')))).toEqual({ kind: 'unknown-table', message: 'No table or view public.nope' });
  });

  test('sorts: numbers as numbers, the enum in its own order, times; NULLs last ascending and first descending; ties by the key', () => {
    const totals = cells(sorted('orders', [{ column: 'total', dir: 'desc' }]), 'total') as string[];
    expect(totals).toEqual([...totals].sort((a, b) => cmpDecimal(b, a)));
    expect(Number(totals[0])).toBeGreaterThan(100);
    const status = cells(sorted('orders', [{ column: 'status', dir: 'asc' }]), 'status') as string[];
    const order = ['pending', 'paid', 'shipped', 'refunded', 'failed'];
    expect(status).toEqual([...status].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    const byStatus = sorted('orders', [{ column: 'status', dir: 'asc' }]);
    const pendingIds = byStatus.rows.filter((r) => r[byStatus.columns.findIndex((c) => c.name === 'status')]!.v === 'pending').map((r) => r[0]!.v!);
    expect(pendingIds).toEqual([...pendingIds].sort((a, b) => cmpDecimal(a, b)));
    const paidAsc = cells(sorted('orders', [{ column: 'paid_at', dir: 'asc' }]), 'paid_at');
    expect(paidAsc.at(-1)).toBeNull();
    expect(paidAsc[0]).not.toBeNull();
    expect(cells(sorted('orders', [{ column: 'paid_at', dir: 'desc' }]), 'paid_at')[0]).toBeNull();
    const created = cells(sorted('orders', [{ column: 'created_at', dir: 'desc' }]), 'id');
    expect(created[0]).toBe('10442');
    const names = cells(sorted('customers', [{ column: 'full_name', dir: 'asc' }]), 'full_name') as string[];
    expect(names.indexOf('Ana Costa')).toBeLessThan(names.indexOf('Marco Rossi'));
  });

  test('a JSON column sorts by a key (as text) and shows one (derived): a big integer stays exact', () => {
    const path = ['parcel', 'id'];
    const p = reads.page(req('webhook_events', { derived: [{ column: 'payload', path }], filters: [{ column: 'source', op: 'eq', values: ['carrier'] }], size: 500 }));
    expect(p.derived).toEqual([{ column: 'payload', path }]);
    const parcel = p.rows.map((r) => r.at(-1)!.v);
    expect(parcel).toContain('1859302233645670401');
    const types = cells(sorted('webhook_events', [{ column: 'payload', path: ['type'], dir: 'asc' }], [{ column: 'source', op: 'eq', values: ['stripe'] }]), 'type') as string[];
    expect(types).toEqual([...types].sort());
    expect(refusal(() => reads.page(req('orders', { derived: [{ column: 'notes', path: ['a'] }] })))).toEqual({ kind: 'other', message: 'notes is not a JSON column' });
  });

  test('filters on every shown type: text (case-insensitive contains), numbers, the enum, times, arrays, booleans', () => {
    const f = (name: string, ...filters: DbFilter[]) => reads.page(req(name, { filters, size: 500 }));
    expect(cells(f('customers', { column: 'email', op: 'contains', values: ['ROSSI'] }), 'email')).toEqual(['m.rossi@example.com']);
    expect(cells(f('customers', { column: 'full_name', op: 'starts', values: ['giulia'] }), 'id')).toEqual(['4022']);
    expect(cells(f('customers', { column: 'id', op: 'eq', values: ['4021'] }), 'full_name')).toEqual(['Marco Rossi']);
    const failed = f('orders', { column: 'status', op: 'in', values: ['failed'] });
    expect(new Set(cells(failed, 'status'))).toEqual(new Set(['failed']));
    expect(cells(failed, 'id')).toContain('10441');
    const between = cells(f('orders', { column: 'total', op: 'between', values: ['50', '60'] }), 'total') as string[];
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((t) => cmpDecimal(t, '50') >= 0 && cmpDecimal(t, '60') <= 0)).toBe(true);
    expect(cells(f('orders', { column: 'created_at', op: 'lastHours', values: ['1'] }), 'id')).toEqual(expect.arrayContaining(['10439', '10440', '10441', '10442']));
    expect(cells(f('orders', { column: 'created_at', op: 'after', values: ['2026-11-06 09:00'] }), 'id')).toEqual(expect.arrayContaining(['10442']));
    const tagged = cells(f('orders', { column: 'tags', op: 'has', values: ['gift-wrap'] }), 'tags') as string[];
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((t) => t.includes('gift-wrap'))).toBe(true);
    expect(cells(f('customers', { column: 'marketing_opt_in', op: 'true', values: [] }), 'marketing_opt_in').every((v) => v === 't')).toBe(true);
    expect(cells(f('orders', { column: 'paid_at', op: 'null', values: [] }), 'paid_at').every((v) => v === null)).toBe(true);
    // Not equals keeps the NULL rows, and so does is none of.
    const all = db.relations.find((r) => r.name === 'orders')!.rows.length;
    const coupon = cells(f('orders', { column: 'coupon', op: 'ne', values: ['AUTUMN10'] }), 'coupon');
    expect(coupon).toContain(null);
    expect(coupon.length + cells(f('orders', { column: 'coupon', op: 'eq', values: ['AUTUMN10'] }), 'id').length).toBe(all);
    expect(cells(f('orders', { column: 'status', op: 'notin', values: ['failed', 'refunded'] }), 'status').every((s) => s !== 'failed' && s !== 'refunded')).toBe(true);
    // Filters AND together.
    expect(cells(f('orders', { column: 'customer_id', op: 'eq', values: ['4021'] }, { column: 'status', op: 'in', values: ['paid'] }), 'customer_id').every((v) => v === '4021')).toBe(true);
  });

  test('JSON path filters: equals and contains at a path (as text), exists, is JSON null', () => {
    const f = (...filters: DbFilter[]) => cells(reads.page(req('webhook_events', { filters, size: 500 })), 'id');
    const parcel = f({ column: 'payload', path: ['parcel', 'id'], op: 'pathEq', values: ['1859302233645670401'] });
    expect(parcel).toHaveLength(1);
    const succeeded = f({ column: 'payload', path: ['type'], op: 'pathEq', values: ['payment_intent.succeeded'] });
    expect(succeeded.length).toBeGreaterThan(0);
    expect(f({ column: 'payload', path: ['type'], op: 'pathContains', values: ['SUCCEEDED'] })).toEqual(succeeded);
    const declined = f({ column: 'payload', path: ['data', 'object', 'last_payment_error', 'code'], op: 'pathEq', values: ['card_declined'] });
    expect(declined.length).toBeGreaterThan(0);
    expect(f({ column: 'payload', path: ['data', 'object', 'last_payment_error'], op: 'pathExists', values: [] })).toEqual(declined);
    const wallet = ['data', 'object', 'charges', 'data', 0, 'payment_method_details', 'card', 'wallet'];
    const nulls = f({ column: 'payload', path: wallet, op: 'pathNull', values: [] });
    expect(nulls.length).toBeGreaterThan(0);
    expect(nulls.length).toBeLessThanOrEqual(succeeded.length);
  });

  test('a filter that does not fit its column is refused, never guessed', () => {
    expect(refusal(() => reads.page(req('orders', { filters: [{ column: 'total', op: 'contains', values: ['5'] }] })))).toEqual({ kind: 'other', message: 'This filter does not fit column total' });
    expect(refusal(() => reads.page(req('orders', { filters: [{ column: 'status', op: 'in', values: ['lost'] }] })))).toEqual({ kind: 'other', message: 'This filter does not fit column status' });
    expect(refusal(() => reads.page(req('orders', { filters: [{ column: 'created_at', op: 'before', values: ['yesterday-ish'] }] })))).toMatchObject({ kind: 'other', code: '22007' });
  });

  test('values past 64 KB arrive cut, with their whole length; every other value whole', () => {
    const p = reads.page(req('webhook_events', { size: 500 }));
    const payloads = p.rows.map((r) => r[p.columns.findIndex((c) => c.name === 'payload')]!);
    const cut = payloads.filter((c): c is Required<DbCell> => c.cut !== undefined);
    expect(cut).toHaveLength(1);
    expect(new TextEncoder().encode(cut[0]!.v!).length).toBe(65_536);
    expect(cut[0]!.cut).toBeGreaterThan(65_536);
    expect(payloads.filter((c) => c.cut === undefined).every((c) => c.v!.length < 65_536)).toBe(true);
  });

  test('a view: its rows in scan order, no key, nothing hidden', () => {
    const p = reads.page(req('paid_orders'));
    expect(p).toMatchObject({ kind: 'view', pk: [], rowKey: [], hidden: [] });
    expect(p.columns.map((c) => c.name)).toEqual(['id', 'customer_id', 'email', 'total', 'currency', 'paid_at']);
    expect(p.columns.every((c) => c.nullable && !c.isPk && !c.fk)).toBe(true);
  });
});

describe('estimate and count', () => {
  test("the table's statistics without filters; the filtered rows otherwise; a view's from its rows", () => {
    const n = db.relations.find((r) => r.name === 'orders')!.rows.length;
    expect(reads.estimate(ref('orders'), [])).toBe(n);
    const failed: DbFilter[] = [{ column: 'status', op: 'in', values: ['failed'] }];
    const count = reads.count(ref('orders'), failed);
    expect(count).toBe(reads.page(req('orders', { filters: failed, size: 500 })).rows.length);
    expect(reads.estimate(ref('orders'), failed)).toBe(count);
    expect(reads.estimate(ref('paid_orders'), [])).toBe(db.relations.find((r) => r.name === 'paid_orders')!.rows.length);
  });
});

describe('the inspector', () => {
  test('peek: the row a foreign key points at, every column; none when nothing is there', () => {
    const p = reads.peek({ ref: ref('customers'), cols: ['id'], values: ['4021'] });
    expect(p.columns.map((c) => c.name)).toEqual(['id', 'email', 'full_name', 'phone', 'locale', 'marketing_opt_in', 'created_at']);
    expect(p.row?.[2]).toEqual({ v: 'Marco Rossi' });
    expect(reads.peek({ ref: ref('customers'), cols: ['id'], values: ['1'] }).row).toBeNull();
  });

  test('the row itself by its key (hidden fields); a key that names no single row is refused', () => {
    const items = reads.page(req('order_items', { size: 1 }));
    const [orderId, line] = [items.rows[0]![0]!.v!, items.rows[0]![1]!.v!];
    expect(reads.peek({ ref: ref('order_items'), cols: ['line', 'order_id'], values: [line, orderId], row: true }).row?.[0]).toEqual({ v: orderId });
    expect(refusal(() => reads.peek({ ref: ref('order_items'), cols: ['order_id'], values: [orderId], row: true }))).toEqual({ kind: 'other', message: 'No key to read this row' });
  });

  test('referenced by: rows pointing at it per foreign key, NULL is none, a value left out is not counted', () => {
    const items = db.relations.find((r) => r.name === 'order_items')!;
    const lines = items.rows.filter((r) => r[0] === '10442').length;
    const refs = reads.refs({ ref: ref('orders'), key: { id: '10442' } });
    expect(refs.map((r) => [r.fk.from.table, r.count])).toEqual([['order_items', lines], ['payments', 1]]);
    expect(refs[0]!.fk).toEqual({ name: 'order_items_order_id_fkey', from: { schema: 'public', table: 'order_items', columns: ['order_id'] }, to: { schema: 'public', table: 'orders', columns: ['id'] }, indexed: true });
    expect(reads.refs({ ref: ref('orders'), key: { id: null } }).map((r) => r.count)).toEqual([0, 0]);
    expect(reads.refs({ ref: ref('orders'), key: {} }).map((r) => [r.count, r.why])).toEqual([[null, 'value'], [null, 'value']]);
    const marco = reads.refs({ ref: ref('customers'), key: { id: '4021' } });
    expect(marco).toHaveLength(1);
    expect(marco[0]!.count).toBe(cells(reads.page(req('orders', { filters: [{ column: 'customer_id', op: 'eq', values: ['4021'] }], size: 500 })), 'id').length);
  });

  test('load full value: the whole text (or the JSON at a path), by a key that names one row', () => {
    const p = reads.page(req('webhook_events', { size: 500 }));
    const k = p.rows.findIndex((r) => r.some((c) => c.cut !== undefined));
    const id = p.rows[k]![0]!.v!;
    const full = reads.full({ ref: ref('webhook_events'), key: { id }, column: 'payload' });
    expect(new TextEncoder().encode(full).length).toBe(p.rows[k]!.find((c) => c.cut !== undefined)!.cut);
    expect(parseJson(full)).toBeDefined();
    const parcelRow = reads.page(req('webhook_events', { filters: [{ column: 'payload', path: ['parcel', 'id'], op: 'pathEq', values: ['1859302233645670401'] }] })).rows[0]!;
    expect(reads.full({ ref: ref('webhook_events'), key: { id: parcelRow[0]!.v! }, column: 'payload', path: ['parcel', 'id'] })).toBe('1859302233645670401');
    expect(reads.full({ ref: ref('orders'), key: { id: '10442' }, column: 'notes' })).toBe('');
    expect(refusal(() => reads.full({ ref: ref('orders'), key: { customer_id: '4021' }, column: 'notes' }))).toEqual({ kind: 'other', message: 'No key to read the whole value' });
    expect(refusal(() => reads.full({ ref: ref('orders'), key: { id: '1' }, column: 'notes' }))).toEqual({ kind: 'norow', message: 'This row no longer exists' });
  });
});

describe('structure, relations, DDL', () => {
  test('orders: columns with notes, checks and identity; the GIN and the partial index; constraints in order; sizes measured', () => {
    const s = reads.structure(ref('orders'));
    expect(s).toMatchObject({ schema: 'public', name: 'orders', kind: 'table', owner: 'postgres', partitions: [], viewDef: null });
    expect(s.comment).toBeTruthy();
    expect(s.columns.find((c) => c.name === 'id')).toMatchObject({ identity: true, generated: null, check: null, comment: null });
    expect(s.columns.find((c) => c.name === 'total')).toMatchObject({ check: 'CHECK ((total >= (0)::numeric))' });
    expect(s.columns.find((c) => c.name === 'metadata')!.comment).toBeTruthy();
    expect(s.indexes.map((i) => i.name)).toEqual(['orders_pkey', 'orders_created_at_idx', 'orders_customer_id_idx', 'orders_metadata_idx', 'orders_pending_idx']);
    expect(s.indexes.find((i) => i.name === 'orders_metadata_idx')).toMatchObject({ method: 'gin', def: 'CREATE INDEX orders_metadata_idx ON public.orders USING gin (metadata jsonb_path_ops)', partial: null });
    expect(s.indexes.find((i) => i.name === 'orders_pending_idx')).toMatchObject({ partial: "(status = 'pending'::order_status)" });
    expect(s.indexes.find((i) => i.name === 'orders_pkey')).toMatchObject({ primary: true, unique: true, neverUsed: false });
    expect(s.constraints.map((k) => k.kind)).toEqual(['p', 'f', 'c']);
    expect(s.size.measured).toBe(true);
    expect(s.size.total).toBe(s.size.table + s.size.indexes + s.size.toast);
    expect(s.stats.estimate).toBe(db.relations.find((r) => r.name === 'orders')!.rows.length);
    // An index nobody uses reads "never used".
    expect(reads.structure(ref('webhook_events')).indexes.find((i) => i.name === 'webhook_events_type_idx')).toMatchObject({ scans: 0, neverUsed: true });
  });

  test('a view: its definition, no indexes nor constraints', () => {
    const s = reads.structure(ref('paid_orders'));
    expect(s).toMatchObject({ kind: 'view', indexes: [], constraints: [], size: { measured: false } });
    expect(s.viewDef).toContain("WHERE o.status = 'paid'::order_status;");
  });

  test('relations: the keys it holds and those pointing at it', () => {
    const r = reads.relations(ref('orders'));
    expect(r.out.map((f) => `${f.name} → ${f.to.table}`)).toEqual(['orders_customer_id_fkey → customers']);
    expect(r.in.map((f) => `${f.from.table}.${f.from.columns.join(',')}`)).toEqual(['order_items.order_id', 'payments.order_id']);
    expect(reads.relations(ref('products')).in.map((f) => f.from.table)).toEqual(['order_items']);
    expect(reads.relations(ref('webhook_events'))).toEqual({ out: [], in: [] });
  });

  test("DDL: the world's text; a function's definition by its arguments; gone when they don't match", () => {
    expect(reads.ddl(ref('orders'))).toBe(db.relations.find((r) => r.name === 'orders')!.ddl);
    expect(reads.ddl({ connId: CONN, schema: 'public', name: 'order_total', args: 'bigint' })).toBe(db.functions[0]!.def);
    expect(refusal(() => reads.ddl({ connId: CONN, schema: 'public', name: 'order_total', args: 'integer' }))).toEqual({ kind: 'gone', message: 'This function no longer exists' });
    expect(refusal(() => reads.ddl(ref('nope')))).toEqual({ kind: 'unknown-table', message: 'No table or view public.nope' });
  });
});

describe('the JSON and number helpers keep values as text', () => {
  test('a lossless parse: integers past 2^53 and decimals keep their digits; #>> reads strings unquoted', () => {
    const j = parseJson('{"a": {"id": 18014398509481985, "x": 1.10, "s": "q\\"uote", "n": null, "l": [1, {"b": true}]}}');
    expect(atJson(j, ['a', 'id'])).toEqual({ text: '18014398509481985', json: '18014398509481985' });
    expect(atJson(j, ['a', 'x'])).toEqual({ text: '1.10', json: '1.10' });
    expect(atJson(j, ['a', 's'])).toEqual({ text: 'q"uote', json: '"q\\"uote"' });
    expect(atJson(j, ['a', 'n'])).toEqual({ text: null, json: 'null' });
    expect(atJson(j, ['a', 'l', 1])).toEqual({ text: '{"b": true}', json: '{"b": true}' });
    expect(atJson(j, ['a', 'missing'])).toBeUndefined();
  });

  test('text sorts by code point, as postgres:16-alpine collates (musl), JSON keys too', () => {
    expect(cmpText('Zoe', 'ana')).toBeLessThan(0);
    expect(cmpText('é', 'z')).toBeGreaterThan(0);
    // Code points, not UTF-16 units: U+FFFD before U+1F600.
    expect(cmpText('�', '😀')).toBeLessThan(0);
    expect(cmpText('ab', 'a')).toBeGreaterThan(0);
    expect(cmpText('x', 'x')).toBe(0);
    expect(cmpJson(parseJson('{"Z": 1}'), parseJson('{"a": 1}'))).toBeLessThan(0);
    const byCodePoint = (a: string, b: string) => { const x = [...a].map((c) => c.codePointAt(0)!); const y = [...b].map((c) => c.codePointAt(0)!); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return x.length - y.length; };
    const names = cells(sorted('customers', [{ column: 'full_name', dir: 'asc' }]), 'full_name') as string[];
    expect(names).toEqual([...names].sort(byCodePoint));
    const emails = cells(sorted('customers', [{ column: 'email', dir: 'desc' }]), 'email') as string[];
    expect(emails).toEqual([...emails].sort(byCodePoint).reverse());
  });

  test('decimals compare exactly, past what a number holds', () => {
    expect(cmpDecimal('9007199254740993', '9007199254740992')).toBe(1);
    expect(cmpDecimal('-2.50', '-2.5')).toBe(0);
    expect(cmpDecimal('10.00', '9.99')).toBe(1);
    expect(cmpDecimal('-1', '0.5')).toBe(-1);
  });
});

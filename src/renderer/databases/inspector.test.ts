import { describe, expect, test } from 'vitest';
import type { DbCell, DbFk, DbPage, DbPeek, DbRefCount } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import type { FormatOpts } from '@shared/pg-format';
import {
  clampWidth, derivedFields, fieldOrder, fkOf, fullRequestOf, hiddenRequest, INSPECTOR_DEFAULT, inspectorLayout, keyFilters, keyOf, labelColumns, peekCard, peekRequest, referencedFilters,
  referencingFilters, refLabel, refRow, refsRequest, resizeStep, rowFields, rowId, rowJsonText, shownRow, typeLine, widthCap
} from './inspector-model';

// The row inspector's pure parts: which columns label a row, the fields in
// grid order and the fold, Referenced by's counts, the row's key, every request built exactly as main's strict schemas
// take it, the FK peek card, the open-with-filters handoff, the panel's width.

const C = 'c0123456789ab';
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
const TABLE = [ID, CUSTOMER, STATUS, TOTAL, CREATED, METADATA, TAGS, PAID, COUPON];
const SHOWN = ['id', 'customer_id', 'status', 'total', 'created_at', 'metadata'];
const O: FormatOpts = { times: 'stored', now: Date.UTC(2026, 10, 5), masked: false, width: 'full' };

const page = (o: Partial<DbPage> = {}): DbPage => ({
  columns: TABLE.slice(0, 6), hidden: [], derived: [], rows: [], ms: 3, sql: '', pk: ['id'], kind: 'table', ...o, rowKey: o.rowKey ?? o.pk ?? ['id']
});
const cells = (...v: (string | null)[]): DbCell[] => v.map((x) => ({ v: x }));
const ROW = cells('10482', '2041', 'paid', '248.00', '2026-11-04 18:22:07.413+01', '{"source": "checkout", "n": 12345678901234567890}');

const ORDERS_CUSTOMER: DbFk = { name: 'orders_customer_id_fkey', from: { schema: 'public', table: 'orders', columns: ['customer_id'] }, to: { schema: 'public', table: 'customers', columns: ['id'] }, indexed: true };
const NOTES_ITEM: DbFk = { name: 'item_notes_item_fkey', from: { schema: 'public', table: 'item_notes', columns: ['item_line', 'item_order'] }, to: { schema: 'public', table: 'order_items', columns: ['line', 'order_id'] }, indexed: true };

describe('labelColumns (the referenced row\'s label)', () => {
  test('the first present of name, title, full_name, display_name, label, email, username, slug, code — then the first enum column', () => {
    const customers = [ID, col('email', 'text', 'S'), col('name', 'text', 'S'), col('plan', 'plan_tier', 'E', { enumValues: ['free', 'pro'] }), CREATED];
    expect(labelColumns(customers)).toEqual(['name', 'plan']);
    expect(labelColumns([ID, col('slug', 'text', 'S'), col('title', 'text', 'S')])).toEqual(['title']);
    expect(labelColumns([ID, col('code', 'text', 'S'), STATUS])).toEqual(['code', 'status']);
    expect(labelColumns([ID, STATUS])).toEqual(['status']);
    expect(labelColumns([ID, TOTAL])).toEqual([]);
  });
});

describe('fieldOrder (the visible columns in grid order, then "N more fields")', () => {
  test('every column shown: all of them, nothing folded', () => {
    expect(fieldOrder(page({ columns: TABLE }), null, TABLE)).toEqual({ shown: TABLE.map((c) => c.name), more: [] });
  });

  test('columns chosen (the Columns chip): those in the grid\'s order, the table\'s others folded in table order — a key kept only to name the row among them', () => {
    const p = page({ columns: [CUSTOMER, STATUS, ID], hidden: ['id'] });
    expect(fieldOrder(p, ['customer_id', 'status'], TABLE)).toEqual({ shown: ['customer_id', 'status'], more: ['id', 'total', 'created_at', 'metadata', 'tags', 'paid_at', 'coupon_code'] });
  });

  test('the table\'s columns not known yet: what the page holds folded, the rest learned by the read', () => {
    const p = page({ columns: [STATUS, ID], hidden: ['id'] });
    expect(fieldOrder(p, ['status'], null)).toEqual({ shown: ['status'], more: ['id'] });
  });
});

describe('refLabel (Referenced by\'s counts, LIMIT 1001)', () => {
  test('none, 1 row, 3 rows, 1,000+ rows', () => {
    expect(refLabel(0)).toBe('none');
    expect(refLabel(1)).toBe('1 row');
    expect(refLabel(3)).toBe('3 rows');
    expect(refLabel(999)).toBe('999 rows');
    expect(refLabel(1000)).toBe('1,000 rows');
    expect(refLabel(1001)).toBe('1,000+ rows');
  });
});

describe('keyOf: the row\'s primary key values (Load full value, the hidden fields\' read, the cache)', () => {
  test('the key\'s columns by name, whatever their place; null without a key', () => {
    expect(keyOf(page(), ROW)).toEqual({ id: '10482' });
    const items = page({ columns: [col('order_id', 'int8', 'N'), col('line', 'int4', 'N'), col('sku', 'text', 'S')], pk: ['order_id', 'line'] });
    expect(keyOf(items, cells('1', '2', 'X'))).toEqual({ order_id: '1', line: '2' });
    expect(keyOf(page({ pk: [] }), ROW)).toBeNull();
  });

  test('no primary key, a unique NOT NULL key — the page\'s row key — names the row', () => {
    const rates = page({ columns: [col('rate', 'numeric', 'N'), col('code', 'text', 'S')], pk: [], rowKey: ['code'], hidden: ['code'] });
    expect(keyOf(rates, cells('1.08', 'USD'))).toEqual({ code: 'USD' });
    expect(rowId(rates, cells('1.08', 'USD'), 3)).toBe('{"code":"USD"}');
    expect(hiddenRequest({ connId: C, schema: 'public', name: 'currency_rates' }, rates, cells('1.08', 'USD'))).toEqual({
      ref: { connId: C, schema: 'public', name: 'currency_rates' }, cols: ['code'], values: ['USD'], row: true
    });
  });

  test('a key main\'s schema can\'t take — not loaded, NULL, cut, over 10,000 characters — is none', () => {
    expect(keyOf(page({ pk: ['nope'] }), ROW)).toBeNull();
    expect(keyOf(page(), cells(null))).toBeNull();
    expect(keyOf(page(), [{ v: 'x', cut: 70_000 }])).toBeNull();
    expect(keyOf(page(), cells('x'.repeat(10_001)))).toBeNull();
  });
});

describe('which row it shows, and its cache key', () => {
  const rows = [ROW, ROW, ROW];
  test('the focused row; none focused, the last selected; a row no longer loaded is none', () => {
    expect(shownRow({ focus: { row: 2, col: 0 }, selection: [0, 1, 2], rows })).toBe(2);
    expect(shownRow({ focus: null, selection: [0, 1], rows })).toBe(1);
    expect(shownRow({ focus: null, selection: [], rows })).toBeNull();
    expect(shownRow({ focus: { row: 7, col: 0 }, selection: [7], rows })).toBeNull();
  });

  test('its primary key\'s values; without one, its place among the rows loaded (the cache is per page)', () => {
    expect(rowId(page(), ROW, 4)).toBe('{"id":"10482"}');
    expect(rowId(page({ pk: [] }), ROW, 4)).toBe('#4');
  });
});

describe('requests, exactly as main\'s strict schemas take them', () => {
  const ref = { connId: C, schema: 'public', name: 'orders' };

  test('Referenced by: every loaded value a key could hold (NULL as null), nothing cut or too long; the names only', () => {
    const p = page({ columns: [ID, TOTAL, METADATA] });
    const r = refsRequest(ref, p, [{ v: '7' }, { v: null }, { v: 'x'.repeat(10_001) }]);
    expect(r).toEqual({ ref, key: { id: '7', total: null } });
    expect(Object.keys(r).sort()).toEqual(['key', 'ref']);
    expect(Object.keys(r.ref).sort()).toEqual(['connId', 'name', 'schema']);
    expect(refsRequest(ref, page({ columns: [ID] }), [{ v: '7', cut: 90_000 }]).key).toEqual({});
  });

  test('Referenced by on a table wider than main\'s 200-column key: the primary key and the keys main added first, 200 at most', () => {
    const wide = Array.from({ length: 250 }, (_, i) => col(`c${i}`, 'text', 'S'));
    const p = page({ columns: [...wide, ID, col('code', 'text', 'S')], pk: ['id'], hidden: ['code'] });
    const key = refsRequest(ref, p, [...wide.map(() => ({ v: 'x' })), { v: '7' }, { v: 'K1' }]).key;
    expect(Object.keys(key)).toHaveLength(200);
    expect(key.id).toBe('7');
    expect(key.code).toBe('K1');
  });

  test('the FK peek: the target table, its key columns, this row\'s values in the key\'s order — a composite key whole', () => {
    expect(fkOf('customer_id', [ORDERS_CUSTOMER])).toBe(ORDERS_CUSTOMER);
    expect(fkOf('status', [ORDERS_CUSTOMER])).toBeNull();
    const vals: Record<string, DbCell> = { customer_id: { v: '2041' } };
    expect(peekRequest(C, ORDERS_CUSTOMER, (c) => vals[c])).toEqual({ ref: { connId: C, schema: 'public', name: 'customers' }, cols: ['id'], values: ['2041'] });
    const note: Record<string, DbCell> = { item_line: { v: '2' }, item_order: { v: '1' } };
    const r = peekRequest(C, NOTES_ITEM, (c) => note[c])!;
    expect(r).toEqual({ ref: { connId: C, schema: 'public', name: 'order_items' }, cols: ['line', 'order_id'], values: ['2', '1'] });
    // The request's arrays are its own (the catalog's stay as they are).
    expect(r.cols).not.toBe(NOTES_ITEM.to.columns);
  });

  test('no peek when the key isn\'t whole: a NULL in it (MATCH SIMPLE: no reference), a value not read yet, cut or too long', () => {
    expect(peekRequest(C, NOTES_ITEM, (c) => ({ item_line: { v: null }, item_order: { v: '1' } } as Record<string, DbCell>)[c])).toBeNull();
    expect(peekRequest(C, NOTES_ITEM, (c) => ({ item_order: { v: '1' } } as Record<string, DbCell>)[c])).toBeNull();
    expect(peekRequest(C, ORDERS_CUSTOMER, () => ({ v: '1', cut: 70_000 }))).toBeNull();
    expect(peekRequest(C, ORDERS_CUSTOMER, () => ({ v: '9'.repeat(10_001) }))).toBeNull();
  });

  test('the hidden fields\' read: this table by its primary key, every column back', () => {
    // The row itself (main checks the key names one row).
    expect(hiddenRequest(ref, page(), ROW)).toEqual({ ref, cols: ['id'], values: ['10482'], row: true });
    expect(hiddenRequest(ref, page({ pk: [] }), ROW)).toBeNull();
  });
});

describe('keyFilters: Open › and "N rows ›" open the other table filtered on the key', () => {
  test('one filter per key column, the operator its type takes for "is this value"', () => {
    expect(keyFilters([['customer_id', CUSTOMER, '2041']])).toEqual([{ column: 'customer_id', op: 'eq', values: ['2041'] }]);
    // A composite key: every column compared.
    expect(keyFilters([['item_line', col('line', 'int4', 'N'), '2'], ['item_order', col('order_id', 'int8', 'N'), '1']]))
      .toEqual([{ column: 'item_line', op: 'eq', values: ['2'] }, { column: 'item_order', op: 'eq', values: ['1'] }]);
    expect(keyFilters([['status', STATUS, 'paid']])).toEqual([{ column: 'status', op: 'in', values: ['paid'] }]);
    expect(keyFilters([['at', CREATED, '2026-11-04 18:22:07+01']])).toEqual([{ column: 'at', op: 'between', values: ['2026-11-04 18:22:07+01', '2026-11-04 18:22:07+01'] }]);
    expect(keyFilters([['on', col('on', 'bool', 'B'), 't']])).toEqual([{ column: 'on', op: 'true', values: [] }]);
  });

  test('a key no filter can name (JSON, an array): none — nothing opens on the wrong rows', () => {
    expect(keyFilters([['m', METADATA, '{}']])).toBeNull();
    expect(keyFilters([['t', TAGS, '{a}']])).toBeNull();
  });

  const fields = (cols: DbColumn[], v: (string | null)[]) => rowFields({ columns: cols }, cells(...v), null);
  const LINE = col('line', 'int4', 'N', { isPk: true });
  const ORDER = col('order_id', 'int8', 'N', { isPk: true });

  test('Open › on a composite foreign key: the referenced table\'s key columns, each equal to this row\'s value (item_notes → order_items)', () => {
    const note = fields([col('id', 'int4', 'N'), col('item_line', 'int4', 'N'), col('item_order', 'int8', 'N')], ['9', '2', '1']);
    expect(referencedFilters(NOTES_ITEM, note)).toEqual([{ column: 'line', op: 'eq', values: ['2'] }, { column: 'order_id', op: 'eq', values: ['1'] }]);
    // A NULL in it: nothing references anything.
    expect(referencedFilters(NOTES_ITEM, fields([col('item_line', 'int4', 'N'), col('item_order', 'int8', 'N')], [null, '1']))).toBeNull();
  });

  test('"N rows ›" on a composite key: the referencing table\'s columns, each equal to this row\'s key value (order_items → item_notes)', () => {
    const item = fields([ORDER, LINE, col('sku', 'text', 'S')], ['1', '2', 'X']);
    expect(referencingFilters(NOTES_ITEM, item)).toEqual([{ column: 'item_line', op: 'eq', values: ['2'] }, { column: 'item_order', op: 'eq', values: ['1'] }]);
    // A key value not loaded (or cut): nothing to open with.
    expect(referencingFilters(NOTES_ITEM, fields([ORDER], ['1']))).toBeNull();
  });
});

describe('the fields', () => {
  test('type lines: Postgres\'s short type, "· primary key", the foreign key\'s table (its schema when another)', () => {
    expect(typeLine(ID, 'public')).toBe('int8 · primary key');
    expect(typeLine(CUSTOMER, 'public')).toBe('int8 → customers');
    expect(typeLine(CUSTOMER, 'billing')).toBe('int8 → public.customers');
    expect(typeLine(STATUS, 'public')).toBe('order_status');
    expect(typeLine(TOTAL, 'public')).toBe('numeric(10,2)');
    expect(typeLine({ ...CUSTOMER, isPk: true }, 'public')).toBe('int8 → customers · primary key');
  });

  test('Load full value\'s request — a column by its name, a JSON column by its column and path', () => {
    const ref = { connId: C, schema: 'public', name: 'orders' };
    const p = page({ columns: [ID, METADATA], derived: [{ column: 'metadata', path: ['discount', 0] }] });
    const [d] = derivedFields(p, [...ROW.slice(0, 2), { v: '{"a": 1', cut: 70_000 }], 'public');
    expect(d!.field.derived).toEqual({ column: 'metadata', path: ['discount', 0] });
    expect(fullRequestOf(ref, { id: '10482' }, d!.name, d!.field)).toEqual({ ref, key: { id: '10482' }, column: 'metadata', path: ['discount', 0] });
    expect(fullRequestOf(ref, { id: '10482' }, 'notes', { col: col('notes', 'text', 'S'), cell: { v: 'x' } })).toEqual({ ref, key: { id: '10482' }, column: 'notes' });
    // Its own arrays.
    expect(fullRequestOf(ref, { id: '1' }, d!.name, d!.field).path).not.toBe(d!.field.derived!.path);
  });

  test('rowFields: each field\'s column and value, from the page or from the hidden fields\' read', () => {
    const p = page({ columns: [STATUS, ID], hidden: ['id'] });
    const read: DbPeek = { columns: TABLE, row: cells('10482', '2041', 'paid', '248.00', null, '{}', '{a,b}', null, 'AUTUMN10') };
    const f = rowFields(p, cells('paid', '10482'), read);
    expect(f.get('status')?.cell.v).toBe('paid');
    expect(f.get('id')?.cell.v).toBe('10482');
    expect(f.get('coupon_code')?.cell.v).toBe('AUTUMN10');
    expect(f.get('coupon_code')?.col).toBe(COUPON);
    expect(rowFields(p, cells('paid', '10482'), null).has('coupon_code')).toBe(false);
  });

  test('the whole row as JSON (the JSON view): numbers and JSON exactly as Postgres printed them, masks held', () => {
    const p = page();
    const text = rowJsonText(p, ROW, null, { schema: 'public', name: 'orders' }, O);
    expect(text).toContain('"id": 10482');
    expect(text).toContain('"total": 248.00');
    expect(text).toContain('"n": 12345678901234567890');
    const masked = rowJsonText(page({ columns: [ID, col('email', 'text', 'S')] }), cells('1', 'mara@lindqvist.example'), null, { schema: 'public', name: 'customers' }, { ...O, masked: true });
    expect(masked).toContain('"email": "••••••••"');
    expect(masked).not.toContain('lindqvist');
  });
});

describe('the FK peek card', () => {
  const customers: DbPeek = {
    columns: [ID, col('name', 'text', 'S'), col('email', 'text', 'S'), col('plan', 'plan_tier', 'E', { enumValues: ['free', 'pro', 'team', 'enterprise'] }), col('created_at', 'timestamptz', 'D')],
    row: cells('2041', 'Mara Lindqvist', 'mara@lindqvist.example', 'pro', '2025-03-12 09:00:00+00')
  };

  test('the label, the enum as a chip, the next label column and the table on the lines under it', () => {
    expect(peekCard(customers, ORDERS_CUSTOMER, 'public', O)).toEqual({
      label: 'Mara Lindqvist', chip: { text: 'pro', tint: 1 }, subs: ['mara@lindqvist.example', 'customers · since 2025-03-12'], table: 'customers'
    });
  });

  test('Mask values on: what the card shows of a masked column is dots; a masked enum\'s chip has no tint of its value', () => {
    const card = peekCard(customers, ORDERS_CUSTOMER, 'public', { ...O, masked: true })!;
    expect(card.subs[0]).toBe('••••••••');
    expect(JSON.stringify(card)).not.toContain('lindqvist');
    const TOKEN = col('token_state', 'token_state', 'E', { enumValues: ['live', 'revoked', 'expired'] });
    const masked = peekCard({ columns: [ID, TOKEN], row: cells('2041', 'expired') }, ORDERS_CUSTOMER, 'public', { ...O, masked: true })!;
    expect(masked.chip).toEqual({ text: '••••••••', tint: null });
    expect(peekCard({ columns: [ID, TOKEN], row: cells('2041', 'expired') }, ORDERS_CUSTOMER, 'public', O)!.chip).toEqual({ text: 'expired', tint: 2 });
  });

  test('no label column: the key names the row; a composite one each of its columns', () => {
    const items: DbPeek = { columns: [col('order_id', 'int8', 'N'), col('line', 'int4', 'N'), col('quantity', 'int4', 'N')], row: cells('1', '2', '3') };
    expect(peekCard(items, NOTES_ITEM, 'public', O)).toEqual({ label: 'line 2 · order_id 1', chip: null, subs: ['order_items'], table: 'order_items' });
  });

  test('no row behind the key: null (the card says so)', () => {
    expect(peekCard({ ...customers, row: null }, ORDERS_CUSTOMER, 'public', O)).toBeNull();
  });
});

describe('Referenced by\'s rows', () => {
  const rc = (fk: DbFk, count: number | null, why?: DbRefCount['why']): DbRefCount => ({ fk, count, ...(why ? { why } : {}) });
  const ITEMS: DbFk = { name: 'order_items_order_id_fkey', from: { schema: 'public', table: 'order_items', columns: ['order_id'] }, to: { schema: 'public', table: 'orders', columns: ['id'] }, indexed: true };

  test('table and columns, "3 rows ›"; "none" can\'t open (its name in the tooltip); not counted: "Open ›" with the reason', () => {
    expect(refRow(rc(ITEMS, 3), 'public')).toEqual({ table: 'order_items', cols: '.order_id', label: '3 rows ›', open: true, tip: 'Open order_items filtered on this row' });
    expect(refRow(rc(ITEMS, 0), 'public')).toMatchObject({ label: 'none', open: false, tip: 'order_items.order_id' });
    expect(refRow(rc(ITEMS, null, 'no-index'), 'public')).toMatchObject({ label: 'Open ›', open: true, tip: 'Not counted: no index finds these rows' });
    expect(refRow(rc(NOTES_ITEM, 1001), 'public')).toMatchObject({ table: 'item_notes', cols: '.(item_line, item_order)', label: '1,000+ rows ›' });
    expect(refRow(rc({ ...ITEMS, from: { ...ITEMS.from, schema: 'billing' } }, 1), 'public').table).toBe('billing.order_items');
  });

  test('a key value too long to send: that foreign key alone says it can\'t count, nothing to open', () => {
    expect(refRow(rc(ITEMS, null, 'value'), 'public')).toEqual({ table: 'order_items', cols: '.order_id', label: 'Can’t count: value too long', open: false, tip: 'order_items.order_id' });
  });
});

describe('the panel\'s width (280–560, default 340)', () => {
  test('clamped, whole pixels; anything unreadable is the default', () => {
    expect(clampWidth(100)).toBe(280);
    expect(clampWidth(9999)).toBe(560);
    expect(clampWidth(401.6)).toBe(402);
    expect(clampWidth(Number.NaN)).toBe(INSPECTOR_DEFAULT);
    expect(INSPECTOR_DEFAULT).toBe(340);
  });

  test('the splitter\'s keys as the app\'s other splitters: ← widens, → narrows, by 16 px; Home and End the bounds', () => {
    expect(resizeStep('ArrowLeft', 340)).toBe(356);
    expect(resizeStep('ArrowRight', 340)).toBe(324);
    expect(resizeStep('ArrowRight', 290)).toBe(280);
    expect(resizeStep('Home', 400)).toBe(280);
    expect(resizeStep('End', 400)).toBe(560);
    expect(resizeStep('ArrowUp', 340)).toBeNull();
  });

  test('a drag or a key widens it only as far as the grid keeps its usable width beside it (over the grid: the pane)', () => {
    expect(widthCap(1200, false)).toBe(560);
    expect(widthCap(700, false)).toBe(380);
    expect(widthCap(550, false)).toBe(280);
    expect(widthCap(500, true)).toBe(500);
    expect(widthCap(900, true)).toBe(560);
    expect(widthCap(0, false)).toBe(560);
  });

  test('beside the grid while the grid keeps a usable width (narrower down to 280 px first); else over it (never squeezing it), never wider than the pane', () => {
    expect(inspectorLayout(1200, 340)).toEqual({ overlay: false, width: 340 });
    expect(inspectorLayout(640, 340)).toEqual({ overlay: false, width: 320 });
    expect(inspectorLayout(600, 340)).toEqual({ overlay: false, width: 280 });
    expect(inspectorLayout(590, 340)).toEqual({ overlay: true, width: 340 });
    expect(inspectorLayout(300, 340)).toEqual({ overlay: true, width: 300 });
    // Not measured yet (hidden): beside, as asked.
    expect(inspectorLayout(0, 340)).toEqual({ overlay: false, width: 340 });
  });
});

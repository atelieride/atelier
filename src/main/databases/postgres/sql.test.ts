// The statement builders for table data: exact text and parameters for
// each shape, every filter operator, quoting of odd names, derived JSON columns, and refusals before any SQL exists.
import { describe, expect, test } from 'vitest';
import type { DbFilter } from '@shared/databases-filters';
import { col, CUSTOMERS, EVENTS_NOPK, ODD_ITEMS, ORDER_ITEMS, ORDERS, WEBHOOK_EVENTS } from '../../../../tests/support/pg-targets';
import { DbError, type Stmt } from '../driver';
import {
  countStmt, CUT_BYTES, CUT_CHARS, CUT_HEX_CHARS, cutOf, displaySql, estimateStmt, fullValueStmt, HEX_CHARS, MAX_PAGE_SIZE, pageStmt, peekStmt,
  refCountStmt, rowKeyOf, rowStmt, type PageSpec, type TableTarget
} from './sql';

/** A pg_catalog type as the builders cast to it: its catalog names, quoted. */
const pg = (typname: string) => `"pg_catalog"."${typname}"`;
/** A pg_catalog operator as the builders write it. */
const op = (sym: string) => `OPERATOR(pg_catalog.${sym})`;
const EQ = op('=');
const ILIKE = op('~~*');
const spec = (o: Partial<PageSpec> = {}): PageSpec => ({ columns: [], derived: [], filters: [], sort: [], page: 0, size: 100, ...o });
const ORDERS_COLS = '"id", "customer_id", "status", "total", "currency", "metadata", "tags", "coupon_code", "created_at", "paid_at", "updated_at", "notes"';
/** A column's value cut on the server, and its whole size. */
const cut = (name: string) => `pg_catalog.left("${name}"::pg_catalog.text, 65537) AS "${name}"`;
const size = (name: string) => `pg_catalog.octet_length("${name}"::pg_catalog.text)`;
/** Orders as a page, a peek or a row reads it: the short types whole, the others cut, their sizes after the values. */
const ORDERS_CUT = `"id", "customer_id", "status", ${cut('total')}, "currency", ${cut('metadata')}, ${cut('tags')}, ${cut('coupon_code')}, `
  + `"created_at", "paid_at", "updated_at", ${cut('notes')}, ${size('total')}, ${size('metadata')}, ${size('tags')}, ${size('coupon_code')}, ${size('notes')}`;

/** A filter compiled alone: the WHERE clause of a count, and its parameters. */
function where(t: TableTarget, f: Omit<DbFilter, 'values'> & { values?: string[] }): { sql: string; values: unknown[] } {
  const s = countStmt(t, [{ values: [], ...f }]);
  const at = s.text.indexOf(' WHERE ');
  expect(at).toBeGreaterThan(0);
  return { sql: s.text.slice(at + ' WHERE '.length), values: s.values };
}

/** The DbError a call throws (a failure if it doesn't). */
function thrown(fn: () => unknown): DbError {
  let e: unknown = null;
  try {
    fn();
  } catch (x) {
    e = x;
  }
  expect(e).toBeInstanceOf(DbError);
  return e as DbError;
}

/** The $n indexes a statement's text uses, sorted. */
const indexes = (s: Stmt) => [...new Set([...s.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

/** The text with every quoted identifier and string literal blanked: what the parser reads as SQL itself. */
const bare = (sql: string) => sql.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g, '_');

/** Function calls not qualified with pg_catalog (keywords such as ANY( are upper case, never matched). */
const unqualifiedCalls = (sql: string) => [...bare(sql).matchAll(/(?<!pg_catalog\.)\b[a-z_][a-z0-9_]*\s*\(/g)].map((m) => m[0]);

/** Operators written bare (=, <, >=, #>>, ILIKE, IS DISTINCT FROM…): outside OPERATOR(pg_catalog.…), after any cast. */
const bareOperators = (sql: string) =>
  [...bare(sql).replace(/OPERATOR\(pg_catalog\.[^)]+\)/g, ' OP ').replace(/::/g, ' ').matchAll(/[=<>~!#@]+|\b(I?LIKE|BETWEEN|DISTINCT)\b/g)]
    .map((m) => m[0])
    .filter((x) => x !== '=>'); // make_interval(days => …): a named argument, not an operator

// Columns of type_zoo's kinds the acme tables lack, and types that test the cast rules.
const ZOO: TableTarget = {
  schema: 'public', name: 'type_zoo', pk: ['id'], uniqueKeys: [],
  columns: [
    col('id', 'bigint', 'int8', 'N', { isPk: true, isKey: true, nullable: false }),
    col('c_bool', 'boolean', 'bool', 'B'),
    col('c_interval', 'interval', 'interval', 'T'),
    col('c_uuid', 'uuid', 'uuid', 'U'),
    col('c_date', 'date', 'date', 'D'),
    col('c_json', 'json', 'json', 'U'),
    col('c_xml', 'xml', 'xml', 'U'),
    col('c_point', 'point', 'point', 'G'),
    col('c_json_array', 'json[]', 'json', 'U', { isArray: true }),
    col('c_char', '"char"', 'char', 'Z'),
    col('c_int4_array', 'integer[]', 'int4', 'N', { isArray: true }),
    col('c_varchar', 'character varying(5)', 'varchar', 'S'),
    col('c_varchar_array', 'character varying(20)[]', 'varchar', 'S', { isArray: true }),
    col('c_ts3', 'timestamp(3) with time zone', 'timestamptz', 'D'),
    col('c_odd_enum', 'billing."Odd Type"', 'Odd Type', 'E', { typeSchema: 'billing', enumValues: ['a', 'b'] }),
    col('$1', 'text', 'text', 'S'),
    col('c_citext', 'citext', 'citext', 'S', { typeSchema: 'public' }),
    col('c_inet', 'inet', 'inet', 'I'),
    col('c_bytea', 'bytea', 'bytea', 'U'),
    col('c_tsvector', 'tsvector', 'tsvector', 'U'),
    col('c_jsonpath', 'jsonpath', 'jsonpath', 'U')
  ]
};

/** Columns whose catalog names try to end the cast and add SQL of their own. */
const HOSTILE: TableTarget = {
  schema: 'public', name: 'hostile', pk: ['k1'], uniqueKeys: [],
  columns: [
    col('k1', 'int4 or true', 'int4 or true', 'N', { isPk: true, isKey: true, nullable: false }),
    col('n2', 'int4" or true', 'int4"', 'N'),
    col('n3', 'int4) or (true', 'int4) or (true', 'N', { typeSchema: 'x") or (true' }),
    col('e4', 'e" or true', 'e" or true', 'E', { typeSchema: 's" or "t', enumValues: ['a'] }),
    col('a5', 'int4[]) or (true', 'int4]) or (true', 'N', { isArray: true }),
    col('t6', 'text or true', 'text or true', 'S')
  ]
};

describe('pageStmt', () => {
  test('a plain page: every column as a plain identifier, the primary key ascending, LIMIT and OFFSET as parameters', () => {
    const s = pageStmt(ORDERS, spec(), false);
    expect(s.text).toBe(`SELECT ${ORDERS_COLS} FROM "public"."orders" ORDER BY "id" ASC LIMIT $1 OFFSET $2`);
    expect(s.values).toEqual([100, 0]);
    expect(s.shape).toBe('page');
    expect(pageStmt(ORDERS, spec({ page: 3, size: 50 })).values).toEqual([50, 150]);
  });

  test('chosen columns only, in the order asked', () => {
    expect(pageStmt(ORDERS, spec({ columns: ['status', 'id'] })).text).toBe('SELECT "status", "id" FROM "public"."orders" ORDER BY "id" ASC LIMIT $1 OFFSET $2');
  });

  test('a composite primary key orders by each of its columns; no key and no sort, no order', () => {
    expect(pageStmt(ORDER_ITEMS, spec()).text).toContain(' ORDER BY "order_id" ASC, "line" ASC LIMIT $1 OFFSET $2');
    const nopk = pageStmt(EVENTS_NOPK, spec(), false);
    expect(nopk.text).toBe('SELECT "occurred_at", "kind", "detail" FROM "public"."events_nopk" LIMIT $1 OFFSET $2');
    expect(pageStmt(EVENTS_NOPK, spec()).text).not.toContain('ORDER BY');
  });

  test('sorts come first, in the order given; the key follows them ascending so ties page stably', () => {
    const s = pageStmt(ORDERS, spec({ sort: [{ column: 'created_at', dir: 'desc' }, { column: 'total', dir: 'asc' }] }));
    expect(s.text).toContain(' ORDER BY "created_at" DESC, "total" ASC, "id" ASC LIMIT $1 OFFSET $2');
    expect(pageStmt(ORDER_ITEMS, spec({ sort: [{ column: 'quantity', dir: 'desc' }] })).text).toContain(
      ' ORDER BY "quantity" DESC, "order_id" ASC, "line" ASC LIMIT'
    );
  });

  test('a key column the user already sorts by is not repeated', () => {
    expect(pageStmt(ORDERS, spec({ sort: [{ column: 'id', dir: 'desc' }] })).text).toContain(' ORDER BY "id" DESC LIMIT $1');
    expect(pageStmt(ORDER_ITEMS, spec({ sort: [{ column: 'line', dir: 'desc' }] })).text).toContain(' ORDER BY "line" DESC, "order_id" ASC LIMIT');
  });

  test('a derived JSON column: (col #>> $n::pg_catalog.text[]) with its alias, the path a text[] parameter', () => {
    const s = pageStmt(WEBHOOK_EVENTS, spec({ columns: ['id'], derived: [{ column: 'payload', path: ['data', 'object', 'status'] }] }), false);
    expect(s.text).toBe(
      `SELECT "id", ("payload" ${op('#>>')} $1::pg_catalog.text[]) AS "payload→data.object.status" FROM "public"."webhook_events" ORDER BY "id" ASC LIMIT $2 OFFSET $3`
    );
    expect(s.values).toEqual([['data', 'object', 'status'], 100, 0]);
  });

  test('array indexes in a path travel as text; an alias with odd keys is still one quoted identifier', () => {
    const s = pageStmt(WEBHOOK_EVENTS, spec({ columns: ['id'], derived: [{ column: 'payload', path: ['data', 'lines', 'data', 0, 'a"b c'] }] }), false);
    expect(s.values[0]).toEqual(['data', 'lines', 'data', '0', 'a"b c']);
    expect(s.text).toContain(' AS "payload→data.lines.data[0][""a\\""b c""]" FROM');
  });

  test('a sort on a derived column sorts by the same path expression, then by the key', () => {
    const s = pageStmt(WEBHOOK_EVENTS, spec({ sort: [{ column: 'payload', path: ['type'], dir: 'desc' }] }));
    expect(s.text).toContain(` ORDER BY ("payload" ${op('#>>')} $1::pg_catalog.text[]) DESC, "id" ASC LIMIT $2 OFFSET $3`);
    expect(s.values).toEqual([['type'], 100, 0]);
  });

  test('odd names go through quoteIdent: Order "Items", Weird Col, a column named $1, a schema with dots', () => {
    const s = pageStmt(ODD_ITEMS, spec({ filters: [{ column: 'Weird Col', op: 'contains', values: ["it's"] }], sort: [{ column: 'Qty', dir: 'desc' }] }), false);
    expect(s.text).toBe(
      `SELECT "id", "Weird Col", "Qty" FROM "public"."Order ""Items""" WHERE "Weird Col"::pg_catalog.text ${ILIKE} $1 ORDER BY "Qty" DESC, "id" ASC LIMIT $2 OFFSET $3`
    );
    expect(s.values).toEqual(["%it's%", 100, 0]);
    const dots: TableTarget = { schema: 'schema.with.dots', name: 'weird"name', pk: [], uniqueKeys: [], columns: [col('Kunden', 'text', 'text', 'S'), col('a"b', 'text', 'text', 'S')] };
    expect(pageStmt(dots, spec(), false).text).toBe('SELECT "Kunden", "a""b" FROM "schema.with.dots"."weird""name" LIMIT $1 OFFSET $2');
    expect(pageStmt(dots, spec()).text).toBe(
      'SELECT pg_catalog.left("Kunden"::pg_catalog.text, 65537) AS "Kunden", pg_catalog.left("a""b"::pg_catalog.text, 65537) AS "a""b", '
        + 'pg_catalog.octet_length("Kunden"::pg_catalog.text), pg_catalog.octet_length("a""b"::pg_catalog.text) FROM "schema.with.dots"."weird""name" LIMIT $1 OFFSET $2'
    );
    expect(where(ZOO, { column: '$1', op: 'eq', values: ['x'] }).sql).toBe(`"$1" ${EQ} $1::${pg('text')}`);
  });

  test('every operator together: AND-ed, parameters numbered in text order with none skipped', () => {
    const filters: DbFilter[] = [
      { column: 'notes', op: 'null', values: [] },
      { column: 'total', op: 'between', values: ['10', '20'] },
      { column: 'status', op: 'notin', values: ['failed'] },
      { column: 'created_at', op: 'lastDays', values: ['7'] },
      { column: 'tags', op: 'has', values: ['vip'] },
      { column: 'metadata', op: 'pathEq', path: ['cart', 'coupon'], values: ['AUTUMN10'] },
      { column: 'notes', op: 'contains', values: ['gift'] }
    ];
    const s = pageStmt(ORDERS, spec({ derived: [{ column: 'metadata', path: ['source'] }], filters, sort: [{ column: 'total', dir: 'desc' }] }));
    expect(s.text).toContain(
      ` WHERE "notes" IS NULL AND ("total" ${op('>=')} $2::${pg('numeric')} AND "total" ${op('<=')} $3::${pg('numeric')})` +
        ` AND (NOT ("status" ${EQ} ANY($4::pg_catalog.text[]::"public"."order_status"[])) OR "status" IS NULL)` +
        ` AND "created_at" ${op('>=')} (pg_catalog.now() ${op('-')} pg_catalog.make_interval(days => $5::pg_catalog.int4)) AND $6::${pg('text')} ${EQ} ANY("tags")` +
        ` AND ("metadata" ${op('#>>')} $7::pg_catalog.text[]) ${EQ} $8 AND "notes"::pg_catalog.text ${ILIKE} $9 ORDER BY "total" DESC, "id" ASC LIMIT $10 OFFSET $11`
    );
    expect(s.values).toEqual([['source'], '10', '20', ['failed'], '7', 'vip', ['cart', 'coupon'], 'AUTUMN10', '%gift%', 100, 0]);
    expect(indexes(s)).toEqual(s.values.map((_, k) => k + 1));
  });

  test('never counts: no count( in a page, whatever it carries (a page never runs count(*) unless asked)', () => {
    const s = pageStmt(ORDERS, spec({
      derived: [{ column: 'metadata', path: ['cart'] }],
      filters: [{ column: 'status', op: 'in', values: ['paid'] }],
      sort: [{ column: 'metadata', path: ['cart'], dir: 'asc' }]
    }));
    expect(s.text.toLowerCase()).not.toContain('count(');
  });

  test('refuses page numbers and sizes that are not whole, and sizes outside 1–500', () => {
    expect(MAX_PAGE_SIZE).toBe(500);
    for (const bad of [{ page: -1 }, { page: 0.5 }, { size: 0 }, { size: 2.5 }, { page: Number.NaN }, { size: 501 }, { size: 10000 }, { page: 2 ** 53 }]) {
      expect(() => pageStmt(ORDERS, spec(bad))).toThrow(RangeError);
    }
    expect(pageStmt(ORDERS, spec({ size: 500 })).values).toEqual([500, 0]);
    expect(pageStmt(ORDERS, spec({ size: 1 })).values).toEqual([1, 0]);
  });
});

describe('a sorted page without a key is tied by every selected column that surely orders', () => {
  test('events_nopk sorted by kind: then every other column, ascending; unsorted, no ORDER BY at all', () => {
    expect(pageStmt(EVENTS_NOPK, spec({ sort: [{ column: 'kind', dir: 'desc' }] })).text).toContain(' ORDER BY "kind" DESC, "occurred_at" ASC, "detail" ASC LIMIT $1');
    expect(pageStmt(EVENTS_NOPK, spec({ columns: ['detail', 'kind'], sort: [{ column: 'kind', dir: 'asc' }] })).text).toContain(' ORDER BY "kind" ASC, "detail" ASC LIMIT');
    expect(pageStmt(EVENTS_NOPK, spec()).text).not.toContain('ORDER BY');
    // A sort by a JSON path ties by every column, its JSON column too (as a whole jsonb it orders).
    expect(pageStmt(EVENTS_NOPK, spec({ sort: [{ column: 'detail', path: ['ip'], dir: 'asc' }] })).text).toContain(
      ` ORDER BY ("detail" ${op('#>>')} $1::pg_catalog.text[]) ASC, "occurred_at" ASC, "kind" ASC, "detail" ASC LIMIT`
    );
  });

  test('left out: types without an ordering (json, xml, point, json[]…) and an extension\'s type (it may have none); enums and arrays of ordered types kept', () => {
    const keyless: TableTarget = { ...ZOO, pk: [] };
    const order = pageStmt(keyless, spec({ sort: [{ column: 'c_date', dir: 'desc' }] })).text.split(' ORDER BY ')[1]!.split(' LIMIT ')[0]!;
    expect(order.split(', ')).toEqual([
      '"c_date" DESC', '"id" ASC', '"c_bool" ASC', '"c_interval" ASC', '"c_uuid" ASC', '"c_char" ASC', '"c_int4_array" ASC', '"c_varchar" ASC',
      '"c_varchar_array" ASC', '"c_ts3" ASC', '"c_odd_enum" ASC', '"$1" ASC', '"c_inet" ASC', '"c_bytea" ASC', '"c_tsvector" ASC'
    ]);
  });

  test('a key, when there is one, is the only tiebreaker', () => {
    expect(pageStmt(ZOO, spec({ sort: [{ column: 'c_date', dir: 'desc' }] })).text).toContain(' ORDER BY "c_date" DESC, "id" ASC LIMIT');
  });

  test('a page of a relation without a row key asks for the stable wrapper — sorted or not; nothing else does', () => {
    expect(pageStmt(EVENTS_NOPK, spec()).stable).toBe(true);
    expect(pageStmt(EVENTS_NOPK, spec({ sort: [{ column: 'kind', dir: 'asc' }] })).stable).toBe(true);
    for (const s of [
      pageStmt(ORDERS, spec()), pageStmt({ ...ORDERS, pk: [], uniqueKeys: [['id']] }, spec()), countStmt(EVENTS_NOPK, []), estimateStmt(EVENTS_NOPK, []),
      peekStmt(CUSTOMERS, ['id'], ['1']), refCountStmt(ORDER_ITEMS, ['order_id'], ['1']), fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'payload')
    ] as Stmt[]) {
      expect(s, s.shape).not.toHaveProperty('stable');
    }
  });
});

describe('page, peek and row reads cut long values on the server; their whole sizes come after them', () => {
  test('64 KB + 1 character of text, 64 KB of bytes + 1 hex character of a bytea', () => {
    expect(CUT_BYTES).toBe(65536);
    expect(CUT_CHARS).toBe(65537);
    expect(HEX_CHARS).toBe(2 + 2 * 65536);
    expect(CUT_HEX_CHARS).toBe(HEX_CHARS + 1);
  });

  test('orders: short types whole, the others cut under their own names, their sizes after every value; cuts says which', () => {
    const s = pageStmt(ORDERS, spec());
    expect(s.text).toBe(`SELECT ${ORDERS_CUT} FROM "public"."orders" ORDER BY "id" ASC LIMIT $1 OFFSET $2`);
    expect(s.cuts).toEqual(['whole', 'whole', 'whole', 'text', 'whole', 'text', 'text', 'text', 'whole', 'whole', 'whole', 'text']);
    expect(pageStmt(ORDERS, spec(), false).cuts).toEqual(Array(12).fill('whole'));
  });

  test('what each type is read as: a cast to text would change bool, inet, "char", character(n) — whole; a bytea as hex, its size in bytes', () => {
    expect(Object.fromEntries(ZOO.columns.map((c) => [c.name, cutOf(c)]))).toEqual({
      id: 'whole', c_bool: 'whole', c_interval: 'whole', c_uuid: 'whole', c_date: 'whole', c_json: 'text', c_xml: 'text', c_point: 'whole',
      c_json_array: 'text', c_char: 'whole', c_int4_array: 'text', c_varchar: 'text', c_varchar_array: 'text', c_ts3: 'whole', c_odd_enum: 'whole',
      $1: 'text', c_citext: 'text', c_inet: 'whole', c_bytea: 'hex', c_tsvector: 'text', c_jsonpath: 'text'
    });
    expect(cutOf(col('cur', 'character(3)', 'bpchar', 'S'))).toBe('whole');
    const s = pageStmt(ZOO, spec({ columns: ['id', 'c_bytea', 'c_citext'] }));
    expect(s.text).toBe(
      'SELECT "id", pg_catalog.left("c_bytea"::pg_catalog.text, 131075) AS "c_bytea", pg_catalog.left("c_citext"::pg_catalog.text, 65537) AS "c_citext", '
        + 'pg_catalog.octet_length("c_bytea"), pg_catalog.octet_length("c_citext"::pg_catalog.text) FROM "public"."type_zoo" ORDER BY "id" ASC LIMIT $1 OFFSET $2'
    );
    expect(s.cuts).toEqual(['whole', 'hex', 'text']);
  });

  test('a derived JSON column is cut too, its size after the columns\' ones', () => {
    const s = pageStmt(WEBHOOK_EVENTS, spec({ columns: ['id', 'type'], derived: [{ column: 'payload', path: ['data', 'object', 'status'] }] }));
    expect(s.text).toBe(
      `SELECT "id", ${cut('type')}, pg_catalog.left(("payload" ${op('#>>')} $1::pg_catalog.text[]), 65537) AS "payload→data.object.status", `
        + `${size('type')}, pg_catalog.octet_length(("payload" ${op('#>>')} $1::pg_catalog.text[])) FROM "public"."webhook_events" ORDER BY "id" ASC LIMIT $2 OFFSET $3`
    );
    expect(s.cuts).toEqual(['whole', 'text', 'text']);
  });

  test('peek and row: every column, cut the same way', () => {
    const peek = peekStmt(CUSTOMERS, ['id'], ['1']);
    expect(peek).toEqual({
      text: `SELECT "id", ${cut('name')}, ${cut('email')}, "plan", "created_at", ${size('name')}, ${size('email')} FROM "public"."customers" WHERE "id" ${EQ} $1::${pg('int8')} LIMIT 1`,
      values: ['1'], shape: 'peek', cuts: ['whole', 'text', 'text', 'whole', 'whole']
    });
    const row = rowStmt(ORDERS, ['id'], ['7']);
    expect(row.text).toBe(`SELECT ${ORDERS_CUT} FROM "public"."orders" WHERE "id" ${EQ} $1::${pg('int8')} LIMIT 2`);
    expect(row.cuts).toEqual(pageStmt(ORDERS, spec()).cuts);
  });
});

describe('filters: one fragment per operator', () => {
  test('null, not null, true, false', () => {
    expect(where(ORDERS, { column: 'notes', op: 'null' })).toEqual({ sql: '"notes" IS NULL', values: [] });
    expect(where(ORDERS, { column: 'paid_at', op: 'notnull' })).toEqual({ sql: '"paid_at" IS NOT NULL', values: [] });
    expect(where(ZOO, { column: 'c_bool', op: 'true' })).toEqual({ sql: '"c_bool" IS TRUE', values: [] });
    expect(where(ZOO, { column: 'c_bool', op: 'false' })).toEqual({ sql: '"c_bool" IS FALSE', values: [] });
  });

  test('text: equals typed, not equals keeps NULL rows, contains / starts / ends as ILIKE with % _ \\ escaped, is any of as one array', () => {
    expect(where(ORDERS, { column: 'coupon_code', op: 'eq', values: ['AUTUMN10'] })).toEqual({ sql: `"coupon_code" ${EQ} $1::${pg('text')}`, values: ['AUTUMN10'] });
    expect(where(ORDERS, { column: 'coupon_code', op: 'ne', values: ['X'] })).toEqual({ sql: `("coupon_code" ${EQ} $1::${pg('text')}) IS NOT TRUE`, values: ['X'] });
    expect(where(ORDERS, { column: 'notes', op: 'contains', values: ['50%_off\\'] })).toEqual({
      sql: `"notes"::pg_catalog.text ${ILIKE} $1`, values: ['%50\\%\\_off\\\\%']
    });
    expect(where(ORDERS, { column: 'notes', op: 'starts', values: ['Leave'] })).toEqual({ sql: `"notes"::pg_catalog.text ${ILIKE} $1`, values: ['Leave%'] });
    expect(where(ORDERS, { column: 'notes', op: 'ends', values: ['.'] })).toEqual({ sql: `"notes"::pg_catalog.text ${ILIKE} $1`, values: ['%.'] });
    expect(where(ORDERS, { column: 'coupon_code', op: 'in', values: ['A', 'B'] })).toEqual({ sql: `"coupon_code" ${EQ} ANY($1::${pg('text')}[])`, values: [['A', 'B']] });
    expect(where(ZOO, { column: 'c_uuid', op: 'in', values: ['8f2a91c4-5b0e-4c1f-9d2a-31b7c0a4e7d1'] }).sql).toBe(`"c_uuid" ${EQ} ANY($1::${pg('uuid')}[])`);
  });

  test('numbers: = ≠ < ≤ > ≥ and between, cast to the column type', () => {
    const num = pg('numeric');
    expect(where(ORDERS, { column: 'total', op: 'eq', values: ['248'] }).sql).toBe(`"total" ${EQ} $1::${num}`);
    expect(where(ORDERS, { column: 'total', op: 'ne', values: ['248'] }).sql).toBe(`("total" ${EQ} $1::${num}) IS NOT TRUE`);
    expect(where(ORDERS, { column: 'total', op: 'lt', values: ['10'] })).toEqual({ sql: `"total" ${op('<')} $1::${num}`, values: ['10'] });
    expect(where(ORDERS, { column: 'total', op: 'le', values: ['10'] }).sql).toBe(`"total" ${op('<=')} $1::${num}`);
    expect(where(ORDERS, { column: 'total', op: 'gt', values: ['10'] }).sql).toBe(`"total" ${op('>')} $1::${num}`);
    expect(where(ORDERS, { column: 'total', op: 'ge', values: ['10'] }).sql).toBe(`"total" ${op('>=')} $1::${num}`);
    expect(where(ORDERS, { column: 'id', op: 'between', values: ['5', '9'] })).toEqual({
      sql: `("id" ${op('>=')} $1::${pg('int8')} AND "id" ${op('<=')} $2::${pg('int8')})`, values: ['5', '9']
    });
  });

  test('enums: is any of / is none of, one text[] parameter cast to the enum array; none of keeps NULL rows', () => {
    expect(where(ORDERS, { column: 'status', op: 'in', values: ['paid', 'shipped'] })).toEqual({
      sql: `"status" ${EQ} ANY($1::pg_catalog.text[]::"public"."order_status"[])`, values: [['paid', 'shipped']]
    });
    expect(where(ORDERS, { column: 'status', op: 'notin', values: ['failed'] }).sql).toBe(
      `(NOT ("status" ${EQ} ANY($1::pg_catalog.text[]::"public"."order_status"[])) OR "status" IS NULL)`
    );
    expect(where(ZOO, { column: 'c_odd_enum', op: 'in', values: ['a'] }).sql).toBe(`"c_odd_enum" ${EQ} ANY($1::pg_catalog.text[]::"billing"."Odd Type"[])`);
  });

  test('times: before, after, between, in the last N hours / days', () => {
    const tz = pg('timestamptz');
    expect(where(ORDERS, { column: 'created_at', op: 'before', values: ['2026-11-01'] })).toEqual({ sql: `"created_at" ${op('<')} $1::${tz}`, values: ['2026-11-01'] });
    expect(where(ORDERS, { column: 'created_at', op: 'after', values: ['2026-11-01'] }).sql).toBe(`"created_at" ${op('>')} $1::${tz}`);
    expect(where(ORDERS, { column: 'created_at', op: 'between', values: ['2026-11-01', '2026-11-02'] }).sql).toBe(
      `("created_at" ${op('>=')} $1::${tz} AND "created_at" ${op('<=')} $2::${tz})`
    );
    expect(where(ORDERS, { column: 'created_at', op: 'lastHours', values: ['6'] })).toEqual({
      sql: `"created_at" ${op('>=')} (pg_catalog.now() ${op('-')} pg_catalog.make_interval(hours => $1::pg_catalog.int4))`, values: ['6']
    });
    expect(where(ORDERS, { column: 'created_at', op: 'lastDays', values: ['7'] }).sql).toBe(
      `"created_at" ${op('>=')} (pg_catalog.now() ${op('-')} pg_catalog.make_interval(days => $1::pg_catalog.int4))`
    );
    expect(where(ZOO, { column: 'c_date', op: 'before', values: ['2026-01-01'] }).sql).toBe(`"c_date" ${op('<')} $1::${pg('date')}`);
  });

  test('arrays: contains as $n::<element type> = ANY(col)', () => {
    expect(where(ORDERS, { column: 'tags', op: 'has', values: ['vip'] })).toEqual({ sql: `$1::${pg('text')} ${EQ} ANY("tags")`, values: ['vip'] });
    expect(where(ZOO, { column: 'c_int4_array', op: 'has', values: ['5'] }).sql).toBe(`$1::${pg('int4')} ${EQ} ANY("c_int4_array")`);
  });

  test('JSON: at path equals / contains / exists, the path a text[] parameter', () => {
    expect(where(ORDERS, { column: 'metadata', op: 'pathEq', path: ['cart', 'coupon'], values: ['AUTUMN10'] })).toEqual({
      sql: `("metadata" ${op('#>>')} $1::pg_catalog.text[]) ${EQ} $2`, values: [['cart', 'coupon'], 'AUTUMN10']
    });
    expect(where(ORDERS, { column: 'metadata', op: 'pathContains', path: ['source'], values: ['w_b'] })).toEqual({
      sql: `("metadata" ${op('#>>')} $1::pg_catalog.text[]) ${ILIKE} $2`, values: [['source'], '%w\\_b%']
    });
    expect(where(ORDERS, { column: 'metadata', op: 'pathExists', path: ['gift', 0] })).toEqual({
      sql: `("metadata" ${op('#>')} $1::pg_catalog.text[]) IS NOT NULL`, values: [['gift', '0']]
    });
    expect(where(ZOO, { column: 'c_json', op: 'pathExists', path: ['plan'] }).sql).toBe(`("c_json" ${op('#>')} $1::pg_catalog.text[]) IS NOT NULL`);
  });

  test('JSON null at a path: the JSON there, as jsonb (a json column too), equals the JSON null', () => {
    expect(where(ORDERS, { column: 'metadata', op: 'pathNull', path: ['discount'] })).toEqual({
      sql: `("metadata" ${op('#>')} $1::pg_catalog.text[])::pg_catalog.jsonb ${EQ} 'null'::pg_catalog.jsonb`, values: [['discount']]
    });
    expect(where(ZOO, { column: 'c_json', op: 'pathNull', path: ['trial', 0] }).sql).toBe(`("c_json" ${op('#>')} $1::pg_catalog.text[])::pg_catalog.jsonb ${EQ} 'null'::pg_catalog.jsonb`);
  });

  test('anything else: equals as text', () => {
    expect(where(ZOO, { column: 'c_interval', op: 'eq', values: ['3 days'] })).toEqual({ sql: `"c_interval"::pg_catalog.text ${EQ} $1`, values: ['3 days'] });
  });
});

describe('operators are the server\'s own (a search_path can\'t put another `=` in front of them)', () => {
  test('no bare operator in any shape, on pg_catalog types and enums', () => {
    const all: Stmt[] = [
      pageStmt(ORDERS, spec({
        derived: [{ column: 'metadata', path: ['source'] }],
        filters: [
          ...(['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const).map((o) => ({ column: 'total', op: o, values: ['1'] })),
          { column: 'total', op: 'between', values: ['1', '2'] }, { column: 'notes', op: 'contains', values: ['x'] },
          { column: 'status', op: 'in', values: ['paid'] }, { column: 'status', op: 'notin', values: ['paid'] },
          { column: 'created_at', op: 'lastHours', values: ['1'] }, { column: 'created_at', op: 'before', values: ['2026-01-01'] },
          { column: 'tags', op: 'has', values: ['vip'] },
          ...(['pathEq', 'pathContains', 'pathExists', 'pathNull'] as const).map((o) => ({ column: 'metadata', op: o, path: ['a'], values: o === 'pathEq' || o === 'pathContains' ? ['b'] : [] }))
        ] as DbFilter[],
        sort: [{ column: 'metadata', path: ['source'], dir: 'desc' }]
      })),
      countStmt(ZOO, [{ column: 'c_interval', op: 'eq', values: ['1 day'] }, { column: 'c_odd_enum', op: 'in', values: ['a'] }]),
      peekStmt(ORDER_ITEMS, ['order_id', 'line'], ['1', '2']),
      rowStmt(CUSTOMERS, ['email'], ['a@b']),
      refCountStmt(ORDER_ITEMS, ['order_id'], ['1']),
      fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'payload', ['a'])
    ];
    for (const s of all) expect(bareOperators(s.text), s.text).toEqual([]);
    // The check itself sees bare ones.
    expect(bareOperators('SELECT 1 FROM t WHERE a = $1 AND b #>> $2 AND c ILIKE $3 AND d IS DISTINCT FROM $4')).toEqual(['=', '#>>', 'ILIKE', 'DISTINCT']);
  });

  test("an extension's type (citext) keeps its own operators, found as Postgres finds them; a cast to text compares as text", () => {
    expect(where(ZOO, { column: 'c_citext', op: 'eq', values: ['x'] }).sql).toBe('"c_citext" = $1::"public"."citext"');
    expect(where(ZOO, { column: 'c_citext', op: 'in', values: ['x'] }).sql).toBe('"c_citext" = ANY($1::"public"."citext"[])');
    expect(where(ZOO, { column: 'c_citext', op: 'contains', values: ['x'] }).sql).toBe(`"c_citext"::pg_catalog.text ${ILIKE} $1`);
  });
});

describe("casts: the type's catalog names, quoted, never format_type text", () => {
  test('typmods never reach a cast: character(3), varchar(5), timestamp(3) cast to their plain types', () => {
    expect(where(ORDERS, { column: 'currency', op: 'eq', values: ['EURO'] }).sql).toBe(`"currency" ${EQ} $1::${pg('bpchar')}`);
    expect(where(ORDERS, { column: 'currency', op: 'in', values: ['EUR', 'USD'] }).sql).toBe(`"currency" ${EQ} ANY($1::${pg('bpchar')}[])`);
    expect(where(ZOO, { column: 'c_varchar', op: 'eq', values: ['abcdefg'] }).sql).toBe(`"c_varchar" ${EQ} $1::${pg('varchar')}`);
    expect(where(ZOO, { column: 'c_varchar_array', op: 'has', values: ['x'] }).sql).toBe(`$1::${pg('varchar')} ${EQ} ANY("c_varchar_array")`);
    expect(where(ZOO, { column: 'c_ts3', op: 'after', values: ['2026-11-01'] }).sql).toBe(`"c_ts3" ${op('>')} $1::${pg('timestamptz')}`);
  });

  test('hostile type names stay inside double quotes: no bare SQL of theirs, quotes always balanced', () => {
    const stmts: Stmt[] = [
      countStmt(HOSTILE, [{ column: 'k1', op: 'lt', values: ['1'] }]),
      countStmt(HOSTILE, [{ column: 'n2', op: 'between', values: ['1', '2'] }]),
      countStmt(HOSTILE, [{ column: 'n3', op: 'eq', values: ['1'] }, { column: 'n2', op: 'ne', values: ['1'] }]),
      countStmt(HOSTILE, [{ column: 'e4', op: 'in', values: ['a'] }, { column: 'e4', op: 'notin', values: ['a'] }]),
      countStmt(HOSTILE, [{ column: 'a5', op: 'has', values: ['1'] }, { column: 't6', op: 'in', values: ['x'] }]),
      peekStmt(HOSTILE, ['k1', 'n3'], ['1', '2']),
      refCountStmt(HOSTILE, ['n2'], ['1']),
      fullValueStmt(HOSTILE, { k1: '1' }, 'n2')
    ];
    for (const s of stmts) {
      // The builders' own keywords are upper case (NOT (…) OR … IS NULL); the hostile names are lower case.
      expect(bare(s.text)).not.toMatch(/\bor\b|\btrue\b|"/);
      expect((s.text.match(/"/g) ?? []).length % 2).toBe(0);
    }
    expect(stmts[0]?.text).toContain(`"k1" ${op('<')} $1::"pg_catalog"."int4 or true"`);
    expect(stmts[1]?.text).toContain(`$1::"pg_catalog"."int4""" AND`);
  });
});

describe('refusals before any SQL exists', () => {
  test("a filter whose column isn't in the target throws DbError kind 'unknown-table'", () => {
    expect(thrown(() => pageStmt(ORDERS, spec({ filters: [{ column: 'nope', op: 'null', values: [] }] }))).problem.kind).toBe('unknown-table');
    expect(thrown(() => countStmt(ORDERS, [{ column: 'nope', op: 'null', values: [] }])).problem.kind).toBe('unknown-table');
    expect(thrown(() => estimateStmt(ORDERS, [{ column: 'Status', op: 'null', values: [] }])).problem.kind).toBe('unknown-table');
  });

  test('unknown names anywhere else: chosen columns, derived, sorts, keys, the full value column', () => {
    const unknown = (fn: () => unknown) => expect(thrown(fn).problem.kind).toBe('unknown-table');
    unknown(() => pageStmt(ORDERS, spec({ columns: ['id', 'nope'] })));
    unknown(() => pageStmt(ORDERS, spec({ derived: [{ column: 'nope', path: ['a'] }] })));
    unknown(() => pageStmt(ORDERS, spec({ sort: [{ column: 'nope', dir: 'asc' }] })));
    unknown(() => pageStmt({ ...ORDERS, pk: ['nope'] }, spec()));
    unknown(() => peekStmt(CUSTOMERS, ['nope'], ['1']));
    unknown(() => refCountStmt(ORDER_ITEMS, ['nope'], ['1']));
    unknown(() => fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'nope'));
  });

  test('a filter that does not fit its column (operator, arity, path, a fraction for an integer) is refused', () => {
    for (const f of [
      { column: 'notes', op: 'lt', values: ['1'] },
      { column: 'total', op: 'between', values: ['1'] },
      { column: 'total', op: 'lt', values: ['1; select 1'] },
      { column: 'metadata', op: 'pathEq', values: ['x'] },
      { column: 'status', op: 'in', values: ['lost'] },
      { column: 'created_at', op: 'lastDays', values: ['7 days'] },
      { column: 'customer_id', op: 'eq', values: ['1.5'] },
      { column: 'id', op: 'between', values: ['1', '2e3'] }
    ] as DbFilter[]) {
      expect(thrown(() => countStmt(ORDERS, [f])).problem.kind).toBe('other');
    }
  });

  test('a derived column or a sort by path needs a JSON column and a path; a sort needs asc or desc', () => {
    expect(thrown(() => pageStmt(ORDERS, spec({ derived: [{ column: 'notes', path: ['a'] }] }))).problem.kind).toBe('other');
    expect(thrown(() => pageStmt(ORDERS, spec({ derived: [{ column: 'metadata', path: [] }] }))).problem.kind).toBe('other');
    expect(thrown(() => pageStmt(ORDERS, spec({ sort: [{ column: 'notes', path: ['a'], dir: 'asc' }] }))).problem.kind).toBe('other');
    const bad = { column: 'id', dir: 'asc; select 1' } as unknown as PageSpec['sort'][number];
    expect(thrown(() => pageStmt(ORDERS, spec({ sort: [bad] }))).problem.kind).toBe('other');
  });

  test('a sort on a type without an ordering (json, xml, jsonpath, geometric…) is refused; a JSON path sorts as text; tsvector orders', () => {
    const unordered: TableTarget = {
      ...ZOO,
      columns: [...ZOO.columns, ...['aclitem', 'xid', 'cid', 'pg_snapshot', 'txid_snapshot'].map((t) => col(`c_${t}`, t, t, 'U'))]
    };
    for (const column of ['c_json', 'c_xml', 'c_point', 'c_json_array', 'c_jsonpath', 'c_aclitem', 'c_xid', 'c_cid', 'c_pg_snapshot', 'c_txid_snapshot']) {
      const e = thrown(() => pageStmt(unordered, spec({ sort: [{ column, dir: 'asc' }] })));
      expect(e.problem.kind).toBe('other');
      expect(e.problem.message).toBe(`Can't sort by ${column}`);
    }
    expect(pageStmt(ZOO, spec({ sort: [{ column: 'c_json', path: ['plan'], dir: 'asc' }] })).text).toContain(` ORDER BY ("c_json" ${op('#>>')} $1::pg_catalog.text[]) ASC, "id" ASC`);
    expect(pageStmt(ORDERS, spec({ sort: [{ column: 'metadata', dir: 'asc' }] })).text).toContain(' ORDER BY "metadata" ASC, "id" ASC'); // jsonb has one
    expect(pageStmt(ZOO, spec({ sort: [{ column: 'c_tsvector', dir: 'asc' }] })).text).toContain(' ORDER BY "c_tsvector" ASC, "id" ASC'); // and tsvector
  });

  test('no primary key — the first unique NOT NULL key is the tiebreaker (rowKeyOf), pages stable; a sort keeps it last', () => {
    const rates: TableTarget = { schema: 'public', name: 'currency_rates', pk: [], uniqueKeys: [['code']], columns: [col('alias', 'text', 'text', 'S'), col('code', 'text', 'text', 'S'), col('rate', 'numeric', 'numeric', 'N')] };
    expect(rowKeyOf(rates)).toEqual(['code']);
    expect(rowKeyOf(ORDERS)).toEqual(['id']);
    expect(rowKeyOf(EVENTS_NOPK)).toEqual([]);
    expect(pageStmt(rates, spec(), false).text).toBe('SELECT "alias", "code", "rate" FROM "public"."currency_rates" ORDER BY "code" ASC LIMIT $1 OFFSET $2');
    expect(pageStmt(rates, spec({ sort: [{ column: 'rate', dir: 'desc' }] })).text).toContain(' ORDER BY "rate" DESC, "code" ASC LIMIT $1');
  });

  test('the hidden fields\' read (rowStmt) names one row by the row\'s key or a unique NOT NULL key — anything else is refused, never LIMIT 1', () => {
    const s = rowStmt(ORDERS, ['id'], ['7']);
    expect(s.text).toContain(` FROM "public"."orders" WHERE "id" ${EQ} $1::${pg('int8')} LIMIT 2`);
    expect(s.shape).toBe('row');
    expect(rowStmt(CUSTOMERS, ['email'], ['mara@lindqvist.example']).text).toContain(`WHERE "email" ${EQ} $1::${pg('text')} LIMIT 2`);
    const noKey = (fn: () => unknown) => expect(thrown(fn).problem).toEqual({ kind: 'other', message: 'No key to read this row' });
    noKey(() => rowStmt(ORDER_ITEMS, ['order_id'], ['1']));
    noKey(() => rowStmt(EVENTS_NOPK, ['kind'], ['login']));
    noKey(() => rowStmt(WEBHOOK_EVENTS, ['type'], ['invoice.paid']));
  });

  test('keys: as many values as columns, at least one', () => {
    expect(thrown(() => peekStmt(CUSTOMERS, ['id'], [])).problem.kind).toBe('other');
    expect(thrown(() => peekStmt(CUSTOMERS, [], [])).problem.kind).toBe('other');
    expect(thrown(() => refCountStmt(ORDER_ITEMS, ['order_id', 'line'], ['1'])).problem.kind).toBe('other');
  });

  test('Load full value needs the primary key or a unique not-null key, whole: else "No key to read the whole value"', () => {
    const noKey = (fn: () => unknown) => expect(thrown(fn).problem).toEqual({ kind: 'other', message: 'No key to read the whole value' });
    noKey(() => fullValueStmt(ORDER_ITEMS, { order_id: '1' }, 'name')); // half of a composite key
    noKey(() => fullValueStmt(WEBHOOK_EVENTS, { type: 'invoice.paid' }, 'payload'));
    noKey(() => fullValueStmt(WEBHOOK_EVENTS, { id: '1', type: 'x' }, 'payload'));
    noKey(() => fullValueStmt(WEBHOOK_EVENTS, {}, 'payload'));
    noKey(() => fullValueStmt(EVENTS_NOPK, { kind: 'login' }, 'detail'));
    noKey(() => fullValueStmt(WEBHOOK_EVENTS, { nope: '1' }, 'payload'));
    expect(fullValueStmt(ORDER_ITEMS, { line: '2', order_id: '1' }, 'name').text).toContain(`WHERE "line" ${EQ} $1::"pg_catalog"."int4" AND "order_id" ${EQ} $2`);
    expect(fullValueStmt(CUSTOMERS, { email: 'mara@lindqvist.example' }, 'name').text).toContain(`WHERE "email" ${EQ} $1::${pg('text')} LIMIT 1`);
  });
});

describe('the other shapes', () => {
  test('estimateStmt: EXPLAIN (FORMAT JSON) SELECT 1 with the filters, never executed for real', () => {
    const plain = estimateStmt(ORDERS, []);
    expect(plain).toEqual({ text: 'EXPLAIN (FORMAT JSON) SELECT 1 FROM "public"."orders"', values: [], shape: 'estimate' });
    const s = estimateStmt(ORDERS, [{ column: 'status', op: 'in', values: ['paid'] }]);
    expect(s.text.startsWith('EXPLAIN (FORMAT JSON) ')).toBe(true);
    expect(s.text).toBe(`EXPLAIN (FORMAT JSON) SELECT 1 FROM "public"."orders" WHERE "status" ${EQ} ANY($1::pg_catalog.text[]::"public"."order_status"[])`);
    expect(s.text).not.toMatch(/\banalyze\b/i);
  });

  test('countStmt: count(*) with the filters', () => {
    expect(countStmt(ORDERS, [])).toEqual({ text: 'SELECT pg_catalog.count(*) FROM "public"."orders"', values: [], shape: 'count' });
    expect(countStmt(ORDERS, [{ column: 'status', op: 'in', values: ['paid', 'shipped'] }, { column: 'notes', op: 'notnull', values: [] }])).toEqual({
      text: `SELECT pg_catalog.count(*) FROM "public"."orders" WHERE "status" ${EQ} ANY($1::pg_catalog.text[]::"public"."order_status"[]) AND "notes" IS NOT NULL`,
      values: [['paid', 'shipped']], shape: 'count'
    });
  });

  test('peekStmt: every column of the row the key names, LIMIT 1', () => {
    expect(peekStmt(ORDER_ITEMS, ['order_id', 'line'], ['1', '2']).text).toContain(` WHERE "order_id" ${EQ} $1::${pg('int8')} AND "line" ${EQ} $2::${pg('int4')} LIMIT 1`);
  });

  test('refCountStmt: count(*) over a LIMIT 1001 subquery, every key column compared', () => {
    expect(refCountStmt(ORDER_ITEMS, ['order_id'], ['1'])).toEqual({
      text: `SELECT pg_catalog.count(*) FROM (SELECT 1 FROM "public"."order_items" WHERE "order_id" ${EQ} $1::${pg('int8')} LIMIT 1001) s`, values: ['1'], shape: 'refs'
    });
    expect(refCountStmt(ORDER_ITEMS, ['order_id', 'line'], ['1', '2']).text).toContain(`WHERE "order_id" ${EQ} $1::${pg('int8')} AND "line" ${EQ} $2::${pg('int4')} LIMIT 1001) s`);
  });

  test('fullValueStmt: the value as text cut at 16777216 characters, and its whole length in bytes', () => {
    expect(fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'payload')).toEqual({
      text: 'SELECT pg_catalog.left("payload"::pg_catalog.text, 16777216), pg_catalog.octet_length("payload"::pg_catalog.text)' +
        ` FROM "public"."webhook_events" WHERE "id" ${EQ} $1::${pg('int8')} LIMIT 1`,
      values: ['1'], shape: 'full'
    });
    expect(fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'payload', ['data', 'object'])).toEqual({
      text: `SELECT pg_catalog.left(("payload" ${op('#>>')} $1::pg_catalog.text[]), 16777216), pg_catalog.octet_length(("payload" ${op('#>>')} $1::pg_catalog.text[]))` +
        ` FROM "public"."webhook_events" WHERE "id" ${EQ} $2::${pg('int8')} LIMIT 1`,
      values: [['data', 'object'], '1'], shape: 'full'
    });
    expect(fullValueStmt(ORDER_ITEMS, { order_id: '1', line: '2' }, 'name').text).toContain(`WHERE "order_id" ${EQ} $1::${pg('int8')} AND "line" ${EQ} $2::${pg('int4')} LIMIT 1`);
    expect(thrown(() => fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'type', ['a'])).problem.kind).toBe('other');
  });

  test('every function a builder calls is pg_catalog-qualified (a search_path can not shadow it)', () => {
    const all: Stmt[] = [
      pageStmt(ORDERS, spec({
        derived: [{ column: 'metadata', path: ['source'] }],
        filters: (['lastHours', 'lastDays'] as const).map((op) => ({ column: 'created_at', op, values: ['3'] })),
        sort: [{ column: 'metadata', path: ['source'], dir: 'desc' }]
      })),
      estimateStmt(ORDERS, [{ column: 'notes', op: 'contains', values: ['x'] }]),
      countStmt(ORDERS, [{ column: 'status', op: 'notin', values: ['paid'] }, { column: 'metadata', op: 'pathContains', path: ['a'], values: ['b'] }]),
      countStmt(ZOO, [{ column: 'c_interval', op: 'eq', values: ['1 day'] }]),
      peekStmt(CUSTOMERS, ['id'], ['1']),
      rowStmt(ZOO, ['id'], ['1']),
      refCountStmt(ORDER_ITEMS, ['order_id'], ['1']),
      fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'payload'),
      fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'payload', ['a'])
    ];
    for (const s of all) expect(unqualifiedCalls(s.text)).toEqual([]);
    expect(unqualifiedCalls('SELECT count(*) FROM t')).toEqual(['count(']); // the check itself sees a bare call
  });
});

describe('displaySql: for reading only', () => {
  test("inlines parameters as quoted literals, quotes doubled: 'it''s'; pg_catalog names and operators short", () => {
    const s = pageStmt(ODD_ITEMS, spec({ filters: [{ column: 'Weird Col', op: 'eq', values: ["it's"] }] }), false);
    expect(displaySql(s)).toBe(`SELECT "id", "Weird Col", "Qty" FROM "public"."Order ""Items""" WHERE "Weird Col" = 'it''s'::text ORDER BY "id" ASC LIMIT 100 OFFSET 0`);
    expect(displaySql(countStmt(ORDERS, [{ column: 'created_at', op: 'lastDays', values: ['7'] }]))).toBe(
      `SELECT count(*) FROM "public"."orders" WHERE "created_at" >= (now() - make_interval(days => '7'::int4))`
    );
    expect(displaySql(countStmt(ORDERS, [{ column: 'notes', op: 'contains', values: ['gift'] }, { column: 'metadata', op: 'pathEq', path: ['a'], values: ['b'] }]))).toBe(
      `SELECT count(*) FROM "public"."orders" WHERE "notes"::text ILIKE '%gift%' AND ("metadata" #>> ARRAY['a']::text[]) = 'b'`
    );
    expect(displaySql(countStmt(ORDERS, [{ column: 'total', op: 'ne', values: ['5'] }]))).toBe(`SELECT count(*) FROM "public"."orders" WHERE ("total" = '5'::numeric) IS NOT TRUE`);
  });

  test('arrays as ARRAY[…], numbers bare, null as NULL, $10 is not $1 followed by 0', () => {
    expect(displaySql(countStmt(ORDERS, [{ column: 'status', op: 'in', values: ['paid', 'shipped'] }]))).toBe(
      `SELECT count(*) FROM "public"."orders" WHERE "status" = ANY(ARRAY['paid', 'shipped']::text[]::"public"."order_status"[])`
    );
    expect(displaySql(countStmt(ORDERS, [{ column: 'coupon_code', op: 'in', values: ['AUTUMN10', "it's"] }]))).toBe(
      `SELECT count(*) FROM "public"."orders" WHERE "coupon_code" = ANY(ARRAY['AUTUMN10', 'it''s']::text[])`
    );
    expect(displaySql({ text: 'SELECT $1, $2', values: [null, 3], shape: 'test' })).toBe('SELECT NULL, 3');
    const values = Array.from({ length: 11 }, (_, k) => `v${k + 1}`);
    expect(displaySql({ text: 'SELECT $1, $10, $11', values, shape: 'test' })).toBe("SELECT 'v1', 'v10', 'v11'");
  });

  test("a value with a backslash reads as an escape string (E'a\\\\b'), the same whatever standard_conforming_strings says", () => {
    expect(displaySql(countStmt(ORDERS, [{ column: 'notes', op: 'contains', values: ['C:\\temp'] }]))).toBe(
      `SELECT count(*) FROM "public"."orders" WHERE "notes"::text ILIKE E'%C:\\\\\\\\temp%'`
    );
    expect(displaySql({ text: 'SELECT $1, $2', values: ["it's a\\b", ['x\\', 'y']], shape: 'test' })).toBe("SELECT E'it''s a\\\\b', ARRAY[E'x\\\\', 'y']");
  });

  test('keeps the quotes a short name would lose its meaning without ("char", "bit"), and user types qualified', () => {
    expect(displaySql(countStmt(ZOO, [{ column: 'c_char', op: 'eq', values: ['x'] }]))).toBe(`SELECT count(*) FROM "public"."type_zoo" WHERE "c_char"::text = 'x'`);
    expect(displaySql(peekStmt({ ...ZOO, columns: [col('k', '"char"', 'char', 'Z')] }, ['k'], ['x']))).toContain(`WHERE "k" = 'x'::"char" LIMIT 1`);
    expect(displaySql(countStmt(ZOO, [{ column: 'c_odd_enum', op: 'in', values: ['a'] }]))).toContain(`::text[]::"billing"."Odd Type"[]`);
  });

  test('leaves $n and pg_catalog inside quoted identifiers and string literals alone', () => {
    expect(displaySql(countStmt(ZOO, [{ column: '$1', op: 'eq', values: ['x'] }]))).toBe(`SELECT count(*) FROM "public"."type_zoo" WHERE "$1" = 'x'::text`);
    expect(displaySql({ text: "SELECT '$1', $1, E'\\\\' AS \"$2\"", values: ['a'], shape: 'test' })).toBe("SELECT '$1', 'a', E'\\\\' AS \"$2\"");
    expect(displaySql({ text: `SELECT 'pg_catalog.now()', "pg_catalog.x", 'OPERATOR(pg_catalog.=)', $1`, values: ['pg_catalog.y'], shape: 'test' })).toBe(
      `SELECT 'pg_catalog.now()', "pg_catalog.x", 'OPERATOR(pg_catalog.=)', 'pg_catalog.y'`
    );
  });
});

// The statement builders (src/main/databases/postgres/sql.ts) against a real Postgres (PGlite behind the test proxy)
// through the read-only client: every shape and every filter operator runs, and returns what hand-written SQL over
// the same fixtures returns. After each builder statement, every fixture table still has its rows (nothing written).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DbFilter, DbSort } from '../../src/shared/databases-filters';
import { quoteIdent } from '../../src/shared/pg-json';
import { DbError, type DbRows, type DbSession, type Stmt } from '../../src/main/databases/driver';
import { postgresDriver } from '../../src/main/databases/postgres/client';
import {
  countStmt, displaySql, estimateStmt, fullValueStmt, pageStmt, peekStmt, refCountStmt, type CellStmt, type PageSpec, type TableTarget
} from '../../src/main/databases/postgres/sql';
import { ACME_COUNTS, BIG_DOC_BYTES, TYPE_ZOO_COLUMNS } from '../support/pg-fixtures';
import { PgServer } from '../support/pg-server';
import { col, CUSTOMERS, EVENTS_NOPK, ODD_ITEMS, ORDER_ITEMS, ORDERS, WEBHOOK_EVENTS } from '../support/pg-targets';

/** pg_type.typcategory of type_zoo's element types ('U' for the rest). */
const CATEGORY: Record<string, string> = {
  int8: 'N', int4: 'N', numeric: 'N', float4: 'N', money: 'N', text: 'S', citext: 'S', bool: 'B', date: 'D', time: 'D',
  timestamp: 'D', timestamptz: 'D', interval: 'T', inet: 'I', cidr: 'I', tstzrange: 'R', int4range: 'R'
};
const TYPE_ZOO: TableTarget = {
  schema: 'public', name: 'type_zoo', pk: ['id'], uniqueKeys: [],
  columns: TYPE_ZOO_COLUMNS.map((c) => col(c.name, c.type, c.typeName, CATEGORY[c.typeName] ?? 'U', {
    isArray: c.type.endsWith('[]'), typeSchema: c.typeName === 'citext' ? 'public' : 'pg_catalog',
    ...(c.name === 'id' ? { isPk: true, isKey: true, nullable: false } : {})
  }))
};

const spec = (o: Partial<PageSpec> = {}): PageSpec => ({ columns: [], derived: [], filters: [], sort: [], page: 0, size: 100, ...o });
const relOf = (key: string) => (key.includes('.') ? key.split('.').map(quoteIdent).join('.') : quoteIdent(key));
const COUNTS_SQL = `SELECT ${Object.keys(ACME_COUNTS).map((k) => `(SELECT count(*) FROM ${relOf(k)})`).join(', ')}`;

let server: PgServer;
let db: DbSession;
beforeAll(async () => {
  server = await PgServer.start();
  db = await postgresDriver.connect({ host: '127.0.0.1', port: server.port, database: 'postgres', user: 'postgres', password: '', tls: 'off', timeoutSec: 15 });
});
afterAll(async () => {
  db?.close();
  await server?.stop();
});

/** Hand-written SQL, the oracle the builders' results are compared with. */
async function oracle(text: string, values: unknown[] = []): Promise<(string | null)[][]> {
  return (await db.run({ text, values, shape: 'oracle' })).rows;
}

/** Runs a builder's statement, then proves nothing changed: every fixture table keeps its fixture count. */
async function run(st: Stmt): Promise<DbRows> {
  const r = await db.run(st);
  const [counts] = await oracle(COUNTS_SQL);
  expect(Object.fromEntries(Object.keys(ACME_COUNTS).map((k, i) => [k, Number(counts?.[i])]))).toEqual(ACME_COUNTS);
  return r;
}

const counted = async (t: TableTarget, filters: DbFilter[]) => Number((await run(countStmt(t, filters))).rows[0]?.[0]);
/** A cut read's values alone (the sizes of the values cut on the server follow them), and their names. */
const valuesOf = (st: CellStmt, r: DbRows) => r.rows.map((row) => row.slice(0, st.cuts.length));
const namesOf = (st: CellStmt, r: DbRows) => r.fields.slice(0, st.cuts.length).map((f) => f.name);
const oracleCount = async (text: string, values: unknown[] = []) => Number((await oracle(text, values))[0]?.[0]);

describe('pages', () => {
  test('page 2 of orders by created_at desc: the rows hand-written SQL returns, every column by name', async () => {
    const st = pageStmt(ORDERS, spec({ sort: [{ column: 'created_at', dir: 'desc' }], page: 1, size: 10 }));
    const r = await run(st);
    expect(namesOf(st, r)).toEqual(ORDERS.columns.map((c) => c.name));
    // The cut values read as the server prints them whole, when short.
    expect(valuesOf(st, r)).toEqual((await run(pageStmt(ORDERS, spec({ sort: [{ column: 'created_at', dir: 'desc' }], page: 1, size: 10 }), false))).rows);
    expect(r.rows).toHaveLength(10);
    const ids = await oracle('select id from orders order by created_at desc, id limit 10 offset 10');
    expect(r.rows.map((row) => row[0])).toEqual(ids.map((row) => row[0]));
  });

  test('paging through a sort with ties (status, plan) shows every row exactly once', async () => {
    const all = async (t: TableTarget, column: string, size: number) => {
      const ids: string[] = [];
      for (let page = 0; ; page++) {
        const r = await run(pageStmt(t, spec({ columns: ['id'], sort: [{ column, dir: 'asc' }], page, size })));
        ids.push(...r.rows.map((row) => row[0] ?? ''));
        if (r.rows.length < size) return ids;
      }
    };
    for (const [t, column, size] of [[ORDERS, 'status', 7], [ORDERS, 'currency', 9], [CUSTOMERS, 'plan', 4]] as const) {
      const ids = await all(t, column, size);
      const every = (await oracle(`select id from ${quoteIdent(t.name)} order by id`)).map((row) => row[0]);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort((a, b) => Number(a) - Number(b))).toEqual(every);
    }
  });

  test('the default order is the primary key ascending; a table without one still pages', async () => {
    const r = await run(pageStmt(ORDER_ITEMS, spec({ columns: ['order_id', 'line'], size: 5 })));
    expect(r.rows).toEqual(await oracle('select order_id, line from order_items order by order_id, line limit 5'));
    const nopk = await run(pageStmt(EVENTS_NOPK, spec()));
    expect(nopk.rows).toHaveLength(ACME_COUNTS.events_nopk ?? -1);
  });

  test('a derived JSON column and a sort by a JSON path, on webhook_events', async () => {
    const derived = [{ column: 'payload', path: ['data', 'object', 'status'] }];
    const st = pageStmt(WEBHOOK_EVENTS, spec({ columns: ['id'], derived }));
    const r = await run(st);
    expect(namesOf(st, r)).toEqual(['id', 'payload→data.object.status']);
    expect(valuesOf(st, r)).toEqual(await oracle("select id, payload #>> '{data,object,status}' from webhook_events order by id limit 100"));
    // After the values, the derived value's whole size.
    expect(r.rows.map((row) => row[2])).toEqual(await oracle("select octet_length(payload #>> '{data,object,status}')::text from webhook_events order by id limit 100").then((x) => x.map((row) => row[0])));
    const byType = await run(pageStmt(WEBHOOK_EVENTS, spec({ columns: ['id'], derived: [{ column: 'payload', path: ['type'] }], sort: [{ column: 'payload', path: ['type'], dir: 'desc' }] })));
    const types = await oracle("select payload #>> '{type}' from webhook_events order by 1 desc");
    expect(byType.rows.map((row) => row[1])).toEqual(types.map((row) => row[0]));
  });

  test('Order "Items" and its Weird Col: odd names quoted, filters on them work', async () => {
    const odd = pageStmt(ODD_ITEMS, spec({ filters: [{ column: 'Weird Col', op: 'contains', values: ["it's"] }] }));
    const r = await run(odd);
    expect(r.rows).toEqual([['2', "it's fragile", '1', '12']]); // then Weird Col's size in bytes
    expect(valuesOf(odd, r)).toEqual([['2', "it's fragile", '1']]);
    const eq = await run(pageStmt(ODD_ITEMS, spec({ columns: ['id'], filters: [{ column: 'Weird Col', op: 'eq', values: ['Größe M · 日本'] }] })));
    expect(eq.rows).toEqual([['3']]);
    expect(await counted(ODD_ITEMS, [{ column: 'Qty', op: 'ge', values: ['2'] }])).toBe(2);
  });

  test('every operator in one page: parameters numbered as the server expects', async () => {
    const filters: DbFilter[] = [
      { column: 'paid_at', op: 'notnull', values: [] },
      { column: 'total', op: 'between', values: ['1', '100000'] },
      { column: 'status', op: 'notin', values: ['failed'] },
      { column: 'created_at', op: 'lastDays', values: ['36500'] },
      { column: 'currency', op: 'in', values: ['EUR', 'USD', 'GBP'] },
      { column: 'metadata', op: 'pathExists', path: ['source'], values: [] },
      { column: 'coupon_code', op: 'ne', values: ['nope'] }
    ];
    const sort: DbSort[] = [{ column: 'metadata', path: ['source'], dir: 'asc' }, { column: 'id', dir: 'asc' }];
    const st = pageStmt(ORDERS, spec({ columns: ['id'], derived: [{ column: 'metadata', path: ['source'] }], filters, sort }));
    const r = await run(st);
    const expected = await oracle(
      `select id, metadata #>> '{source}' from orders where paid_at is not null and total between 1 and 100000
         and status <> 'failed' and currency in ('EUR', 'USD', 'GBP') and metadata ? 'source' and coupon_code is distinct from 'nope'
       order by metadata #>> '{source}', id limit 100`
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(valuesOf(st, r)).toEqual(expected);
  });

  test('paging through a sorted table without a key shows every row exactly once (ties broken by every column)', async () => {
    const all: string[] = [];
    for (let page = 0; ; page++) {
      const st = pageStmt(EVENTS_NOPK, spec({ sort: [{ column: 'kind', dir: 'asc' }], page, size: 2 }));
      const r = await run(st);
      all.push(...valuesOf(st, r).map((row) => JSON.stringify(row)));
      if (r.rows.length < 2) break;
    }
    const every = (await oracle('select occurred_at::text, kind, detail::text from events_nopk')).map((row) => JSON.stringify(row));
    expect(new Set(every).size).toBeLessThan(every.length + 1);
    expect([...all].sort()).toEqual([...every].sort());
  });

  test('a sort on a type the server can\'t order (jsonpath) is refused before any SQL — the server would fail it', async () => {
    const paths: TableTarget = { schema: 'public', name: 'events_nopk', pk: [], uniqueKeys: [], columns: [col('p', 'jsonpath', 'jsonpath', 'U')] };
    const e = (() => { try { pageStmt(paths, spec({ sort: [{ column: 'p', dir: 'asc' }] })); return null; } catch (x) { return x as DbError; } })();
    expect(e?.problem).toEqual({ kind: 'other', message: "Can't sort by p" });
    const server = await oracle("select x from (select '$.a'::jsonpath as x) s order by x").then(() => null, (x: unknown) => x as DbError);
    expect(server?.problem.message).toMatch(/could not identify an ordering operator for type jsonpath/);
    // tsvector has one: sorted by the server.
    expect(await oracle("select x from (select 'b'::tsvector as x union all select 'a'::tsvector) s order by x")).toEqual([["'a'"], ["'b'"]]);
  });
});

describe('every filter operator returns what hand-written SQL returns', () => {
  const cases: [string, TableTarget, DbFilter, string][] = [
    ['null', ORDERS, { column: 'notes', op: 'null', values: [] }, 'select count(*) from orders where notes is null'],
    ['notnull', ORDERS, { column: 'paid_at', op: 'notnull', values: [] }, 'select count(*) from orders where paid_at is not null'],
    ['eq text', ORDERS, { column: 'coupon_code', op: 'eq', values: ['AUTUMN10'] }, "select count(*) from orders where coupon_code = 'AUTUMN10'"],
    ['ne text', ORDERS, { column: 'coupon_code', op: 'ne', values: ['AUTUMN10'] }, "select count(*) from orders where coupon_code is distinct from 'AUTUMN10'"],
    ['contains', ORDERS, { column: 'notes', op: 'contains', values: ['GIFT'] }, "select count(*) from orders where notes ilike '%gift%'"],
    ['contains %', ORDERS, { column: 'notes', op: 'contains', values: ['%'] }, "select count(*) from orders where strpos(notes, '%') > 0"],
    ['contains _', ORDERS, { column: 'notes', op: 'contains', values: ['_'] }, "select count(*) from orders where strpos(notes, '_') > 0"],
    ['contains \\', ORDERS, { column: 'notes', op: 'contains', values: ['\\'] }, "select count(*) from orders where strpos(notes, '\\') > 0"],
    ['starts', ORDERS, { column: 'notes', op: 'starts', values: ['ring'] }, "select count(*) from orders where notes ilike 'ring%'"],
    ['ends', ORDERS, { column: 'notes', op: 'ends', values: ['.'] }, "select count(*) from orders where notes like '%.'"],
    ['in text', ORDERS, { column: 'coupon_code', op: 'in', values: ['AUTUMN10', 'VIP20'] }, "select count(*) from orders where coupon_code in ('AUTUMN10', 'VIP20')"],
    ['eq number', ORDERS, { column: 'customer_id', op: 'eq', values: ['1'] }, 'select count(*) from orders where customer_id = 1'],
    ['ne number', ORDERS, { column: 'customer_id', op: 'ne', values: ['1'] }, 'select count(*) from orders where customer_id <> 1'],
    ['lt', ORDERS, { column: 'total', op: 'lt', values: ['50'] }, 'select count(*) from orders where total < 50'],
    ['le', ORDERS, { column: 'total', op: 'le', values: ['248'] }, 'select count(*) from orders where total <= 248'],
    ['gt', ORDERS, { column: 'total', op: 'gt', values: ['100.5'] }, 'select count(*) from orders where total > 100.5'],
    ['ge', ORDERS, { column: 'total', op: 'ge', values: ['248'] }, 'select count(*) from orders where total >= 248'],
    ['between number', ORDERS, { column: 'total', op: 'between', values: ['50', '150'] }, 'select count(*) from orders where total between 50 and 150'],
    ['in enum', ORDERS, { column: 'status', op: 'in', values: ['paid', 'shipped'] }, "select count(*) from orders where status in ('paid', 'shipped')"],
    ['notin enum', ORDERS, { column: 'status', op: 'notin', values: ['paid', 'shipped'] }, "select count(*) from orders where status not in ('paid', 'shipped')"],
    ['before', ORDERS, { column: 'created_at', op: 'before', values: ['2026-11-01 00:00+00'] }, "select count(*) from orders where created_at < '2026-11-01 00:00+00'"],
    ['after', ORDERS, { column: 'created_at', op: 'after', values: ['2026-11-01 00:00+00'] }, "select count(*) from orders where created_at > '2026-11-01 00:00+00'"],
    ['between time', ORDERS, { column: 'created_at', op: 'between', values: ['2026-10-30', '2026-11-02'] }, "select count(*) from orders where created_at between '2026-10-30' and '2026-11-02'"],
    ['has', ORDERS, { column: 'tags', op: 'has', values: ['vip'] }, "select count(*) from orders where 'vip' = any(tags)"],
    ['true', TYPE_ZOO, { column: 'c_bool', op: 'true', values: [] }, 'select count(*) from type_zoo where c_bool'],
    ['false', TYPE_ZOO, { column: 'c_bool', op: 'false', values: [] }, 'select count(*) from type_zoo where not c_bool'],
    ['pathEq', WEBHOOK_EVENTS, { column: 'payload', op: 'pathEq', path: ['data', 'object', 'status'], values: ['paid'] }, "select count(*) from webhook_events where payload->'data'->'object'->>'status' = 'paid'"],
    ['pathContains', WEBHOOK_EVENTS, { column: 'payload', op: 'pathContains', path: ['data', 'object', 'customer_email'], values: ['LINDQVIST'] }, "select count(*) from webhook_events where payload->'data'->'object'->>'customer_email' ilike '%lindqvist%'"],
    ['pathExists', WEBHOOK_EVENTS, { column: 'payload', op: 'pathExists', path: ['data', 'previous_attributes'], values: [] }, "select count(*) from webhook_events where payload->'data' ? 'previous_attributes'"],
    ['pathEq index', WEBHOOK_EVENTS, { column: 'payload', op: 'pathEq', path: ['data', 'object', 'lines', 'data', 0, 'quantity'], values: ['1'] }, "select count(*) from webhook_events where payload->'data'->'object'->'lines'->'data'->0->>'quantity' = '1'"],
    ['eq other (interval as text)', TYPE_ZOO, { column: 'c_interval', op: 'eq', values: ['3 days 04:00:00'] }, "select count(*) from type_zoo where c_interval::text = '3 days 04:00:00'"],
    ['eq citext (case-insensitive)', TYPE_ZOO, { column: 'c_citext', op: 'eq', values: ['mara@lindqvist.example'] }, "select count(*) from type_zoo where lower(c_citext::text) = 'mara@lindqvist.example'"],
    ['in uuid', TYPE_ZOO, { column: 'c_uuid', op: 'in', values: ['8f2a91c4-5b0e-4c1f-9d2a-31b7c0a4e7d1', '00000000-0000-0000-0000-000000000000'] }, 'select count(*) from type_zoo where c_uuid is not null'],
    ['eq inet', TYPE_ZOO, { column: 'c_inet', op: 'eq', values: ['10.24.0.17'] }, "select count(*) from type_zoo where c_inet = '10.24.0.17'"],
    ['eq int8 past 2^53', TYPE_ZOO, { column: 'c_int8', op: 'eq', values: ['9007199254740993'] }, 'select count(*) from type_zoo where c_int8 = 9007199254740993'],
    ['lt real', TYPE_ZOO, { column: 'c_real', op: 'lt', values: ['0'] }, 'select count(*) from type_zoo where c_real < 0'],
    ['gt money', TYPE_ZOO, { column: 'c_money', op: 'gt', values: ['0'] }, 'select count(*) from type_zoo where c_money > 0::money'],
    ['before date', TYPE_ZOO, { column: 'c_date', op: 'before', values: ['2000-01-01'] }, "select count(*) from type_zoo where c_date < '2000-01-01'"],
    ['after timestamp', TYPE_ZOO, { column: 'c_timestamp', op: 'after', values: ['2026-01-01'] }, "select count(*) from type_zoo where c_timestamp > '2026-01-01'"],
    ['has int4[]', TYPE_ZOO, { column: 'c_int4_array', op: 'has', values: ['5'] }, 'select count(*) from type_zoo where 5 = any(c_int4_array)'],
    ['pathExists json', TYPE_ZOO, { column: 'c_json', op: 'pathExists', path: ['limits', 'projects'], values: [] }, "select count(*) from type_zoo where c_json->'limits'->'projects' is not null"],
    // Is JSON null — a jsonb column, a json one, a nested path.
    ['pathNull', TYPE_ZOO, { column: 'c_jsonb', op: 'pathNull', path: ['trial'], values: [] }, "select count(*) from type_zoo where c_jsonb->'trial' = 'null'::jsonb"],
    ['pathNull json', TYPE_ZOO, { column: 'c_json', op: 'pathNull', path: ['trial'], values: [] }, "select count(*) from type_zoo where (c_json->'trial')::jsonb = 'null'::jsonb"],
    ['pathNull nested', WEBHOOK_EVENTS, { column: 'payload', op: 'pathNull', path: ['request', 'id'], values: [] }, "select count(*) from webhook_events where payload->'request'->'id' = 'null'::jsonb"],
    ['eq xml as text', TYPE_ZOO, { column: 'c_xml', op: 'eq', values: ['<empty/>'] }, "select count(*) from type_zoo where c_xml::text = '<empty/>'"]
  ];

  test.each(cases)('%s', async (_name, t, f, sql) => {
    expect(await counted(t, [f])).toBe(await oracleCount(sql));
  });

  test('is JSON null takes the row whose key holds a JSON null, not the one without the key nor a NULL value — which #>> can\'t tell apart', async () => {
    // type_zoo: row 1 {"trial": null, …}, row 2 NULL, row 3 {} (no key).
    const pathNull = { column: 'c_jsonb', op: 'pathNull' as const, path: ['trial'], values: [] };
    expect(await counted(TYPE_ZOO, [pathNull])).toBe(1);
    expect(await counted(TYPE_ZOO, [{ ...pathNull, column: 'c_json' }])).toBe(1);
    expect(await oracleCount("select count(*) from type_zoo where c_jsonb #>> '{trial}' is null")).toBe(3);
    expect(await counted(TYPE_ZOO, [{ column: 'c_jsonb', op: 'pathExists', path: ['trial'], values: [] }])).toBe(1);
    // webhook_events: request.id is a JSON null on some events, a string on the others.
    const nulls = await counted(WEBHOOK_EVENTS, [{ column: 'payload', op: 'pathNull', path: ['request', 'id'], values: [] }]);
    expect(nulls).toBeGreaterThan(0);
    expect(nulls).toBeLessThan(await oracleCount('select count(*) from webhook_events'));
  });

  test('the escaped LIKE characters really matter: unescaped, % and _ would match every note', async () => {
    const notes = await oracleCount('select count(*) from orders where notes is not null');
    expect(notes).toBeGreaterThan(0);
    expect(await counted(ORDERS, [{ column: 'notes', op: 'contains', values: ['%'] }])).toBe(0);
    expect(await counted(ORDERS, [{ column: 'notes', op: 'contains', values: ['_'] }])).toBe(0);
  });

  test('in the last N hours / days: runs (now() is the server clock, not ACME_NOW)', async () => {
    for (const op of ['lastHours', 'lastDays'] as const) {
      const n = await counted(ORDERS, [{ column: 'created_at', op, values: ['1'] }]);
      expect(Number.isInteger(n) && n >= 0).toBe(true);
    }
    expect(await counted(ORDERS, [{ column: 'created_at', op: 'lastDays', values: ['100000'] }])).toBe(ACME_COUNTS.orders);
    expect(await counted(TYPE_ZOO, [{ column: 'c_date', op: 'lastDays', values: ['100000'] }])).toBe(2);
  });

  test('not equals and is none of keep the NULL rows (Exclude This Value hides only that value)', async () => {
    const nulls = await oracleCount('select count(*) from orders where coupon_code is null');
    expect(nulls).toBeGreaterThan(0);
    const others = await oracleCount("select count(*) from orders where coupon_code <> 'AUTUMN10'");
    expect(await counted(ORDERS, [{ column: 'coupon_code', op: 'ne', values: ['AUTUMN10'] }])).toBe(others + nulls);
    // A nullable column described as an enum of the coupon codes: notin's fragment on the server, NULLs included.
    const codes = (await oracle('select code from coupons order by code')).map((row) => row[0] ?? '');
    const asEnum: TableTarget = {
      ...ORDERS,
      columns: ORDERS.columns.map((c) => (c.name === 'coupon_code' ? { ...c, typeCat: 'E', enumValues: codes } : c))
    };
    expect(await counted(asEnum, [{ column: 'coupon_code', op: 'notin', values: ['AUTUMN10', 'VIP20'] }])).toBe(
      await oracleCount("select count(*) from orders where coupon_code not in ('AUTUMN10', 'VIP20') or coupon_code is null")
    );
    expect(await counted(asEnum, [{ column: 'coupon_code', op: 'notin', values: ['AUTUMN10'] }])).toBe(others + nulls);
  });

  test('a hostile type name in the catalog is an unknown type on the server: an error, never extra rows', async () => {
    const hostile = (typeName: string, typeSchema = 'pg_catalog'): TableTarget => ({
      ...ORDERS,
      columns: ORDERS.columns.map((c) => (c.name === 'total' ? { ...c, type: typeName, typeName, typeSchema } : c))
    });
    for (const [typeName, typeSchema] of [['int4 or true'], ['int4) or (true'], ['int4" or true'], ['int4', 'x") or (true']]) {
      const st = countStmt(hostile(typeName ?? '', typeSchema), [{ column: 'total', op: 'lt', values: ['0'] }]);
      const e = await db.run(st).then(() => null, (x: unknown) => x as DbError);
      expect(e).toBeInstanceOf(DbError);
      expect(e?.problem.code).toMatch(/^(42704|3F000)$/); // undefined type, or undefined schema
    }
    expect(await counted(ORDERS, [{ column: 'total', op: 'lt', values: ['0'] }])).toBe(0);
  });

  test('a char(3) column: EURO is not EUR (the cast drops the typmod instead of cutting the value)', async () => {
    const eur = await oracleCount("select count(*) from orders where currency = 'EUR'");
    expect(eur).toBeGreaterThan(0);
    expect(await counted(ORDERS, [{ column: 'currency', op: 'eq', values: ['EUR'] }])).toBe(eur);
    expect(await counted(ORDERS, [{ column: 'currency', op: 'eq', values: ['EURO'] }])).toBe(0);
    expect(await counted(ORDERS, [{ column: 'currency', op: 'in', values: ['EURO'] }])).toBe(0);
  });

  test('status in (paid, shipped): the exact count and the estimate', async () => {
    const f: DbFilter[] = [{ column: 'status', op: 'in', values: ['paid', 'shipped'] }];
    const exact = await counted(ORDERS, f);
    expect(exact).toBe(await oracleCount("select count(*) from orders where status in ('paid', 'shipped')"));
    expect(exact).toBeGreaterThan(0);
    const plan = JSON.parse((await run(estimateStmt(ORDERS, f))).rows[0]?.[0] ?? 'null') as { Plan: { 'Plan Rows': number } }[];
    expect(plan[0]?.Plan['Plan Rows']).toBeGreaterThan(0);
    const whole = JSON.parse((await run(estimateStmt(ODD_ITEMS, []))).rows[0]?.[0] ?? 'null') as { Plan: { 'Plan Rows': number } }[];
    expect(typeof whole[0]?.Plan['Plan Rows']).toBe('number');
  });
});

describe('peek, references, full value', () => {
  test('peek of customer 1: Mara, every column', async () => {
    const st = peekStmt(CUSTOMERS, ['id'], ['1']);
    const r = await run(st);
    expect(namesOf(st, r)).toEqual(CUSTOMERS.columns.map((c) => c.name));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.slice(0, 3)).toEqual(['1', 'Mara Lindqvist', 'mara@lindqvist.example']);
    expect((await run(peekStmt(CUSTOMERS, ['id'], ['999999']))).rows).toEqual([]);
    expect((await run(peekStmt(ORDER_ITEMS, ['order_id', 'line'], ['1', '1']))).rows).toHaveLength(1);
  });

  test('order 1 is referenced by 3 order_items; the count stops at 1001', async () => {
    expect((await run(refCountStmt(ORDER_ITEMS, ['order_id'], ['1']))).rows).toEqual([['3']]);
    expect((await run(refCountStmt(ORDER_ITEMS, ['order_id', 'line'], ['1', '2']))).rows).toEqual([['1']]);
    expect((await run(refCountStmt(ORDERS, ['customer_id'], ['999999']))).rows).toEqual([['0']]);
  });

  test("webhook 1's whole payload: BIG_DOC_BYTES long, with its byte length; a path reads just that part", async () => {
    const r = await run(fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'payload'));
    expect(r.fields).toHaveLength(2);
    expect(r.rows[0]?.[0]).toHaveLength(BIG_DOC_BYTES);
    expect(r.rows[0]?.[1]).toBe(String(BIG_DOC_BYTES));
    const part = await run(fullValueStmt(WEBHOOK_EVENTS, { id: '1' }, 'payload', ['data', 'object', 'id']));
    expect(part.rows).toEqual(await oracle("select payload #>> '{data,object,id}', octet_length(payload #>> '{data,object,id}') from webhook_events where id = 1"));
  });

  test('the byte length counts bytes, not characters; a unique not-null key reads the row too', async () => {
    const odd = await run(fullValueStmt(ODD_ITEMS, { id: '3' }, 'Weird Col'));
    expect(odd.rows).toEqual([['Größe M · 日本', String(Buffer.byteLength('Größe M · 日本'))]]);
    const byEmail = await run(fullValueStmt(CUSTOMERS, { email: 'mara@lindqvist.example' }, 'name'));
    expect(byEmail.rows).toEqual([['Mara Lindqvist', '14']]);
  });
});

describe('displaySql', () => {
  test('reads back as the same statement: run as plain SQL, it returns the same rows', async () => {
    const p = spec({
      columns: ['id', 'status', 'notes'], derived: [{ column: 'metadata', path: ['cart'] }],
      filters: [
        { column: 'status', op: 'in', values: ['paid', 'shipped'] }, { column: 'total', op: 'between', values: ['10', '500'] },
        { column: 'coupon_code', op: 'ne', values: ["it's a\\b"] }
      ],
      sort: [{ column: 'total', dir: 'desc' }], size: 20
    });
    // What the SQL popover shows (the read without the transport's cut), and what runs.
    const shown = displaySql(pageStmt(ORDERS, p, false));
    expect(shown).toContain("E'it''s a\\\\b'");
    const st = pageStmt(ORDERS, p);
    const inlined = await run({ text: shown, values: [], shape: 'test' });
    expect(inlined.rows).toEqual(valuesOf(st, await run(st)));
    expect(inlined.rows.length).toBeGreaterThan(0);
    // The cut statement reads back too (the operators as written by hand, its sizes included).
    expect((await run({ text: displaySql(st), values: [], shape: 'test' })).rows).toEqual((await run(st)).rows);
  });
});

// The query resolver (src/main/databases/queries.ts) against a real Postgres (PGlite behind the test proxy) through the
// read-only client: the renderer's structured requests resolved against the catalog before any SQL exists (an unknown
// name never reaches the server), pages with cells cut at 64 KB and derived JSON columns by position, estimates
// (reltuples without filters, EXPLAIN with them), counts, peeks, references, Load full value, the 30 s column cache,
// and a page past the timeout.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DbPageRequest, DbProblem, DbRefCount, DbTableRef } from '../../src/shared/databases';
import type { DbDerived } from '../../src/shared/databases-filters';
import { DbError, type DbRows, type DbSession, type Stmt } from '../../src/main/databases/driver';
import { postgresDriver } from '../../src/main/databases/postgres/client';
import { CUT_BYTES, CUT_CHARS, CUT_HEX_CHARS, FULL_CHARS } from '../../src/main/databases/postgres/sql';
import { CACHE_CAP, CACHE_MS, cellOf, DbQueries } from '../../src/main/databases/queries';
import { ACME_COUNTS, BIG_DOC_BYTES } from '../support/pg-fixtures';
import { PgServer } from '../support/pg-server';

/** The two wrappers: every statement's, and a keyless page's. */
const WRAP = 'BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = 15000';
const STABLE = `${WRAP}; SET LOCAL synchronize_seqscans = off; SET LOCAL max_parallel_workers_per_gather = 0`;
const ref = (name: string, schema = 'public'): DbTableRef => ({ connId: 'c0123456789ab', schema, name });
const req = (r: DbTableRef, o: Partial<DbPageRequest> = {}): DbPageRequest => ({
  ref: r, columns: [], derived: [], filters: [], sort: [], page: 0, size: 100, ...o
});

let server: PgServer;
let db: DbSession;
/** Every statement the queries ran, in order (shapes name the builders). */
const ran: Stmt[] = [];
/** The queries' clock (ms): tests move it to age the cache. */
let now = 1_000_000;
let q: DbQueries;

/** A session that records what runs through it. */
function recording(inner: DbSession, log: Stmt[]): DbSession {
  return {
    run(st: Stmt): Promise<DbRows> {
      log.push(st);
      return inner.run(st);
    },
    close: () => inner.close(),
    get closed() { return inner.closed; },
    get tlsActive() { return inner.tlsActive; }
  };
}

beforeAll(async () => {
  server = await PgServer.start();
  db = await postgresDriver.connect({ host: '127.0.0.1', port: server.port, database: 'postgres', user: 'postgres', password: '', tls: 'off', timeoutSec: 15 });
  q = new DbQueries(recording(db, ran), () => now);
  // The server version is read once per session, on the first catalog read: done here, so the logs below hold only
  // what each test asks for.
  await q.page(req(ref('orders'), { size: 1 }));
  q.forget();
});
afterAll(async () => {
  db?.close();
  await server?.stop();
});

/** The problem a promise rejects with (a DbError's), or a failure if it resolves. */
async function problem(p: Promise<unknown>): Promise<DbProblem> {
  const e = await p.then(() => new Error('expected a rejection'), (x: unknown) => x);
  expect(e).toBeInstanceOf(DbError);
  return (e as DbError).problem;
}

/** Hand-written SQL straight through the session, the oracle the queries' results are compared with. */
async function oracle(text: string, values: unknown[] = []): Promise<(string | null)[][]> {
  return (await db.run({ text, values, shape: 'oracle' })).rows;
}

/** What reached the server since the last clearLog, without the read-only wrapper around each statement. */
async function sent(): Promise<string[]> {
  return (await server.statementsLog()).filter((l) => l !== WRAP && l !== STABLE && l !== 'ROLLBACK');
}

/**
 * Everything that reached the server since the last clearLog, the BEGIN wrapper included, except ROLLBACK: a run
 * resolves before its ROLLBACK goes out, so the previous request's can land after clearLog.
 */
async function reached(): Promise<string[]> {
  return (await server.statementsLog()).filter((l) => l !== 'ROLLBACK');
}

async function fresh(): Promise<void> {
  ran.length = 0;
  await server.clearLog();
}

const shapes = (): string[] => ran.map((s) => s.shape);

/** EXPLAIN (FORMAT JSON)'s top Plan Rows for hand-written SQL. */
async function plan(text: string): Promise<number | undefined> {
  const json = (await oracle(text))[0]?.[0] ?? '[]';
  return (JSON.parse(json) as { Plan: { 'Plan Rows': number } }[])[0]?.Plan['Plan Rows'];
}

const lost = (): DbError => new DbError({ kind: 'lost', message: 'Reconnecting…' });
type Answer = DbProblem | { rows: (string | null)[][] };
/**
 * The real session, except for the statements a rule matches: those fail with the rule's problem (a rule with
 * `closes` also closes the session, as the client-side timeout does: every later run fails as lost) or get its rows.
 */
function faulty(rules: { when: (st: Stmt) => boolean; answer: Answer; closes?: boolean }[]): DbSession {
  let closed = false;
  return {
    run(st: Stmt): Promise<DbRows> {
      if (closed) return Promise.reject(lost());
      const rule = rules.find((r) => r.when(st));
      if (!rule) return db.run(st);
      if (rule.closes) closed = true;
      if ('rows' in rule.answer) return Promise.resolve({ fields: [], rows: rule.answer.rows, ms: 0 });
      return Promise.reject(new DbError(rule.answer));
    },
    close: () => {},
    get closed() { return closed; },
    tlsActive: false
  };
}
/** The references count on public.<table>. */
const countOn = (table: string) => (st: Stmt): boolean => st.shape === 'refs' && st.text.includes(`FROM "public"."${table}"`);

describe('every name resolved against the catalog before any SQL', () => {
  test('an unknown column (selected, derived, filtered, sorted, a key) is refused and nothing reaches the server', async () => {
    await q.page(req(ref('orders'), { size: 1 })); // orders' columns are known now
    await fresh();
    const bad: Partial<DbPageRequest>[] = [
      { columns: ['id', 'nope'] },
      { derived: [{ column: 'nope', path: ['a'] }] },
      { filters: [{ column: 'nope', op: 'null', values: [] }] },
      { sort: [{ column: 'nope', dir: 'asc' }] }
    ];
    for (const o of bad) expect(await problem(q.page(req(ref('orders'), o)))).toMatchObject({ kind: 'unknown-table' });
    const nope = [{ column: 'nope', op: 'null' as const, values: [] }];
    expect(await problem(q.estimate(ref('orders'), nope))).toMatchObject({ kind: 'unknown-table' });
    expect(await problem(q.count(ref('orders'), nope))).toMatchObject({ kind: 'unknown-table' });
    expect(await problem(q.peek(ref('orders'), ['nope'], ['1']))).toMatchObject({ kind: 'unknown-table' });
    expect(await problem(q.refs(ref('orders'), { id: '1', nope: '1' }))).toMatchObject({ kind: 'unknown-table' });
    expect(await problem(q.full(ref('orders'), { id: '1' }, 'nope'))).toMatchObject({ kind: 'unknown-table' });
    expect(await reached()).toEqual([]);
    expect(ran).toEqual([]);
  });

  test('an unknown table or schema is refused: the one lookup carries the name as a parameter, a repeat sends nothing', async () => {
    const unknown = [ref('no_such_table'), ref('orders', 'no_such_schema'), ref('orders"; drop table orders; --')];
    await fresh();
    for (const r of unknown) {
      expect(await problem(q.page(req(r)))).toEqual({ kind: 'unknown-table', message: `No table or view ${r.schema}.${r.name}` });
    }
    expect(shapes()).toEqual(['cat.columns', 'cat.columns', 'cat.columns']);
    const texts = await sent();
    expect(texts).toHaveLength(3);
    expect(texts.filter((t) => t.includes('no_such') || t.includes('drop table'))).toEqual([]);
    await fresh();
    for (const r of unknown) expect(await problem(q.count(r, []))).toMatchObject({ kind: 'unknown-table' });
    expect(await reached()).toEqual([]);
    expect((await oracle('select count(*) from orders'))[0]?.[0]).toBe(String(ACME_COUNTS.orders));
  });
});

describe('pages', () => {
  test("webhook_events: id 1's payload is cut at CUT_BYTES with its whole length; every other cell comes whole", async () => {
    const p = await q.page(req(ref('webhook_events')));
    expect(p.kind).toBe('table');
    expect(p.pk).toEqual(['id']);
    expect(p.columns.map((c) => c.name)).toEqual(['id', 'type', 'payload', 'received_at']);
    expect(p.derived).toEqual([]);
    expect(p.hidden).toEqual([]);
    expect(p.rows).toHaveLength(Number(ACME_COUNTS.webhook_events));
    const [first, ...rest] = p.rows;
    expect(first?.[0]).toEqual({ v: '1' });
    const payload = first?.[2];
    expect(payload?.cut).toBe(BIG_DOC_BYTES);
    expect(Buffer.byteLength(payload?.v ?? '')).toBe(CUT_BYTES);
    const whole = (await oracle('select payload::text from webhook_events where id = 1'))[0]?.[0] ?? '';
    expect(whole.startsWith(payload?.v ?? '-')).toBe(true);
    expect(rest.flat().filter((c) => c.cut !== undefined)).toEqual([]);
    // w.id: "order by id" would sort the id::text output column.
    const all = await oracle('select id::text, type, payload::text, received_at::text from webhook_events w where w.id > 1 order by w.id');
    expect(rest.map((row) => row.map((c) => c.v))).toEqual(all);
    expect(typeof p.ms).toBe('number');
    expect(p.sql).toBe('SELECT "id", "type", "payload", "received_at" FROM "public"."webhook_events" ORDER BY "id" ASC LIMIT 100 OFFSET 0');
  });

  test('derived JSON columns follow the selected ones, mapped by position (an alias Postgres cuts at 63 bytes too)', async () => {
    const long = 'a_key_long_enough_that_its_alias_runs_past_sixty_three_bytes_in_postgres';
    const derived: DbDerived[] = [
      { column: 'payload', path: ['type'] },
      { column: 'payload', path: ['data', 'object', long] },
      { column: 'payload', path: ['data', 'object', 'lines', 'data', 0, 'price', 'unit_amount'] },
      { column: 'payload', path: ['data', 'object', 'status'] }
    ];
    const p = await q.page(req(ref('webhook_events'), { columns: ['id'], derived, sort: [{ column: 'id', dir: 'desc' }], size: 50 }));
    expect(p.columns.map((c) => c.name)).toEqual(['id']);
    expect(p.derived).toEqual(derived);
    const want = await oracle(
      `select id::text, payload #>> '{type}', payload #>> '{data,object,${long}}', `
      + "payload #>> '{data,object,lines,data,0,price,unit_amount}', payload #>> '{data,object,status}' from webhook_events w order by w.id desc limit 50"
    );
    expect(p.rows.map((row) => row.map((c) => c.v))).toEqual(want);
    expect(want.every((row) => row[1] !== null && row[2] === null && row[4] !== null)).toBe(true);
  });

  test('a size over 500 is clamped to 500', async () => {
    const p = await q.page(req(ref('orders'), { columns: ['id'], size: 5000 }));
    expect(p.sql.endsWith('LIMIT 500 OFFSET 0')).toBe(true);
    expect(p.rows).toHaveLength(Number(ACME_COUNTS.orders));
    const next = await q.page(req(ref('orders'), { columns: ['id'], size: 501, page: 1 }));
    expect(next.sql.endsWith('LIMIT 500 OFFSET 500')).toBe(true);
    expect(next.rows).toEqual([]);
  });

  test('a page or size that is not a whole number is a DbError, not a crash, and nothing is read for it', async () => {
    q.forget();
    await fresh();
    for (const o of [{ page: -1 }, { page: 1.5 }, { size: 0 }, { size: Number.NaN }]) {
      expect(await problem(q.page(req(ref('orders'), o)))).toMatchObject({ kind: 'other' });
    }
    expect(shapes()).toEqual([]);
  });

  test('a view: no key, so no order, and its kind says so', async () => {
    const p = await q.page(req(ref('paid_orders')));
    expect(p.kind).toBe('view');
    expect(p.pk).toEqual([]);
    expect(p.sql).not.toContain('ORDER BY');
    expect(p.rows.length).toBe(Number((await oracle("select count(*) from orders where status = 'paid'"))[0]?.[0]));
  });

  test('a table whose name needs every quoting rule browses like any other', async () => {
    const p = await q.page(req(ref('Order "Items"'), { sort: [{ column: 'Qty', dir: 'desc' }] }));
    expect(p.columns.map((c) => c.name)).toEqual(['id', 'Weird Col', 'Qty']);
    expect(p.rows.map((row) => row.map((c) => c.v))).toEqual([['3', 'Größe M · 日本', '4'], ['1', 'gift wrap', '2'], ['2', "it's fragile", '1']]);
  });
});

describe('long values are cut on the server, before they cross the network', () => {
  /** Every row a read brought, as the session got it: what crossed the network. */
  const wire: (string | null)[][] = [];
  let big: DbQueries;
  const MB = 1024 * 1024;
  beforeAll(async () => {
    await server.exec(`create schema cut103;
      create table cut103.big (id int primary key, t text, b bytea, j jsonb, n int not null);
      insert into cut103.big values
        (1, repeat('x', ${MB}), decode(repeat('ab', ${MB}), 'hex'), ('{"k":"' || repeat('y', ${MB}) || '"}')::jsonb, 1),
        (2, repeat('日', 400000), decode('00ff', 'hex'), '{"k":1}', 2),
        (3, 'short', decode(repeat('cd', ${CUT_BYTES}), 'hex'), null, 3);`);
    big = new DbQueries({
      async run(st: Stmt): Promise<DbRows> {
        ran.push(st);
        const r = await db.run(st);
        wire.push(...r.rows);
        return r;
      },
      close: () => db.close(),
      get closed() { return db.closed; },
      get tlsActive() { return db.tlsActive; }
    }, () => now);
  });
  afterAll(() => server.exec('drop schema cut103 cascade;'));

  test('a 1 MB text and a 1 MB bytea arrive cut, each with its whole size; the query log shows the left(…) form', async () => {
    await fresh();
    wire.length = 0;
    const p = await big.page(req(ref('big', 'cut103')));
    expect(p.columns.map((c) => c.name)).toEqual(['id', 't', 'b', 'j', 'n']);
    const [one, two, three] = p.rows;
    // Text: the first 64 KB, the whole value's bytes; a bytea: 64 KB of its bytes as hex, its bytes counted.
    expect(one?.[1]).toEqual({ v: 'x'.repeat(CUT_BYTES), cut: MB });
    expect(one?.[2]).toEqual({ v: '\\x' + 'ab'.repeat(CUT_BYTES), cut: MB });
    expect(one?.[3]?.cut).toBe(MB + 9); // {"k": "…"} as jsonb prints it
    expect(one?.[3]?.v).toBe('{"k": "' + 'y'.repeat(CUT_BYTES - 7));
    // 400,000 characters of 3 bytes: the server cut them to 65,537 characters; cellOf to whole characters within 64 KB;
    // the size is the server's (1.2 MB), not what arrived.
    expect(two?.[1]).toEqual({ v: '日'.repeat(Math.floor(CUT_BYTES / 3)), cut: 1_200_000 });
    expect(two?.[2]).toEqual({ v: '\\x00ff' });
    // Exactly 64 KB of bytes: whole (its hex is 2 + 2 × 64 KB characters).
    expect(three?.[2]).toEqual({ v: '\\x' + 'cd'.repeat(CUT_BYTES) });
    expect(three?.[3]).toEqual({ v: null });
    // Nothing longer than the cut crossed the network.
    expect(Math.max(...wire.flat().map((v) => v?.length ?? 0))).toBeLessThanOrEqual(CUT_HEX_CHARS);
    expect(wire.flat().filter((v) => (v?.length ?? 0) > CUT_CHARS && !v!.startsWith('\\x'))).toEqual([]);
    const page = (await sent()).find((l) => l.includes('"cut103"."big"')) ?? '';
    expect(page).toContain('pg_catalog.left("t"::pg_catalog.text, 65537) AS "t"');
    expect(page).toContain('pg_catalog.left("b"::pg_catalog.text, 131075) AS "b"');
    expect(page).toContain('pg_catalog.octet_length("b")');
    // The SQL popover shows the read itself, without the transport's cut.
    expect(p.sql).toBe('SELECT "id", "t", "b", "j", "n" FROM "cut103"."big" ORDER BY "id" ASC LIMIT 100 OFFSET 0');
  });

  test('a peek and the row itself (the inspector\'s hidden fields) come cut the same way', async () => {
    wire.length = 0;
    const peek = await big.peek(ref('big', 'cut103'), ['id'], ['1']);
    expect(peek.row?.[1]).toEqual({ v: 'x'.repeat(CUT_BYTES), cut: MB });
    expect(peek.row?.[2]?.cut).toBe(MB);
    const self = await big.peek(ref('big', 'cut103'), ['id'], ['1'], true);
    expect(self.row).toEqual(peek.row);
    expect(Math.max(...wire.flat().map((v) => v?.length ?? 0))).toBeLessThanOrEqual(CUT_HEX_CHARS);
  });

  test('Load full value is unchanged: the whole value, up to 16 MB', async () => {
    expect(await big.full(ref('big', 'cut103'), { id: '1' }, 't')).toBe('x'.repeat(MB));
  });
});

describe('only a page of a relation without a row key runs in the stable wrapper', () => {
  /** The wrapper each statement ran in: the BEGIN logged right before it. */
  async function wrappers(): Promise<{ begin: string; text: string }[]> {
    const log = (await server.statementsLog()).filter((l) => l !== 'ROLLBACK');
    return log.flatMap((l, i) => (l.startsWith('BEGIN') ? [] : [{ begin: log[i - 1] ?? '', text: l }]));
  }

  test('events_nopk\'s page (sorted or not): stable; its estimate and count, a keyed page, a peek: the plain one (parallel workers kept)', async () => {
    await q.page(req(ref('events_nopk')));
    await q.page(req(ref('orders')));
    await fresh();
    await q.page(req(ref('events_nopk')));
    await q.page(req(ref('events_nopk'), { sort: [{ column: 'kind', dir: 'asc' }] }));
    await q.page(req(ref('orders')));
    await q.page(req(ref('currency_rates')));
    await q.count(ref('events_nopk'), []);
    await q.estimate(ref('events_nopk'), [{ column: 'kind', op: 'eq', values: ['login'] }]);
    await q.peek(ref('customers'), ['id'], ['1']);
    const ran = await wrappers();
    const by = (re: RegExp) => ran.filter((x) => re.test(x.text)).map((x) => x.begin);
    expect(by(/^SELECT .* FROM "public"\."events_nopk" .*LIMIT/)).toEqual([STABLE, STABLE]);
    expect(by(/^SELECT .* FROM "public"\."(orders|currency_rates)" .*LIMIT/)).toEqual([WRAP, WRAP]);
    expect(by(/count\(\*\)|EXPLAIN|"public"\."customers"/)).toEqual([WRAP, WRAP, WRAP]);
  });
});

describe('cells', () => {
  test('a value up to CUT_BYTES comes whole; past it, the first CUT_BYTES bytes and the whole length', () => {
    expect(cellOf(null)).toEqual({ v: null });
    expect(cellOf('')).toEqual({ v: '' });
    const exact = 'x'.repeat(CUT_BYTES);
    expect(cellOf(exact)).toEqual({ v: exact });
    expect(cellOf(exact + 'y')).toEqual({ v: exact, cut: CUT_BYTES + 1 });
  });

  test('cut on the server: the size the server measured; a bytea\'s hex holds 64 KB of bytes, its size in bytes', () => {
    const exact = 'x'.repeat(CUT_BYTES);
    expect(cellOf(exact, 'text', CUT_BYTES)).toEqual({ v: exact });
    expect(cellOf(exact + 'y', 'text', 5_000_000)).toEqual({ v: exact, cut: 5_000_000 });
    // A server in another encoding counts other bytes: never less than what arrived.
    expect(cellOf('é'.repeat(CUT_BYTES), 'text', CUT_BYTES)).toEqual({ v: 'é'.repeat(CUT_BYTES / 2), cut: 2 * CUT_BYTES });
    expect(cellOf(null, 'text', null as unknown as number)).toEqual({ v: null });
    const hex = '\\x' + 'ab'.repeat(CUT_BYTES);
    expect(cellOf(hex, 'hex', CUT_BYTES)).toEqual({ v: hex });
    expect(cellOf(hex + 'c', 'hex', 3_000_000)).toEqual({ v: hex, cut: 3_000_000 });
  });

  test('never splits a character: a cut ends before a multibyte character that straddles CUT_BYTES', () => {
    // '日' is 3 bytes: 'a' + 21845 of them is 65536 bytes exactly (whole); one more straddles the limit.
    const fits = 'a' + '日'.repeat(21845);
    expect(Buffer.byteLength(fits)).toBe(CUT_BYTES);
    expect(cellOf(fits)).toEqual({ v: fits });
    const over = 'ab' + '日'.repeat(21845);
    const c = cellOf(over);
    expect(c.cut).toBe(CUT_BYTES + 1);
    expect(c.v).toBe('ab' + '日'.repeat(21844));
    expect(Buffer.byteLength(c.v ?? '')).toBe(CUT_BYTES - 2);
    // A 4-byte character (two UTF-16 units) across the limit: dropped whole, no lone surrogate, no U+FFFD.
    const emoji = 'abc' + '😀'.repeat(16384);
    const e = cellOf(emoji);
    expect(e.cut).toBe(3 + 4 * 16384);
    expect(e.v).toBe('abc' + '😀'.repeat(16383));
    expect(e.v).not.toContain('�');
  });
});

describe('estimates and counts', () => {
  test("without filters, on a table: the catalog's reltuples, read once, never an EXPLAIN", async () => {
    q.forget();
    await fresh();
    const a = await q.estimate(ref('orders'), []);
    const b = await q.estimate(ref('orders'), []);
    expect(shapes()).toEqual(['cat.columns']);
    const texts = await sent();
    expect(texts).toHaveLength(1);
    expect(texts.filter((t) => /EXPLAIN/i.test(t))).toEqual([]);
    const tuples = (await oracle("select reltuples::int8 from pg_class where oid = 'public.orders'::regclass"))[0]?.[0];
    expect(a).toBe(Number(tuples));
    expect(a).toBe(ACME_COUNTS.orders); // the seed ends with ANALYZE
    expect(b).toBe(a);
  });

  test("with filters, or for a view: the planner's estimate, EXPLAIN (FORMAT JSON)'s Plan Rows", async () => {
    await q.page(req(ref('orders'), { size: 1 }));
    await q.page(req(ref('paid_orders'), { size: 1 }));
    await fresh();
    // id < $1: the bound value is planned like a literal (an enum array's cast from text[] would not be folded).
    const filtered = await q.estimate(ref('orders'), [{ column: 'id', op: 'lt', values: ['50'] }]);
    const view = await q.estimate(ref('paid_orders'), []);
    expect(shapes()).toEqual(['estimate', 'estimate']);
    expect((await sent()).filter((t) => t.startsWith('EXPLAIN (FORMAT JSON) SELECT 1 FROM'))).toHaveLength(2);
    expect(filtered).toBe(await plan('explain (format json) select 1 from orders where id < 50'));
    expect(view).toBe(await plan('explain (format json) select 1 from paid_orders'));
    expect(filtered).toBeGreaterThan(0);
  });

  test("a table never analyzed (no statistics): the planner's estimate, even without filters", async () => {
    await server.exec('create table never_analyzed (id int8); insert into never_analyzed select pg_catalog.generate_series(1, 40);');
    await fresh();
    const e = await q.estimate(ref('never_analyzed'), []);
    expect(shapes()).toEqual(['cat.columns', 'estimate']);
    expect(e).toBe(await plan('explain (format json) select 1 from never_analyzed'));
    expect((await q.structure(ref('never_analyzed'))).stats.estimate).toBeNull(); // reltuples -1: unknown
  });

  test('count: count(*) with the filters', async () => {
    expect(await q.count(ref('orders'), [])).toBe(ACME_COUNTS.orders);
    const n = await q.count(ref('orders'), [{ column: 'status', op: 'in', values: ['paid', 'shipped'] }]);
    expect(n).toBe(Number((await oracle("select count(*) from orders where status in ('paid', 'shipped')"))[0]?.[0]));
  });
});

describe('peeks, references and full values', () => {
  test("peek: the row a key names, every column; null when there's none", async () => {
    const p = await q.peek(ref('customers'), ['id'], ['1']);
    expect(p.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'plan', 'created_at']);
    const want = (await oracle('select id::text, name, email, plan::text, created_at::text from customers where id = 1'))[0];
    expect(p.row?.map((c) => c.v)).toEqual(want);
    expect((await q.peek(ref('customers'), ['id'], ['999999'])).row).toBeNull();
  });

  test('refs: order 1 is referenced by four foreign keys; the indexed ones are counted, the others never scanned', async () => {
    await fresh();
    const r = await q.refs(ref('orders'), { id: '1' });
    expect(r.every((x) => x.fk.from.columns.join() === 'order_id' && x.fk.to.columns.join() === 'id')).toBe(true);
    const payments = Number((await oracle('select count(*) from payments where order_id = 1'))[0]?.[0]);
    expect(r.map((x) => ({ table: x.fk.from.table, count: x.count, why: x.why }))).toEqual([
      { table: 'order_items', count: 3 }, { table: 'payments', count: payments },
      { table: 'refunds', count: null, why: 'no-index' }, { table: 'shipments', count: null, why: 'no-index' }
    ]);
    expect(ran.filter((s) => s.shape === 'refs').map((s) => s.text.includes('"order_items"') || s.text.includes('"payments"'))).toEqual([true, true]);
  });

  test("refs through a composite key: each value goes to the column that points at the key's column", async () => {
    // item_notes (item_line, item_order) → order_items (line, order_id): (1, 2) and (2, 1) count differently.
    const at = async (order: string, line: string) => (await q.refs(ref('order_items'), { order_id: order, line })).map((x) => x.count);
    const [fk] = (await q.refs(ref('order_items'), { order_id: '1', line: '1' })).map((x) => x.fk);
    expect(fk).toMatchObject({ name: 'item_notes_item_fkey', from: { columns: ['item_line', 'item_order'] }, to: { columns: ['line', 'order_id'] }, indexed: true });
    expect([await at('1', '1'), await at('1', '2'), await at('2', '1'), await at('1', '3')]).toEqual([[2], [1], [3], [0]]);
  });

  test('refs: a NULL in the key counts 0 without asking (nothing points at a NULL), even through an unindexed key', async () => {
    await q.refs(ref('order_items'), { order_id: '1', line: '1' }); // relations and columns known
    await q.refs(ref('coupons'), { code: 'X' });
    await fresh();
    // item_notes 7 has order 1 and no line: it points at nothing, so it isn't counted for (1, NULL).
    expect((await q.refs(ref('order_items'), { order_id: '1', line: null })).map((x) => x.count)).toEqual([0]);
    expect((await q.refs(ref('coupons'), { code: null })).map((x) => ({ table: x.fk.from.table, count: x.count, why: x.why }))).toEqual([{ table: 'orders', count: 0 }]);
    expect(ran).toEqual([]);
  });

  test('refs: a key without the value of a referenced column leaves that foreign key uncounted (why: value), the others counted', async () => {
    await fresh();
    const view = (rs: DbRefCount[]) => rs.map((x) => ({ table: x.fk.from.table, count: x.count, ...(x.why ? { why: x.why } : {}) }));
    expect(view(await q.refs(ref('order_items'), { order_id: '1' }))).toEqual([{ table: 'item_notes', count: null, why: 'value' }]);
    expect(view(await q.refs(ref('coupons'), {}))).toEqual([{ table: 'orders', count: null, why: 'value' }]);
    // customers: orders.customer_id → id counted; item_notes.author_email → email, its value not sent: not counted.
    const c = view(await q.refs(ref('customers'), { id: '1' }));
    expect(c.find((x) => x.table === 'item_notes')).toEqual({ table: 'item_notes', count: null, why: 'value' });
    expect(c.find((x) => x.table === 'orders')?.count).toBe(Number((await oracle('select count(*) from orders where customer_id = 1'))[0]?.[0]));
    // Nothing was counted for the ones without a value.
    expect(shapes().filter((s) => s === 'refs')).toHaveLength(1);
  });

  test('refs: a self-reference is listed; without an index on manager_id it is not counted', async () => {
    const managed = await q.refs(ref('employees'), { id: '1' });
    expect(managed.map((x) => ({ table: x.fk.from.table, count: x.count, why: x.why }))).toEqual([{ table: 'employees', count: null, why: 'no-index' }]);
  });

  test('Load full value: the whole payload by its primary key, a part of it by path, a column by a unique key', async () => {
    const whole = (await oracle('select payload::text from webhook_events where id = 1'))[0]?.[0];
    const v = await q.full(ref('webhook_events'), { id: '1' }, 'payload');
    expect(Buffer.byteLength(v)).toBe(BIG_DOC_BYTES);
    expect(v).toBe(whole);
    expect(await q.full(ref('webhook_events'), { id: '1' }, 'payload', ['data', 'object', 'metadata', 'contract'])).toBe('ENT-2026-014');
    const [email, name] = (await oracle('select email, name from customers where id = 2'))[0] ?? [];
    expect(await q.full(ref('customers'), { email: email ?? '' }, 'name')).toBe(name);
  });

  test('Load full value on events_nopk: "No key to read the whole value", and nothing reaches the server', async () => {
    await q.page(req(ref('events_nopk'), { size: 1 }));
    await fresh();
    const p = await problem(q.full(ref('events_nopk'), { occurred_at: '2026-11-01 00:00:00+00', kind: 'x' }, 'detail'));
    expect(p).toEqual({ kind: 'other', message: 'No key to read the whole value' });
    expect(await reached()).toEqual([]);
  });

  test("Load full value of a row that's gone, or of a value over 16 MB: a DbError of its own kind (nothing to retry), never a wrong value", async () => {
    expect(await problem(q.full(ref('webhook_events'), { id: '999999' }, 'payload'))).toEqual({ kind: 'norow', message: 'This row no longer exists' });
    // A server that answers 16 MB + 1 byte for the value's length (the text itself cut at FULL_CHARS characters).
    const big: DbSession = {
      run: (st: Stmt) => (st.shape === 'full' ? Promise.resolve({ fields: [], rows: [['x', String(FULL_CHARS + 1)]], ms: 0 }) : db.run(st)),
      close: () => {},
      closed: false,
      tlsActive: false
    };
    expect(await problem(new DbQueries(big).full(ref('webhook_events'), { id: '1' }, 'payload'))).toEqual({ kind: 'toolarge', message: 'This value is over 16 MB' });
  });

  test('a table without a primary key but a unique NOT NULL key: that key names its rows — pages say so and load it, Load full value and the hidden fields\' read work by it', async () => {
    const p = await q.page(req(ref('currency_rates'), { columns: ['rate'], size: 10 }));
    expect(p.pk).toEqual([]);
    expect(p.rowKey).toEqual(['code']);
    // The nullable unique column (alias) can't name a row: never the row's key.
    expect([p.columns.map((c) => c.name), p.hidden]).toEqual([['rate', 'code'], ['code']]);
    expect(p.rows.map((r) => r[1]?.v).sort()).toEqual(['EUR', 'JPY', 'USD']);
    expect(await q.full(ref('currency_rates'), { code: 'USD' }, 'note')).toBe('ECB reference rate, 2026-11-04');
    const read = await q.peek(ref('currency_rates'), ['code'], ['JPY']);
    expect(read.row?.[read.columns.findIndex((c) => c.name === 'note')]?.v).toBe('Rounded to six places');
    // A table with a primary key: that one; with neither: none.
    expect((await q.page(req(ref('orders'), { size: 1 }))).rowKey).toEqual(['id']);
    expect((await q.page(req(ref('events_nopk'), { size: 1 }))).rowKey).toEqual([]);
    expect((await oracle('select count(*) from currency_rates'))[0]?.[0]).toBe(String(ACME_COUNTS.currency_rates));
  });

  test('pages of a table without a primary key are stable by its unique NOT NULL key — page after page, every row once, in key order', async () => {
    const codes: (string | null)[] = [];
    for (let page = 0; page < 4; page++) {
      const p = await q.page(req(ref('currency_rates'), { columns: ['code'], size: 1, page }));
      codes.push(...p.rows.map((r) => r[0]?.v ?? null));
    }
    expect(codes).toEqual(['EUR', 'JPY', 'USD']);
    expect((await q.page(req(ref('currency_rates'), { size: 1 }))).sql).toContain('ORDER BY "code" ASC');
  });

  test('the hidden fields\' read (a peek of the row itself) names one row by the row\'s key — any other key is refused before anything runs', async () => {
    const r = await q.peek(ref('currency_rates'), ['code'], ['USD'], true);
    expect(r.row?.[r.columns.findIndex((c) => c.name === 'rate')]?.v).toBe('1.083200');
    expect((await q.peek(ref('orders'), ['id'], ['1'], true)).row?.[0]?.v).toBe('1');
    await fresh();
    for (const [name, cols, values] of [['currency_rates', ['alias'], ['euro']], ['events_nopk', ['kind'], ['login']], ['order_items', ['order_id'], ['1']]] as const) {
      expect(await problem(q.peek(ref(name), [...cols], [...values], true)), name).toEqual({ kind: 'other', message: 'No key to read this row' });
    }
    expect(shapes().filter((s) => s === 'row')).toEqual([]);
    // A foreign key's peek (not the row itself) is as before: its target's columns, whatever key they are.
    expect((await q.peek(ref('currency_rates'), ['alias'], ['euro'])).row?.[1]?.v).toBe('EUR');
  });

  test('structure, relations and DDL come from the catalog reader', async () => {
    const s = await q.structure(ref('orders'));
    expect([s.schema, s.name, s.kind]).toEqual(['public', 'orders', 'table']);
    const r = await q.relations(ref('orders'));
    expect(r.in.map((f) => f.from.table)).toEqual(['order_items', 'payments', 'refunds', 'shipments']);
    expect(r.out.map((f) => f.to.table)).toEqual(['coupons', 'customers']); // by constraint name
    expect((await q.ddl(ref('orders'))).startsWith('CREATE TABLE ')).toBe(true);
    expect(await problem(q.structure(ref('no_such_table')))).toMatchObject({ kind: 'unknown-table' });
  });

  test('DDL of a function: by its schema, name and identity arguments, through the same path', async () => {
    const fn = { connId: 'c0123456789ab', schema: 'public', name: 'order_total', args: 'bigint' };
    expect(await q.ddl(fn)).toMatch(/^CREATE OR REPLACE FUNCTION public\.order_total\(order_id bigint\)/);
    expect(await problem(q.ddl({ ...fn, args: 'integer' }))).toEqual({ kind: 'gone', message: 'This function no longer exists' });
    // A table's DDL is still a table's, whatever its name: only `args` makes it a function.
    expect(await problem(q.ddl(ref('order_total')))).toMatchObject({ kind: 'unknown-table' });
  });
});

describe('Referenced by never loses every count', () => {
  const view = (r: DbRefCount[]) => r.map((x) => ({ table: x.fk.from.table, count: x.count, why: x.why }));
  const payments = async () => Number((await oracle('select count(*) from payments where order_id = 1'))[0]?.[0]);

  test('a count past the timeout is "slow"; once the timeout has closed the session, the counts after it are too, without a throw', async () => {
    const qs = new DbQueries(faulty([{ when: countOn('order_items'), answer: { kind: 'canceled', message: 'Stopped after 15 s' }, closes: true }]));
    expect(view(await qs.refs(ref('orders'), { id: '1' }))).toEqual([
      { table: 'order_items', count: null, why: 'slow' }, { table: 'payments', count: null, why: 'slow' },
      { table: 'refunds', count: null, why: 'no-index' }, { table: 'shipments', count: null, why: 'no-index' }
    ]);
  });

  test('after a canceled count (57014, session open), a later lost one is "slow" too', async () => {
    const qs = new DbQueries(faulty([
      { when: countOn('order_items'), answer: { kind: 'canceled', message: 'Stopped after 15 s', code: '57014' } },
      { when: countOn('payments'), answer: { kind: 'lost', message: 'Reconnecting…' } }
    ]));
    expect(view(await qs.refs(ref('orders'), { id: '1' })).slice(0, 2)).toEqual([
      { table: 'order_items', count: null, why: 'slow' }, { table: 'payments', count: null, why: 'slow' }
    ]);
  });

  test('a count the role may not read (42501) is "denied"; the others still come back', async () => {
    const qs = new DbQueries(faulty([{ when: countOn('order_items'), answer: { kind: 'denied', message: "This role can't read order_items", code: '42501' } }]));
    expect(view(await qs.refs(ref('orders'), { id: '1' })).slice(0, 2)).toEqual([
      { table: 'order_items', count: null, why: 'denied' }, { table: 'payments', count: await payments() }
    ]);
  });

  test('a referencing table the catalog no longer shows is "denied"; the others still come back', async () => {
    const qs = new DbQueries(faulty([{ when: (st) => st.shape === 'cat.columns' && st.values[1] === 'order_items', answer: { rows: [] } }]));
    expect(view(await qs.refs(ref('orders'), { id: '1' })).slice(0, 2)).toEqual([
      { table: 'order_items', count: null, why: 'denied' }, { table: 'payments', count: await payments() }
    ]);
  });

  test('a lost connection with no timeout before it, or any other error, rejects (the hub reconnects; the request was wrong)', async () => {
    const gone = new DbQueries(faulty([{ when: countOn('payments'), answer: { kind: 'lost', message: 'Reconnecting…' } }]));
    expect(await problem(gone.refs(ref('orders'), { id: '1' }))).toMatchObject({ kind: 'lost' });
    expect(await problem(q.refs(ref('orders'), { id: 'not a number' }))).toMatchObject({ kind: 'other', code: '22P02' });
  });
});

describe('the primary key and the referenced columns are always selected', () => {
  test('hidden: the key columns the request left out, after its own, in table order; derived columns after them', async () => {
    const p = await q.page(req(ref('customers'), { columns: ['name'], size: 3 }));
    expect(p.columns.map((c) => c.name)).toEqual(['name', 'id', 'email']); // id: the primary key; email: item_notes.author_email
    expect(p.hidden).toEqual(['id', 'email']);
    expect(p.rows.map((row) => row.map((c) => c.v))).toEqual(await oracle('select name, id::text, email from customers c order by c.id limit 3'));
    const items = await q.page(req(ref('order_items'), { columns: ['sku'], size: 2 }));
    expect([items.columns.map((c) => c.name), items.hidden]).toEqual([['sku', 'order_id', 'line'], ['order_id', 'line']]);
    const derived: DbDerived[] = [{ column: 'payload', path: ['data', 'object', 'status'] }];
    const w = await q.page(req(ref('webhook_events'), { columns: ['type'], derived, size: 3 }));
    expect(w.hidden).toEqual(['id']);
    expect(w.rows.map((row) => row.map((c) => c.v))).toEqual(
      await oracle("select type, id::text, payload #>> '{data,object,status}' from webhook_events w order by w.id limit 3")
    );
  });

  test('nothing hidden when the request has them, or selects every column (and no relations read for that)', async () => {
    expect((await q.page(req(ref('customers'), { columns: ['email', 'name', 'id'], size: 1 }))).hidden).toEqual([]);
    q.forget();
    await fresh();
    const all = await q.page(req(ref('customers'), { size: 1 }));
    expect(all.hidden).toEqual([]);
    expect(shapes()).toEqual(['cat.columns', 'page']);
  });

  test('an unknown name is refused before the relations are read', async () => {
    q.forget();
    await q.count(ref('customers'), []); // columns known, relations not
    await fresh();
    expect(await problem(q.page(req(ref('customers'), { columns: ['name'], filters: [{ column: 'nope', op: 'null', values: [] }] })))).toMatchObject({ kind: 'unknown-table' });
    expect(ran).toEqual([]);
  });

  test('the relations read failing never fails the page — the row key is still loaded, the referenced columns aren\'t', async () => {
    const r = new DbQueries(faulty([{ when: (st) => st.shape === 'cat.relations', answer: { kind: 'denied', message: 'nope' } }]), () => now);
    const p = await r.page(req(ref('customers'), { columns: ['name'], size: 3 }));
    expect(p.columns.map((c) => c.name)).toEqual(['name', 'id']);
    expect(p.hidden).toEqual(['id']);
    expect(p.rows.map((row) => row.map((c) => c.v))).toEqual(await oracle('select name, id::text from customers c order by c.id limit 3'));
    // A failed read isn't kept: the next page reads the relations again (here they fail again: same page).
    expect((await r.page(req(ref('customers'), { columns: ['name'], size: 1 }))).hidden).toEqual(['id']);
  });
});

describe('the cache stays small', () => {
  /** A server with no tables at all: every lookup is quick, and every table is unknown (still cached). */
  function empty(log: Stmt[]): DbSession {
    return {
      run(st: Stmt): Promise<DbRows> {
        log.push(st);
        return Promise.resolve({ fields: [], rows: st.shape === 'cat.version' ? [['180000']] : [], ms: 0 });
      },
      close: () => {},
      closed: false,
      tlsActive: false
    };
  }

  test('at most CACHE_CAP tables: the oldest goes first', async () => {
    const log: Stmt[] = [];
    const qs = new DbQueries(empty(log), () => 0);
    const ask = (i: number) => qs.count(ref('t' + i), []).catch(() => {});
    const reads = () => log.filter((s) => s.shape === 'cat.columns').length;
    for (let i = 0; i <= CACHE_CAP; i++) await ask(i);
    expect(reads()).toBe(CACHE_CAP + 1);
    expect(qs.cacheSize()).toBe(CACHE_CAP);
    await ask(CACHE_CAP);
    await ask(1);
    expect(reads()).toBe(CACHE_CAP + 1); // kept
    await ask(0);
    expect(reads()).toBe(CACHE_CAP + 2); // t0 was the one that went
  });

  test('expired tables go when another one is read', async () => {
    let t = 0;
    const qs = new DbQueries(empty([]), () => t);
    for (let i = 0; i < 10; i++) await qs.count(ref('t' + i), []).catch(() => {});
    expect(qs.cacheSize()).toBe(10);
    t += CACHE_MS;
    await qs.count(ref('t10'), []).catch(() => {});
    expect(qs.cacheSize()).toBe(1);
  });
});

describe('the column cache', () => {
  test("a table's columns are read once per 30 s; forget() drops them", async () => {
    q.forget();
    await fresh();
    await q.page(req(ref('customers'), { size: 5 }));
    now += 29_999;
    await q.count(ref('customers'), []);
    expect(shapes()).toEqual(['cat.columns', 'page', 'count']);
    now += 1;
    await q.count(ref('customers'), []);
    expect(shapes().slice(3)).toEqual(['cat.columns', 'count']);
    q.forget();
    await q.count(ref('customers'), []);
    expect(shapes().slice(5)).toEqual(['cat.columns', 'count']);
  });

  test('requests at the same time share one catalog read', async () => {
    q.forget();
    await fresh();
    await Promise.all([q.page(req(ref('customers'))), q.estimate(ref('customers'), []), q.count(ref('customers'), [])]);
    expect(shapes().filter((s) => s === 'cat.columns')).toHaveLength(1);
  });

  test('a column dropped under the cache: that page fails, the next one reads the table again', async () => {
    await server.exec("create table scratch_cols (id int8 primary key, gone text, kept text); insert into scratch_cols values (1, 'a', 'b');");
    expect((await q.page(req(ref('scratch_cols')))).columns.map((c) => c.name)).toEqual(['id', 'gone', 'kept']);
    await server.exec('alter table scratch_cols drop column gone;');
    expect(await problem(q.page(req(ref('scratch_cols'))))).toMatchObject({ code: '42703' });
    const p = await q.page(req(ref('scratch_cols')));
    expect(p.columns.map((c) => c.name)).toEqual(['id', 'kept']);
    expect(p.rows).toEqual([[{ v: '1' }, { v: 'b' }]]);
  });
});

describe('a page past the timeout', () => {
  // Its own server: one PGlite backend, and slow_view's sleep holds it to the end (the client-side timeout stops it).
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start(); });
  afterAll(async () => { await s?.stop(); });

  test('slow_view with a 1 s timeout: canceled, not a hang, and the session is closed', async () => {
    const one = await postgresDriver.connect({ host: '127.0.0.1', port: s.port, database: 'postgres', user: 'postgres', password: '', tls: 'off', timeoutSec: 1 });
    const t0 = Date.now();
    expect(await problem(new DbQueries(one).page(req(ref('slow_view'))))).toEqual({ kind: 'canceled', message: 'Stopped after 1 s' });
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(one.closed).toBe(true);
  });
});

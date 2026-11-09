// The test Postgres: PGlite (Postgres compiled to WASM) in a worker thread, behind
// our front proxy, which answers SSL requests, checks a password when asked, logs the statements it sees and can drop
// every connection. Values are read as Postgres's text output (the raw type parser), as the app's client reads them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ACME_COUNTS, ACME_NOW, BIG_DOC_BYTES, TYPE_ZOO_COLUMNS } from './pg-fixtures';
import { PgServer } from './pg-server';

const raw = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;

function client(s: PgServer, o: pg.ClientConfig = {}): pg.Client {
  const c = new pg.Client({ host: '127.0.0.1', port: s.port, user: 'postgres', database: 'postgres', types: raw, ...o });
  // A dropped connection also surfaces through the pending query; the event alone would be an unhandled error.
  c.on('error', () => {});
  return c;
}

async function connected(s: PgServer, o: pg.ClientConfig = {}): Promise<pg.Client> {
  const c = client(s, o);
  await c.connect();
  return c;
}

const first = async (c: pg.Client, sql: string, values?: unknown[]) => (await c.query(sql, values)).rows[0] as Record<string, string>;

describe('the seeded server (the acme world)', () => {
  let s: PgServer;
  let c: pg.Client;
  beforeAll(async () => {
    s = await PgServer.start();
    c = new pg.Client({ connectionString: s.url, types: raw });
    await c.connect();
  });
  afterAll(async () => {
    await c?.end().catch(() => {});
    await s?.stop();
  });

  test('is reached through its url, on 127.0.0.1, without a password', () => {
    expect(s.url).toBe(`postgres://postgres@127.0.0.1:${s.port}/postgres`);
    expect(s.port).toBeGreaterThan(0);
  });

  test('serves the fixtures: 120 orders, 40 customers, a table whose name has quotes and a space', async () => {
    expect(await first(c, 'select count(*) from orders')).toEqual({ count: '120' });
    expect(await first(c, 'select count(*) from customers')).toEqual({ count: '40' });
    const weird = await c.query('select "Weird Col" from "Order ""Items""" order by 1');
    expect(weird.rows.length).toBeGreaterThan(0);
    expect(Object.keys(weird.rows[0] as object)).toEqual(['Weird Col']);
  });

  test('orders span the 10 days before the fixed ACME_NOW, never after it (no now() in the data)', async () => {
    const r = await first(c, "select extract(epoch from min(created_at))::int8 as lo, extract(epoch from max(created_at))::int8 as hi from orders");
    const now = Date.parse(ACME_NOW) / 1000;
    expect(Number(r.hi)).toBeLessThanOrEqual(now);
    expect(Number(r.hi)).toBeGreaterThan(now - 86_400);
    expect(Number(r.lo)).toBeGreaterThanOrEqual(now - 10 * 86_400);
  });

  test("webhook_events 1's payload is the big document: BIG_DOC_BYTES of text, over 70 KB", async () => {
    const r = await first(c, 'select octet_length(payload::text) as n from webhook_events where id = 1');
    expect(r.n).toBe(String(BIG_DOC_BYTES));
    expect(BIG_DOC_BYTES).toBeGreaterThan(70 * 1024);
  });

  test('type_zoo has one column per listed type, and its rows read back', async () => {
    const cols = await c.query(`
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, coalesce(eb.typname, e.typname, b.typname, t.typname) as "typeName"
      from pg_attribute a join pg_type t on t.oid = a.atttypid left join pg_type e on t.typcategory = 'A' and e.oid = t.typelem
      left join pg_type eb on e.typtype = 'd' and eb.oid = e.typbasetype left join pg_type b on t.typtype = 'd' and b.oid = t.typbasetype
      where a.attrelid = 'type_zoo'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`);
    expect(cols.rows).toEqual(TYPE_ZOO_COLUMNS);
    const rows = (await c.query('select * from type_zoo order by id')).rows as Record<string, string | null>[];
    expect(rows.length).toBe(3);
    expect(rows[0]?.c_bytea?.startsWith('\\x89504e470d0a1a0a')).toBe(true); // a PNG
    expect(rows[2]?.c_int8).toBe('9007199254740993'); // past 2^53: exact only as text
  });

  test('every table holds ACME_COUNTS rows; the views, the function and the comments are there', async () => {
    for (const [table, n] of Object.entries(ACME_COUNTS)) {
      const name = table.includes('"') ? `"${table.replace(/"/g, '""')}"` : table;
      expect([table, (await first(c, `select count(*) from ${name}`)).count]).toEqual([table, String(n)]);
    }
    expect(await first(c, 'select count(*) as n from order_items where order_id = 1')).toEqual({ n: '3' });
    expect(await first(c, 'select order_total(1) > 0 as ok')).toEqual({ ok: 't' });
    expect((await first(c, 'select count(*) from paid_orders')).count).not.toBe('0');
    expect((await first(c, 'select count(*) from daily_revenue')).count).not.toBe('0');
    expect(await first(c, "select obj_description('orders'::regclass, 'pg_class') as d")).toEqual({ d: 'One row per checkout' });
    const fks = await c.query("select conrelid::regclass::text as t from pg_constraint where contype = 'f' and confrelid = 'orders'::regclass order by 1");
    expect(fks.rows.map((r) => (r as { t: string }).t)).toEqual(['order_items', 'payments', 'refunds', 'shipments']);
  });

  test('logs every statement the proxy saw, simple and extended, in order; clearLog empties it', async () => {
    await s.clearLog();
    await c.query('select count(*) from orders');
    await c.query('select $1::int8 as n', ['7']);
    expect(await s.statementsLog()).toEqual(['select count(*) from orders', 'select $1::int8 as n']);
    await s.clearLog();
    expect(await s.statementsLog()).toEqual([]);
  });

  test("logs every StartupMessage's parameters, in order; clearLog empties it", async () => {
    await s.clearLog();
    const other = await connected(s, { application_name: 'probe', options: '-c search_path=public' });
    expect(await s.startupsLog()).toEqual([
      // client_encoding: pg adds it to every StartupMessage.
      { user: 'postgres', database: 'postgres', application_name: 'probe', options: '-c search_path=public', client_encoding: 'UTF8' }
    ]);
    await other.end();
    await s.clearLog();
    expect(await s.startupsLog()).toEqual([]);
  });

  test('exec runs on the instance itself: the client sees its work, the log does not', async () => {
    await s.clearLog();
    await s.exec('create table scratch (x int); insert into scratch values (1), (2)');
    expect(await s.statementsLog()).toEqual([]);
    expect(await first(c, 'select count(*) from scratch')).toEqual({ count: '2' });
  });

  test("a sleeping query runs in the worker: the test process's timers keep ticking", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      await c.query('select pg_sleep(1)');
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(20);
    expect((await first(c, "select pg_get_viewdef('slow_view') as d")).d).toMatch(/pg_sleep\(\(?8\)?/);
  });

  test('answers an SSL request with N when TLS is off', async () => {
    await expect(connected(s, { ssl: { rejectUnauthorized: false } })).rejects.toThrow(/does not support SSL/);
  });
});

describe('connections dropped and taken again', () => {
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start({ seed: false }); });
  afterAll(async () => { await s?.stop(); });

  test('stopListening breaks a live client and refuses new ones; resume listens again on the same port', async () => {
    const live = await connected(s);
    expect(await first(live, 'select 1 as one')).toEqual({ one: '1' });
    const port = s.port;
    await s.stopListening();
    await expect(live.query('select 1')).rejects.toThrow();
    await expect(connected(s)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await s.resume();
    expect(s.port).toBe(port);
    const again = await connected(s);
    expect(await first(again, 'select 2 as two')).toEqual({ two: '2' });
    await again.end();
  });

  test('terminate ends every connection as a restarting server does (FATAL 57P01), and keeps listening', async () => {
    const holder = await connected(s);
    const c = await connected(s); // before holder's transaction: a startup waits behind it too
    await holder.query('begin read only'); // the backend now serves holder alone: c's query waits in flight
    const waiting = c.query('select 1').catch((e: Error & { code?: string }) => e);
    await s.terminate();
    expect(await waiting).toMatchObject({ code: '57P01', message: 'terminating connection due to administrator command' });
    // Its transaction went with it, and new clients get in.
    const b = await connected(s);
    expect(await first(b, "select current_setting('transaction_read_only') as ro")).toEqual({ ro: 'off' });
    await b.end();
  });

  test('without seed the instance is empty', async () => {
    const c = await connected(s);
    expect(await first(c, "select to_regclass('orders') as t")).toEqual({ t: null });
    await c.end();
  });

  test('a client dropped inside a transaction leaves none behind for the next one', async () => {
    const a = await connected(s);
    await a.query('begin read only');
    await s.stopListening();
    await s.resume();
    const b = await connected(s);
    // One backend serves both: a's read-only transaction would still be open here if nobody rolled it back.
    expect(await first(b, "select current_setting('transaction_read_only') as ro")).toEqual({ ro: 'off' });
    await b.end();
  });

  test("exec waits for a client's open transaction instead of running inside it, and reports errors", async () => {
    const a = await connected(s);
    await a.query('begin read only');
    const created = s.exec('create table after_tx (x int)');
    await a.query('select 1'); // still a's turn: the backend is a's until it ends the transaction
    await a.query('rollback');
    await created; // inside a's read-only transaction it would have failed with 25006
    expect(await first(a, "select to_regclass('after_tx') is not null as there")).toEqual({ there: 't' });
    await a.end();
    await expect(s.exec('select * from no_such_table')).rejects.toThrow(/no_such_table" does not exist/);
  });

  test('stop frees the port, even in the middle of a sleep', async () => {
    const other = await PgServer.start({ seed: false });
    const c = await connected(other);
    const sleeping = c.query('select pg_sleep(30)').catch((e: Error) => e);
    const t0 = Date.now();
    await other.stop();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await sleeping).toBeInstanceOf(Error);
    await expect(connected(other)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe('a password', () => {
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start({ password: 'pw', seed: false }); });
  afterAll(async () => { await s?.stop(); });

  test('a wrong one is refused with 28P01, as Postgres does', async () => {
    await expect(connected(s, { password: 'nope' })).rejects.toMatchObject({
      code: '28P01',
      message: 'password authentication failed for user "postgres"'
    });
  });

  test('the right one connects', async () => {
    const c = await connected(s, { password: 'pw' });
    expect(await first(c, 'select 1 as one')).toEqual({ one: '1' });
    await c.end();
  });
});

describe('TLS', () => {
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start({ tls: true, seed: false }); });
  afterAll(async () => { await s?.stop(); });

  test('a client that accepts any certificate connects over TLS', async () => {
    const c = await connected(s, { ssl: { rejectUnauthorized: false } });
    expect(await first(c, 'select 1 as one')).toEqual({ one: '1' });
    expect((c as unknown as { connection: { stream: { encrypted?: boolean } } }).connection.stream.encrypted).toBe(true);
    await c.end();
  });

  test('a client that verifies the certificate refuses the self-signed one', async () => {
    await expect(connected(s, { ssl: { rejectUnauthorized: true } })).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  test('the committed key says it is a throwaway test fixture, never a real key (the text before its PEM block)', () => {
    const key = readFileSync(join(__dirname, '../fixtures/pg-tls/server.key'), 'utf8');
    const note = key.slice(0, key.indexOf('-----BEGIN PRIVATE KEY-----'));
    expect(note).toMatch(/throwaway test fixture/i);
    expect(note).toMatch(/never a real key/i);
  });
});

describe('the worker', () => {
  test("names the pglite-socket version whose private members it uses; that version is the one pinned and installed", () => {
    const root = join(__dirname, '..', '..');
    const worker = readFileSync(join(__dirname, 'pg-worker.mjs'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    const installed = (JSON.parse(readFileSync(join(root, 'node_modules/@electric-sql/pglite-socket/package.json'), 'utf8')) as { version: string }).version;
    expect(pkg.devDependencies['@electric-sql/pglite-socket']).toBe(installed); // pinned exactly, no range
    expect(worker).toContain(`Pinned: @electric-sql/pglite-socket ${installed}`);
    expect(worker).toMatch(/inner\.queryQueue\.enqueue\(/);
    expect(worker).toMatch(/inner\.server\.address\(\)/);
  });

  test("never holds the test process open: unref'd once ready, ref'd only while a call waits for its answer", async () => {
    const ref = vi.spyOn(Worker.prototype, 'ref');
    const unref = vi.spyOn(Worker.prototype, 'unref');
    const s = await PgServer.start({ seed: false });
    try {
      expect(unref).toHaveBeenCalledTimes(1);
      expect(ref).not.toHaveBeenCalled();
      const both = Promise.all([s.clearLog(), s.statementsLog()]);
      expect(ref).toHaveBeenCalledTimes(1); // two calls waiting: one ref
      await both;
      expect(unref).toHaveBeenCalledTimes(2); // the last answer lets go again
    } finally {
      ref.mockRestore();
      unref.mockRestore();
      await s.stop();
    }
  });
});

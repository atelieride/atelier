// The Postgres client against a real Postgres (PGlite behind the test proxy,
// tests/support/pg-server.ts): every statement inside BEGIN TRANSACTION READ ONLY … ROLLBACK, writes refused by the
// server, one statement at a time, timeouts and lost connections that close the session instead of hanging it, the TLS
// modes, and a config that nothing in the environment (PG* variables, a .pgpass) can change.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The module object pg's own require('tls') gets: spied on, it sees what reaches tls.connect.
import tls from 'node:tls';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DbProblem } from '../../src/shared/databases';
import { DbError, type DbConnectConfig, type DbSession, type Stmt } from '../../src/main/databases/driver';
import { caRoots, postgresDriver } from '../../src/main/databases/postgres/client';
import { ACME_COUNTS } from '../support/pg-fixtures';
import { PgServer } from '../support/pg-server';

/** The wrapper of every statement: read only, the timeout, local to the transaction. */
const wrapOf = (ms: number) => `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${ms}`;
const WRAP = wrapOf(15000);
/**
 * A `stable` statement's (a page of a relation without a row key): two more settings, local too, so
 * its OFFSET pages meet the rows in one order — no synchronized scan starting mid-table, no parallel workers.
 */
const STABLE = `${WRAP}; SET LOCAL synchronize_seqscans = off; SET LOCAL max_parallel_workers_per_gather = 0`;

const cfgFor = (s: PgServer, o: Partial<DbConnectConfig> = {}): DbConnectConfig => ({
  host: '127.0.0.1', port: s.port, database: 'postgres', user: 'postgres', password: '', tls: 'off', timeoutSec: 15, ...o
});
const stmt = (text: string, values: unknown[] = []): Stmt => ({ text, values, shape: 'test' });

/** The problem a promise rejects with (a DbError's), or a failure if it resolves. */
async function problem(p: Promise<unknown>): Promise<DbProblem> {
  const e = await p.then(() => new Error('expected a rejection'), (x: unknown) => x);
  expect(e).toBeInstanceOf(DbError);
  return (e as DbError).problem;
}

const count = async (s: DbSession, table: string) => (await s.run(stmt(`select count(*) from ${table}`))).rows[0]?.[0];

/**
 * Returns once every ROLLBACK the sessions sent so far has reached the server. A run settles as soon as its result is
 * in, without waiting for its ROLLBACK (written by then after a success, sent once the server is ready again after an
 * error), and the server reads it in its own time, on another thread: a log read or cleared at once can miss it, or see
 * it land in the fresh log. The test server's exec (unlogged) takes its turn only after a client's open transaction has
 * ended (tests/support/pg-worker.mjs), by its ROLLBACK or by the end of its connection, which the proxy reads after
 * everything sent before it: either way the proxy has logged that ROLLBACK by then.
 */
async function settle(s: PgServer): Promise<void> {
  await s.exec('select 1');
}

/** Empties the server's logs once every ROLLBACK sent so far has reached it. */
async function freshLog(s: PgServer): Promise<void> {
  await settle(s);
  await s.clearLog();
}

/** A plain pg client, as another app would be: it keeps the one backend busy or holds a transaction open. */
async function rawClient(s: PgServer): Promise<pg.Client> {
  const c = new pg.Client({ host: '127.0.0.1', port: s.port, user: 'postgres', database: 'postgres', password: 'unused' });
  c.on('error', () => {}); // the server ends it at the test's end
  await c.connect();
  return c;
}

describe('a session on the acme world', () => {
  let s: PgServer;
  let db: DbSession;
  beforeAll(async () => {
    s = await PgServer.start();
    db = await postgresDriver.connect(cfgFor(s));
  });
  afterAll(async () => {
    db?.close();
    await s?.stop();
  });

  test('returns rows as Postgres prints them, with the field names and type oids', async () => {
    const r = await db.run(stmt('select id, total from orders where id = $1', ['1']));
    expect(r.fields).toEqual([{ name: 'id', oid: 20 }, { name: 'total', oid: 1700 }]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.[0]).toBe('1');
    expect(r.rows[0]?.[1]).toMatch(/^\d+\.\d\d$/); // numeric(10,2) as text, exact
    expect(typeof r.ms).toBe('number');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    const nulls = await db.run(stmt('select null::text as a, 9007199254740993::int8 as b'));
    expect(nulls.rows).toEqual([[null, '9007199254740993']]);
  });

  test('wraps each statement: BEGIN TRANSACTION READ ONLY with SET LOCAL, the statement, ROLLBACK', async () => {
    await freshLog(s);
    await db.run(stmt('select id from orders where id = $1', ['2']));
    await db.run(stmt('select 1 as one')); // the first one's ROLLBACK went out before this one started
    expect((await s.statementsLog()).slice(0, 4)).toEqual([WRAP, 'select id from orders where id = $1', 'ROLLBACK', WRAP]);
  });

  test('refuses writes: an insert ends with 25006 and the table keeps its rows', async () => {
    const p = await problem(db.run(stmt("insert into coupons values ('X')")));
    expect(p).toMatchObject({ kind: 'other', code: '25006' });
    expect(await count(db, 'coupons')).toBe(String(ACME_COUNTS.coupons));
  });

  test('refuses a delete the same way', async () => {
    expect(await problem(db.run(stmt('delete from orders')))).toMatchObject({ kind: 'other', code: '25006' });
    expect(await count(db, 'orders')).toBe(String(ACME_COUNTS.orders));
  });

  test("a statement can't end the transaction to write after it: one statement per run", async () => {
    expect(await problem(db.run(stmt('commit; delete from orders')))).toMatchObject({ kind: 'other', code: '42601' });
    expect(await problem(db.run(stmt('rollback; delete from payments')))).toMatchObject({ kind: 'other', code: '42601' });
    expect(await count(db, 'orders')).toBe(String(ACME_COUNTS.orders));
    expect(await count(db, 'payments')).toBe(String(ACME_COUNTS.payments));
  });

  test('one statement at a time: concurrent runs resolve in order with their own rows, never interleaved', async () => {
    await freshLog(s);
    const done: string[] = [];
    const a = db.run(stmt("select 'a' as x from pg_sleep(0.2)")).then((r) => { done.push('a'); return r; });
    const b = db.run(stmt("select 'b' as x")).then((r) => { done.push('b'); return r; });
    const [ra, rb] = await Promise.all([a, b]);
    expect(done).toEqual(['a', 'b']);
    expect(ra.rows).toEqual([['a']]);
    expect(rb.rows).toEqual([['b']]);
    await db.run(stmt('select 1'));
    expect((await s.statementsLog()).slice(0, 6)).toEqual([
      WRAP, "select 'a' as x from pg_sleep(0.2)", 'ROLLBACK', WRAP, "select 'b' as x", 'ROLLBACK'
    ]);
  });

  test('a stable statement runs in the stable wrapper — the scan from the table\'s first block, no parallel workers —; every other one keeps the server\'s settings', async () => {
    const SETTINGS = "select current_setting('synchronize_seqscans'), current_setting('transaction_read_only')";
    await freshLog(s);
    const stable = await db.run({ ...stmt(SETTINGS), stable: true });
    expect(stable.rows).toEqual([['off', 'on']]);
    const plain = await db.run(stmt(SETTINGS));
    expect(plain.rows).toEqual([['on', 'on']]);
    expect((await s.statementsLog()).filter((l) => l.startsWith('BEGIN'))).toEqual([STABLE, WRAP]);
    // Local to the transaction: once it is rolled back the backend keeps the server's own value (PGlite has one backend,
    // so another client reads the very one ours used: a pooler's next client would see nothing of ours).
    const raw = await rawClient(s);
    try {
      expect((await raw.query("select current_setting('synchronize_seqscans') as v")).rows).toEqual([{ v: 'on' }]);
    } finally {
      await raw.end();
    }
  });

  test('a session told its server is CockroachDB (plainOnly) runs a stable statement in the plain wrapper', async () => {
    const other = await postgresDriver.connect(cfgFor(s));
    try {
      other.plainOnly?.();
      await freshLog(s);
      await other.run({ ...stmt('select 1'), stable: true });
      expect((await s.statementsLog()).filter((l) => l.startsWith('BEGIN'))).toEqual([WRAP]);
    } finally {
      other.close();
    }
  });

  test('ms measures the statement alone', async () => {
    const r = await db.run(stmt('select pg_sleep(0.3)'));
    expect(r.ms).toBeGreaterThanOrEqual(250);
    expect(r.ms).toBeLessThan(2000);
  });

  test("the only SET the server ever sees is the wrapper's; never a COMMIT, never a statement on connect", async () => {
    await freshLog(s);
    const other = await postgresDriver.connect(cfgFor(s));
    expect(await s.statementsLog()).toEqual([]);
    const texts = ['select 1', "insert into coupons values ('Y')", 'select * from no_such_table', 'select $1::int8 as n'];
    for (const t of texts) await other.run(stmt(t, t.includes('$1') ? ['7'] : [])).catch(() => {});
    await other.run(stmt('select 2'));
    other.close();
    await settle(s); // the last run's ROLLBACK, on the wire by now, may not have reached the server yet
    const log = await s.statementsLog();
    expect(log.filter((l) => l !== WRAP && l !== 'ROLLBACK' && !texts.includes(l) && l !== 'select 2')).toEqual([]);
    expect(log.filter((l) => /\b(SET|RESET|COMMIT)\b|set_config/i.test(l) && l !== WRAP && l !== STABLE)).toEqual([]);
    expect(log.filter((l) => l === WRAP)).toHaveLength(texts.length + 1);
    expect(log.filter((l) => l === 'ROLLBACK')).toHaveLength(texts.length + 1);
  });

  test('a server error leaves the session usable', async () => {
    expect(await problem(db.run(stmt('select * from no_such_table')))).toMatchObject({ kind: 'gone', code: '42P01' });
    expect(db.closed).toBe(false);
    expect((await db.run(stmt('select 3'))).rows).toEqual([['3']]);
  });

  test('close ends the session: later runs reject at once', async () => {
    const other = await postgresDriver.connect(cfgFor(s));
    other.close();
    expect(other.closed).toBe(true);
    expect(await problem(other.run(stmt('select 1')))).toMatchObject({ kind: 'lost' });
  });

  test('TLS off at the server: Prefer falls back to plain, Require is refused', async () => {
    const prefer = await postgresDriver.connect(cfgFor(s, { tls: 'prefer' }));
    expect(prefer.tlsActive).toBe(false);
    expect((await prefer.run(stmt('select 1'))).rows).toEqual([['1']]);
    prefer.close();
    expect(await problem(postgresDriver.connect(cfgFor(s, { tls: 'require' })))).toEqual({ kind: 'notls', message: "This server doesn't offer TLS" });
  });
});

describe('a statement past the timeout', () => {
  // Its own server: one PGlite backend, and the sleep holds it to the end (pg_sleep ignores statement_timeout there,
  // so the client-side query_timeout is what stops it, as on a server that ignores SET LOCAL).
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start({ seed: false }); });
  afterAll(async () => { await s?.stop(); });

  test('is canceled by the client-side timeout (timeout + 2 s), and the session closes', async () => {
    const db = await postgresDriver.connect(cfgFor(s, { timeoutSec: 1 }));
    const t0 = Date.now();
    const p = await problem(db.run(stmt('select pg_sleep(5)')));
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(p).toEqual({ kind: 'canceled', message: 'Stopped after 1 s' });
    expect(db.closed).toBe(true);
    const t1 = Date.now();
    expect(await problem(db.run(stmt('select 1')))).toEqual(p);
    expect(Date.now() - t1).toBeLessThan(500);
    expect(await s.statementsLog()).toContain(wrapOf(1000));
  });

  test("an unanswered BEGIN is a dead connection, not a slow statement: lost, and the session closes", async () => {
    // A silently dead link (sleep, a network change) looks like this: nothing answers. Here the one backend is busy
    // with another client's sleep, so the BEGIN waits unanswered.
    const busy = await rawClient(s);
    const db = await postgresDriver.connect(cfgFor(s, { timeoutSec: 1 }));
    void busy.query('select pg_sleep(6)').catch(() => {});
    await new Promise((r) => setTimeout(r, 300)); // the sleep has the backend before the BEGIN arrives
    const t0 = Date.now();
    expect(await problem(db.run(stmt('select 1')))).toEqual({ kind: 'lost', message: 'Reconnecting…' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(db.closed).toBe(true);
  });
});

describe('a connection lost', () => {
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start({ seed: false }); });
  afterAll(async () => { await s?.stop(); });

  test('closes the session and fails the next run with lost, without hanging; a new connect works once the server is back', async () => {
    const db = await postgresDriver.connect(cfgFor(s));
    expect((await db.run(stmt('select 1'))).rows).toEqual([['1']]);
    await s.stopListening();
    // An idle session notices by itself (the hub sees closed before the next request needs it).
    await vi.waitFor(() => expect(db.closed).toBe(true), { timeout: 2000, interval: 20 });
    const t0 = Date.now();
    expect(await problem(db.run(stmt('select 1')))).toEqual({ kind: 'lost', message: 'Reconnecting…' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await problem(postgresDriver.connect(cfgFor(s)))).toMatchObject({
      kind: 'refused', message: `Can't connect · connection refused 127.0.0.1:${s.port}`
    });
    await s.resume();
    const again = await postgresDriver.connect(cfgFor(s));
    expect((await again.run(stmt('select 2'))).rows).toEqual([['2']]);
    again.close();
  });

  /** A request in flight: another client's open transaction holds the one backend, so ours waits for an answer. */
  async function inFlight(): Promise<{ db: DbSession; pending: Promise<DbProblem> }> {
    const db = await postgresDriver.connect(cfgFor(s));
    const holder = await rawClient(s);
    await holder.query('begin');
    const pending = problem(db.run(stmt('select 1')));
    await new Promise((r) => setTimeout(r, 50)); // the BEGIN is on the wire
    return { db, pending };
  }

  test('a request the server ends (FATAL 57P01, as on a restart) fails with lost, and the session is closed by then', async () => {
    const { db, pending } = await inFlight();
    const t0 = Date.now();
    await s.terminate();
    expect(await pending).toEqual({ kind: 'lost', message: 'Reconnecting…', code: '57P01' });
    expect(db.closed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('a request whose socket drops fails with lost, and the session is closed by then', async () => {
    const { db, pending } = await inFlight();
    const t0 = Date.now();
    await s.stopListening();
    expect(await pending).toEqual({ kind: 'lost', message: 'Reconnecting…' });
    expect(db.closed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    await s.resume();
  });
});

describe('TLS', () => {
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start({ tls: true, seed: false }); });
  afterAll(async () => { await s?.stop(); });

  test('Require encrypts and accepts the self-signed certificate', async () => {
    const db = await postgresDriver.connect(cfgFor(s, { tls: 'require' }));
    expect(db.tlsActive).toBe(true);
    expect((await db.run(stmt('select 1'))).rows).toEqual([['1']]);
    db.close();
  });

  test('Prefer encrypts when the server offers TLS; Off stays plain', async () => {
    const prefer = await postgresDriver.connect(cfgFor(s, { tls: 'prefer' }));
    expect(prefer.tlsActive).toBe(true);
    prefer.close();
    const off = await postgresDriver.connect(cfgFor(s, { tls: 'off' }));
    expect(off.tlsActive).toBe(false);
    expect((await off.run(stmt('select 1'))).rows).toEqual([['1']]);
    off.close();
  });

  test('a direct connection to a host name: pg names it in SNI itself (sslFor gives none)', async () => {
    const spy = vi.spyOn(tls, 'connect');
    try {
      const db = await postgresDriver.connect(cfgFor(s, { host: 'localhost', tls: 'require' }));
      expect(db.tlsActive).toBe(true);
      db.close();
      expect(spy.mock.calls.map((c) => c[0] as tls.ConnectionOptions).at(-1)).toMatchObject({ host: 'localhost', servername: 'localhost' });
    } finally {
      spy.mockRestore();
    }
  });

  test('Verify refuses a certificate no trusted root signed', async () => {
    expect(await problem(postgresDriver.connect(cfgFor(s, { tls: 'verify' })))).toMatchObject({
      kind: 'cert', message: "The certificate isn't trusted (self-signed certificate)", code: 'DEPTH_ZERO_SELF_SIGNED_CERT'
    });
  });

  test("caRoots holds Node's roots and the system's", () => {
    const roots = caRoots();
    expect(roots).toBeDefined();
    expect(roots).toEqual(expect.arrayContaining(tls.getCACertificates('default')));
    expect(roots).toEqual(expect.arrayContaining(tls.getCACertificates('system')));
  });
});

describe('a password', () => {
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start({ password: 'pw', seed: false }); });
  afterAll(async () => { await s?.stop(); });

  test('the right one connects', async () => {
    const db = await postgresDriver.connect(cfgFor(s, { password: 'pw' }));
    expect((await db.run(stmt('select 1'))).rows).toEqual([['1']]);
    db.close();
  });

  test('a wrong one: wrong user or password', async () => {
    expect(await problem(postgresDriver.connect(cfgFor(s, { password: 'nope' })))).toEqual({ kind: 'auth', message: 'Wrong user or password', code: '28P01' });
  });

  test('none: needs a password, even with a PGPASSWORD and a .pgpass that know it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atl-pgpass-'));
    const passfile = join(dir, 'pgpass');
    writeFileSync(passfile, '*:*:*:*:pw\n');
    chmodSync(passfile, 0o600);
    const saved = { PGPASSWORD: process.env.PGPASSWORD, PGPASSFILE: process.env.PGPASSFILE };
    process.env.PGPASSWORD = 'pw';
    process.env.PGPASSFILE = passfile;
    try {
      expect(await problem(postgresDriver.connect(cfgFor(s, { password: '' })))).toEqual({ kind: 'password', message: 'Needs a password', code: '28P01' });
      delete process.env.PGPASSWORD; // the .pgpass alone
      expect(await problem(postgresDriver.connect(cfgFor(s, { password: '' })))).toMatchObject({ kind: 'password' });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('the environment', () => {
  let s: PgServer;
  beforeAll(async () => { s = await PgServer.start({ seed: false }); });
  afterAll(async () => { await s?.stop(); });

  test('no PG* variable reaches the server: the startup holds our user, database and application_name atelier', async () => {
    const vars: Record<string, string> = {
      PGOPTIONS: '-c default_transaction_read_only=off', PGREPLICATION: 'database', PGSSLNEGOTIATION: 'direct', PGAPPNAME: 'intruder',
      PGUSER: 'intruder', PGDATABASE: 'intruder', PGHOST: '192.0.2.1', PGPORT: '1', PGSSLMODE: 'require', PGCLIENT_ENCODING: 'LATIN1'
    };
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      await freshLog(s);
      const db = await postgresDriver.connect(cfgFor(s));
      expect(db.tlsActive).toBe(false);
      expect((await db.run(stmt("select 'é' as e"))).rows).toEqual([['é']]);
      db.close();
      expect(await s.startupsLog()).toEqual([{ user: 'postgres', database: 'postgres', application_name: 'atelier', client_encoding: 'UTF8' }]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('timeoutSec must be a positive whole number of seconds (it is written into the wrapper)', async () => {
    for (const timeoutSec of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(postgresDriver.connect(cfgFor(s, { timeoutSec }))).rejects.toThrow(RangeError);
    }
  });

  test('a config pg would complete from PG* variables is refused before anything is contacted', async () => {
    await freshLog(s);
    const bad: Partial<DbConnectConfig>[] = [
      { user: '' }, { database: '' }, { host: '' }, { socket: '' }, { socket: 'tmp' },
      { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: Number.NaN }
    ];
    for (const o of bad) {
      expect([o, await postgresDriver.connect(cfgFor(s, o)).then(() => 'connected', (e: unknown) => e instanceof RangeError)]).toEqual([o, true]);
    }
    expect(await s.startupsLog()).toEqual([]);
  });

  // A Unix socket directory is a POSIX path (pg reads a host starting with "/" as one): Windows' temp folder is C:\….
  test.skipIf(process.platform === 'win32')('a socket needs no host: one that isn\'t there means Postgres isn\'t running', async () => {
    const socket = mkdtempSync(join(tmpdir(), 'atl-pgsock-'));
    expect(await problem(postgresDriver.connect(cfgFor(s, { host: '', socket })))).toMatchObject({ kind: 'refused' });
  });
});

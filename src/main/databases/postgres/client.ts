// The Postgres client: the only module that imports `pg` (its JS client, never
// the index: NODE_PG_FORCE_NATIVE would swap in pg-native, i.e. libpq reading ~/.pgpass and PG* variables). Every
// statement runs inside its own read-only transaction:
//   1. BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = <ms>   (one simple-query round trip); a `stable`
//      statement (a keyless page) adds SET LOCAL synchronize_seqscans = off; SET LOCAL
//      max_parallel_workers_per_gather = 0 — except on CockroachDB (plainOnly)
//   2. the statement, through the extended protocol (one statement, $n parameters)
//   3. ROLLBACK, after success or error, sent once the result is in (the caller doesn't wait for it). Never COMMIT.
// The server refuses any write inside (25006), however it is hidden. No session-level SET, ever: behind a transaction
// pooler it would stay on a server connection another app reuses. One pg.Client per session, no pool, one
// statement at a time.
import * as tls from 'node:tls';
import type pg from 'pg';
import PgClient from 'pg/lib/client';
import type { DbProblem } from '@shared/databases';
import { DbError, isIpLiteral, type DbConnectConfig, type DbDriver, type DbRows, type DbSession, type Stmt } from '../driver';
import { CONNECT_TIMEOUT_SEC, problemOf, type ProblemContext } from './errors';

/** Every value reaches us as Postgres prints it: exact numerics, times with their offset, arrays as literals. */
const RAW_TYPES = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;
const LOST = { kind: 'lost', message: 'Reconnecting…' } as const;
const noop = () => {};

/** caRoots' answer, once read: the system store doesn't change while Atelier runs, and reading it isn't free. */
let roots: { list: string[] | undefined } | null = null;

/**
 * The roots Verify trusts: Node's bundled ones plus the system store (macOS Keychain, Windows), when the runtime has it.
 * Read once, the same list for every connect after.
 */
export function caRoots(): string[] | undefined {
  roots ??= { list: readRoots() };
  return roots.list;
}

function readRoots(): string[] | undefined {
  const get = (tls as { getCACertificates?: (type: 'default' | 'system') => string[] }).getCACertificates;
  if (typeof get !== 'function') return undefined;
  const all = new Set(get('default'));
  try {
    for (const c of get('system')) all.add(c);
  } catch {
    // An older runtime without 'system': Node's roots alone.
  }
  return [...all];
}

/**
 * The `ssl` option pg gets. The name TLS sends (SNI) and checks the certificate against is the server's own. pg
 * (lib/connection.js upgradeToSSL) copies these options into tls.connect, then sets `servername: host` itself, over
 * ours, whenever host isn't an IP address: a direct connection needs nothing from here. Through an SSH
 * tunnel host is 127.0.0.1, which pg leaves alone, so the real host comes as `servername` — never an IP
 * address (RFC 6066). tls.connect checks the identity against servername before host.
 */
export function sslFor(cfg: DbConnectConfig): pg.ClientConfig['ssl'] {
  if (cfg.tls === 'off') return false;
  const sni = cfg.servername && !isIpLiteral(cfg.servername) ? { servername: cfg.servername } : {};
  if (cfg.tls !== 'verify') return { rejectUnauthorized: false, ...sni };
  const ca = caRoots();
  return { rejectUnauthorized: true, ...sni, ...(ca ? { ca } : {}) };
}

/**
 * pg completes an empty or missing value from PG* variables (`config.x || process.env.PGX`): refused instead, before
 * anything is contacted. timeoutSec is written into the wrapper's SQL text.
 */
function checkConfig(cfg: DbConnectConfig): void {
  if (!Number.isInteger(cfg.timeoutSec) || cfg.timeoutSec < 1) throw new RangeError('timeoutSec must be a whole number of seconds ≥ 1');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new RangeError('port must be 1–65535');
  if (cfg.socket !== undefined && !cfg.socket.startsWith('/')) throw new RangeError('socket must be an absolute directory');
  if (cfg.socket === undefined && !cfg.host) throw new RangeError('host is empty');
  if (!cfg.user) throw new RangeError('user is empty');
  if (!cfg.database) throw new RangeError('database is empty');
}

/** The pg client for one session, not connected yet (exported for its tests: what the environment can't change). */
export function newClient(cfg: DbConnectConfig, ssl: pg.ClientConfig['ssl']): pg.Client {
  const password = cfg.password;
  const client = new PgClient({
    host: cfg.socket ?? cfg.host,
    port: cfg.port,
    user: cfg.user,
    database: cfg.database,
    // A function, never the bare string: pg takes '' for "none given" and then reads PGPASSWORD and ~/.pgpass.
    password: () => password,
    ssl,
    // Given, so that PGSSLNEGOTIATION can't be read in its place (direct TLS, or a constructor that throws).
    sslnegotiation: 'postgres',
    application_name: 'atelier',
    // Given, so that PGCLIENT_ENCODING is never read: the protocol speaks UTF8 (pg's StartupMessage
    // says so), and nothing in the environment may say otherwise to the client.
    client_encoding: 'UTF8',
    connectionTimeoutMillis: CONNECT_TIMEOUT_SEC * 1000,
    keepAlive: true,
    // The backstop for servers that ignore statement_timeout.
    query_timeout: (cfg.timeoutSec + 2) * 1000,
    types: RAW_TYPES
  });
  // pg fills an option it wasn't given (or was given empty) from PG* variables; the ones above are always given. Two
  // reach the StartupMessage only that way (PGOPTIONS: session settings; PGREPLICATION): cleared, so the environment
  // never changes the session. PGSSLMODE and PGCONNECT_TIMEOUT are read only when ssl/connectionTimeoutMillis are absent.
  const params = (client as unknown as { connectionParameters: { options?: string; replication?: unknown } }).connectionParameters;
  params.options = undefined;
  params.replication = undefined;
  return client;
}

class PgSession implements DbSession {
  /** Why the session is closed; null while it is open. */
  private why: DbProblem | null = null;
  /** The previous run, its ROLLBACK included: the next one starts after it. */
  private turn: Promise<unknown> = Promise.resolve();
  /** The last ROLLBACK sent (it never rejects: a failed one closes the session). */
  private after: Promise<void> = Promise.resolve();
  /** Every statement's wrapper. */
  private readonly plain: string;
  /** A `stable` statement's, unless the server is CockroachDB. */
  private readonly stable: string;
  /** The server is CockroachDB (plainOnly): every statement in the plain wrapper. */
  private cockroach = false;
  /**
   * The client-side timeout of BEGIN and ROLLBACK, which answer at once on a live connection: no answer in the connect
   * timeout means a dead link (sleep, a network change), found sooner than the statement's own timeout would.
   */
  private readonly wrapMs: number;

  constructor(private readonly client: pg.Client, readonly tlsActive: boolean, private readonly ctx: ProblemContext) {
    // The only SETs Atelier sends, local to the transaction: they die with it, so a pooler's next client finds
    // nothing of ours. Exactly these two templates (a static guard holds client.ts to them).
    this.plain = `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${ctx.timeoutSec * 1000}`;
    // A page without a key orders by what the user sorts (or not at all), so its OFFSET pages hold
    // together only while each read meets the rows in the same order — a scan that starts where another one is
    // (synchronize_seqscans) or parallel workers interleaving their rows would move them between pages. Only for it:
    // a count or an estimate keeps the server's parallel workers.
    this.stable = `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${ctx.timeoutSec * 1000}; SET LOCAL synchronize_seqscans = off; SET LOCAL max_parallel_workers_per_gather = 0`;
    this.wrapMs = Math.min(CONNECT_TIMEOUT_SEC, ctx.timeoutSec + 2) * 1000;
    // From the start: without a listener, a stray 'error' event would throw in the main process.
    client.on('error', noop);
  }

  get closed(): boolean { return this.why !== null; }

  async open(): Promise<void> {
    try {
      await this.client.connect();
    } catch (err) {
      this.shut(LOST);
      throw err;
    }
    // Only once connected: while connecting pg reports through connect(), and ending the client then (shut) would
    // leave that promise unsettled.
    this.client.on('error', () => this.shut(LOST));
    this.client.on('end', () => this.shut(LOST));
  }

  run(stmt: Stmt): Promise<DbRows> {
    const result = this.turn.then(() => this.exec(stmt));
    this.turn = result.then(() => this.after, () => this.after);
    return result;
  }

  close(): void { this.shut(LOST); }

  plainOnly(): void { this.cockroach = true; }

  private async exec(stmt: Stmt): Promise<DbRows> {
    if (this.why) throw new DbError(this.why);
    let res: pg.QueryArrayResult<(string | null)[]>;
    let ms: number;
    let phase: 'begin' | 'statement' = 'begin';
    try {
      await this.client.query(this.wrapper(stmt.stable === true && !this.cockroach ? this.stable : this.plain));
      phase = 'statement';
      const t0 = performance.now();
      // The extended protocol takes a single statement: no `commit; …` can end the transaction and write after it.
      const query: pg.QueryArrayConfig & { queryMode: 'extended' } = {
        text: stmt.text, values: stmt.values, rowMode: 'array', queryMode: 'extended'
      };
      res = await this.client.query<(string | null)[]>(query);
      ms = Math.round(performance.now() - t0);
    } catch (err) {
      throw new DbError(this.why ?? this.failed(err, phase));
    }
    this.after = this.rollback();
    return { fields: res.fields.map((f) => ({ name: f.name, oid: f.dataTypeID })), rows: res.rows, ms };
  }

  /** A run that failed on a session still open: its problem, and whether the connection outlives it. */
  private failed(err: unknown, phase: 'begin' | 'statement'): DbProblem {
    const timedOut = err instanceof Error && err.message === 'Query read timeout';
    // An unanswered BEGIN is a dead link, not a slow statement (which never ran): lost, so the hub reconnects.
    const problem = timedOut && phase === 'begin' ? LOST : problemOf(err, this.ctx);
    // Timed out: the statement still runs on a busy backend. Lost: the server ended the connection (57P01, class 08).
    // Either way this client is done, and closed by the time the run rejects.
    if (timedOut || problem.kind === 'lost') this.shut(problem);
    else this.after = this.rollback();
    return problem;
  }

  /** Ends the transaction; if even that fails or goes unanswered, nothing more can be trusted on this connection. */
  private rollback(): Promise<void> {
    return this.client.query(this.wrapper('ROLLBACK')).then(noop, () => this.shut(LOST));
  }

  /** BEGIN or ROLLBACK with its own client-side timeout (pg reads query_timeout per query; @types/pg doesn't list it). */
  private wrapper(text: string): pg.QueryConfig {
    const query: pg.QueryConfig & { query_timeout: number } = { text, query_timeout: this.wrapMs };
    return query;
  }

  /** Marks the session closed (the first reason wins) and drops the socket: pg destroys it when a query is in flight. */
  private shut(problem: DbProblem): void {
    if (this.why) return;
    this.why = problem;
    this.client.end().catch(noop);
  }
}

async function open(cfg: DbConnectConfig, ssl: pg.ClientConfig['ssl'], ctx: ProblemContext): Promise<PgSession> {
  const session = new PgSession(newClient(cfg, ssl), ssl !== false, ctx);
  await session.open();
  return session;
}

export const postgresDriver: DbDriver = {
  async connect(cfg) {
    checkConfig(cfg);
    const ctx: ProblemContext = {
      host: cfg.socket ?? cfg.host, port: cfg.port, database: cfg.database, timeoutSec: cfg.timeoutSec, noPassword: cfg.password === ''
    };
    try {
      return await open(cfg, sslFor(cfg), ctx);
    } catch (err) {
      // Prefer: TLS when the server offers it, plain otherwise.
      if (cfg.tls === 'prefer' && err instanceof Error && /does not support SSL/.test(err.message)) {
        try {
          return await open(cfg, false, ctx);
        } catch (plainErr) {
          throw new DbError(problemOf(plainErr, ctx));
        }
      }
      throw new DbError(problemOf(err, ctx));
    }
  }
};

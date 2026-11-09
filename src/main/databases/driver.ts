// The database driver: what the hub and the queries use, whatever the engine. A session runs
// one statement at a time, each a Stmt the builders made, never a string from the renderer; every failure is a
// DbError carrying the problem the view shows.
import type { DbProblem, DbSsh, DbTls } from '@shared/databases';

/**
 * A statement from the builders: `$n` parameters in `values`; `shape` names the builder (logs, tests). `stable`: a page of a relation without a row key — its OFFSET pages hold together only while each read meets the rows in
 * one order, so the client runs it in the wrapper that turns off synchronized scans and parallel workers. No other
 * statement asks for it: a count or an estimate keeps the server's parallel workers.
 */
export interface Stmt { text: string; values: unknown[]; shape: string; stable?: true }

/** A result: every value as the server prints it (or null); `ms` is the statement's own time, not the wrapper's. */
export interface DbRows { fields: { name: string; oid: number }[]; rows: (string | null)[][]; ms: number }

export interface DbConnectConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Always a string: '' when none is known. */
  password: string;
  /** A Unix socket directory, used instead of host. */
  socket?: string;
  /**
   * The server's own name when `host` isn't it (through an SSH tunnel host is 127.0.0.1): TLS sends it as SNI and checks
   * the certificate against it. A name, never an IP address (RFC 6066).
   */
  servername?: string;
  tls: DbTls;
  /** The query timeout (Settings), a whole number of seconds. */
  timeoutSec: number;
}

export interface DbSession {
  /** Runs one statement; calls queue up and run in order. Rejects with a DbError. */
  run(stmt: Stmt): Promise<DbRows>;
  close(): void;
  /** True once closed by close(), a lost connection or a client-side timeout: the next request needs a new session. */
  readonly closed: boolean;
  readonly tlsActive: boolean;
  /**
   * The server is CockroachDB (isCockroach on its version(), told by the server read): from now on a
   * `stable` statement runs in the plain wrapper too — Cockroach may refuse a SET of a setting it doesn't implement.
   * Optional: a test's wrapping session may leave it out.
   */
  plainOnly?(): void;
}

/** Whether a server's version() text is CockroachDB's. */
export const isCockroach = (version: string): boolean => /\bCockroachDB\b/.test(version);

export interface DbDriver { connect(cfg: DbConnectConfig): Promise<DbSession> }

/** An SSH tunnel: the database answers on 127.0.0.1:localPort while it is open; close() ends it. */
export interface Tunnel {
  localPort: number;
  close(): void;
  readonly closed: boolean;
  /**
   * Why ssh couldn't open the last connection forwarded through it (the bastion couldn't reach the database), read once
   * its stderr had a moment to arrive; null when no forward failed.
   */
  lastError(): Promise<string | null>;
}
/** Opens a tunnel to `target` (the database as the bastion host sees it); rejects with a DbError of kind 'ssh'. */
export type TunnelFactory = (ssh: DbSsh, target: { host: string; port: number }) => Promise<Tunnel>;

/** An IPv4 or IPv6 address (bracketed or not) rather than a name: TLS never sends one as SNI (RFC 6066). */
export const isIpLiteral = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

export class DbError extends Error {
  constructor(readonly problem: DbProblem) {
    super(problem.message);
    this.name = 'DbError';
  }
}

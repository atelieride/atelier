// Connection and Postgres errors as the problems the view shows: a kind the UI acts on and a
// short message. Matched on the SQLSTATE or Node's error code first, then on pg's own messages.
import type { DbProblem, DbProblemKind } from '@shared/databases';
import { DbError } from '../driver';

export interface ProblemContext {
  /** The host as the user knows it (the socket directory for a socket). */
  host: string;
  port: number;
  database: string;
  timeoutSec: number;
  /** No password was given: a refused empty one means the server wants one. */
  noPassword?: boolean;
}

/** pg's connect timeout (client.ts), named in the message. */
export const CONNECT_TIMEOUT_SEC = 8;

/** Node's certificate check failures, with the reason the message gives. */
const CERT_REASONS: Readonly<Record<string, string>> = {
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in the chain',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unknown issuer',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'unknown issuer',
  ERR_TLS_CERT_ALTNAME_INVALID: 'issued for another host',
  CERT_HAS_EXPIRED: 'expired',
  CERT_NOT_YET_VALID: 'not valid yet',
  UNABLE_TO_GET_ISSUER_CERT: 'unknown issuer',
  CERT_UNTRUSTED: 'root not trusted',
  CERT_SIGNATURE_FAILURE: 'bad signature'
};

/**
 * The connection is gone: Node's socket errors; the server ending it (57P01 admin shutdown or restart, 57P02 crash of
 * another backend) and SQLSTATE class 08 (connection exception: a pooler losing its server, a broken link) — but not
 * 08P01, a protocol violation: a client bug the server reports and survives, shown as it is rather than read
 * as a reconnect. PgBouncer is the exception: it words its server link dying with 08P01, then closes the client.
 */
const LOST_CODES = new Set(['ECONNRESET', 'EPIPE', '57P01', '57P02']);
const PGBOUNCER_LOST = /^server conn crashed\?$/;
const isLostCode = (code: string, message: string) =>
  LOST_CODES.has(code) || (/^08[0-9A-Z]{3}$/.test(code) && (code !== '08P01' || PGBOUNCER_LOST.test(message)));
/** pg's words for a connection that is gone (dropped, or ended while a query waited). */
const LOST_MESSAGE = /^Connection terminated( unexpectedly)?$|is not queryable$/;
const DENIED_OBJECT = /permission denied for (?:table|relation|view|materialized view|sequence|schema|foreign table) (.+)$/;

interface ErrorFields { message?: unknown; code?: unknown; syscall?: unknown; detail?: unknown; hint?: unknown }

export function problemOf(err: unknown, ctx: ProblemContext): DbProblem {
  if (err instanceof DbError) return err.problem;
  const e: ErrorFields = typeof err === 'object' && err !== null ? (err as ErrorFields) : {};
  const message = typeof e.message === 'string' ? e.message : String(err);
  const code = typeof e.code === 'string' ? e.code : undefined;
  const of = (kind: DbProblemKind, text: string, more: Partial<DbProblem> = {}): DbProblem =>
    ({ kind, message: text, ...more, ...(code ? { code } : {}) });

  if (code === 'ECONNREFUSED' || (code === 'ENOENT' && e.syscall === 'connect')) {
    return of('refused', `Can't connect · connection refused ${ctx.host}:${ctx.port}`, { hint: 'Is Postgres running?' });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return of('host', `Host not found: ${ctx.host}`);
  if (message === 'timeout expired' || message === 'Connection terminated due to connection timeout') {
    return of('timeout', `No answer from ${ctx.host} in ${CONNECT_TIMEOUT_SEC} s`, { hint: 'On a VPN or behind a firewall?' });
  }
  if (/does not support SSL/.test(message)) return of('notls', "This server doesn't offer TLS");
  // pg_hba refusing a plain connection: "…, no encryption" (Postgres 14+), "…, SSL off" before.
  if (code === '28000' && /no encryption|SSL off/.test(message)) return of('needtls', 'The server requires TLS');
  if (/client password must be a (non-empty )?string/.test(message)) return of('password', 'Needs a password');
  if (code === '28P01' || /password authentication failed/.test(message)) {
    return ctx.noPassword ? of('password', 'Needs a password') : of('auth', 'Wrong user or password');
  }
  if (code === '28000') return of('auth', 'Wrong user or password');
  if (code === '3D000') return of('nodb', `Database ${ctx.database} doesn't exist`);
  if (code === '53300') return of('toomany', 'Too many connections on the server');
  if (code && code in CERT_REASONS) return of('cert', `The certificate isn't trusted (${CERT_REASONS[code]})`, { detail: message });
  if (code === '57014' || message === 'Query read timeout') return of('canceled', `Stopped after ${ctx.timeoutSec} s`);
  if (code === '42501') return of('denied', `This role can't read ${DENIED_OBJECT.exec(message)?.[1] ?? 'this table'}`);
  if (code === '42P01') return of('gone', 'This table no longer exists');
  if ((code && isLostCode(code, message)) || LOST_MESSAGE.test(message)) return of('lost', 'Reconnecting…');
  return of('other', message, {
    ...(typeof e.detail === 'string' && e.detail ? { detail: e.detail } : {}),
    ...(typeof e.hint === 'string' && e.hint ? { hint: e.hint } : {})
  });
}

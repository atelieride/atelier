import { describe, expect, test } from 'vitest';
import { DbError } from '../driver';
import { problemOf } from './errors';

const ctx = { host: 'db.acme.test', port: 5433, database: 'shop', timeoutSec: 15 };

/** An error as Node or pg raise it: a message plus the fields they set (code, syscall, detail, hint…). */
const err = (message: string, fields: Record<string, unknown> = {}) => Object.assign(new Error(message), fields);

describe('problemOf: one row each', () => {
  test('ECONNREFUSED: connection refused, with the host and port, and the hint', () => {
    expect(problemOf(err('connect ECONNREFUSED 10.0.0.5:5433', { code: 'ECONNREFUSED', syscall: 'connect' }), ctx)).toEqual({
      kind: 'refused', message: "Can't connect · connection refused db.acme.test:5433", hint: 'Is Postgres running?', code: 'ECONNREFUSED'
    });
  });

  test("a Unix socket that isn't there (ENOENT on connect) is refused too: Postgres isn't running", () => {
    const sock = { ...ctx, host: '/tmp', port: 5432 };
    expect(problemOf(err('connect ENOENT /tmp/.s.PGSQL.5432', { code: 'ENOENT', syscall: 'connect' }), sock)).toMatchObject({
      kind: 'refused', message: "Can't connect · connection refused /tmp:5432"
    });
    expect(problemOf(err('open ENOENT x', { code: 'ENOENT', syscall: 'open' }), ctx).kind).toBe('other');
  });

  test('ENOTFOUND and EAI_AGAIN: host not found', () => {
    expect(problemOf(err('getaddrinfo ENOTFOUND db.acme.test', { code: 'ENOTFOUND' }), ctx)).toEqual({
      kind: 'host', message: 'Host not found: db.acme.test', code: 'ENOTFOUND'
    });
    expect(problemOf(err('getaddrinfo EAI_AGAIN db.acme.test', { code: 'EAI_AGAIN' }), ctx)).toMatchObject({ kind: 'host', message: 'Host not found: db.acme.test' });
  });

  test("the connect timeout: no answer in 8 s, and the hint", () => {
    expect(problemOf(err('timeout expired'), ctx)).toEqual({ kind: 'timeout', message: 'No answer from db.acme.test in 8 s', hint: 'On a VPN or behind a firewall?' });
    expect(problemOf(err('Connection terminated due to connection timeout'), ctx)).toMatchObject({ kind: 'timeout' });
  });

  test('28P01 and 28000: wrong user or password', () => {
    expect(problemOf(err('password authentication failed for user "shop"', { code: '28P01' }), ctx)).toEqual({
      kind: 'auth', message: 'Wrong user or password', code: '28P01'
    });
    expect(problemOf(err('role "nobody" is not permitted to log in', { code: '28000' }), ctx)).toMatchObject({ kind: 'auth', message: 'Wrong user or password' });
  });

  test('the server asks for a password we lack: needs a password', () => {
    expect(problemOf(err('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string'), ctx)).toEqual({ kind: 'password', message: 'Needs a password' });
    // What pg says when the password it has is '' (ours, when none is saved).
    expect(problemOf(err('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string'), ctx)).toMatchObject({ kind: 'password' });
    // Cleartext and MD5 send the empty password: the server refuses it as a wrong one.
    const refused = err('password authentication failed for user "shop"', { code: '28P01' });
    expect(problemOf(refused, { ...ctx, noPassword: true })).toEqual({ kind: 'password', message: 'Needs a password', code: '28P01' });
  });

  test("3D000: the database doesn't exist", () => {
    expect(problemOf(err('database "shop" does not exist', { code: '3D000' }), ctx)).toEqual({ kind: 'nodb', message: "Database shop doesn't exist", code: '3D000' });
  });

  test('53300: too many connections', () => {
    expect(problemOf(err('sorry, too many clients already', { code: '53300' }), ctx)).toEqual({ kind: 'toomany', message: 'Too many connections on the server', code: '53300' });
  });

  test("a server without TLS, asked for it: doesn't offer TLS", () => {
    expect(problemOf(err('The server does not support SSL connections'), ctx)).toEqual({ kind: 'notls', message: "This server doesn't offer TLS" });
  });

  test('28000 "no encryption": the server requires TLS', () => {
    const e = err('no pg_hba.conf entry for host "10.0.0.9", user "shop", database "shop", no encryption', { code: '28000' });
    expect(problemOf(e, ctx)).toEqual({ kind: 'needtls', message: 'The server requires TLS', code: '28000' });
    // Servers before 14 say it this way.
    const old = err('no pg_hba.conf entry for host "10.0.0.9", user "shop", database "shop", SSL off', { code: '28000' });
    expect(problemOf(old, ctx)).toEqual({ kind: 'needtls', message: 'The server requires TLS', code: '28000' });
  });

  test("certificate errors: the certificate isn't trusted, with a short reason", () => {
    const cases: [string, string][] = [
      ['SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in the chain'],
      ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'],
      ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unknown issuer'],
      ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unknown issuer'],
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'issued for another host'],
      ['CERT_HAS_EXPIRED', 'expired'],
      ['CERT_NOT_YET_VALID', 'not valid yet'],
      ['UNABLE_TO_GET_ISSUER_CERT', 'unknown issuer'],
      ['CERT_UNTRUSTED', 'root not trusted'],
      ['CERT_SIGNATURE_FAILURE', 'bad signature']
    ];
    for (const [code, reason] of cases) {
      expect(problemOf(err(`node says ${code}`, { code }), ctx)).toEqual({
        kind: 'cert', message: `The certificate isn't trusted (${reason})`, code, detail: `node says ${code}`
      });
    }
  });

  test('57014 and the client-side read timeout: stopped after N s', () => {
    expect(problemOf(err('canceling statement due to statement timeout', { code: '57014' }), ctx)).toEqual({ kind: 'canceled', message: 'Stopped after 15 s', code: '57014' });
    expect(problemOf(err('Query read timeout'), { ...ctx, timeoutSec: 1 })).toEqual({ kind: 'canceled', message: 'Stopped after 1 s' });
  });

  test("42501: this role can't read the table Postgres names", () => {
    expect(problemOf(err('permission denied for table orders', { code: '42501' }), ctx)).toEqual({ kind: 'denied', message: "This role can't read orders", code: '42501' });
    expect(problemOf(err('permission denied for materialized view daily_revenue', { code: '42501' }), ctx)).toMatchObject({ message: "This role can't read daily_revenue" });
    expect(problemOf(err('permission denied for schema billing', { code: '42501' }), ctx)).toMatchObject({ message: "This role can't read billing" });
    expect(problemOf(err('must be owner of something', { code: '42501' }), ctx)).toMatchObject({ kind: 'denied', message: "This role can't read this table" });
  });

  test('42P01: the table no longer exists', () => {
    expect(problemOf(err('relation "orders" does not exist', { code: '42P01' }), ctx)).toEqual({ kind: 'gone', message: 'This table no longer exists', code: '42P01' });
  });

  test('a socket closed while in use: reconnecting', () => {
    expect(problemOf(err('read ECONNRESET', { code: 'ECONNRESET' }), ctx)).toEqual({ kind: 'lost', message: 'Reconnecting…', code: 'ECONNRESET' });
    expect(problemOf(err('write EPIPE', { code: 'EPIPE' }), ctx)).toMatchObject({ kind: 'lost' });
    expect(problemOf(err('Connection terminated unexpectedly'), ctx)).toEqual({ kind: 'lost', message: 'Reconnecting…' });
    expect(problemOf(err('Connection terminated'), ctx)).toMatchObject({ kind: 'lost' });
    expect(problemOf(err('Client has encountered a connection error and is not queryable'), ctx)).toMatchObject({ kind: 'lost' });
  });

  test('a server ending the connection (restart, terminated backend, a pooler losing its server): reconnecting', () => {
    expect(problemOf(err('terminating connection due to administrator command', { code: '57P01', severity: 'FATAL' }), ctx)).toEqual({
      kind: 'lost', message: 'Reconnecting…', code: '57P01'
    });
    expect(problemOf(err('terminating connection due to crash of another server process', { code: '57P02' }), ctx)).toMatchObject({ kind: 'lost' });
    // SQLSTATE class 08, connection exception: PgBouncer's "server conn crashed?", a broken link.
    expect(problemOf(err('server conn crashed?', { code: '08P01' }), ctx)).toMatchObject({ kind: 'lost', code: '08P01' });
    expect(problemOf(err('connection failure', { code: '08006' }), ctx)).toEqual({ kind: 'lost', message: 'Reconnecting…', code: '08006' });
    expect(problemOf(err('connection does not exist', { code: '08003' }), ctx)).toMatchObject({ kind: 'lost' });
    // Not every 57 is: a canceled statement stays canceled.
    expect(problemOf(err('canceling statement due to user request', { code: '57014' }), ctx).kind).toBe('canceled');
  });

  test('08P01 is a protocol violation — a client bug the server reports and survives: shown, never a reconnect; PgBouncer\'s lost server excepted', () => {
    const bind = 'bind message supplies 1 parameters, but prepared statement "" requires 2';
    expect(problemOf(err(bind, { code: '08P01' }), ctx)).toEqual({ kind: 'other', message: bind, code: '08P01' });
    expect(problemOf(err('invalid frontend message type 0', { code: '08P01' }), ctx).kind).toBe('other');
    // PgBouncer words its server link dying with this code, then closes the client: that one is lost.
    expect(problemOf(err('server conn crashed?', { code: '08P01' }), ctx).kind).toBe('lost');
  });

  test("anything else: Postgres's message, its SQLSTATE, detail and hint", () => {
    const e = err('cannot execute INSERT in a read-only transaction', { code: '25006', detail: 'd', hint: 'h', severity: 'ERROR' });
    expect(problemOf(e, ctx)).toEqual({ kind: 'other', message: 'cannot execute INSERT in a read-only transaction', code: '25006', detail: 'd', hint: 'h' });
    expect(problemOf(err('connect EHOSTUNREACH 10.0.0.5:5433', { code: 'EHOSTUNREACH' }), ctx)).toEqual({
      kind: 'other', message: 'connect EHOSTUNREACH 10.0.0.5:5433', code: 'EHOSTUNREACH'
    });
  });

  test('not an Error at all: its text, as other', () => {
    expect(problemOf('boom', ctx)).toEqual({ kind: 'other', message: 'boom' });
    expect(problemOf(undefined, ctx)).toEqual({ kind: 'other', message: 'undefined' });
  });

  test("a DbError keeps its problem", () => {
    const problem = { kind: 'ssh', message: 'Permission denied (publickey).' } as const;
    expect(problemOf(new DbError(problem), ctx)).toBe(problem);
  });
});

describe('DbError', () => {
  test("is an Error whose message is the problem's", () => {
    const e = new DbError({ kind: 'gone', message: 'This table no longer exists' });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('This table no longer exists');
    expect(e.name).toBe('DbError');
  });
});

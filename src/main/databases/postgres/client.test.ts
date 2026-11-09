// The TLS options the Postgres client hands pg: the name TLS sends (SNI) and
// checks the certificate against is the server's own, also through an SSH tunnel, where the client dials 127.0.0.1.
// pg sets `servername: host` itself, over ours, whenever host isn't an IP address (node_modules/pg/lib/connection.js
// upgradeToSSL), so only a tunnel's real host needs one: 127.0.0.1 never overrides it; tests/integration/db-ssh.test.ts
// sees it reach tls.connect, db-client.test.ts sees pg name a direct host itself. Plus the pg client as built: nothing
// from the environment changes the session.
import { afterEach, describe, expect, test } from 'vitest';
import { isCockroach, type DbConnectConfig } from '../driver';
import { caRoots, newClient, sslFor } from './client';

describe('isCockroach: the server\'s version() text says CockroachDB (it keeps the plain wrapper)', () => {
  test('CockroachDB, any edition; Postgres and its hosted kinds are not', () => {
    for (const v of ['CockroachDB CCL v23.1.11 (x86_64-pc-linux-gnu, built 2023/09/27 01:53:43, go1.19.10)', 'CockroachDB OSS v21.2.0 (aarch64-apple-darwin)']) {
      expect(isCockroach(v), v).toBe(true);
    }
    for (const v of ['PostgreSQL 16.2 on x86_64-pc-linux-gnu, compiled by gcc', 'PostgreSQL 17.4 on aarch64-unknown-linux-gnu (Neon)', 'PostgreSQL 18.0 (PGlite)', '']) {
      expect(isCockroach(v), v).toBe(false);
    }
  });
});

const cfg = (o: Partial<DbConnectConfig>): DbConnectConfig => ({
  host: 'db.example.com', port: 5432, database: 'app', user: 'app', password: '', tls: 'verify', timeoutSec: 15, ...o
});

describe('sslFor', () => {
  test('Off: no TLS', () => {
    expect(sslFor(cfg({ tls: 'off', servername: 'db.example.com' }))).toBe(false);
  });

  test('a direct connection: Verify checks, and SNI is left to pg (it sends the host when it is a name, never an IP)', () => {
    expect(sslFor(cfg({}))).toMatchObject({ rejectUnauthorized: true });
    for (const host of ['db.example.com', '10.0.0.5', '::1']) expect(sslFor(cfg({ host })), host).not.toHaveProperty('servername');
    expect(sslFor(cfg({ host: '', socket: '/tmp' }))).not.toHaveProperty('servername');
  });

  test('through an SSH tunnel (host 127.0.0.1): servername is the real host, in every TLS mode', () => {
    for (const tls of ['prefer', 'require', 'verify'] as const) {
      expect(sslFor(cfg({ host: '127.0.0.1', servername: 'db.example.com', tls })), tls).toMatchObject({ servername: 'db.example.com' });
    }
    expect(sslFor(cfg({ host: '127.0.0.1', servername: 'db.example.com', tls: 'verify' }))).toMatchObject({ rejectUnauthorized: true });
    expect(sslFor(cfg({ host: '127.0.0.1', servername: 'db.example.com', tls: 'require' }))).toMatchObject({ rejectUnauthorized: false });
    // Belt and braces: an IP address given as servername is still never sent.
    expect(sslFor(cfg({ host: '127.0.0.1', servername: '10.0.0.5' }))).not.toHaveProperty('servername');
    expect(sslFor(cfg({ host: '127.0.0.1' }))).not.toHaveProperty('servername');
  });

  test('Prefer and Require accept any certificate (they encrypt, Verify checks)', () => {
    expect(sslFor(cfg({ tls: 'prefer' }))).toMatchObject({ rejectUnauthorized: false });
    expect(sslFor(cfg({ tls: 'require' }))).toMatchObject({ rejectUnauthorized: false });
  });

  test("Verify's roots are read once (the system store is slow to read), the same list for every connect", () => {
    const roots = caRoots();
    expect(roots).toBeDefined();
    expect(caRoots()).toBe(roots);
    expect((sslFor(cfg({})) as { ca?: string[] }).ca).toBe(roots);
  });
});

describe('newClient: no PG* variable can change the session', () => {
  const VARS: Record<string, string> = {
    // pg reads PG + the option's name upper-cased (PGCLIENT_ENCODING); libpq's spelling too, for good measure.
    PGCLIENT_ENCODING: 'LATIN1', PGCLIENTENCODING: 'LATIN1', PGOPTIONS: '-c default_transaction_read_only=off', PGREPLICATION: 'database'
  };
  const saved = Object.fromEntries(Object.keys(VARS).map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('client_encoding is UTF8, options and replication unset, whatever the environment says', () => {
    Object.assign(process.env, VARS);
    const c = newClient(cfg({ tls: 'off' }), false) as unknown as { connectionParameters: { client_encoding?: string; options?: string; replication?: unknown } };
    expect(c.connectionParameters.client_encoding).toBe('UTF8');
    expect(c.connectionParameters.options).toBeUndefined();
    expect(c.connectionParameters.replication).toBeUndefined();
  });
});

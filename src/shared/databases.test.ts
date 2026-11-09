import { describe, expect, test } from 'vitest';
import { DB_ENGINES, compactCount, defaultEnv, defaultName, defaultTls, envLabel, isLoopback, newConnId, providerOf } from './databases';

describe('loopback, environment and TLS defaults', () => {
  test('isLoopback', () => {
    for (const h of ['localhost', '127.0.0.2', '::1', '/tmp', '']) expect(isLoopback(h)).toBe(true);
    for (const h of ['10.0.0.1', 'db.neon.tech']) expect(isLoopback(h)).toBe(false);
  });
  test('defaults', () => {
    expect(defaultEnv('localhost')).toBe('local');
    expect(defaultEnv('db.neon.tech')).toBe('dev');
    expect(defaultEnv('x', '/var/run/postgresql')).toBe('local');
    expect(defaultTls('127.0.0.1')).toBe('prefer');
    expect(defaultTls('db.neon.tech')).toBe('require');
  });
  test('envLabel', () => {
    expect((['local', 'dev', 'staging', 'prod'] as const).map(envLabel)).toEqual(['Local', 'Dev', 'Staging', 'Prod']);
  });
});

describe('providers and names', () => {
  test('providerOf', () => {
    expect(providerOf('sample-db1.proxy.rlwy.net')).toBe('Railway');
    expect(providerOf('ep-x.eu-central-1.aws.neon.tech')).toBe('Neon');
    expect(providerOf('db.abc.supabase.co')).toBe('Supabase');
    expect(providerOf('x.rds.amazonaws.com')).toBe('AWS RDS');
    expect(providerOf('x.postgres.database.azure.com')).toBe('Azure');
    expect(providerOf('x.tsdb.cloud.timescale.com')).toBe('Timescale');
    expect(providerOf('example.com')).toBeNull();
    expect(providerOf('X.RLWY.NET')).toBe('Railway');
    // A fully qualified name's trailing dot is the same host.
    expect(providerOf('sample-db1.proxy.rlwy.net.')).toBe('Railway');
    expect(providerOf(' ep-x.aws.neon.tech. ')).toBe('Neon');
    expect(providerOf('example.com.')).toBeNull();
  });
  test('defaultName', () => {
    expect(defaultName({ host: 'x.rlwy.net', database: 'railway' })).toBe('Railway · railway');
    expect(defaultName({ host: 'localhost', database: 'acme' })).toBe('acme');
  });
});

describe('helpers', () => {
  test('compactCount', () => {
    expect([null, 412, 2140, 131000, 1.2e6].map(compactCount)).toEqual(['—', '412', '2.1k', '131k', '1.2M']);
    // Rounded first, then the unit: 999,999 reads "1M", never "1000k".
    expect([999, 999_499, 999_950, 999_999, 99_950, 9_999_999].map(compactCount)).toEqual(['999', '999k', '1M', '1M', '100k', '10M']);
  });
  test('newConnId', () => {
    expect(newConnId()).toMatch(/^c[0-9a-f]{12}$/);
    expect(newConnId()).not.toBe(newConnId());
  });
  test('DB_ENGINES: only postgres is ready', () => {
    expect(DB_ENGINES.filter((e) => e.ready).map((e) => e.id)).toEqual(['postgres']);
    expect(DB_ENGINES.map((e) => e.id)).toEqual(['postgres', 'mysql', 'sqlite', 'mssql', 'clickhouse', 'mongodb']);
  });
});

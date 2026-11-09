// The overview reader (src/main/databases/postgres/overview.ts) against the fixtures: size, connections, biggest
// tables, schemas, extensions, our own backend in the activity list, and no pg_stat_statements.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { postgresDriver } from '../../src/main/databases/postgres/client';
import { readServerInfo } from '../../src/main/databases/postgres/catalog';
import { readOverview } from '../../src/main/databases/postgres/overview';
import type { DbSession, Stmt } from '../../src/main/databases/driver';
import { PgServer } from '../support/pg-server';

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

/** Plain (non-partitioned, non-partition) tables of the fixtures as schema, name, total bytes by relpages. */
const ORACLE = `SELECT n.nspname, c.relname, ((c.relpages + COALESCE(t.relpages, 0)
  + COALESCE((SELECT sum(i.relpages) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid IN (c.oid, c.reltoastrelid)), 0))
  * current_setting('block_size')::int8)::int8
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
  WHERE c.relkind = 'r' AND NOT c.relispartition AND n.nspname IN ('public', 'analytics')`;

describe('readOverview', () => {
  test('a partitioned table is listed under its own name with all its partitions, which are not counted as tables', async () => {
    const s2 = await PgServer.start();
    const d2 = await postgresDriver.connect({ host: '127.0.0.1', port: s2.port, database: 'postgres', user: 'postgres', password: '', tls: 'off', timeoutSec: 15 });
    try {
      await s2.exec("INSERT INTO measurements SELECT 1, timestamptz '2026-11-02 00:00+00' + g * interval '1 second', 20.5 FROM generate_series(1, 60000) g");
      await s2.exec('ANALYZE measurements_2026_11; ANALYZE measurements_2026_10');
      const parts = await d2.run({ text: "SELECT sum(relpages)::int8 * current_setting('block_size')::int8 FROM pg_class WHERE relname LIKE 'measurements\\_2026\\_%' AND relkind = 'r'", values: [], shape: 'ov.oracle' });
      const o = await readOverview(d2, await readServerInfo(d2, Date.now()));
      const m = o.biggest.find((b) => b.name === 'measurements');
      expect(Number(parts.rows[0]![0])).toBeGreaterThan(0);
      expect(m?.bytes).toBeGreaterThanOrEqual(Number(parts.rows[0]![0]));
      expect(o.biggest.map((b) => b.name).some((n) => n.startsWith('measurements_2026'))).toBe(false);
      const pub = o.schemas.find((x) => x.name === 'public')!;
      expect(pub.bytes).toBeGreaterThanOrEqual(m!.bytes);
      const plain = await d2.run({ text: "SELECT count(*)::int8 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','f') AND NOT c.relispartition", values: [], shape: 'ov.oracle' });
      expect(pub.tables).toBe(Number(plain.rows[0]![0]));
    } finally {
      d2.close();
      await s2.stop();
    }
  });

  test('reads the fixture database', async () => {
    const info = await readServerInfo(db, Date.now());
    const before = Date.now();
    const o = await readOverview(db, info);
    expect(o.server).toBe(info);
    expect(o.sizeBytes).toBeGreaterThan(0);
    // The oracle: relpages of the table, its TOAST table and all their indexes, times the block size.
    const oracle = await db.run({ text: ORACLE + ' ORDER BY 3 DESC, 2 LIMIT 1', values: [], shape: 'ov.oracle' });
    expect(o.biggest[0]).toEqual({ schema: oracle.rows[0]![0], name: oracle.rows[0]![1], bytes: Number(oracle.rows[0]![2]) });
    expect(o.biggest.length).toBeLessThanOrEqual(6);
    const names = o.schemas.map((s) => s.name);
    expect(names).toContain('public');
    expect(names).toContain('analytics');
    expect(o.schemas.find((s) => s.name === 'analytics')?.tables).toBeGreaterThan(0);
    expect(o.extensions.map((e) => e.name)).toContain('plpgsql');
    expect(o.activity.filter((a) => a.ours)).toHaveLength(1);
    expect(o.slowest).toBeNull();
    expect(o.connections.max).toBeGreaterThan(0);
    expect(o.connections.total).toBeGreaterThanOrEqual(1);
    expect(o.xacts).toBeGreaterThanOrEqual(0);
    expect(o.uptimeSec === null || o.uptimeSec >= 0).toBe(true);
    expect(o.cacheHit === null || (o.cacheHit >= 0 && o.cacheHit <= 1)).toBe(true);
    expect(o.at).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.now() - o.at).toBeLessThan(1000);
  });

  test('queries are one line, at most 300 characters, and few statements run', async () => {
    const ran: Stmt[] = [];
    const rec: DbSession = { run: (st) => { ran.push(st); return db.run(st); }, close: () => db.close(), get closed() { return db.closed; }, get tlsActive() { return db.tlsActive; } };
    const o = await readOverview(rec, await readServerInfo(db, Date.now()));
    for (const a of o.activity) if (a.query !== null) { expect(a.query).not.toMatch(/\s{2}|\n/); expect(a.query.length).toBeLessThanOrEqual(300); }
    expect(ran.length).toBeLessThanOrEqual(3);
    // The tree's sizes are aggregated once, not rescanned per relation (O(N²) on a big catalog).
    expect(ran.find((s) => s.shape === 'ov.main')!.text).not.toMatch(/FROM tree JOIN rel m ON m\.oid = tree\.oid WHERE tree\.root = r\.oid/);
    expect(ran.find((s) => s.shape === 'ov.main')!.text).toContain('GROUP BY tree.root');
    expect(ran.filter((s) => s.shape !== 'cat.version').every((s) => s.shape.startsWith('ov.'))).toBe(true);
  });

  test('a 9.6 server gets the statement without the newer columns, and it still runs', async () => {
    const old: DbSession = {
      run: (st) => st.shape === 'cat.version' ? Promise.resolve({ fields: [{ name: 'v', oid: 25 }], rows: [['90600']], ms: 0 }) : db.run(st),
      close: () => undefined, closed: false, tlsActive: false
    };
    const o = await readOverview(old, await readServerInfo(db, Date.now()));
    expect(o.activity.filter((a) => a.ours)).toHaveLength(1);
  });

  const pretend = (ext: { name: string; version: string; schema?: string }, ran: Stmt[], fail = false): DbSession => ({
    run: async (st) => {
      if (st.shape === 'ov.slowest') {
        ran.push(st);
        if (fail) throw new Error('permission denied for view pg_stat_statements');
        return { fields: [], rows: [['select 1', '12', '3.5']], ms: 0 };
      }
      const r = await db.run(st);
      if (st.shape === 'ov.main') {
        const i = r.fields.findIndex((f) => f.name === 'extensions');
        const row = [...r.rows[0]!];
        row[i] = JSON.stringify([ext]);
        return { ...r, rows: [row] };
      }
      return r;
    },
    close: () => undefined, closed: false, tlsActive: false
  });

  test('slowest comes from pg_stat_statements when it is there, and errors become null', async () => {
    const info = await readServerInfo(db, Date.now());
    const ext = { name: 'pg_stat_statements', version: '1.10', schema: 'public' };
    const ok = await readOverview(pretend(ext, []), info);
    expect(ok.slowest).toEqual([{ query: 'select 1', calls: 12, meanMs: 3.5 }]);
    expect((await readOverview(pretend(ext, [], true), info)).slowest).toBeNull();
  });

  test('the statements view is qualified by its schema, its column follows the extension version, hidden rows are left out', async () => {
    const info = await readServerInfo(db, Date.now());
    const ran: Stmt[] = [];
    await readOverview(pretend({ name: 'pg_stat_statements', version: '1.10', schema: 'My Schema' }, ran), info);
    await readOverview(pretend({ name: 'pg_stat_statements', version: '1.7', schema: 'public' }, ran), info);
    expect(ran[0]!.text).toContain('"My Schema".pg_stat_statements');
    expect(ran[0]!.text).toContain('mean_exec_time');
    expect(ran[1]!.text).toContain('s.mean_time');
    expect(ran[1]!.text).not.toContain('mean_exec_time');
    expect(ran[0]!.text).toContain("<insufficient privilege>");
  });
});

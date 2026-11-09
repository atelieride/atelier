// The site shots' Postgres: the live demo's world (src/demo/world/databases.ts)
// loaded into the test Postgres (PGlite behind the proxy, ./pg-server.ts), so the Databases shot shows the database the
// demo plays. Read back as Postgres's text output (the raw type parser), as the app's client reads it: the world's
// claim that every value is text "as Postgres prints it" is checked here against a real engine.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ACME_DB } from '../../src/demo/world/databases-conn';
import { acmeDatabase, type PgRelation } from '../../src/demo/world/databases';
import { demoSeedSql, startDemoPostgres } from './pg-demo-seed';
import type { PgServer } from './pg-server';

const NOW = Date.parse('2026-11-06T09:42:15.877Z');
const world = acmeDatabase(NOW);
const raw = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;
const qualified = (r: Pick<PgRelation, 'schema' | 'name'>) => `"${r.schema}"."${r.name}"`;

describe('demoSeedSql', () => {
  test('quotes every value as a literal: an apostrophe is doubled, NULL stays NULL', () => {
    const sql = demoSeedSql(world);
    expect(sql).toContain("'Liam O''Connor'");
    expect(sql).toMatch(/, NULL[,)]/);
    // Created before it is filled: the schema, the enum, then the tables, the view and the function, then the rows.
    const at = (s: string) => sql.indexOf(s);
    expect(at('CREATE SCHEMA "analytics"')).toBeLessThan(at('CREATE TYPE "public"."order_status"'));
    expect(at('CREATE TYPE "public"."order_status"')).toBeLessThan(at('CREATE TABLE public.orders'));
    expect(at('CREATE OR REPLACE FUNCTION public.order_total')).toBeLessThan(at('INSERT INTO "public"."customers"'));
    expect(sql.trimEnd().endsWith('ANALYZE;')).toBe(true);
  });
});

describe('the demo world in the test Postgres', () => {
  let s: PgServer;
  let c: pg.Client;
  beforeAll(async () => {
    s = await startDemoPostgres(NOW);
    // As the shot's saved connection names it (world/databases-conn.ts): PGlite serves one database whatever the name.
    c = new pg.Client({ host: '127.0.0.1', port: s.port, database: ACME_DB.database, user: ACME_DB.user, types: raw });
    await c.connect();
    await c.query("SET TimeZone = 'UTC'");
  }, 60_000);
  afterAll(async () => {
    await c?.end().catch(() => {});
    await s?.stop();
  });

  test('every relation of the world and no other, each with as many rows', async () => {
    const listed = await c.query("select n.nspname || '.' || c.relname as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'v') and n.nspname in ('public', 'analytics') order by 1");
    expect(listed.rows.map((r) => (r as { name: string }).name)).toEqual(world.relations.map((r) => `${r.schema}.${r.name}`).sort());
    for (const r of world.relations) {
      const n = (await c.query(`select count(*) as n from ${qualified(r)}`)).rows[0] as { n: string };
      expect([r.name, n.n]).toEqual([r.name, String(r.rows.length)]);
    }
    expect(world.relations.find((r) => r.name === 'orders')!.rows.length).toBeGreaterThan(300);
  });

  test('every value reads back as the world prints it (timestamps in UTC, jsonb, arrays, numerics, the enum)', async () => {
    for (const r of world.relations) {
      const res = await c.query({ text: `select * from ${qualified(r)}`, rowMode: 'array' });
      expect(res.fields.map((f) => f.name), r.name).toEqual(r.columns.map((col) => col.name));
      const text = (rows: unknown[][]) => rows.map((row) => JSON.stringify(row)).sort();
      expect(text(res.rows as unknown[][]), r.name).toEqual(text(r.rows));
    }
  });

  test('the enum, the function, the comments and the keys as the world defines them', async () => {
    const one = async (sql: string) => Object.values((await c.query(sql)).rows[0] as Record<string, string>)[0];
    expect(await one("select enum_range(null::public.order_status)::text")).toBe(`{${world.enums[0]!.values.join(',')}}`);
    // The Redis world's newest order: 3 black mugs at 18.00.
    expect(await one('select public.order_total(10442)')).toBe('54.00');
    expect(await one("select obj_description('public.orders'::regclass, 'pg_class')")).toBe('One row per checkout');
    expect(await one("select count(*) from pg_catalog.pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace")).toBe('4');
    expect(await one("select indexdef from pg_catalog.pg_indexes where indexname = 'orders_metadata_idx'")).toBe('CREATE INDEX orders_metadata_idx ON public.orders USING gin (metadata jsonb_path_ops)');
  });

  test('statistics are fresh (ANALYZE): the estimate the view shows is the row count', async () => {
    const r = (await c.query("select reltuples::int8 as n from pg_catalog.pg_class where oid = 'public.orders'::regclass")).rows[0] as { n: string };
    expect(r.n).toBe(String(world.relations.find((x) => x.name === 'orders')!.rows.length));
  });
});

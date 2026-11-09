import { describe, expect, test } from 'vitest';
import { readOnlyRoleSql } from '../../main/databases/postgres/catalog';
import { compileWorld } from '../compile/index';
import { ACME_DB } from './databases-conn';
import { dockerContainers } from './docker';
import { ACME_SERVER, ACME_SOURCE, acmeDatabase, jsonbText, type AcmeDatabase, type PgRelation } from './databases';
import { acmeStoreSeed } from './redis';

// The acme-store's Postgres: pure data as a function of now, as Postgres
// prints it, which the live demo's engine reads and the site's shot loads into a real database. Deterministic, its keys
// whole, and the same people, products and orders as the rest of the fictional world.

const NOW = Date.parse('2026-11-06T09:42:15.877Z');
const db = acmeDatabase(NOW);
const rel = (name: string, schema = 'public'): PgRelation => {
  const r = db.relations.find((x) => x.schema === schema && x.name === name);
  if (!r) throw new Error(`no ${schema}.${name}`);
  return r;
};
const col = (r: PgRelation, name: string) => r.columns.findIndex((c) => c.name === name);
const values = (r: PgRelation, name: string) => r.rows.map((row) => row[col(r, name)]!);
const TS = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;

describe('the world', () => {
  test('deterministic: the same now gives the same database; another now moves only the times', () => {
    expect(acmeDatabase(NOW)).toEqual(db);
    const later: AcmeDatabase = acmeDatabase(NOW + 3 * 86_400_000);
    for (const r of db.relations) {
      const other = later.relations.find((x) => x.schema === r.schema && x.name === r.name)!;
      expect(other.rows.length, r.name).toBe(r.rows.length);
      const untimed = (x: PgRelation) => x.rows.map((row) => row.filter((_, k) => !/timestamp|date/.test(x.columns[k]!.type) && x.columns[k]!.typeName !== 'jsonb'));
      expect(untimed(other), r.name).toEqual(untimed(r));
    }
  });

  test('the schemas, the enum, the tables, the view, the function: what the spec lists', () => {
    expect(db.schemas).toEqual(['public', 'analytics']);
    expect(db.enums).toEqual([{ schema: 'public', name: 'order_status', values: ['pending', 'paid', 'shipped', 'refunded', 'failed'] }]);
    expect(db.relations.filter((r) => r.schema === 'public' && r.kind === 'table').map((r) => r.name).sort())
      .toEqual(['customers', 'order_items', 'orders', 'payments', 'products', 'webhook_events']);
    expect(db.relations.filter((r) => r.kind === 'view').map((r) => `${r.schema}.${r.name}`)).toEqual(['public.paid_orders']);
    expect(db.relations.filter((r) => r.schema === 'analytics').map((r) => r.name)).toEqual(['daily_revenue']);
    expect(db.functions.map((f) => [`${f.schema}.${f.name}(${f.args})`, f.returns])).toEqual([['public.order_total(bigint)', 'numeric']]);
    expect(db.functions[0]!.def).toMatch(/^CREATE OR REPLACE FUNCTION public\.order_total\(order_id bigint\)\n RETURNS numeric\n/);
    expect(rel('paid_orders').viewDef).toMatch(/^ SELECT o\.id,[\s\S]+WHERE o\.status = 'paid'::order_status;$/);
  });

  test('a few hundred orders: scrolling loads more than one page', () => {
    expect(rel('orders').rows.length).toBeGreaterThanOrEqual(300);
    expect(rel('order_items').rows.length).toBeGreaterThan(rel('orders').rows.length);
  });

  test('indexes: one GIN on a jsonb, one partial, every key backed by one; comments on tables and columns', () => {
    const all = db.relations.flatMap((r) => r.indexes.map((i) => ({ ...i, table: r.name })));
    const gin = all.filter((i) => i.method === 'gin');
    expect(gin.map((i) => i.table)).toEqual(['orders']);
    expect(rel('orders').columns[col(rel('orders'), gin[0]!.columns[0]!)]!.typeName).toBe('jsonb');
    expect(all.filter((i) => i.partial !== null).map((i) => [i.name, i.partial])).toEqual([['orders_pending_idx', "(status = 'pending'::order_status)"]]);
    for (const r of db.relations.filter((x) => x.kind === 'table')) {
      expect(r.indexes.find((i) => i.primary)?.columns, r.name).toEqual(r.pk);
      expect(r.comment, r.name).not.toBeNull();
    }
    expect(rel('orders').columns.find((c) => c.name === 'metadata')?.comment).toBeTruthy();
  });

  test('every row as Postgres prints it: one text per column, NULL only where allowed, numbers and times in their forms', () => {
    for (const r of db.relations) {
      for (const row of r.rows) expect(row, r.name).toHaveLength(r.columns.length);
      r.columns.forEach((c, k) => {
        const vs = r.rows.map((row) => row[k]!);
        if (!c.nullable) expect(vs.filter((v) => v === null), `${r.name}.${c.name}`).toEqual([]);
        const present = vs.filter((v): v is string => v !== null);
        const bad = (re: RegExp) => present.filter((v) => !re.test(v));
        if (c.type === 'bigint' || c.type === 'integer') expect(bad(/^-?\d+$/), `${r.name}.${c.name}`).toEqual([]);
        if (/^numeric\(\d+,2\)$/.test(c.type)) expect(bad(/^-?\d+\.\d\d$/), `${r.name}.${c.name}`).toEqual([]);
        if (c.type === 'timestamp with time zone') expect(bad(TS), `${r.name}.${c.name}`).toEqual([]);
        if (c.type === 'date') expect(bad(/^\d{4}-\d\d-\d\d$/), `${r.name}.${c.name}`).toEqual([]);
        if (c.type === 'boolean') expect(bad(/^[tf]$/), `${r.name}.${c.name}`).toEqual([]);
        if (c.isArray) expect(bad(/^\{.*\}$/), `${r.name}.${c.name}`).toEqual([]);
        if (c.enumValues) expect(present.filter((v) => !c.enumValues!.includes(v)), `${r.name}.${c.name}`).toEqual([]);
      });
    }
  });

  test('keys hold: primary and unique keys unique, every foreign key points at a row that exists', () => {
    const keyOf = (r: PgRelation, cols: readonly string[], row: readonly (string | null)[]) => cols.map((c) => row[col(r, c)]).join('\0');
    for (const r of db.relations) {
      for (const key of [r.pk, ...r.uniqueKeys].filter((k) => k.length > 0)) {
        const keys = r.rows.map((row) => keyOf(r, key, row));
        expect(new Set(keys).size, `${r.name} (${key.join(', ')})`).toBe(keys.length);
      }
      for (const fk of r.fks) {
        const target = rel(fk.to.table, fk.to.schema);
        const there = new Set(target.rows.map((row) => keyOf(target, fk.to.columns, row)));
        const missing = r.rows.filter((row) => fk.columns.every((c) => row[col(r, c)] !== null)).map((row) => keyOf(r, fk.columns, row)).filter((k) => !there.has(k));
        expect(missing, `${r.name} → ${fk.to.table}`).toEqual([]);
      }
    }
    // Every order's customer exists, and every line's order and product.
    const customers = new Set(values(rel('customers'), 'id'));
    expect(values(rel('orders'), 'customer_id').every((id) => customers.has(id))).toBe(true);
  });

  test('the view and the analytics table follow the orders', () => {
    const orders = rel('orders');
    const paid = orders.rows.filter((row) => row[col(orders, 'status')] === 'paid').map((row) => row[col(orders, 'id')]);
    expect(values(rel('paid_orders'), 'id')).toEqual(paid);
    const daily = rel('daily_revenue', 'analytics');
    expect(daily.rows.length).toBe(14);
    expect(values(daily, 'day')).toEqual([...values(daily, 'day')].sort());
  });

  test('the same people, products and orders as the Redis world', () => {
    const redis = acmeStoreSeed(NOW);
    const customers = rel('customers');
    const byEmail = new Map(customers.rows.map((row) => [row[col(customers, 'email')], row]));
    const emails = redis.keys.flatMap((k) => (k.key.startsWith('bull:email-queue:') && k.value.type === 'hash' && typeof k.value.v.data === 'string' ? [k.value.v.data] : []))
      .map((data) => (JSON.parse(data) as { to?: string }).to).filter((e): e is string => !!e);
    expect(emails.sort()).toEqual(['g.verdi@example.com', 'l.bianchi@example.com', 'm.rossi@example.com']);
    for (const e of emails) expect(byEmail.has(e), e).toBe(true);
    // The sessions' users: 4021 (it-IT) and 4022 (en-GB).
    expect(byEmail.get('m.rossi@example.com')?.[col(customers, 'id')]).toBe('4021');
    expect(byEmail.get('m.rossi@example.com')?.[col(customers, 'locale')]).toBe('it-IT');
    expect(byEmail.get('g.verdi@example.com')?.[col(customers, 'id')]).toBe('4022');
    expect(byEmail.get('g.verdi@example.com')?.[col(customers, 'locale')]).toBe('en-GB');
    // The cached product and the leaderboard's.
    const products = rel('products');
    const mug = products.rows.find((row) => row[col(products, 'id')] === '8812')!;
    expect([mug[col(products, 'sku')], mug[col(products, 'name')], mug[col(products, 'price')], mug[col(products, 'stock')]]).toEqual(['MUG-CERAMIC-BLK', 'Ceramic mug, black', '18.00', '37']);
    const board = redis.keys.find((k) => k.key === 'leaderboard:bestsellers:week')!.value as { v: Record<string, number> };
    expect(Object.keys(board.v).map((m) => m.slice('product:'.length)).every((id) => values(products, 'id').includes(id))).toBe(true);
    // The orders stream: 10442 paid (54.00) by Marco Rossi seconds ago, 10441 failed, 10437 shipped.
    const orders = rel('orders');
    const order = (id: string) => orders.rows.find((row) => row[col(orders, 'id')] === id)!;
    expect([order('10442')[col(orders, 'status')], order('10442')[col(orders, 'total')], order('10442')[col(orders, 'customer_id')]]).toEqual(['paid', '54.00', '4021']);
    expect(order('10441')[col(orders, 'status')]).toBe('failed');
    expect(order('10437')[col(orders, 'status')]).toBe('shipped');
    expect(Math.max(...values(orders, 'id').map(Number))).toBe(10442);
  });

  test("the Redis stream's story: 10441 failed before any charge, 10442 paid sixteen seconds ago, 10437 shipped five minutes ago", () => {
    const stream = acmeStoreSeed(NOW).keys.find((k) => k.key === 'events:orders')!.value as { v: { id: string; fields: Record<string, string> }[] };
    const at = (type: string, order: string) => Number(stream.v.find((e) => e.fields.type === type && e.fields.order === order)!.id.split('-')[0]);
    const ms = (ts: string) => Date.parse(ts.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1').replace('+00', 'Z'));
    // jwt_expired: the checkout failed before Stripe was asked — no payment, no webhook.
    const payments = rel('payments');
    expect(values(payments, 'order_id')).not.toContain('10441');
    const events = rel('webhook_events');
    expect((values(events, 'payload') as string[]).filter((p) => p.includes('"order_id": "10441"'))).toEqual([]);
    // Paid when the stream says so (the world places its times on whole seconds of now, the stream on now itself).
    const paid = payments.rows.find((row) => row[col(payments, 'order_id')] === '10442')!;
    expect(Math.abs(ms(paid[col(payments, 'created_at')]!) - at('order.paid', '10442'))).toBeLessThan(2000);
    // The carrier's event for 10437 when the stream's order.shipped came.
    const shipped = events.rows.filter((row) => row[col(events, 'source')] === 'carrier' && row[col(events, 'payload')]!.includes('"order_id": "10437"'));
    expect(shipped).toHaveLength(1);
    expect(Math.abs(ms(shipped[0]![col(events, 'received_at')]!) - at('order.shipped', '10437'))).toBeLessThan(2000);
    // Only what arrived in the last minute is still being processed.
    const pending = events.rows.filter((row) => row[col(events, 'processed_at')] === null).map((row) => NOW - ms(row[col(events, 'received_at')]!));
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((age) => age < 60_000)).toBe(true);
  });

  test("Copy SQL for a Read-only Role: main's own script for this server", () => {
    expect(db.readOnlyRoleSql).toBe(readOnlyRoleSql('atelier_readonly', ACME_SERVER.versionNum));
  });

  test('webhook payloads: nested objects and arrays, one past 64 KB, one integer past 2^53 written exactly', () => {
    const events = rel('webhook_events');
    const payloads = values(events, 'payload') as string[];
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    expect(payloads.filter((p) => bytes(p) > 65_536)).toHaveLength(1);
    const big = payloads.find((p) => /"id": 1859302233645670401\b/.test(p));
    expect(big, 'a parcel id past 2^53, digit for digit').toBeDefined();
    expect(Number('1859302233645670401') > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(payloads.some((p) => /"data": \{"object": \{/.test(p) && /\[\{/.test(p))).toBe(true);
    // jsonb's own text: shorter keys first, then by bytes; ", " and ": ".
    expect(jsonbText({ type: 'a', id: 1n, data: { b: [1, 'x', null, true] } })).toBe('{"id": 1, "data": {"b": [1, "x", null, true]}, "type": "a"}');
    expect(jsonbText(18014398509481985n)).toBe('18014398509481985');
  });

  test('the connection: the Docker world\'s postgres, as its DATABASE_URL names it (one project), Local', () => {
    expect(ACME_DB).toMatchObject({ name: 'acme', host: '127.0.0.1', port: 5432, database: 'acme', user: 'acme', env: 'local' });
    // The container the Docker view lists, publishing the port the connection reaches.
    const postgres = compileWorld().docker.snapshot.containers.find((c) => c.containerName === ACME_SOURCE.container);
    expect(postgres).toMatchObject({ project: 'acme-store', service: ACME_SOURCE.service, state: 'running' });
    expect(ACME_SOURCE).toEqual({ kind: 'docker', container: 'acme-store-postgres-1', service: 'postgres' });
    // The api's own URL: the same database and user, on that service's port.
    const urls = dockerContainers('/p', NOW).flatMap((c) => c.spec.env ?? []).filter((e) => e.startsWith('DATABASE_URL=')).map((e) => new URL(e.slice('DATABASE_URL='.length)));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect([u.hostname, u.port, u.pathname.slice(1), u.username]).toEqual([ACME_SOURCE.service, String(ACME_DB.port), ACME_DB.database, ACME_DB.user]);
    // A demo simplification: the role reads as one that can only read (no amber note).
    expect(ACME_SERVER).toMatchObject({ version: '16.4', versionNum: 160004, canWrite: false });
  });

  test('DDL as Atelier rebuilds it, static: every column and every index no constraint made', () => {
    for (const r of db.relations) {
      if (r.kind === 'table') {
        expect(r.ddl, r.name).toMatch(new RegExp(`^CREATE TABLE ${r.schema}\\.${r.name} \\(\\n`));
        for (const c of r.columns) expect(r.ddl, `${r.name}.${c.name}`).toContain(`    ${c.name} ${c.type}`);
        for (const k of r.constraints) expect(r.ddl, `${r.name}: ${k.name}`).toContain(`CONSTRAINT ${k.name} ${k.def}`);
        for (const i of r.indexes.filter((x) => !x.byConstraint)) expect(r.ddl, `${r.name}: ${i.name}`).toContain(`${i.def};`);
      } else expect(r.ddl).toBe(`CREATE VIEW ${r.schema}.${r.name} AS\n${r.viewDef}\n\nCOMMENT ON VIEW ${r.schema}.${r.name} IS '${r.comment}';\n`);
      expect(r.ddl.endsWith('\n'), r.name).toBe(true);
    }
  });
});

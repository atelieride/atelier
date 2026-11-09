// The catalog reader (src/main/databases/postgres/catalog.ts) against a real Postgres (PGlite behind the test proxy)
// through the read-only client: the sidebar's lists, a table's columns and keys (the SQL builders' TableTarget, checked
// against the hand-built ones in tests/support/pg-targets.ts), structure, relations, DDL, the server and its role.
// Older servers are simulated by a session that answers the version query with an older number: the version-gated
// statements leave out the columns those servers lack, and still run here.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DbColumn } from '../../src/shared/databases-filters';
import { DbError, type DbRows, type DbSession, type Stmt } from '../../src/main/databases/driver';
import { postgresDriver } from '../../src/main/databases/postgres/client';
import {
  readCatalog, readColumns, readDdl, readFunctionDef, readOnlyRoleSql, readRelations, readServerInfo, readStructure
} from '../../src/main/databases/postgres/catalog';
import { countStmt, type TableTarget } from '../../src/main/databases/postgres/sql';
import { ACME_COUNTS, TYPE_ZOO_COLUMNS } from '../support/pg-fixtures';
import { PgServer } from '../support/pg-server';
import { col, CUSTOMERS, EVENTS_NOPK, ODD_ITEMS, ORDER_ITEMS, ORDERS, WEBHOOK_EVENTS } from '../support/pg-targets';

/** pg_type.typcategory of type_zoo's element (or base) types ('U' for the rest). */
const CATEGORY: Record<string, string> = {
  int8: 'N', int4: 'N', numeric: 'N', float4: 'N', money: 'N', text: 'S', citext: 'S', bool: 'B', date: 'D', time: 'D',
  timestamp: 'D', timestamptz: 'D', interval: 'T', inet: 'I', cidr: 'I', tstzrange: 'R', int4range: 'R'
};
const TYPE_ZOO: TableTarget = {
  schema: 'public', name: 'type_zoo', pk: ['id'], uniqueKeys: [],
  columns: TYPE_ZOO_COLUMNS.map((c) => col(c.name, c.type, c.typeName, CATEGORY[c.typeName] ?? 'U', {
    isArray: c.type.endsWith('[]'), typeSchema: c.typeName === 'citext' ? 'public' : 'pg_catalog',
    ...(c.name === 'id' ? { isPk: true, isKey: true, nullable: false } : {})
  }))
};

let server: PgServer;
let db: DbSession;
/** Every statement the catalog reader ran through `db`. */
const ran: Stmt[] = [];
let session: DbSession;

beforeAll(async () => {
  server = await PgServer.start();
  db = await postgresDriver.connect({ host: '127.0.0.1', port: server.port, database: 'postgres', user: 'postgres', password: '', tls: 'off', timeoutSec: 15 });
  session = recording(db, ran);
});
afterAll(async () => {
  db?.close();
  await server?.stop();
});

/** A session that records what runs through it; with `version`, it answers the version query with that number. */
function recording(inner: DbSession, log: Stmt[], version?: number): DbSession {
  return {
    run(st: Stmt): Promise<DbRows> {
      log.push(st);
      if (version !== undefined && st.shape === 'cat.version') return Promise.resolve({ fields: [{ name: 'v', oid: 25 }], rows: [[String(version)]], ms: 0 });
      return inner.run(st);
    },
    close: () => inner.close(),
    get closed() { return inner.closed; },
    get tlsActive() { return inner.tlsActive; }
  };
}

const withoutDefault = (cols: DbColumn[]) => cols.map(({ default: _d, ...c }) => c);

describe('server', () => {
  test('version, role, TLS and whether the role can write', async () => {
    const t0 = Date.now() - 5;
    const info = await readServerInfo(session, t0);
    expect(info.versionNum).toBeGreaterThanOrEqual(180000);
    expect(info.version).toMatch(/^18\./);
    expect(info.role).toBe('postgres');
    expect(info.canWrite).toBe(true);
    expect(info.tls).toBe(false);
    expect(info.latencyMs).toBeGreaterThanOrEqual(5);
    expect(info.latencyMs).toBeLessThan(10000);
  });

  test('the server read tells a CockroachDB session to keep the plain wrapper (from version()), once; Postgres keeps both', async () => {
    let told = 0;
    const asking = (cockroach: boolean): DbSession => ({
      async run(st: Stmt): Promise<DbRows> {
        const r = await db.run(st);
        if (st.shape !== 'cat.server' || !cockroach) return r;
        // The same row, its last value (version()) as CockroachDB writes it.
        return { ...r, rows: r.rows.map((row) => [...row.slice(0, -1), 'CockroachDB CCL v23.1.11 (x86_64-pc-linux-gnu, built 2023/09/27, go1.19.10)']) };
      },
      close: () => db.close(),
      get closed() { return db.closed; },
      get tlsActive() { return db.tlsActive; },
      plainOnly: () => { told++; }
    });
    const ran: Stmt[] = [];
    await readServerInfo(recording(asking(false), ran), Date.now());
    expect(ran.find((st) => st.shape === 'cat.server')?.text).toContain('pg_catalog.version()');
    expect(told).toBe(0);
    const pg = asking(false);
    await readServerInfo(pg, Date.now());
    expect(told).toBe(0);
    const info = await readServerInfo(asking(true), Date.now());
    expect(told).toBe(1);
    expect(info.role).toBe('postgres');
  });

  test('a role that can only read: canWrite false; one granted UPDATE on a table or a column, or owning one: true', async () => {
    await server.exec(`create role catalog_reader; grant select on all tables in schema public to catalog_reader;
      create role catalog_writer; grant select on all tables in schema public to catalog_writer; grant update on coupons to catalog_writer;
      create role catalog_column; grant select on all tables in schema public to catalog_column; grant update (notes) on orders to catalog_column;
      create role catalog_owner; create schema catalog_owned; create table catalog_owned.t (id int); alter table catalog_owned.t owner to catalog_owner;`);
    try {
      const roles = [['catalog_reader', false], ['catalog_writer', true], ['catalog_column', true], ['catalog_owner', true]] as const;
      for (const [role, canWrite] of roles) {
        // PGlite runs one backend for every connection and ignores the startup user: the role is switched on it.
        await server.exec(`set role ${role};`);
        try {
          const info = await readServerInfo(recording(db, []), Date.now());
          expect(info.role).toBe(role);
          expect(info.canWrite, role).toBe(canWrite);
        } finally {
          await server.exec('reset role;');
        }
      }
    } finally {
      await server.exec('drop schema catalog_owned cascade;');
    }
  });

  test('past the scan cap without a writable relation: canWrite true (the amber note is the safe mistake)', async () => {
    const [row] = (await db.run({
      text: `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'`,
      values: [], shape: 'oracle'
    })).rows;
    const relations = Number(row?.[0]);
    expect(relations).toBeGreaterThan(10);
    await server.exec('set role catalog_reader;');
    try {
      const s = recording(db, []);
      // Every relation scanned, none writable: the role can only read.
      expect((await readServerInfo(s, Date.now(), relations)).canWrite).toBe(false);
      // One left unscanned: it might be writable, so the answer is "can write".
      expect((await readServerInfo(s, Date.now(), relations - 1)).canWrite).toBe(true);
    } finally {
      await server.exec('reset role;');
    }
  });

  test('the read-only role script: pg_read_all_data from 14, GRANT SELECT before', () => {
    const v17 = readOnlyRoleSql('reader', 170000);
    expect(v17).toContain('CREATE ROLE "reader" LOGIN');
    expect(v17).toContain('GRANT pg_read_all_data TO "reader"');
    expect(v17).not.toContain('GRANT SELECT ON ALL TABLES');
    const v13 = readOnlyRoleSql('reader', 130000);
    expect(v13).toContain('CREATE ROLE "reader" LOGIN');
    expect(v13).toContain('GRANT SELECT ON ALL TABLES');
    expect(v13).not.toContain('pg_read_all_data');
    // A role name with quotes and dollars can't break out of the identifier or the DO block.
    const odd = readOnlyRoleSql(`x" ; drop table t; --$$`, 130000);
    expect(odd).toContain(`CREATE ROLE "x"" ; drop table t; --$$" LOGIN`);
    expect(odd).not.toMatch(/DO \$\$/);
    expect(readOnlyRoleSql("o'brien", 130000)).toContain("'o''brien'");
    // A newline would end the script's comment line and run whatever follows it.
    expect(() => readOnlyRoleSql('reader\nDROP DATABASE acme; --', 170000)).toThrow(TypeError);
  });
});

describe('catalog lists (sidebar)', () => {
  test('no schema asked: public, with the schemas that hold anything, public first', async () => {
    const cat = await readCatalog(session, null);
    expect(cat.schema).toBe('public');
    expect(cat.schemas[0]).toBe('public');
    expect(cat.schemas).toContain('analytics');
    expect(cat.schemas.some((s) => s.startsWith('pg_') || s === 'information_schema')).toBe(false);
  });

  test('tables, views and materialized views with estimates; partitions hidden, a partitioned table sums them', async () => {
    const { rels } = await readCatalog(session, null);
    const by = (name: string) => rels.find((r) => r.name === name);
    expect(by('orders')).toEqual({ schema: 'public', name: 'orders', kind: 'table', estimate: ACME_COUNTS.orders });
    expect(by('paid_orders')).toEqual({ schema: 'public', name: 'paid_orders', kind: 'view', estimate: null });
    expect(by('daily_revenue')).toMatchObject({ kind: 'matview' });
    expect(by('measurements')).toEqual({ schema: 'public', name: 'measurements', kind: 'table', estimate: ACME_COUNTS.measurements, partitions: 2 });
    expect(by('Order "Items"')).toMatchObject({ kind: 'table', estimate: ACME_COUNTS['Order "Items"'] });
    expect(rels.filter((r) => r.name.startsWith('measurements_'))).toEqual([]);
    expect(rels.some((r) => r.name === 'page_views')).toBe(false);
    expect(rels.map((r) => r.name)).toEqual([...rels.map((r) => r.name)].sort());
  });

  test('enums with their values in order; functions as name(types) → result, without extension members', async () => {
    const { enums, functions } = await readCatalog(session, null);
    expect(enums.find((e) => e.name === 'order_status')).toEqual({ schema: 'public', name: 'order_status', values: ['pending', 'paid', 'shipped', 'refunded', 'failed'] });
    expect(enums.find((e) => e.name === 'plan_tier')?.values).toEqual(['free', 'pro', 'team', 'enterprise']);
    const total = functions.find((f) => f.name === 'order_total');
    expect(total).toMatchObject({ schema: 'public', name: 'order_total', args: 'bigint', returns: 'numeric' });
    expect(total?.oid).toBeGreaterThan(0);
    expect(functions.find((f) => f.name === 'set_updated_at')).toMatchObject({ args: '', returns: 'trigger' });
    // citext lives in public: its dozens of functions are the extension's, not the schema's.
    expect(functions.filter((f) => f.name.includes('citext'))).toEqual([]);
  });

  test('another schema when asked; public when the asked one holds nothing', async () => {
    const analytics = await readCatalog(session, 'analytics');
    expect(analytics.schema).toBe('analytics');
    expect(analytics.rels).toEqual([{ schema: 'analytics', name: 'page_views', kind: 'table', estimate: ACME_COUNTS['analytics.page_views'] }]);
    expect(analytics.enums).toEqual([]);
    expect((await readCatalog(session, 'no_such_schema')).schema).toBe('public');
  });
});

// The palette searches every schema's relations by name: one more read per catalog read, of
// pg_class and pg_namespace with the privilege functions only (no lock, nothing else read).
describe("every schema's relations by name (the palette)", () => {
  test('tables, views and materialized views of every user schema, whichever the sidebar shows; partitions and the server\'s schemas left out', async () => {
    const log: Stmt[] = [];
    const cat = await readCatalog(recording(db, log), null);
    const { names, namesMore } = cat;
    expect(namesMore).toBe(false);
    for (const r of [
      { schema: 'public', name: 'orders', kind: 'table' }, { schema: 'public', name: 'paid_orders', kind: 'view' },
      { schema: 'public', name: 'daily_revenue', kind: 'matview' }, { schema: 'public', name: 'measurements', kind: 'table' },
      { schema: 'public', name: 'Order "Items"', kind: 'table' }, { schema: 'analytics', name: 'page_views', kind: 'table' }
    ]) expect(names).toContainEqual(r);
    expect(names.filter((r) => r.name.startsWith('measurements_'))).toEqual([]);
    expect(names.some((r) => r.schema.startsWith('pg_') || r.schema === 'information_schema')).toBe(false);
    // public first, then by schema and name: what a cap keeps is the sidebar's usual schema.
    const key = (r: { schema: string; name: string }) => `${r.schema === 'public' ? 0 : 1}\u0000${r.schema}\u0000${r.name}`;
    expect(names.map(key)).toEqual(names.map(key).sort());
    expect((await readCatalog(session, 'analytics')).names).toEqual(names);
    // The read itself: one statement more than the sidebar's two, over pg_class and pg_namespace.
    expect(log.map((s) => s.shape)).toEqual(['cat.version', 'cat.schemas', 'cat.lists', 'cat.names', 'cat.databases']);
    const text = log.find((s) => s.shape === 'cat.names')!.text;
    expect(text.match(/pg_catalog\.pg_\w+/g)?.filter((x) => !/^pg_catalog\.pg_(class|namespace)$/.test(x)) ?? []).toEqual([]);
    expect(text).toContain('has_table_privilege');
  });

  test('only what the role may read: a schema without USAGE, a table without SELECT are left out; a column grant counts', async () => {
    await server.exec(`create role palette_reader; grant select on orders to palette_reader; grant select (id) on customers to palette_reader;
      grant select on analytics.page_views to palette_reader;`);
    try {
      await server.exec('set role palette_reader;');
      try {
        const { names } = await readCatalog(recording(db, []), null);
        expect(names).toEqual([{ schema: 'public', name: 'customers', kind: 'table' }, { schema: 'public', name: 'orders', kind: 'table' }]);
      } finally {
        await server.exec('reset role;');
      }
    } finally {
      await server.exec('drop owned by palette_reader; drop role palette_reader;');
    }
  });

  test('capped: past the cap, the first ones and `more`; a cap of 0 or less, or not whole, is refused before anything runs', async () => {
    const all = (await readCatalog(session, null)).names;
    const capped = await readCatalog(session, null, 3);
    expect(capped.names).toEqual(all.slice(0, 3));
    expect(capped.namesMore).toBe(true);
    expect((await readCatalog(session, null, all.length)).namesMore).toBe(false);
    for (const cap of [0, -1, 2.5, Number.NaN]) {
      const log: Stmt[] = [];
      await expect(readCatalog(recording(db, log), null, cap), String(cap)).rejects.toThrow(RangeError);
      expect(log).toEqual([]);
    }
  });

  test('the names read failing (a timeout, a privilege quirk) leaves them empty: the sidebar still gets its catalog, warned once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failing = (inner: DbSession): DbSession => ({
        run: (st) => (st.shape === 'cat.names'
          ? Promise.reject(new DbError({ kind: 'timeout', message: 'canceling statement due to statement timeout' }))
          : inner.run(st)),
        close: () => inner.close(),
        get closed() { return inner.closed; },
        get tlsActive() { return inner.tlsActive; }
      });
      const cat = await readCatalog(failing(db), null);
      expect(cat).toMatchObject({ schema: 'public', names: [], namesMore: false });
      expect(cat.schemas).toContain('analytics');
      expect(cat.rels.some((r) => r.name === 'orders')).toBe(true);
      expect(cat.functions.some((f) => f.name === 'order_total')).toBe(true);
      // Again: the same answer, and no second warning (one per run of the app).
      expect((await readCatalog(failing(db), 'analytics')).rels.map((r) => r.name)).toEqual(['page_views']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.join(' '))).toContain('statement timeout');
    } finally {
      warn.mockRestore();
    }
  });
});

// The sidebar's database chip: the server's databases the role may connect to, read with the catalog —
// names only, from pg_database alone (a shared catalog: no lock on anything of the user's) —, isolated as the names are.
describe("the server's databases", () => {
  const failing = (inner: DbSession, shape: string): DbSession => ({
    run: (st) => (st.shape === shape ? Promise.reject(new DbError({ kind: 'denied', message: 'permission denied for table pg_database' })) : inner.run(st)),
    close: () => inner.close(),
    get closed() { return inner.closed; },
    get tlsActive() { return inner.tlsActive; }
  });

  // CREATE and DROP DATABASE refuse a transaction block: one statement per exec.
  const each = async (...sql: string[]) => { for (const s of sql) await server.exec(s); };

  test('those the role may connect to, sorted, by name only: templates and databases that refuse connections left out', async () => {
    await each('create database "zeta shop"', 'create database alpha', 'create database closed_db');
    try {
      await server.exec('alter database closed_db allow_connections false;');
      const log: Stmt[] = [];
      const cat = await readCatalog(recording(db, log), null);
      expect(cat.databases).toEqual(['alpha', 'postgres', 'zeta shop']);
      const st = log.find((s) => s.shape === 'cat.databases')!;
      expect(st.text).toContain('datallowconn');
      expect(st.text).toContain('datistemplate');
      expect(st.text).toContain("has_database_privilege(d.oid, 'CONNECT')");
      // pg_database alone: nothing of the user's is read, so nothing of the user's is locked.
      expect(st.text.match(/pg_catalog\.pg_\w+/g)?.filter((x) => x !== 'pg_catalog.pg_database') ?? []).toEqual([]);
    } finally {
      await each('drop database "zeta shop"', 'drop database alpha', 'drop database closed_db');
    }
  });

  test('a database the role has no CONNECT on is left out', async () => {
    await each('create database private_db', 'revoke connect on database private_db from public', 'create role db_lister');
    try {
      await server.exec('set role db_lister;');
      try {
        expect((await readCatalog(recording(db, []), null)).databases).toEqual(['postgres']);
      } finally {
        await server.exec('reset role;');
      }
    } finally {
      await each('drop database private_db', 'drop role db_lister');
    }
  });

  test('their read failing leaves none: the sidebar still gets its catalog, warned once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cat = await readCatalog(failing(db, 'cat.databases'), null);
      expect(cat.databases).toEqual([]);
      expect(cat.rels.some((r) => r.name === 'orders')).toBe(true);
      expect(cat.names.length).toBeGreaterThan(0);
      expect((await readCatalog(failing(db, 'cat.databases'), 'analytics')).databases).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.join(' '))).toContain('permission denied');
    } finally {
      warn.mockRestore();
    }
  });
});

// A database with no table, view or materialized view in any schema says so (and lists the server's others).
describe('a database without tables', () => {
  let bare: PgServer;
  let conn: DbSession;
  beforeAll(async () => {
    bare = await PgServer.start({ seed: false });
    conn = await postgresDriver.connect({ host: '127.0.0.1', port: bare.port, database: 'postgres', user: 'postgres', password: '', tls: 'off', timeoutSec: 15 });
  });
  afterAll(async () => {
    conn?.close();
    await bare?.stop();
  });

  test('noRels: no table, view or materialized view in any user schema; enums and functions alone don\'t count; any one relation does', async () => {
    const empty = await readCatalog(conn, null);
    expect(empty).toMatchObject({ schema: 'public', rels: [], noRels: true, databases: ['postgres'] });
    await bare.exec("create schema extra; create type extra.mood as enum ('ok'); create function public.one() returns int language sql as 'select 1';");
    const still = await readCatalog(conn, null);
    expect(still.noRels).toBe(true);
    expect(still.functions.map((f) => f.name)).toEqual(['one']);
    await bare.exec('create view extra.v as select 1 as x;');
    // The view is in another schema than the one the sidebar shows: the database holds a relation all the same.
    const one = await readCatalog(conn, 'public');
    expect(one).toMatchObject({ schema: 'public', rels: [], noRels: false });
  });

  test('the acme world holds tables: noRels false', async () => {
    expect((await readCatalog(session, null)).noRels).toBe(false);
  });
});

describe('columns and keys (TableTarget)', () => {
  test('orders: the hand-built target, plus defaults', async () => {
    const r = await readColumns(session, 'public', 'orders');
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.kind).toBe('table');
    expect(r.estimate).toBe(ACME_COUNTS.orders);
    expect(r.pk).toEqual(['id']);
    expect(r.uniqueKeys).toEqual([]);
    expect(withoutDefault(r.columns)).toEqual(ORDERS.columns);
    const by = (name: string) => r.columns.find((c) => c.name === name);
    expect(by('total')?.type).toBe('numeric(10,2)');
    expect(by('status')).toMatchObject({ typeSchema: 'public', typeName: 'order_status', typeCat: 'E', enumValues: ['pending', 'paid', 'shipped', 'refunded', 'failed'] });
    expect(by('tags')).toMatchObject({ type: 'text[]', typeName: 'text', isArray: true });
    expect(by('customer_id')).toMatchObject({ isKey: true, fk: { schema: 'public', table: 'customers', column: 'id' } });
    expect(by('status')?.default).toBe("'pending'::order_status");
    expect(by('id')?.default).toBeUndefined();
    expect(by('notes')?.default).toBeUndefined();
  });

  test.each([
    ['customers', CUSTOMERS], ['order_items', ORDER_ITEMS], ['webhook_events', WEBHOOK_EVENTS], ['Order "Items"', ODD_ITEMS],
    ['events_nopk', EVENTS_NOPK], ['type_zoo', TYPE_ZOO]
  ] as const)('%s: the hand-built target', async (name, target) => {
    const r = await readColumns(session, 'public', name);
    expect(r && { schema: 'public', name, pk: r.pk, uniqueKeys: r.uniqueKeys, columns: withoutDefault(r.columns) }).toEqual(target);
  });

  test('a domain is read as its base type, an array of it as the base element', async () => {
    const r = await readColumns(session, 'public', 'type_zoo');
    const by = (name: string) => r?.columns.find((c) => c.name === name);
    expect(by('c_domain')).toMatchObject({ type: 'positive_int', typeSchema: 'pg_catalog', typeName: 'int4', typeCat: 'N', isArray: false });
    expect(by('c_domain_array')).toMatchObject({ type: 'positive_int[]', typeSchema: 'pg_catalog', typeName: 'int4', typeCat: 'N', isArray: true });
    // The builders cast to the base type: a value the domain's CHECK refuses filters to nothing instead of failing.
    if (!r) return;
    const target: TableTarget = { schema: 'public', name: 'type_zoo', ...r };
    const count = async (values: string[]) => Number((await db.run(countStmt(target, [{ column: 'c_domain', op: 'eq', values }]))).rows[0]?.[0]);
    expect(await count(['-1'])).toBe(0);
    expect(await count(['12'])).toBe(1);
  });

  test('a unique index that compares otherwise than its column — another operator class, another collation — never names a row', async () => {
    await server.exec(`create schema keys80;
      create table keys80.codes (by_pattern text not null, by_c text not null, plain text not null, num int4 not null);
      create unique index codes_a_pattern on keys80.codes (by_pattern text_pattern_ops);
      create unique index codes_b_collate on keys80.codes (by_c collate "C");
      create unique index codes_c_plain on keys80.codes (plain);
      create unique index codes_d_num on keys80.codes (num);`);
    try {
      await server.clearLog();
      expect((await readColumns(session, 'keys80', 'codes'))?.uniqueKeys).toEqual([['plain'], ['num']]);
      // A nondeterministic collation (an ICU one: PGlite has none, so the statement's text says it): never a key.
      const sent = (await server.statementsLog()).find((l) => l.includes('indisunique')) ?? '';
      expect(sent).toContain('collisdeterministic');
      expect(sent).toContain('i.indcollation[k] <> a.attcollation');
      expect(sent).toContain('oc.opcdefault');
    } finally {
      await server.exec('drop schema keys80 cascade;');
    }
  });

  test('the operator class must be the default for the column\'s own type — a citext column with a text_ops index compares otherwise', async () => {
    await server.exec(`create schema keys25;
      create domain keys25.ci_d as citext;
      create domain keys25.t_d as text;
      create table keys25.codes (
        a_ci citext not null, b_ci citext not null, c_vc varchar(20) not null, d_dom keys25.ci_d not null, e_dom keys25.t_d not null
      );
      create unique index codes_a on keys25.codes (a_ci text_ops);
      create unique index codes_b on keys25.codes (b_ci);
      create unique index codes_c on keys25.codes (c_vc);
      create unique index codes_d on keys25.codes (d_dom text_ops);
      create unique index codes_e on keys25.codes (e_dom);`);
    try {
      // a: case-sensitive index on a case-insensitive column (two rows can equal 'X' as the column compares); d: the
      // same through a domain. b (citext's own), c (varchar's default is text's), e (a domain over text): keys.
      expect((await readColumns(session, 'keys25', 'codes'))?.uniqueKeys).toEqual([['b_ci'], ['c_vc'], ['e_dom']]);
    } finally {
      await server.exec('drop schema keys25 cascade;');
    }
  });

  test('unique keys whose columns are all NOT NULL; identity columns are keys', async () => {
    expect((await readColumns(session, 'public', 'payments'))?.uniqueKeys).toEqual([['provider_ref']]);
    const views = await readColumns(session, 'analytics', 'page_views');
    expect(views?.pk).toEqual(['id']);
    expect(views?.columns.find((c) => c.name === 'id')).toMatchObject({ isKey: true, isPk: true });
  });

  test('views, materialized views and partitioned tables', async () => {
    const view = await readColumns(session, 'public', 'paid_orders');
    expect(view).toMatchObject({ kind: 'view', estimate: null, pk: [], uniqueKeys: [] });
    expect(view?.columns.map((c) => c.name)).toEqual(['id', 'customer_id', 'total', 'currency', 'paid_at']);
    expect(view?.columns.every((c) => c.nullable && !c.isPk)).toBe(true);
    const days = Number((await db.run({ text: 'select count(*) from daily_revenue', values: [], shape: 'oracle' })).rows[0]?.[0]);
    expect(await readColumns(session, 'public', 'daily_revenue')).toMatchObject({ kind: 'matview', estimate: days, pk: [] });
    expect(await readColumns(session, 'public', 'measurements')).toMatchObject({ kind: 'table', estimate: ACME_COUNTS.measurements, pk: [] });
  });

  test('null for a name that is not a table or view (missing, an index, another schema)', async () => {
    expect(await readColumns(session, 'public', 'no_such_table')).toBeNull();
    expect(await readColumns(session, 'public', 'orders_pkey')).toBeNull();
    expect(await readColumns(session, 'analytics', 'orders')).toBeNull();
  });
});

describe('structure', () => {
  test('orders: owner, comments, column notes, indexes, constraints and triggers, size, stats', async () => {
    const st = await readStructure(session, 'public', 'orders');
    expect(st).toMatchObject({ schema: 'public', name: 'orders', kind: 'table', owner: 'postgres', comment: 'One row per checkout', partitions: [], viewDef: null });
    const colBy = (name: string) => st.columns.find((c) => c.name === name);
    expect(colBy('notes')).toMatchObject({ comment: 'Shown on the packing slip', identity: false, generated: null, check: null });
    expect(colBy('id')).toMatchObject({ identity: true, isPk: true, comment: null });
    expect(colBy('total')?.check).toMatch(/^CHECK \(\(total >= /);
    expect(colBy('customer_id')?.fk).toEqual({ schema: 'public', table: 'customers', column: 'id' });

    const ix = (name: string) => st.indexes.find((i) => i.name === name);
    expect(st.indexes.map((i) => i.name).sort()).toEqual(['orders_created_at_idx', 'orders_customer_id_idx', 'orders_metadata_gin', 'orders_pending_idx', 'orders_pkey']);
    expect(ix('orders_pkey')).toMatchObject({ primary: true, unique: true, method: 'btree', neverUsed: false, partial: null });
    expect(ix('orders_metadata_gin')).toMatchObject({ method: 'gin', scans: 0, neverUsed: true, unique: false, primary: false });
    expect(ix('orders_metadata_gin')?.def).toContain('USING gin (metadata jsonb_path_ops)');
    expect(ix('orders_pending_idx')?.partial).toBe("(status = 'pending'::order_status)");
    expect(st.indexes.every((i) => i.bytes !== null && i.bytes > 0)).toBe(true);

    const con = (name: string) => st.constraints.find((c) => c.name === name);
    expect(con('orders_pkey')).toEqual({ name: 'orders_pkey', kind: 'p', def: 'PRIMARY KEY (id)' });
    expect(con('orders_customer_id_fkey')).toMatchObject({ kind: 'f', def: 'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT' });
    expect(con('orders_total_check')?.kind).toBe('c');
    expect(con('orders_set_updated_at')?.kind).toBe('t');
    expect(con('orders_set_updated_at')?.def).toContain('BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION set_updated_at()');
    // Postgres 18 keeps NOT NULL as constraints: the columns already say it.
    expect(st.constraints.map((c) => c.kind).sort()).toEqual(['c', 'f', 'f', 'p', 't']);

    expect(st.size.total).toBeGreaterThan(0);
    expect(st.size.indexes).toBeGreaterThan(0);
    expect(st.size.table + st.size.indexes + st.size.toast).toBe(st.size.total);
    expect(st.stats.estimate).toBe(ACME_COUNTS.orders);
    expect(st.stats.dead).toBe(0);
    expect(Date.parse(st.stats.lastAnalyze ?? '')).toBeGreaterThan(Date.now() - 10 * 60_000);
    expect(st.stats.lastAnalyze).toMatch(/Z$/);
  });

  test('a view: its definition, no indexes or constraints', async () => {
    const st = await readStructure(session, 'public', 'paid_orders');
    expect(st).toMatchObject({ kind: 'view', indexes: [], constraints: [], partitions: [] });
    expect(st.viewDef).toContain("WHERE status = 'paid'::order_status");
    expect((await readStructure(session, 'public', 'daily_revenue')).viewDef).toContain('GROUP BY');
  });

  test('a partitioned table: its partitions with their bounds, the size and estimate of all of them', async () => {
    const st = await readStructure(session, 'public', 'measurements');
    expect(st.partitions).toEqual([
      { schema: 'public', name: 'measurements_2026_10', bound: "FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')" },
      { schema: 'public', name: 'measurements_2026_11', bound: "FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00')" }
    ]);
    expect(st.size.table).toBeGreaterThan(0);
    expect(st.stats.estimate).toBe(ACME_COUNTS.measurements);
  });

  test('an unknown table rejects as unknown-table', async () => {
    const e = await readStructure(session, 'public', 'no_such_table').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DbError);
    expect((e as DbError).problem.kind).toBe('unknown-table');
  });

  // In Structure too: pg_relation_size and friends take an AccessShareLock on every
  // relation they measure (it queues behind VACUUM FULL, TRUNCATE or ALTER on a production table) — relpages doesn't.
  const LOCKING_SIZES = /pg_(relation|table|indexes|total_relation)_size/;
  const oracle = async (text: string) => (await db.run({ text, values: [], shape: 'oracle' })).rows;
  const pagesOf = (rel: string) => `(select greatest(x.relpages, 0) from pg_class x where x.oid = '${rel}'::regclass)`;
  /** Pages of `oid`'s indexes (a SQL expression over the relation's oid). */
  const indexPages = (oid: string) => `coalesce((select sum(greatest(i.relpages, 0)) from pg_index x join pg_class i on i.oid = x.indexrelid where x.indrelid = ${oid}), 0)`;

  test('sizes from the statistics, without a lock: relpages × block size of the table, its indexes, its TOAST and each index', async () => {
    const log: Stmt[] = [];
    const st = await readStructure(recording(db, log), 'public', 'orders');
    expect(log.filter((s) => LOCKING_SIZES.test(s.text)).map((s) => s.shape)).toEqual([]);
    const [row] = await oracle(`select current_setting('block_size'), ${pagesOf('public.orders')}, ${indexPages("'public.orders'::regclass")},
      coalesce((select greatest(t.relpages, 0) + ${indexPages('t.oid')} from pg_class c join pg_class t on t.oid = c.reltoastrelid where c.oid = 'public.orders'::regclass), 0)`);
    const [block, table, indexes, toast] = (row ?? []).map(Number) as [number, number, number, number];
    expect(block).toBe(8192);
    expect(st.size).toEqual({ table: table * block, indexes: indexes * block, toast: toast * block, total: (table + indexes + toast) * block, measured: true });
    expect(st.size.table).toBeGreaterThan(0);
    for (const i of st.indexes) {
      const [[pages]] = (await oracle(`select ${pagesOf(`public.${i.name}`)}`)) as [[string]];
      expect(i.bytes, i.name).toBe(Number(pages) * block);
    }
  });

  test('a partitioned table\'s sizes are its partitions\' (relpages: the parent stores nothing)', async () => {
    const log: Stmt[] = [];
    const st = await readStructure(recording(db, log), 'public', 'measurements');
    expect(log.filter((s) => LOCKING_SIZES.test(s.text)).map((s) => s.shape)).toEqual([]);
    const [[pages]] = (await oracle(`select ${pagesOf('public.measurements_2026_10')} + ${pagesOf('public.measurements_2026_11')}`)) as [[string]];
    expect(st.size.table).toBe(Number(pages) * 8192);
    expect(st.size.table + st.size.indexes + st.size.toast).toBe(st.size.total);
  });

  describe('measured, partitions elsewhere, partitioned indexes', () => {
    beforeAll(() => server.exec(`create schema meas; create schema meas_parts;
      create table meas.fresh (id int primary key, v text);
      insert into meas.fresh select g, 'x' from generate_series(1, 500) g;
      create table meas.p (id int not null, primary key (id)) partition by range (id);
      create table meas_parts.p1 partition of meas.p for values from (0) to (100);
      create table meas.p2 partition of meas.p for values from (100) to (200);
      insert into meas.p select g from generate_series(1, 150) g;`));
    afterAll(() => server.exec('drop schema meas cascade; drop schema meas_parts cascade;'));

    test('measured: an ANALYZE or a VACUUM (manual or auto) seen on the table; a partitioned one\'s, on one of its partitions', async () => {
      expect((await readStructure(session, 'public', 'orders')).size.measured).toBe(true);
      expect((await readStructure(session, 'public', 'measurements')).size.measured).toBe(true);
      expect((await readStructure(session, 'meas', 'fresh')).size.measured).toBe(false);
      expect((await readStructure(session, 'meas', 'p')).size.measured).toBe(false);
      await server.exec('analyze meas.p2;');
      expect((await readStructure(session, 'meas', 'p')).size.measured).toBe(true);
      await server.exec('vacuum meas.fresh;');
      expect((await readStructure(session, 'meas', 'fresh')).size.measured).toBe(true);
    });

    test('a partition in another schema says so; a partitioned index has no size of its own (its partitions\' have)', async () => {
      const st = await readStructure(session, 'meas', 'p');
      expect(st.partitions.map((p) => [p.schema, p.name])).toEqual([['meas_parts', 'p1'], ['meas', 'p2']]);
      expect(st.indexes.find((i) => i.name === 'p_pkey')).toMatchObject({ primary: true, bytes: null });
      expect((await readStructure(session, 'meas_parts', 'p1')).indexes.every((i) => typeof i.bytes === 'number')).toBe(true);
    });
  });
});

describe('function definitions (the sidebar\'s Copy Definition)', () => {
  beforeAll(() => server.exec(`create schema fnov;
    create function fnov.f(a int4) returns int4 language sql immutable as $$ select a + 1 $$;
    create function fnov.f(a text) returns text language sql immutable as $$ select a || '!' $$;
    create procedure fnov.p(n int4) language sql as $$ select 1 $$;
    create aggregate fnov.total(int4) (sfunc = int4pl, stype = int4);`));
  afterAll(() => server.exec('drop schema fnov cascade;'));

  test('a function by its schema, name and identity arguments as the sidebar lists them: pg_get_functiondef', async () => {
    const { functions } = await readCatalog(session, null);
    const total = functions.find((f) => f.name === 'order_total')!;
    const def = await readFunctionDef(session, 'public', 'order_total', total.args);
    expect(def).toMatch(/^CREATE OR REPLACE FUNCTION public\.order_total\(order_id bigint\)\n RETURNS numeric\n/);
    expect(def).toContain('select coalesce(sum(quantity * unit_price), 0) from order_items');
    expect(await readFunctionDef(session, 'public', 'set_updated_at', '')).toMatch(/RETURNS trigger[\s\S]*new\.updated_at := now\(\);/);
  });

  test('overloads told apart by their arguments; a procedure too; an aggregate is never listed nor read', async () => {
    const fns = (await readCatalog(session, 'fnov')).functions;
    expect(fns.map((f) => [f.name, f.args])).toEqual([['f', 'integer'], ['f', 'text'], ['p', 'integer']]);
    expect(await readFunctionDef(session, 'fnov', 'f', 'integer')).toMatch(/^CREATE OR REPLACE FUNCTION fnov\.f\(a integer\)\n RETURNS integer[\s\S]*select a \+ 1/);
    expect(await readFunctionDef(session, 'fnov', 'f', 'text')).toMatch(/^CREATE OR REPLACE FUNCTION fnov\.f\(a text\)\n RETURNS text[\s\S]*select a \|\| '!'/);
    expect(await readFunctionDef(session, 'fnov', 'p', 'integer')).toMatch(/^CREATE OR REPLACE PROCEDURE fnov\.p\(IN n integer\)/);
    const e = await readFunctionDef(session, 'fnov', 'total', 'integer').catch((x: unknown) => x);
    expect((e as DbError).problem).toEqual({ kind: 'gone', message: 'This function no longer exists' });
  });

  test('nothing matches — dropped since, other arguments, another schema: gone, never another function\'s definition', async () => {
    for (const [schema, name, args] of [['fnov', 'f', 'bigint'], ['fnov', 'f', ''], ['public', 'f', 'integer'], ['fnov', 'nope', 'integer'], ['fnov', 'f', 'integer, text']]) {
      const e = await readFunctionDef(session, schema!, name!, args!).catch((x: unknown) => x);
      expect(e, `${schema}.${name}(${args})`).toBeInstanceOf(DbError);
      expect((e as DbError).problem.kind).toBe('gone');
    }
  });

  test('one statement, the names and arguments as parameters, never in its text', async () => {
    const log: Stmt[] = [];
    await readFunctionDef(recording(db, log), 'fnov', 'f', 'text');
    const st = log.filter((s) => s.shape === 'cat.functiondef');
    expect(st).toHaveLength(1);
    expect(st[0]!.values).toEqual(['fnov', 'f', 'text']);
    expect(st[0]!.text).toContain('pg_catalog.pg_get_functiondef(p.oid)');
    expect(st[0]!.text).not.toMatch(/fnov|'text'/);
  });
});

describe('relations', () => {
  test('orders: points at customers and coupons; order_items, payments, refunds and shipments point at it', async () => {
    const rel = await readRelations(session, 'public', 'orders');
    expect(rel.out).toEqual([
      { name: 'orders_coupon_code_fkey', from: { schema: 'public', table: 'orders', columns: ['coupon_code'] }, to: { schema: 'public', table: 'coupons', columns: ['code'] }, indexed: false },
      { name: 'orders_customer_id_fkey', from: { schema: 'public', table: 'orders', columns: ['customer_id'] }, to: { schema: 'public', table: 'customers', columns: ['id'] }, indexed: true }
    ]);
    expect(rel.in.map((f) => f.from.table)).toEqual(['order_items', 'payments', 'refunds', 'shipments']);
    expect(rel.in.every((f) => f.to.table === 'orders' && f.to.columns.join() === 'id' && f.from.columns.join() === 'order_id')).toBe(true);
    // order_items by its primary key (order_id, line), payments by payments_order_id_idx; refunds and shipments by none.
    expect(rel.in.map((f) => f.indexed)).toEqual([true, true, false, false]);
  });

  test('a composite key declared in another order than the referenced one: columns paired by position, indexed in any order', async () => {
    const rel = await readRelations(session, 'public', 'order_items');
    expect(rel.in).toEqual([{
      name: 'item_notes_item_fkey', from: { schema: 'public', table: 'item_notes', columns: ['item_line', 'item_order'] },
      to: { schema: 'public', table: 'order_items', columns: ['line', 'order_id'] }, indexed: true
    }]);
  });

  test('a self-reference is in both directions', async () => {
    const rel = await readRelations(session, 'public', 'employees');
    const self = { name: 'employees_manager_id_fkey', from: { schema: 'public', table: 'employees', columns: ['manager_id'] }, to: { schema: 'public', table: 'employees', columns: ['id'] }, indexed: false };
    expect(rel).toEqual({ out: [self], in: [self] });
  });

  describe('indexed: an index whose leading key columns are the foreign key columns, in any order', () => {
    beforeAll(() => server.exec(`create schema fkix;
      create table fkix.t (a int, b int, primary key (a, b));
      create table fkix.swapped (a int, b int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.swapped (b, a);
      create table fkix.longer (a int, b int, z int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.longer (b, a, z);
      create table fkix.own_pk (a int, b int, id int, foreign key (a, b) references fkix.t (a, b), primary key (a, b, id));
      create table fkix.not_leading (a int, b int, z int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.not_leading (z, a, b);
      create table fkix.one_of_two (a int, b int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.one_of_two (a);
      create table fkix.partial (a int, b int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.partial (a, b) where a > 0;
      create table fkix.included (a int, b int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.included (a) include (b);
      create table fkix.expr (a int, b int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.expr ((a + b), a, b);
      create table fkix.twice (a int, b int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.twice (a, a);
      create table fkix.none (a int, b int, foreign key (a, b) references fkix.t (a, b));
      create table fkix.brin (a int, b int, foreign key (a, b) references fkix.t (a, b));
      create index on fkix.brin using brin (a, b);
      create table fkix.one (id int primary key);
      create table fkix.by_hash (id int references fkix.one (id));
      create index on fkix.by_hash using hash (id);
      create table fkix.by_brin (id int references fkix.one (id));
      create index on fkix.by_brin using brin (id);`));
    afterAll(() => server.exec('drop schema fkix cascade;'));

    test('only a btree or a hash index finds the rows pointing at one row; a BRIN index (lossy, a range scan) does not', async () => {
      expect((await readRelations(session, 'fkix', 't')).in.find((f) => f.from.table === 'brin')?.indexed).toBe(false);
      const one = await readRelations(session, 'fkix', 'one');
      expect(Object.fromEntries(one.in.map((f) => [f.from.table, f.indexed]))).toEqual({ by_hash: true, by_brin: false });
    });

    test('leading in any order, longer, a primary key: indexed; not leading, one of two, partial, INCLUDE, expression, none: not', async () => {
      const rel = await readRelations(session, 'fkix', 't');
      expect(Object.fromEntries(rel.in.map((f) => [f.from.table, f.indexed]))).toEqual({
        swapped: true, longer: true, own_pk: true,
        not_leading: false, one_of_two: false, partial: false, included: false, expr: false, twice: false, none: false, brin: false
      });
    });

    test('the 9.6 statement (indnatts: no INCLUDE before 11) tells them apart too', async () => {
      const rel = await readRelations(recording(db, [], 90600), 'fkix', 't');
      // Read on this Postgres 18 catalog, INCLUDE columns count as key columns; a real 9.6 server has none.
      expect(rel.in.filter((f) => f.indexed).map((f) => f.from.table)).toEqual(['included', 'longer', 'own_pk', 'swapped']);
    });
  });

  test('none for a table without foreign keys; unknown-table for a missing one', async () => {
    expect(await readRelations(session, 'public', 'measurements')).toEqual({ out: [], in: [] });
    const e = await readRelations(session, 'public', 'no_such_table').catch((x: unknown) => x);
    expect((e as DbError).problem?.kind).toBe('unknown-table');
  });
});

describe('DDL', () => {
  test('orders: CREATE TABLE with columns and constraints, then indexes, comments and triggers', async () => {
    const ddl = await readDdl(session, 'public', 'orders');
    expect(ddl.startsWith('CREATE TABLE public.orders (\n')).toBe(true);
    expect(ddl).toContain('    id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n');
    expect(ddl).toContain("    status order_status DEFAULT 'pending'::order_status NOT NULL,\n");
    expect(ddl).toContain('    tags text[],\n');
    expect(ddl).toContain('    CONSTRAINT orders_pkey PRIMARY KEY (id),\n');
    expect(ddl).toContain('CREATE INDEX orders_metadata_gin ON public.orders USING gin (metadata jsonb_path_ops);');
    expect(ddl).not.toContain('CREATE UNIQUE INDEX orders_pkey');
    expect(ddl).toContain("COMMENT ON TABLE public.orders IS 'One row per checkout';");
    expect(ddl).toContain("COMMENT ON COLUMN public.orders.notes IS 'Shown on the packing slip';");
    expect(ddl).toContain('CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON public.orders');
  });

  test('names that need quotes, views, materialized views and partitions', async () => {
    const odd = await readDdl(session, 'public', 'Order "Items"');
    expect(odd.startsWith('CREATE TABLE public."Order ""Items""" (\n')).toBe(true);
    expect(odd).toContain('    "Weird Col" text,\n');
    expect(await readDdl(session, 'public', 'paid_orders')).toMatch(/^CREATE VIEW public\.paid_orders AS\n SELECT id,/);
    expect(await readDdl(session, 'public', 'daily_revenue')).toMatch(/^CREATE MATERIALIZED VIEW public\.daily_revenue AS\n/);
    const parts = await readDdl(session, 'public', 'measurements');
    expect(parts).toContain('\n) PARTITION BY RANGE (taken_at);\n');
    expect(parts).toContain("CREATE TABLE public.measurements_2026_10 PARTITION OF public.measurements FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');");
    expect(await readDdl(session, 'analytics', 'page_views')).toContain('    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,\n');
  });

  describe('sub-partitions and foreign tables', () => {
    beforeAll(() => server.exec(`create schema ddl18;
      create table ddl18.p (id int, k int) partition by range (id);
      create table ddl18.p1 partition of ddl18.p for values from (0) to (10) partition by list (k);
      create table ddl18.p1a partition of ddl18.p1 for values in (1);
      create table ddl18.p1b partition of ddl18.p1 for values in (2);
      create table ddl18.p2 partition of ddl18.p for values from (10) to (20);
      create foreign data wrapper ddl18_fdw;
      create server ddl18_srv foreign data wrapper ddl18_fdw options (host 'h');
      create foreign table ddl18.ft (id int not null, name text) server ddl18_srv options (schema_name 'remote', table_name 'it''s');
      comment on foreign table ddl18.ft is 'remote rows';`));
    afterAll(() => server.exec('drop schema ddl18 cascade; drop server ddl18_srv; drop foreign data wrapper ddl18_fdw;'));

    test('a partition that is partitioned itself says PARTITION BY, and its own partitions follow it', async () => {
      const ddl = await readDdl(session, 'ddl18', 'p');
      expect(ddl).toContain('\n) PARTITION BY RANGE (id);\n');
      expect(ddl).toContain('CREATE TABLE ddl18.p1 PARTITION OF ddl18.p FOR VALUES FROM (0) TO (10) PARTITION BY LIST (k);\n'
        + 'CREATE TABLE ddl18.p1a PARTITION OF ddl18.p1 FOR VALUES IN (1);\n'
        + 'CREATE TABLE ddl18.p1b PARTITION OF ddl18.p1 FOR VALUES IN (2);\n'
        + 'CREATE TABLE ddl18.p2 PARTITION OF ddl18.p FOR VALUES FROM (10) TO (20);');
      // Structure lists the table's own partitions, as before.
      expect((await readStructure(session, 'ddl18', 'p')).partitions.map((x) => x.name)).toEqual(['p1', 'p2']);
    });

    test('a foreign table: CREATE FOREIGN TABLE … SERVER … OPTIONS (…), its comment ON FOREIGN TABLE', async () => {
      const ddl = await readDdl(session, 'ddl18', 'ft');
      expect(ddl.startsWith("CREATE FOREIGN TABLE ddl18.ft (\n    id integer NOT NULL,\n    name text\n) SERVER ddl18_srv OPTIONS (schema_name 'remote', table_name 'it''s');\n")).toBe(true);
      expect(ddl).toContain("COMMENT ON FOREIGN TABLE ddl18.ft IS 'remote rows';");
    });

    test.each([['p', 'table'], ['ft', 'foreign table']] as const)('ddl18.%s: the DDL recreates it', async (name, kind) => {
      const ddl = await readDdl(session, 'ddl18', name);
      try {
        await server.exec(`begin; drop ${kind} ddl18.${name} cascade;\n${ddl}\nrollback;`);
      } finally {
        await server.exec('rollback;').catch(() => {});
      }
    });
  });

  // Runs each DDL on the server itself (setup access, not the read-only client), in a transaction rolled back: the
  // text recreates what it describes.
  test.each([
    ['public', 'orders', 'table'], ['public', 'Order "Items"', 'table'], ['public', 'measurements', 'table'],
    ['analytics', 'page_views', 'table'], ['public', 'paid_orders', 'view'], ['public', 'daily_revenue', 'materialized view']
  ] as const)('%s.%s: the DDL recreates it', async (schema, name, kind) => {
    const ddl = await readDdl(session, schema, name);
    const rel = `"${schema}"."${name.replace(/"/g, '""')}"`;
    try {
      await server.exec(`begin; drop ${kind} ${rel} cascade;\n${ddl}\nrollback;`);
    } finally {
      await server.exec('rollback;').catch(() => {});
    }
  });
});

describe('edge cases (a scratch schema)', () => {
  beforeAll(() => server.exec(`create schema edge;
    create type edge.mood as enum ('sad', 'ok', 'happy');
    create domain edge.tags_d as text[];
    create table edge.k (
      id serial, a int not null, b int, c int not null, d int not null, mood edge.mood[], tags edge.tags_d,
      twice int generated always as (a * 2) stored, plus_one int generated always as (a + 1) virtual
    );
    create unique index k_a on edge.k (a);
    create unique index k_a_again on edge.k (a);
    create unique index k_b_nullable on edge.k (b);
    create unique index k_c_partial on edge.k (c) where c > 0;
    create unique index k_cd_include on edge.k (c, d) include (b);
    create unique index k_expr on edge.k ((c + d));
    create unlogged table edge.u (id int);
    create table edge.p (id int primary key) partition by range (id);
    create table edge.p1 partition of edge.p for values from (0) to (10);
    create table edge.p2 partition of edge.p for values from (10) to (20);
    create table edge.ref (pid int references edge.p (id));
    create view edge.vec as select indexrelid, indkey, indclass from pg_catalog.pg_index;
    insert into edge.p values (1), (2), (11);
    analyze edge.p1;
    analyze edge.p2;`));
  afterAll(() => server.exec('drop schema edge cascade;'));

  test('unique keys: plain columns, all NOT NULL, not partial, INCLUDE columns left out, each once', async () => {
    const k = await readColumns(session, 'edge', 'k');
    expect(k?.pk).toEqual([]);
    expect(k?.uniqueKeys).toEqual([['a'], ['c', 'd']]);
  });

  test('serial, an enum array, a domain over an array, generated columns', async () => {
    const k = await readColumns(session, 'edge', 'k');
    const by = (name: string) => k?.columns.find((c) => c.name === name);
    expect(by('id')).toMatchObject({ isKey: true, default: "nextval('edge.k_id_seq'::regclass)" });
    expect(by('mood')).toMatchObject({ type: 'edge.mood[]', typeSchema: 'edge', typeName: 'mood', typeCat: 'E', isArray: true, enumValues: ['sad', 'ok', 'happy'] });
    expect(by('tags')).toMatchObject({ type: 'edge.tags_d', typeSchema: 'pg_catalog', typeName: 'text', typeCat: 'S', isArray: true });
    expect(by('twice')?.default).toBeUndefined();
    const st = await readStructure(session, 'edge', 'k');
    expect(st.columns.find((c) => c.name === 'twice')?.generated).toBe('(a * 2)');
    expect(st.columns.find((c) => c.name === 'plus_one')?.generated).toBe('(a + 1)');
    expect(st.columns.find((c) => c.name === 'a')?.generated).toBeNull();
    const ddl = await readDdl(session, 'edge', 'k');
    expect(ddl).toContain('    id serial NOT NULL,\n');
    expect(ddl).toContain('    twice integer GENERATED ALWAYS AS ((a * 2)) STORED,\n');
    expect(ddl).toContain('    plus_one integer GENERATED ALWAYS AS ((a + 1)) VIRTUAL\n');
    expect(ddl).toContain('CREATE UNIQUE INDEX k_cd_include ON edge.k USING btree (c, d) INCLUDE (b);');
  });

  test('int2vector and oidvector are not arrays (their typelem is no array element)', async () => {
    const vec = await readColumns(session, 'edge', 'vec');
    expect(vec?.columns.map(({ name, typeSchema, typeName, isArray }) => ({ name, typeSchema, typeName, isArray }))).toEqual([
      { name: 'indexrelid', typeSchema: 'pg_catalog', typeName: 'oid', isArray: false },
      { name: 'indkey', typeSchema: 'pg_catalog', typeName: 'int2vector', isArray: false },
      { name: 'indclass', typeSchema: 'pg_catalog', typeName: 'oidvector', isArray: false }
    ]);
  });

  test('a foreign key to a partitioned table counts once, not once per partition', async () => {
    const fk = { name: 'ref_pid_fkey', from: { schema: 'edge', table: 'ref', columns: ['pid'] }, to: { schema: 'edge', table: 'p', columns: ['id'] }, indexed: false };
    expect(await readRelations(session, 'edge', 'p')).toEqual({ out: [], in: [fk] });
    expect(await readRelations(session, 'edge', 'ref')).toEqual({ out: [fk], in: [] });
    expect((await readColumns(session, 'edge', 'ref'))?.columns[0]?.fk).toEqual({ schema: 'edge', table: 'p', column: 'id' });
  });

  test('the schema lists its own enums and tables, partitions hidden', async () => {
    const cat = await readCatalog(session, 'edge');
    expect(cat.rels.map((r) => r.name)).toEqual(['k', 'p', 'ref', 'u', 'vec']);
    // Only the partitions were analyzed: the parent's own estimate is unknown, theirs add up.
    expect(cat.rels.find((r) => r.name === 'p')).toMatchObject({ partitions: 2, estimate: 3 });
    expect(cat.rels.find((r) => r.name === 'u')?.estimate).toBeNull();
    expect(cat.enums).toEqual([{ schema: 'edge', name: 'mood', values: ['sad', 'ok', 'happy'] }]);
    expect((await readDdl(session, 'edge', 'u')).startsWith('CREATE UNLOGGED TABLE edge.u (\n')).toBe(true);
  });

  test.each(['k', 'u', 'p'])('edge.%s: the DDL recreates it', async (name) => {
    const ddl = await readDdl(session, 'edge', name);
    try {
      await server.exec(`begin; drop table edge.${name} cascade;\n${ddl}\nrollback;`);
    } finally {
      await server.exec('rollback;').catch(() => {});
    }
  });
});

describe('older servers', () => {
  const NEWER = ['relispartition', 'relpartbound', 'pg_get_partkeydef', 'attidentity', 'attgenerated', 'conparentid', 'indnkeyatts', 'prokind'];
  const textOf = (log: Stmt[]) => log.map((s) => s.text).join('\n');

  async function readAll(s: DbSession): Promise<void> {
    await readCatalog(s, null);
    await readColumns(s, 'public', 'orders');
    await readStructure(s, 'public', 'measurements');
    await readStructure(s, 'public', 'orders');
    await readRelations(s, 'public', 'orders');
    await readDdl(s, 'public', 'orders');
    await readFunctionDef(s, 'public', 'order_total', 'bigint');
  }

  test('9.6: none of the newer catalog columns; the statements still run', async () => {
    const log: Stmt[] = [];
    await readAll(recording(db, log, 90600));
    const text = textOf(log);
    for (const word of NEWER) expect(text, word).not.toContain(word);
    // Without relispartition, partitions are listed as tables (9.6 has none to hide).
    expect((await readCatalog(recording(db, [], 90600), null)).rels.some((r) => r.name === 'measurements_2026_10')).toBe(true);
  });

  test('10 and 11: partitions and identity from 10, INCLUDE-aware keys and prokind from 11, generated columns from 12', async () => {
    const v10: Stmt[] = [];
    await readAll(recording(db, v10, 100000));
    for (const word of ['relispartition', 'relpartbound', 'pg_get_partkeydef', 'attidentity']) expect(textOf(v10), word).toContain(word);
    for (const word of ['attgenerated', 'conparentid', 'indnkeyatts', 'prokind']) expect(textOf(v10), word).not.toContain(word);
    const v11: Stmt[] = [];
    await readAll(recording(db, v11, 110000));
    for (const word of ['conparentid', 'indnkeyatts', 'prokind']) expect(textOf(v11), word).toContain(word);
    expect(textOf(v11)).not.toContain('attgenerated');
    const v12: Stmt[] = [];
    await readAll(recording(db, v12, 120000));
    expect(textOf(v12)).toContain('attgenerated');
  });

  test('the version is asked once per session; readServerInfo answers it', async () => {
    const log: Stmt[] = [];
    const s = recording(db, log);
    await readServerInfo(s, Date.now());
    await readAll(s);
    expect(log.filter((st) => st.shape === 'cat.version')).toEqual([]);
    const fresh: Stmt[] = [];
    const t = recording(db, fresh);
    await readAll(t);
    expect(fresh.filter((st) => st.shape === 'cat.version')).toHaveLength(1);
  });
});

// A relation never analyzed (reltuples -1; before Postgres 14, 0 rows in 0 pages) counts its live rows from
// the statistics (pg_stat_user_tables.n_live_tup: inserts and deletes move it, no ANALYZE needed); "—" (null) only
// when both say nothing. PGlite keeps n_live_tup (its statistics flush once the backend is idle: asked again until then).
describe('row estimates without ANALYZE', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  beforeAll(async () => {
    for (const st of [
      'create schema r118',
      'create table r118.fresh_rows (id int primary key)',
      'insert into r118.fresh_rows select g from generate_series(1, 37) g',
      'create table r118.never_filled (id int)',
      'create table r118.parts (id int, k int) partition by range (k)',
      'create table r118.parts_a partition of r118.parts for values from (0) to (10)',
      'create table r118.parts_b partition of r118.parts for values from (10) to (20)',
      'insert into r118.parts select g, g % 20 from generate_series(1, 60) g',
      'select pg_catalog.pg_stat_force_next_flush()'
    ]) await server.exec(st);
  });
  afterAll(async () => { await server.exec('drop schema r118 cascade'); });

  /** The schema's catalog once the statistics have reached the server's views. */
  async function settled(): Promise<Awaited<ReturnType<typeof readCatalog>>> {
    for (let i = 0; i < 60; i++) {
      const cat = await readCatalog(session, 'r118');
      if ((cat.rels.find((r) => r.name === 'fresh_rows')?.estimate ?? null) !== null) return cat;
      await sleep(100);
    }
    return readCatalog(session, 'r118');
  }

  test('the sidebar: a table filled without ANALYZE shows its live rows; one never filled, "—"; a partitioned one sums its partitions so', async () => {
    const rels = (await settled()).rels;
    expect(rels.find((r) => r.name === 'fresh_rows')).toEqual({ schema: 'r118', name: 'fresh_rows', kind: 'table', estimate: 37 });
    expect(rels.find((r) => r.name === 'never_filled')).toEqual({ schema: 'r118', name: 'never_filled', kind: 'table', estimate: null });
    expect(rels.find((r) => r.name === 'parts')).toEqual({ schema: 'r118', name: 'parts', kind: 'table', estimate: 60, partitions: 2 });
  });

  test('the table tab\'s "~N rows" and Structure\'s estimate read the same', async () => {
    await settled();
    expect((await readColumns(session, 'r118', 'fresh_rows'))?.estimate).toBe(37);
    expect((await readColumns(session, 'r118', 'never_filled'))?.estimate).toBeNull();
    expect((await readStructure(session, 'r118', 'parts')).stats.estimate).toBe(60);
  });

  test('the statement: unknown is a negative reltuples from 14, also 0 rows in 0 pages before; the live rows from pg_stat_user_tables', async () => {
    const lists = async (version: number) => {
      const log: Stmt[] = [];
      await readCatalog(recording(db, log, version), 'r118');
      return log.find((s) => s.shape === 'cat.lists')!.text;
    };
    const v16 = await lists(160000);
    const v13 = await lists(130000);
    for (const t of [v16, v13]) {
      expect(t).toContain('pg_catalog.pg_stat_user_tables');
      expect(t).toContain('n_live_tup');
    }
    expect(v13).toContain('c.reltuples = 0 AND c.relpages = 0');
    expect(v16).not.toContain('c.reltuples = 0 AND c.relpages = 0');
  });

  test('analyzed, the statistics\' own count wins: rows deleted since still read as analyzed until the next ANALYZE', async () => {
    await settled();
    await server.exec('analyze r118.fresh_rows');
    await server.exec('delete from r118.fresh_rows where id > 30');
    await server.exec('select pg_catalog.pg_stat_force_next_flush()');
    await sleep(300);
    expect((await readCatalog(session, 'r118')).rels.find((r) => r.name === 'fresh_rows')?.estimate).toBe(37);
  });
});

test('every catalog statement is a cat.* shape with its names as $n parameters', () => {
  expect(ran.length).toBeGreaterThan(10);
  for (const st of ran) {
    expect(st.shape).toMatch(/^cat\./);
    expect(st.text).not.toContain('orders');
    expect(st.text).not.toContain('Order');
  }
});

// The databases hub (src/main/databases/hub.ts) against a real Postgres (PGlite behind the test proxy, asking for a
// password) through the real driver: windows and their project, which connections each window sees, one shared session
// per connection opened on demand and closed when idle, passwords through a Map-backed secret store (never in a
// snapshot or a reply), snapshots per window, reads through DbQueries, a lost
// connection reconnected once.
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  EMPTY_DB_SNAPSHOT, type DbConnectionForm, type DbConnView, type DbPageRequest, type DbProblem, type DbResult, type DbSnapshot,
  type DbTableRef
} from '../../src/shared/databases';
import { DbError, type DbConnectConfig, type DbDriver, type DbRows, type DbSession, type Stmt, type Tunnel, type TunnelFactory } from '../../src/main/databases/driver';
import { DB_CHANNELS, DB_TIMING, DbHub, type DbHubWindow, type DbSettings, type SecretsLike } from '../../src/main/databases/hub';
import { postgresDriver } from '../../src/main/databases/postgres/client';
import { createDbStore, type DbStore } from '../../src/main/databases/store';
import { PgServer } from '../support/pg-server';

const A = '/code/acme';
const B = '/code/beta';
/** The server's password: distinctive, so a search for it in what the hub sends can't match anything else. */
const SECRET = 'Zq9-atelier-s3cret-pw';

let server: PgServer;
let hub: DbHub | null = null;
beforeAll(async () => { server = await PgServer.start({ password: SECRET }); });
afterAll(async () => { await server?.stop(); });
afterEach(() => { hub?.dispose(); hub = null; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

interface FakeWindow extends DbHubWindow { sent: { ch: string; p: unknown }[]; last(): DbSnapshot | undefined; destroy(): void }
function win(id: number): FakeWindow {
  const sent: { ch: string; p: unknown }[] = [];
  const gone: (() => void)[] = [];
  let destroyed = false;
  return {
    id, sent,
    send: (ch, p) => { sent.push({ ch, p }); },
    isDestroyed: () => destroyed,
    once: (_e, fn) => { gone.push(fn); },
    last: () => [...sent].reverse().find((x) => x.ch === DB_CHANNELS.snapshot)?.p as DbSnapshot | undefined,
    destroy: () => { destroyed = true; for (const f of gone) f(); }
  };
}

interface Counting extends DbDriver {
  connects: number;
  sessions: DbSession[];
  configs: DbConnectConfig[];
  /** Fails this many of the next reads (never the server read at connect) as a dropped link does: the client closes. */
  lose: number;
  /** Refuses this many of the next connects, as a server that is down does (counted in `connects` all the same). */
  refuse: number;
  /** While set, reads wait for it before they reach the server; `held` counts the ones that waited. */
  hold: Promise<void> | null;
  held: number;
  /** Every statement that reached the server, in order. */
  ran: Stmt[];
}
/** The real driver, counting connects and keeping every session (to see which are closed). */
function counting(): Counting {
  const d: Counting = {
    connects: 0, sessions: [], configs: [], lose: 0, refuse: 0, hold: null, held: 0, ran: [],
    async connect(cfg: DbConnectConfig): Promise<DbSession> {
      d.connects++;
      d.configs.push(cfg);
      if (d.refuse > 0) { d.refuse--; throw new DbError({ kind: 'refused', message: 'Nothing answers on that port' }); }
      const inner = await postgresDriver.connect(cfg);
      const s: DbSession = {
        async run(st: Stmt): Promise<DbRows> {
          if (st.shape !== 'cat.server') {
            if (d.hold) { d.held++; await d.hold; }
            if (d.lose > 0) { d.lose--; inner.close(); throw new DbError({ kind: 'lost', message: 'Reconnecting…' }); }
          }
          d.ran.push(st);
          return inner.run(st);
        },
        close: () => inner.close(),
        get closed() { return inner.closed; },
        get tlsActive() { return inner.tlsActive; }
      };
      d.sessions.push(s);
      return s;
    }
  };
  return d;
}

interface Setup {
  store: DbStore;
  home: string;
  secrets: Map<string, string>;
  settings: DbSettings;
  driver: ReturnType<typeof counting>;
  /** Every reply the test recorded with rec(). */
  replies: unknown[];
  rec<T>(p: Promise<T> | T): Promise<T>;
}
function setup(o: {
  secrets?: SecretsLike | null; tunnel?: TunnelFactory; settings?: Partial<DbSettings>; store?: (s: DbStore) => DbStore; timing?: Partial<typeof DB_TIMING>;
} = {}): Setup {
  const home = mkdtempSync(join(tmpdir(), 'atl-dbhub-'));
  const real = createDbStore(home);
  const store = o.store ? o.store(real) : real;
  const secrets = new Map<string, string>();
  const settings: DbSettings = { showDatabases: 'auto', dbTimeoutSec: 15, ...o.settings };
  const driver = counting();
  const replies: unknown[] = [];
  hub = new DbHub({
    settings: () => settings, store, driver,
    secrets: o.secrets !== undefined ? o.secrets : { read: (id) => secrets.get(id) ?? null, write: (id, v) => { secrets.set(id, v); }, remove: (id) => { secrets.delete(id); } },
    ...(o.tunnel ? { tunnel: o.tunnel } : {}),
    timing: { idleCloseMs: 50, overviewMs: 1000, ...o.timing }
  });
  return { store, home, secrets, settings, driver, replies, rec: async (p) => { const v = await p; replies.push(v); return v; } };
}

const form = (o: Partial<DbConnectionForm> = {}): DbConnectionForm => ({
  name: 'acme', engine: 'postgres', env: 'local', host: '127.0.0.1', port: server.port, database: 'postgres', user: 'postgres', tls: 'off',
  ssh: null, scope: { kind: 'project', root: A }, ...o
});
const ref = (connId: string, name: string, schema = 'public'): DbTableRef => ({ connId, schema, name });
const req = (connId: string, name: string): DbPageRequest => ({ ref: ref(connId, name), columns: [], derived: [], filters: [], sort: [], page: 0, size: 5 });
function ok<T>(r: DbResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.problem.kind}: ${r.problem.message}`);
  return r.value;
}
const view = (s: DbSnapshot | undefined, id: string): DbConnView | undefined => s?.connections.find((c) => c.conn.id === id);
/** Opens a window on a project and waits for its first snapshot. */
async function opened(root: string, id = 1): Promise<FakeWindow> {
  const w = win(id);
  hub!.open(root, w);
  await until(() => w.last() !== undefined);
  return w;
}
const UNKNOWN = { ok: false, problem: { kind: 'other', message: 'Unknown connection' } };
const KEYCHAIN_WARNING = "The Keychain refused the password: it's kept until you quit.";
const NEW_SERVER = { ok: false, problem: { kind: 'password', message: 'Type the password for the new server' } };

describe('DbHub', () => {
  test('a window sees its project\'s connections and the every-project ones, never another project\'s; a request on those contacts nothing', async () => {
    const h = setup();
    const wa = await opened(A, 1);
    const wb = await opened(B, 2);
    const a = ok(await hub!.save(1, { form: form({ name: 'mine' }), password: SECRET, id: null })).id;
    const all = ok(await hub!.save(1, { form: form({ name: 'shared', scope: { kind: 'all' } }), password: SECRET, id: null })).id;
    const b = ok(await hub!.save(2, { form: form({ name: 'theirs', scope: { kind: 'project', root: B } }), password: SECRET, id: null })).id;
    await until(() => wa.last()!.connections.length === 2 && wb.last()!.connections.length === 2);
    expect(wa.last()!.connections.map((c) => c.conn.name)).toEqual(['mine', 'shared']);
    expect(wb.last()!.connections.map((c) => c.conn.name)).toEqual(['shared', 'theirs']);
    expect(hub!.snapshotFor(1).connections.map((c) => c.conn.id)).toEqual([a, all]);
    expect(hub!.snapshotFor(99)).toEqual(EMPTY_DB_SNAPSHOT);

    await server.clearLog();
    const r = ref(b, 'orders');
    const asked: unknown[] = [
      await hub!.page(1, req(b, 'orders')), await hub!.estimate(1, { ref: r, filters: [] }), await hub!.count(1, { ref: r, filters: [] }),
      await hub!.peek(1, { ref: r, cols: ['id'], values: ['1'] }), await hub!.refs(1, { ref: r, key: { id: '1' } }),
      await hub!.full(1, { ref: r, key: { id: '1' }, column: 'id' }), await hub!.structure(1, r), await hub!.relations(1, r), await hub!.ddl(1, r),
      await hub!.ddl(1, { connId: b, schema: 'public', name: 'order_total', args: 'bigint' }),
      await hub!.overview(1, b), await hub!.connect(1, b), await hub!.password(1, { connId: b, password: SECRET, save: true }),
      hub!.readOnlySql(1, b), hub!.duplicate(1, b), await hub!.test(1, { form: form(), password: null, id: b }),
      await hub!.save(1, { form: form({ name: 'stolen' }), password: null, id: b })
    ];
    for (const x of asked) expect(x).toEqual(UNKNOWN);
    // Requests that answer nothing change nothing either.
    await hub!.select(1, b);
    hub!.setMask(1, b, true);
    hub!.noteWrite(1, b);
    await hub!.setSchema(1, b, 'analytics');
    hub!.disconnect(1, b);
    hub!.remove(1, b);
    expect(h.store.get(b)).toMatchObject({ name: 'theirs', mask: false, writeNoted: false, scope: { kind: 'project', root: B } });
    expect(h.store.get(b)!.schema).toBeUndefined();
    expect(h.store.pick(A)).toBeNull();
    expect(h.secrets.get(`db-${b}`)).toBe(SECRET);
    expect(h.driver.connects).toBe(0);
    expect((await server.statementsLog()).filter((l) => l !== 'ROLLBACK')).toEqual([]);
  });

  test('save, then select: connected, with the server version and the catalog; reads answer', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    expect(id).toMatch(/^c[0-9a-f]{12}$/);
    await until(() => view(w.last(), id)?.state === 'idle');
    expect(view(w.last(), id)).toMatchObject({ hasPassword: true, server: null, problem: null, provider: null });
    expect(h.store.get(id)).toMatchObject({ name: 'acme', mask: false, writeNoted: false, scope: { kind: 'project', root: A } });

    await hub!.select(1, id);
    await until(() => w.last()?.catalog?.rels.some((r) => r.name === 'orders') === true);
    const s = w.last()!;
    expect(s.selected).toBe(id);
    expect(h.store.pick(A)).toBe(id);
    expect(view(s, id)).toMatchObject({ state: 'connected', problem: null, server: { role: 'postgres', canWrite: true } });
    expect(view(s, id)!.server!.versionNum).toBeGreaterThanOrEqual(180000);
    expect(view(s, id)!.server!.version).toMatch(/^18/);
    expect(s.catalog).toMatchObject({ connId: id, schema: 'public' });
    expect(s.catalog!.schemas).toContain('analytics');
    // Every schema's relations by name, whichever schema the sidebar shows (the palette's tables).
    expect(s.catalog!.names).toContainEqual({ schema: 'analytics', name: 'page_views', kind: 'table' });
    expect(s.catalog!.namesMore).toBe(false);

    const page = ok(await hub!.page(1, req(id, 'orders')));
    expect(page.rows).toHaveLength(5);
    expect(ok(await hub!.count(1, { ref: ref(id, 'orders'), filters: [] }))).toBeGreaterThan(5);
    expect(ok(await hub!.ddl(1, ref(id, 'orders')))).toContain('CREATE TABLE');
    expect(ok(await hub!.ddl(1, { connId: id, schema: 'public', name: 'order_total', args: 'bigint' }))).toContain('CREATE OR REPLACE FUNCTION public.order_total');
    expect(ok(await hub!.structure(1, ref(id, 'orders'))).name).toBe('orders');
    expect(await hub!.page(1, req(id, 'no_such_table'))).toMatchObject({ ok: false, problem: { kind: 'unknown-table' } });
    expect(h.driver.connects).toBe(1);
    expect(h.driver.configs[0]).toMatchObject({ host: '127.0.0.1', port: server.port, database: 'postgres', user: 'postgres', tls: 'off', timeoutSec: 15 });
  });

  test('the password never reaches a snapshot or a reply', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await h.rec(hub!.save(1, { form: form(), password: SECRET, id: null }))).id;
    await h.rec(hub!.select(1, id));
    await h.rec(hub!.test(1, { form: form(), password: null, id }));
    await h.rec(hub!.test(1, { form: form(), password: SECRET, id: null }));
    await h.rec(hub!.test(1, { form: form(), password: 'nope', id: null }));
    await h.rec(hub!.password(1, { connId: id, password: SECRET, save: false }));
    await h.rec(hub!.page(1, req(id, 'orders')));
    await h.rec(hub!.structure(1, ref(id, 'customers')));
    await h.rec(hub!.overview(1, id));
    await h.rec(hub!.duplicate(1, id));
    await h.rec(hub!.readOnlySql(1, id));
    await until(() => w.last()!.connections.length === 2);
    h.replies.push(hub!.snapshotFor(1));
    expect(w.sent.length).toBeGreaterThan(3);
    const all = JSON.stringify(w.sent) + JSON.stringify(h.replies);
    expect(all).toContain(String(server.port));
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/password":"/);
  });

  test('a wrong password: state password (auth); password() with save connects and keeps it; without save, for this run only', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: 'wrong', id: null })).id;
    await hub!.select(1, id);
    await until(() => view(w.last(), id)?.state === 'password');
    expect(view(w.last(), id)).toMatchObject({ problem: { kind: 'auth', message: 'Wrong user or password' }, hasPassword: true, server: null });
    expect(w.last()!.catalog).toBeNull();
    // A read doesn't try the known-bad password again.
    expect(await hub!.page(1, req(id, 'orders'))).toMatchObject({ ok: false, problem: { kind: 'auth' } });
    expect(h.driver.connects).toBe(1);

    expect(await hub!.password(1, { connId: id, password: 'still wrong', save: true })).toMatchObject({ ok: false, problem: { kind: 'auth' } });
    expect(h.secrets.get(`db-${id}`)).toBe('wrong');
    expect(ok(await hub!.password(1, { connId: id, password: SECRET, save: true }))).toMatchObject({ role: 'postgres' });
    await until(() => view(w.last(), id)?.state === 'connected' && w.last()!.catalog !== null);
    expect(h.secrets.get(`db-${id}`)).toBe(SECRET);

    // save:false: the Keychain keeps what it had, the password works until quit.
    const other = ok(await hub!.save(1, { form: form({ name: 'other' }), password: null, id: null })).id;
    expect(view(hub!.snapshotFor(1), other)!.hasPassword).toBe(false);
    expect(await hub!.connect(1, other)).toMatchObject({ ok: false, problem: { kind: 'password', message: 'Needs a password' } });
    expect(view(hub!.snapshotFor(1), other)!.state).toBe('password');
    ok(await hub!.password(1, { connId: other, password: SECRET, save: false }));
    expect(h.secrets.has(`db-${other}`)).toBe(false);
    expect(view(hub!.snapshotFor(1), other)).toMatchObject({ state: 'connected', hasPassword: true });
    hub!.disconnect(1, other);
    expect(view(hub!.snapshotFor(1), other)).toMatchObject({ state: 'idle', server: null });
    ok(await hub!.connect(1, other));
  });

  test('a password the Keychain can\'t read counts as none; no Keychain at all keeps passwords for this run', async () => {
    const h = setup({ secrets: { read: () => { throw new Error('SecretUnreadable'); }, write: () => { throw new Error('SecretUnavailable'); }, remove: () => {} } });
    await opened(A);
    const saved = await hub!.save(1, { form: form(), password: null, id: null });
    expect(saved).not.toHaveProperty('warning'); // nothing to keep, nothing refused
    const id = ok(saved).id;
    expect(view(hub!.snapshotFor(1), id)!.hasPassword).toBe(false);
    expect(await hub!.connect(1, id)).toMatchObject({ ok: false, problem: { kind: 'password' } });
    // The Keychain refuses the write: the password still works until quit, and the reply says so.
    const typed = await hub!.password(1, { connId: id, password: SECRET, save: true });
    expect(typed).toMatchObject({ ok: true, warning: KEYCHAIN_WARNING });
    hub!.disconnect(1, id);
    ok(await hub!.connect(1, id));
    expect(h.driver.connects).toBe(3);
    expect(await hub!.save(1, { form: form({ name: 'renamed' }), password: SECRET, id })).toEqual({ ok: true, value: { id }, warning: KEYCHAIN_WARNING });
    // Not asked to save: nothing refused, no warning.
    expect(await hub!.password(1, { connId: id, password: SECRET, save: false })).not.toHaveProperty('warning');
    hub!.dispose();

    setup({ secrets: null });
    await opened(A);
    const kept = await hub!.save(1, { form: form(), password: SECRET, id: null });
    expect(kept).toMatchObject({ ok: true, warning: KEYCHAIN_WARNING });
    const id2 = ok(kept).id;
    expect(view(hub!.snapshotFor(1), id2)!.hasPassword).toBe(true);
    ok(await hub!.connect(1, id2));
    hub!.dispose();

    // A Keychain that keeps it: no warning.
    setup();
    await opened(A);
    expect(await hub!.save(1, { form: form(), password: SECRET, id: null })).not.toHaveProperty('warning');
  });

  test('remove deletes the entry, its secret and its pick, and closes its session', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    await until(() => view(w.last(), id)?.state === 'connected');
    hub!.remove(1, id);
    expect(h.store.get(id)).toBeNull();
    expect(createDbStore(h.home).get(id)).toBeNull();
    expect(h.secrets.has(`db-${id}`)).toBe(false);
    expect(h.store.pick(A)).toBeNull();
    await until(() => w.last()!.connections.length === 0);
    expect(w.last()).toMatchObject({ selected: null, catalog: null });
    expect(h.driver.sessions[0]!.closed).toBe(true);
    expect(await hub!.page(1, req(id, 'orders'))).toEqual(UNKNOWN);
  });

  test('duplicate copies the settings and the secret, named " copy"', async () => {
    const h = setup();
    await opened(A);
    const id = ok(await hub!.save(1, { form: form({ name: 'acme', env: 'prod', scope: { kind: 'all' } }), password: SECRET, id: null })).id;
    hub!.setMask(1, id, true);
    const dup = ok(hub!.duplicate(1, id)).id;
    expect(dup).not.toBe(id);
    expect(h.store.get(dup)).toMatchObject({ name: 'acme copy', env: 'prod', mask: true, scope: { kind: 'all' }, host: '127.0.0.1', port: server.port });
    expect(h.secrets.get(`db-${dup}`)).toBe(SECRET);
    expect(hub!.snapshotFor(1).connections.map((c) => c.conn.name)).toEqual(['acme', 'acme copy']);
    ok(await hub!.connect(1, dup));
    // A long name stays within the 120 characters a name may have.
    const long = ok(await hub!.save(1, { form: form({ name: 'x'.repeat(120) }), password: null, id: null })).id;
    expect(h.store.get(ok(hub!.duplicate(1, long)).id)!.name).toBe('x'.repeat(115) + ' copy');
  });

  test('an unselected connection closes idleCloseMs after its last use; a selected one stays; a read reopens on demand', async () => {
    const h = setup();
    const w = await opened(A);
    const kept = ok(await hub!.save(1, { form: form({ name: 'kept' }), password: SECRET, id: null })).id;
    const used = ok(await hub!.save(1, { form: form({ name: 'used' }), password: SECRET, id: null })).id;
    await hub!.select(1, kept);
    ok(await hub!.connect(1, used));
    expect(view(hub!.snapshotFor(1), used)!.state).toBe('connected');
    await until(() => view(w.last(), used)?.state === 'idle', 2000);
    expect(h.driver.sessions[1]!.closed).toBe(true);
    await sleep(120);
    expect(view(w.last(), kept)!.state).toBe('connected');
    expect(h.driver.sessions[0]!.closed).toBe(false);
    ok(await hub!.page(1, req(used, 'orders')));
    expect(h.driver.connects).toBe(3);
    // Selecting another one lets the first go too.
    await hub!.select(1, used);
    await until(() => view(w.last(), kept)?.state === 'idle', 2000);
    expect(h.driver.sessions[0]!.closed).toBe(true);
    // A closed window no longer keeps its selection's session.
    w.destroy();
    await until(() => h.driver.sessions[2]!.closed, 2000);
  });

  test('the idle close waits for a request in progress on an unselected connection', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    ok(await hub!.connect(1, id)); // not selected: the idle timer runs from here
    let release!: () => void;
    h.driver.hold = new Promise<void>((r) => { release = r; });
    const p = hub!.page(1, req(id, 'orders'));
    await until(() => h.driver.held === 1);
    await sleep(150); // three idle periods
    expect(h.driver.sessions[0]!.closed).toBe(false);
    expect(view(hub!.snapshotFor(1), id)!.state).toBe('connected');
    h.driver.hold = null;
    release();
    expect(ok(await p).rows).toHaveLength(5);
    // Once it is done, the idle close comes.
    await until(() => view(w.last(), id)?.state === 'idle', 2000);
    expect(h.driver.sessions[0]!.closed).toBe(true);
    expect(h.driver.connects).toBe(1);
  });

  test('setMask, noteWrite and setSchema persist; setSchema and refresh read the catalog again', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    hub!.setMask(1, id, true);
    hub!.noteWrite(1, id);
    expect(createDbStore(h.home).get(id)).toMatchObject({ mask: true, writeNoted: true });
    await until(() => view(w.last(), id)?.conn.mask === true && view(w.last(), id)?.conn.writeNoted === true);
    hub!.setMask(1, id, false);
    expect(createDbStore(h.home).get(id)!.mask).toBe(false);

    await hub!.select(1, id);
    await until(() => w.last()?.catalog?.schema === 'public');
    await hub!.setSchema(1, id, 'analytics');
    expect(createDbStore(h.home).get(id)!.schema).toBe('analytics');
    await until(() => w.last()?.catalog?.schema === 'analytics');
    const readAt = w.last()!.catalog!.readAt;
    await sleep(5);
    await hub!.refresh(1);
    await until(() => (w.last()?.catalog?.readAt ?? 0) > readAt);
    expect(w.last()!.catalog!.schema).toBe('analytics');
  });

  test('the catalog names its database and the server\'s; another database on the same server keeps the password, drops the schema pick', async () => {
    await server.exec('create database other');
    try {
      const h = setup();
      const w = await opened(A);
      const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
      await hub!.select(1, id);
      await until(() => w.last()?.catalog?.schema === 'public');
      expect(w.last()!.catalog).toMatchObject({ database: 'postgres', databases: ['other', 'postgres'], noRels: false });
      await hub!.setSchema(1, id, 'analytics');
      await until(() => w.last()?.catalog?.schema === 'analytics');
      // The database chip's switch: the exact form with another database, the password field left empty.
      ok(await hub!.save(1, { form: form({ database: 'other' }), password: null, id }));
      expect(h.store.get(id)).toMatchObject({ database: 'other' });
      expect(h.store.get(id)!.schema).toBeUndefined();
      expect(h.secrets.get(`db-${id}`)).toBe(SECRET);
      // The session pointed at the old database: closed, its catalog gone with it.
      expect(view(w.last(), id)).toMatchObject({ state: 'idle', problem: null });
      expect(w.last()!.catalog).toBeNull();
      ok(await hub!.connect(1, id));
      await until(() => w.last()?.catalog?.database === 'other');
      expect(h.driver.configs.at(-1)).toMatchObject({ database: 'other', password: SECRET });
      // The new database's default schema (PGlite serves one world whatever the name asked).
      expect(w.last()!.catalog!.schema).toBe('public');
      // Same database, another name or schema pick: the pick stays.
      await hub!.setSchema(1, id, 'analytics');
      ok(await hub!.save(1, { form: form({ database: 'other', name: 'renamed' }), password: null, id }));
      expect(h.store.get(id)!.schema).toBe('analytics');
    } finally {
      await server.exec('drop database other');
    }
  });

  test('editing keeps the id and the saved password; a changed endpoint closes the session', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    await until(() => view(w.last(), id)?.state === 'connected');
    hub!.noteWrite(1, id);
    expect(ok(await hub!.save(1, { form: form({ name: 'renamed', env: 'dev' }), password: null, id }))).toEqual({ id });
    expect(h.store.get(id)).toMatchObject({ name: 'renamed', env: 'dev', writeNoted: true });
    expect(view(hub!.snapshotFor(1), id)!.state).toBe('connected');
    expect(h.secrets.get(`db-${id}`)).toBe(SECRET);
    // The write note is about the role on its server: another database of it (the chip's switch) keeps it dismissed.
    ok(await hub!.save(1, { form: form({ name: 'renamed', env: 'dev', database: 'shop' }), password: null, id }));
    expect(h.store.get(id)).toMatchObject({ database: 'shop', writeNoted: true });
    ok(await hub!.save(1, { form: form({ name: 'renamed', env: 'dev' }), password: null, id }));
    expect(h.store.get(id)).toMatchObject({ database: 'postgres', writeNoted: true });
    // Another user, host, port or SSH hop: another role somewhere — the note shows again.
    expect(ok(await hub!.save(1, { form: form({ name: 'renamed', user: 'reader' }), password: null, id }))).toEqual({ id });
    expect(h.store.get(id)).toMatchObject({ user: 'reader', writeNoted: false });
    expect(view(hub!.snapshotFor(1), id)).toMatchObject({ state: 'idle', server: null });
    expect(h.driver.sessions[0]!.closed).toBe(true);
    for (const other of [form({ host: 'localhost' }), form({ port: 1 }), form({ ssh: { host: 'bastion', port: null, user: '' } })]) {
      hub!.noteWrite(1, id);
      ok(await hub!.save(1, { form: other, password: null, id }));
      expect(h.store.get(id)!.writeNoted, JSON.stringify(other)).toBe(false);
    }
    expect(await hub!.save(1, { form: form({ user: '' }), password: null, id })).toMatchObject({ ok: false, problem: { kind: 'other' } });
    expect(await hub!.save(1, { form: form({ host: '', port: 5432 }), password: null, id: null })).toMatchObject({ ok: false, problem: { kind: 'other' } });
    expect(h.store.list()).toHaveLength(1);
  });

  test('a password typed in Edit Connection replaces a refused one: the next read tries it', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: 'wrong', id: null })).id;
    await hub!.select(1, id);
    await until(() => view(w.last(), id)?.state === 'password');
    ok(await hub!.save(1, { form: form(), password: SECRET, id }));
    expect(view(hub!.snapshotFor(1), id)).toMatchObject({ state: 'idle', problem: null });
    expect(ok(await hub!.page(1, req(id, 'orders'))).rows).toHaveLength(5);
    expect(h.secrets.get(`db-${id}`)).toBe(SECRET);
  });

  test('a saved password only goes back to the server it was typed for; an empty field keeps it', async () => {
    const h = setup();
    await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    // Editing, the field left empty ('' as null): the saved password, same server.
    ok(await hub!.test(1, { form: form({ name: 'x' }), password: '', id }));
    ok(await hub!.test(1, { form: form({ database: 'acme', user: 'postgres' }), password: null, id }));
    // Another server (host, port, socket, SSH or TLS): asked for, nothing contacted.
    await server.clearLog();
    const connects = h.driver.connects;
    for (const other of [form({ host: 'localhost' }), form({ port: server.port + 1 }), form({ tls: 'require' }), form({ socket: '/tmp/pg' }), form({ ssh: { host: 'b', port: 22, user: 'me' } })]) {
      expect(await hub!.test(1, { form: other, password: null, id })).toEqual(NEW_SERVER);
      expect(await hub!.test(1, { form: other, password: '', id })).toEqual(NEW_SERVER);
    }
    expect(h.driver.connects).toBe(connects);
    expect((await server.statementsLog()).filter((l) => l !== 'ROLLBACK')).toEqual([]);
    // Typed for the new server: used.
    expect(await hub!.test(1, { form: form({ tls: 'prefer' }), password: SECRET, id })).toMatchObject({ ok: true });

    // Saved with only the database changed and no password: kept, and it connects.
    ok(await hub!.save(1, { form: form({ database: 'acme' }), password: '', id }));
    expect(h.secrets.get(`db-${id}`)).toBe(SECRET);
    expect(view(hub!.snapshotFor(1), id)!.hasPassword).toBe(true);
    ok(await hub!.connect(1, id));

    // Saved pointing at another port with no password: the old one goes (Keychain and memory), asked for again.
    ok(await hub!.password(1, { connId: id, password: SECRET, save: false }));
    ok(await hub!.save(1, { form: form({ database: 'acme', port: 1 }), password: null, id }));
    expect(h.secrets.has(`db-${id}`)).toBe(false);
    expect(view(hub!.snapshotFor(1), id)).toMatchObject({ hasPassword: false, state: 'password', problem: { kind: 'password', message: 'Type the password for the new server' } });
    // A read doesn't contact the new server with nothing to give it.
    expect(await hub!.page(1, req(id, 'orders'))).toMatchObject({ ok: false, problem: { kind: 'password' } });
    expect(h.driver.connects).toBe(connects + 3); // test(), connect(), password()
    // Back to the first server, still nothing typed: the password isn't coming back by itself.
    ok(await hub!.save(1, { form: form({ database: 'acme' }), password: null, id }));
    expect(view(hub!.snapshotFor(1), id)!.hasPassword).toBe(false);
    expect(await hub!.connect(1, id)).toMatchObject({ ok: false, problem: { kind: 'password' } });
  });

  test('Show Databases Never closes every session and shows nothing; Auto again shows the connections', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    await until(() => view(w.last(), id)?.state === 'connected');

    h.settings.showDatabases = 'never';
    hub!.settingsChanged();
    await until(() => w.last()!.connections.length === 0);
    expect(w.last()).toEqual(EMPTY_DB_SNAPSHOT);
    expect(h.driver.sessions.every((s) => s.closed)).toBe(true);
    await hub!.refresh(1);
    expect(await hub!.page(1, req(id, 'orders'))).toMatchObject({ ok: false });
    await hub!.select(1, id);
    expect(await hub!.connect(1, id)).toMatchObject({ ok: false });
    expect(h.driver.connects).toBe(1);

    h.settings.showDatabases = 'auto';
    hub!.settingsChanged();
    await until(() => w.last()!.connections.length === 1);
  });

  test('two windows share one session, whatever their project', async () => {
    const h = setup();
    const w1 = await opened(A, 1);
    const w2 = await opened(B, 2);
    const w3 = await opened(A, 3);
    const id = ok(await hub!.save(1, { form: form({ scope: { kind: 'all' } }), password: SECRET, id: null })).id;
    await Promise.all([hub!.select(1, id), hub!.select(2, id)]);
    const pages = await Promise.all([hub!.page(1, req(id, 'orders')), hub!.page(2, req(id, 'customers')), hub!.page(3, req(id, 'orders'))]);
    for (const p of pages) ok(p);
    expect(h.driver.connects).toBe(1);
    for (const w of [w1, w2, w3]) await until(() => w.last()?.selected === id && view(w.last(), id)?.state === 'connected' && w.last()!.catalog !== null);
  });

  test('a connection lost while browsing: one reconnect, the read retried once; the hub never retries what it closed', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    await until(() => view(w.last(), id)?.state === 'connected' && w.last()!.catalog !== null);
    // The server restarts.
    await server.terminate();
    const from = w.sent.length;
    expect(ok(await hub!.page(1, req(id, 'orders'))).rows).toHaveLength(5);
    expect(h.driver.connects).toBe(2);
    expect(view(w.last(), id)!.state).toBe('connected');
    // The window saw it reconnect, and its catalog stayed while it did.
    const during = w.sent.slice(from).map((x) => x.p as DbSnapshot);
    expect(during.map((s) => view(s, id)!.state)).toEqual(['connecting', 'connected']);
    expect(during.every((s) => s.catalog?.connId === id)).toBe(true);
    // The link drops under a read the session thought it could send: reconnected, the read tried again.
    h.driver.lose = 1;
    expect(ok(await hub!.page(1, req(id, 'customers'))).rows).toHaveLength(5);
    expect(h.driver.connects).toBe(3);
    // Lost again on the second try: the problem comes back, once.
    h.driver.lose = 2;
    expect(await hub!.page(1, req(id, 'payments'))).toEqual({ ok: false, problem: { kind: 'lost', message: 'The connection was lost' } });
    expect(h.driver.connects).toBe(4);
    ok(await hub!.page(1, req(id, 'payments')));
    expect(h.driver.connects).toBe(5);

    // Disconnected while a read is on its way: that read fails, nothing reconnects.
    let release!: () => void;
    h.driver.hold = new Promise<void>((r) => { release = r; });
    const p = hub!.page(1, req(id, 'shipments'));
    await until(() => h.driver.held === 1);
    hub!.disconnect(1, id);
    h.driver.hold = null;
    release();
    expect(await p).toEqual({ ok: false, problem: { kind: 'other', message: 'Disconnected' } });
    expect(h.driver.connects).toBe(5);
    expect(view(hub!.snapshotFor(1), id)!.state).toBe('idle');
  });

  test('the selected connection\'s catalog is read whatever opens its session: a read first (a tab restored at launch), a read after a failed reconnect', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    const catalogReads = () => h.driver.ran.filter((s) => s.shape === 'cat.schemas').length;
    // Launch: the pick is the last run's and nothing connected it yet; a table tab restored with its space reads first.
    h.store.setPick(A, id);
    ok(await hub!.page(1, req(id, 'orders')));
    await until(() => w.last()?.catalog?.connId === id);
    expect(view(w.last(), id)).toMatchObject({ state: 'connected', problem: null });
    // The view's own connect then finds it there: no second session, no second read of the catalog.
    ok(await hub!.connect(1, id));
    expect(h.driver.connects).toBe(1);
    expect(catalogReads()).toBe(1);

    // The server goes away: the reconnect fails and drops the catalog; the next read reconnects and brings it back.
    await server.terminate();
    h.driver.refuse = 1;
    expect(await hub!.page(1, req(id, 'customers'))).toMatchObject({ ok: false, problem: { kind: 'refused' } });
    expect(w.last()!.catalog).toBeNull();
    ok(await hub!.page(1, req(id, 'customers')));
    await until(() => w.last()?.catalog?.connId === id);
    expect(view(w.last(), id)).toMatchObject({ state: 'connected', problem: null });
    expect(catalogReads()).toBe(2);
  });

  test('test() connects with the form, reports the server and closes; it saves nothing', async () => {
    const h = setup();
    await opened(A);
    const info = ok(await hub!.test(1, { form: form(), password: SECRET, id: null }));
    expect(info).toMatchObject({ role: 'postgres', canWrite: true, tls: false });
    expect(info.versionNum).toBeGreaterThanOrEqual(180000);
    expect(h.store.list()).toEqual([]);
    expect(h.secrets.size).toBe(0);
    expect(h.driver.sessions[0]!.closed).toBe(true);
    expect(await hub!.test(1, { form: form(), password: 'nope', id: null })).toMatchObject({ ok: false, problem: { kind: 'auth' } });
    expect(await hub!.test(1, { form: form({ port: 1 }), password: SECRET, id: null })).toMatchObject({ ok: false, problem: { kind: 'refused' } });
    // Editing: an empty password field uses the saved one.
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    ok(await hub!.test(1, { form: form({ name: 'edited' }), password: null, id }));
    expect(h.store.get(id)!.name).toBe('acme');
    // A form the file would refuse is refused before anything is contacted.
    const connects = h.driver.connects;
    expect(await hub!.test(1, { form: form({ user: '' }), password: SECRET, id: null })).toMatchObject({ ok: false, problem: { kind: 'other' } });
    expect(h.driver.connects).toBe(connects);
    expect(h.driver.sessions.every((s) => s.closed)).toBe(true);
  });

  test('SSH: without a tunnel factory the connect fails with kind ssh; with one, it goes through the tunnel and closes it', async () => {
    const ssh = { host: 'bastion.example.com', port: 22, user: 'me' };
    const h = setup();
    await opened(A);
    const id = ok(await hub!.save(1, { form: form({ ssh, host: 'db.internal', port: 5432 }), password: SECRET, id: null })).id;
    expect(await hub!.connect(1, id)).toEqual({ ok: false, problem: { kind: 'ssh', message: "SSH tunnels aren't available" } });
    expect(view(hub!.snapshotFor(1), id)!.state).toBe('error');
    expect(h.driver.connects).toBe(0);
    hub!.dispose();

    const tunnels: { ssh: unknown; target: unknown; t: Tunnel }[] = [];
    const tunnel: TunnelFactory = async (s, target) => {
      const t = { localPort: server.port, closed: false, close() { t.closed = true; }, lastError: async () => null };
      tunnels.push({ ssh: s, target, t });
      return t;
    };
    const h2 = setup({ tunnel });
    await opened(A);
    const id2 = ok(await hub!.save(1, { form: form({ ssh, host: 'db.internal', port: 5432 }), password: SECRET, id: null })).id;
    ok(await hub!.connect(1, id2));
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0]).toMatchObject({ ssh, target: { host: 'db.internal', port: 5432 } });
    // TLS through the tunnel still names the real server (SNI, the certificate check).
    expect(h2.driver.configs[0]).toMatchObject({ host: '127.0.0.1', port: server.port, servername: 'db.internal' });
    expect(tunnels[0]!.t.closed).toBe(false);
    hub!.disconnect(1, id2);
    expect(tunnels[0]!.t.closed).toBe(true);
    // A target given as an IP address: no servername (never an IP in SNI); without ssh, none either (host is the name).
    const ip = ok(await hub!.save(1, { form: form({ name: 'by ip', ssh, host: '10.1.2.3', port: 5432 }), password: SECRET, id: null })).id;
    ok(await hub!.connect(1, ip));
    expect(h2.driver.configs.at(-1)).toMatchObject({ host: '127.0.0.1' });
    expect(h2.driver.configs.at(-1)).not.toHaveProperty('servername');
    hub!.disconnect(1, ip);
    const direct = ok(await hub!.save(1, { form: form({ name: 'direct', host: 'localhost' }), password: SECRET, id: null })).id;
    ok(await hub!.connect(1, direct));
    expect(h2.driver.configs.at(-1)).toMatchObject({ host: 'localhost' });
    expect(h2.driver.configs.at(-1)).not.toHaveProperty('servername');
    hub!.disconnect(1, direct);
    const tunnelsSoFar = tunnels.length;
    // A connect that fails closes its tunnel too.
    ok(await hub!.save(1, { form: form({ ssh, host: 'db.internal', port: 5432 }), password: 'nope', id: id2 }));
    expect(await hub!.connect(1, id2)).toMatchObject({ ok: false, problem: { kind: 'auth' } });
    expect(tunnels).toHaveLength(tunnelsSoFar + 1);
    expect(tunnels.every((t) => t.t.closed)).toBe(true);
  });

  test('SSH: a connect error names the real target, never the tunnel\'s 127.0.0.1:<local>; a channel ssh could not open is kind ssh', async () => {
    const ssh = { host: 'bastion.example.com', port: 22, user: 'me' };
    // A local port nothing listens on: the client's connect is refused there.
    const closed = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
    });
    let why: string | null = null;
    const made: Tunnel[] = [];
    const tunnel: TunnelFactory = async () => {
      const t = { localPort: closed, closed: false, close() { t.closed = true; }, lastError: async () => why };
      made.push(t);
      return t;
    };
    setup({ tunnel });
    await opened(A);
    const id = ok(await hub!.save(1, { form: form({ ssh, host: 'db.internal', port: 6543 }), password: SECRET, id: null })).id;
    const r = await hub!.connect(1, id);
    expect(r).toMatchObject({ ok: false, problem: { kind: 'refused', message: "Can't connect · connection refused db.internal:6543" } });
    expect(JSON.stringify(r)).not.toContain('127.0.0.1');
    // Test Connection says the same.
    expect(await hub!.test(1, { form: form({ ssh, host: 'db.internal', port: 6543 }), password: SECRET, id: null }))
      .toMatchObject({ ok: false, problem: { kind: 'refused', message: "Can't connect · connection refused db.internal:6543" } });
    // ssh said why it couldn't forward the connection: that, naming the target as the bastion sees it.
    why = 'connect failed: Connection refused';
    expect(await hub!.connect(1, id)).toEqual({ ok: false, problem: { kind: 'ssh', message: "The bastion couldn't reach db.internal:6543: connect failed: Connection refused" } });
    expect(made.every((t) => t.closed)).toBe(true);
  });

  test('through a tunnel only 127.0.0.1:<local> is the tunnel\'s — a certificate\'s own 127.0.0.1 stays; the password is hidden before anything is rewritten', async () => {
    const ssh = { host: 'bastion.example.com', port: 22, user: 'me' };
    const LOCAL = 6000;
    // A password that holds the tunnel's own address: rewritten first, it would no longer be found to hide.
    const PW = `Zq9-127.0.0.1:${LOCAL}-pw`;
    let next: DbProblem = { kind: 'other', message: 'x' };
    const h = setup();
    hub!.dispose();
    hub = new DbHub({
      settings: () => h.settings, store: h.store, secrets: null,
      driver: { connect: async () => { throw new DbError(next); } },
      tunnel: async () => ({ localPort: LOCAL, closed: false, close() {}, lastError: async () => null }),
      timing: { idleCloseMs: 50 }
    });
    await opened(A);
    const id = ok(await hub.save(1, { form: form({ ssh, host: 'db.internal', port: 6543 }), password: PW, id: null })).id;
    const tried = async (p: DbProblem) => { next = p; return hub!.connect(1, id); };
    // The client's own words for the address it dialled: the real target.
    expect(await tried({ kind: 'refused', message: `Can't connect · connection refused 127.0.0.1:${LOCAL}`, hint: 'Is Postgres running?' }))
      .toEqual({ ok: false, problem: { kind: 'refused', message: "Can't connect · connection refused db.internal:6543", hint: 'Is Postgres running?' } });
    expect(await tried({ kind: 'timeout', message: 'No answer from 127.0.0.1 in 8 s' })).toMatchObject({ problem: { message: 'No answer from db.internal in 8 s' } });
    // A certificate's detail is the certificate's: its 127.0.0.1 is not the tunnel's.
    const detail = "Hostname/IP does not match certificate's altnames: IP: 127.0.0.1 is not in the cert's list: 10.0.0.5";
    expect(await tried({ kind: 'cert', message: "The certificate isn't trusted (issued for another host)", detail }))
      .toEqual({ ok: false, problem: { kind: 'cert', message: "The certificate isn't trusted (issued for another host)", detail } });
    // The server repeating the password (belt and braces): hidden whole, never half-rewritten.
    const r = await tried({ kind: 'other', message: `password authentication failed for "${PW}"`, detail: `127.0.0.1:${LOCAL} said ${PW}` });
    expect(JSON.stringify(r)).not.toContain('Zq9');
    expect(r).toEqual({ ok: false, problem: { kind: 'other', message: 'password authentication failed for "••••"', detail: 'db.internal:6543 said ••••' } });
  });

  test('SSH: a tunnel that opens after dispose (a connect or a Test Connection in flight) is closed, and nothing is contacted', async () => {
    const ssh = { host: 'bastion.example.com', port: 22, user: 'me' };
    const pending: (() => void)[] = [];
    const made: Tunnel[] = [];
    const tunnel: TunnelFactory = () => new Promise((resolve) => {
      pending.push(() => {
        const t = { localPort: server.port, closed: false, close() { t.closed = true; }, lastError: async () => null };
        made.push(t);
        resolve(t);
      });
    });
    const h = setup({ tunnel });
    await opened(A);
    const id = ok(await hub!.save(1, { form: form({ ssh, host: 'db.internal', port: 5432 }), password: SECRET, id: null })).id;
    const connecting = hub!.connect(1, id);
    const testing = hub!.test(1, { form: form({ ssh, host: 'db.internal', port: 5432 }), password: SECRET, id: null });
    await until(() => pending.length === 2);
    hub!.dispose();
    for (const open of pending) open();
    expect(await connecting).toMatchObject({ ok: false });
    expect(await testing).toMatchObject({ ok: false });
    expect(made).toHaveLength(2);
    expect(made.every((t) => t.closed)).toBe(true);
    expect(h.driver.connects).toBe(0);
  });

  test('overview: read through the session, shared by requests within overviewMs; the read-only role script for the server', async () => {
    setup();
    await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    expect(hub!.readOnlySql(1, id)).toMatchObject({ ok: false, problem: { kind: 'other' } });
    const [o1, o2] = await Promise.all([hub!.overview(1, id), hub!.overview(1, id)]);
    expect(ok(o1).server.role).toBe('postgres');
    expect(ok(o2).at).toBe(ok(o1).at);
    expect(ok(await hub!.overview(1, id)).at).toBe(ok(o1).at);
    const sql = ok(hub!.readOnlySql(1, id));
    expect(sql).toContain('CREATE ROLE "atelier_readonly" LOGIN;');
    expect(sql).toContain('GRANT pg_read_all_data TO "atelier_readonly";');
  });

  test('nothing is looked for — a window\'s first snapshot comes at once and holds its connections, its pick and the catalog; Refresh reads the catalog only', async () => {
    const h = setup();
    const w = win(1);
    hub!.open(A, w);
    // Synchronously: no discovery to wait for.
    expect(w.last()).toEqual({ connections: [], selected: null, catalog: null });
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    await until(() => w.last()?.catalog?.schema === 'public');
    expect(Object.keys(w.last()!).sort()).toEqual(['catalog', 'connections', 'selected']);
    // The hub has nothing to rediscover on focus or Docker changes.
    expect('onFocus' in hub!).toBe(false);
    expect('sourcesChanged' in hub!).toBe(false);
    expect('addSuggestion' in hub!).toBe(false);
    const readAt = w.last()!.catalog!.readAt;
    const before = h.driver.connects;
    await sleep(5);
    await hub!.refresh(1);
    expect(w.last()!.catalog!.readAt).toBeGreaterThan(readAt);
    expect(h.driver.connects).toBe(before);
    expect(h.driver.ran.filter((s) => s.shape === 'cat.schemas').length).toBeGreaterThanOrEqual(2);
  });

  test('a query timeout change replaces a session once nothing uses it, never under a read in progress', async () => {
    const h = setup();
    await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    let release!: () => void;
    h.driver.hold = new Promise<void>((r) => { release = r; });
    const held = hub!.page(1, req(id, 'orders'));
    await until(() => h.driver.held === 1);
    h.settings.dbTimeoutSec = 30;
    hub!.settingsChanged();
    // Another read meanwhile waits for it (one request at a time per connection).
    const also = hub!.page(1, req(id, 'customers'));
    await sleep(30);
    expect(h.driver.held).toBe(1);
    h.driver.hold = null;
    release();
    // The read in progress ends on its session; the one after it, nothing else in progress, gets the new timeout.
    expect(ok(await held).rows).toHaveLength(5);
    expect(ok(await also).rows).toHaveLength(5);
    expect(h.driver.connects).toBe(2);
    expect(h.driver.configs[1]!.timeoutSec).toBe(30);
    expect(h.driver.sessions[0]!.closed).toBe(true);
    // The next read keeps that session.
    ok(await hub!.page(1, req(id, 'payments')));
    expect(h.driver.connects).toBe(2);
  });

  test('an explicit Disconnect holds the connection in every window until one connects it; nothing reads it meanwhile', async () => {
    const h = setup();
    const wa = await opened(A, 1);
    const wb = await opened(A, 2);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    await until(() => view(wb.last(), id)?.state === 'connected');
    expect(view(wa.last(), id)?.held).toBe(false);
    hub!.disconnect(1, id);
    expect(view(hub!.snapshotFor(1), id)).toMatchObject({ state: 'idle', held: true });
    await until(() => view(wb.last(), id)?.held === true);
    const connects = h.driver.connects;
    // B shows a table tab of it (its first-show read) or its overview: a calm "held", nothing contacted.
    const HELD = { ok: false, problem: { kind: 'held', message: 'Disconnected' } };
    const r = ref(id, 'orders');
    const asked = [
      await hub!.page(2, req(id, 'orders')), await hub!.estimate(2, { ref: r, filters: [] }), await hub!.count(2, { ref: r, filters: [] }),
      await hub!.peek(2, { ref: r, cols: ['id'], values: ['1'] }), await hub!.refs(2, { ref: r, key: { id: '1' } }),
      await hub!.full(2, { ref: r, key: { id: '1' }, column: 'id' }), await hub!.structure(2, r), await hub!.relations(2, r), await hub!.ddl(2, r),
      await hub!.overview(2, id)
    ];
    for (const x of asked) expect(x).toEqual(HELD);
    expect(h.driver.connects).toBe(connects);
    // B selects it (a click on its row): released for every window, connected again.
    await hub!.select(2, id);
    await until(() => view(wa.last(), id)?.held === false && view(wa.last(), id)?.state === 'connected');
    ok(await hub!.page(1, req(id, 'orders')));
    // Connect and a typed password release it too.
    hub!.disconnect(2, id);
    await until(() => view(wa.last(), id)?.held === true);
    ok(await hub!.connect(1, id));
    expect(view(hub!.snapshotFor(2), id)?.held).toBe(false);
    hub!.disconnect(1, id);
    ok(await hub!.password(2, { connId: id, password: SECRET, save: false }));
    expect(view(hub!.snapshotFor(1), id)?.held).toBe(false);
    // Kept for this run of the app only: never in the connections file.
    hub!.disconnect(1, id);
    expect(readFileSync(join(h.home, 'databases.json'), 'utf8')).not.toContain('held');
    // An idle close isn't a Disconnect: the next read reconnects as before.
    await hub!.connect(1, id);
    await hub!.select(1, null);
    await until(() => view(wa.last(), id)?.state === 'idle', 2000);
    expect(view(wa.last(), id)?.held).toBe(false);
    ok(await hub!.page(2, req(id, 'orders')));
  });

  test('a read waiting behind another when Disconnect comes answers "held" when its turn comes, and reconnects nothing', async () => {
    const h = setup();
    await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    let release!: () => void;
    h.driver.hold = new Promise<void>((r) => { release = r; });
    const first = hub!.page(1, req(id, 'orders'));
    await until(() => h.driver.held === 1);
    const waiting = hub!.page(1, req(id, 'customers'));
    hub!.disconnect(1, id);
    h.driver.hold = null;
    release();
    expect(await first).toEqual({ ok: false, problem: { kind: 'other', message: 'Disconnected' } });
    expect(await waiting).toEqual({ ok: false, problem: { kind: 'held', message: 'Disconnected' } });
    expect(h.driver.connects).toBe(1);
  });

  test('one request at a time per connection; a page, estimate or count not started yet is dropped when a newer one for its slot comes', async () => {
    const h = setup();
    await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    await until(() => hub!.snapshotFor(1).catalog !== null);
    let release!: () => void;
    h.driver.hold = new Promise<void>((r) => { release = r; });
    // A read holds the session.
    const busy = hub!.count(1, { ref: ref(id, 'customers'), filters: [] });
    await until(() => h.driver.held === 1);
    const SUPERSEDED = { ok: false, problem: { kind: 'canceled', message: 'Superseded' } };
    const p1 = hub!.page(1, { ...req(id, 'orders'), slot: 'db:orders' });
    const p2 = hub!.page(1, { ...req(id, 'orders'), page: 1, slot: 'db:orders' });
    // The same tab's estimate is another request (its own slot of the kind), and another tab's page is its own.
    const estimate = hub!.estimate(1, { ref: ref(id, 'orders'), filters: [], slot: 'db:orders' });
    const other = hub!.page(1, { ...req(id, 'customers'), slot: 'db:customers' });
    const unslotted = hub!.page(1, req(id, 'payments'));
    const p3 = hub!.page(1, { ...req(id, 'orders'), page: 2, slot: 'db:orders' });
    // The superseded ones answer at once, before anything of theirs is read.
    expect(await p1).toEqual(SUPERSEDED);
    expect(await p2).toEqual(SUPERSEDED);
    expect(h.driver.held).toBe(1);
    h.driver.hold = null;
    release();
    ok(await busy);
    expect(ok(await p3).rows).toHaveLength(5);
    expect(ok(await estimate)).toBeGreaterThan(0);
    ok(await other);
    ok(await unslotted);
    // One page of orders reached the server: the third (OFFSET 10 for pages of 5).
    const orders = h.driver.ran.filter((s) => s.shape === 'page' && s.text.includes('"public"."orders"'));
    expect(orders.map((s) => s.values.at(-1))).toEqual([10]);
    // A request that started is never dropped: it answers, and the renderer drops a stale reply by its id.
    h.driver.hold = new Promise<void>((r) => { release = r; });
    const started = hub!.page(1, { ...req(id, 'orders'), slot: 'db:orders' });
    await until(() => h.driver.held === 2);
    const newer = hub!.page(1, { ...req(id, 'orders'), page: 1, slot: 'db:orders' });
    h.driver.hold = null;
    release();
    ok(await started);
    ok(await newer);
  });

  test('a slot is a window\'s — the same table open in another window (the same tab key) never drops this one\'s page', async () => {
    const h = setup();
    await opened(A, 1);
    await opened(A, 2);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    let release!: () => void;
    h.driver.hold = new Promise<void>((r) => { release = r; });
    const busy = hub!.count(1, { ref: ref(id, 'customers'), filters: [] });
    await until(() => h.driver.held === 1);
    const mine = hub!.page(1, { ...req(id, 'orders'), slot: 'db:orders' });
    const theirs = hub!.page(2, { ...req(id, 'orders'), page: 1, slot: 'db:orders' });
    h.driver.hold = null;
    release();
    ok(await busy);
    expect(ok(await mine).rows).toHaveLength(5);
    expect(ok(await theirs).rows).toHaveLength(5);
  });

  test('hasPassword asks the Keychain whether one is saved without decrypting it, when the store can say', async () => {
    const reads: string[] = [];
    const saved = new Map<string, string>();
    const h = setup({
      secrets: {
        read: (id) => { reads.push(id); return saved.get(id) ?? null; }, write: (id, v) => { saved.set(id, v); }, remove: (id) => { saved.delete(id); },
        has: (id) => saved.has(id)
      }
    });
    // Saved by an earlier run of the app: the connection in the file, its password in the Keychain.
    const id = 'c0123456789ab';
    h.store.put({
      id, name: 'acme', engine: 'postgres', env: 'local', host: '127.0.0.1', port: server.port, database: 'postgres', user: 'postgres', tls: 'off',
      ssh: null, scope: { kind: 'project', root: A }, mask: false, writeNoted: false, createdAt: 1
    });
    saved.set(`db-${id}`, SECRET);
    await opened(A);
    const other = ok(await hub!.save(1, { form: form({ name: 'other' }), password: null, id: null })).id;
    expect(view(hub!.snapshotFor(1), id)?.hasPassword).toBe(true);
    expect(view(hub!.snapshotFor(1), other)?.hasPassword).toBe(false);
    expect(reads).toEqual([]);
    // Connecting reads it, of course.
    ok(await hub!.connect(1, id));
    expect(reads).toEqual([`db-${id}`]);
    expect(h.driver.configs.at(-1)?.password).toBe(SECRET);
  });

  test('a selection the file can\'t keep still selects and connects (logged once)', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
    try {
      setup({ store: (s) => ({ ...s, setPick: () => { throw new Error('disk full'); } }) });
      await opened(A);
      const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
      await expect(hub!.select(1, id)).resolves.toBeUndefined();
      await expect(hub!.select(1, null)).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(String((errors[0] as unknown[]).join(' '))).toContain('disk full');
    } finally {
      spy.mockRestore();
    }
  });

  test('after dispose, requests answer "Disconnected" and nothing connects', async () => {
    const h = setup();
    const w = await opened(A);
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    await hub!.select(1, id);
    await until(() => view(w.last(), id)?.state === 'connected');
    hub!.dispose();
    expect(h.driver.sessions[0]!.closed).toBe(true);
    const gone = { ok: false, problem: { kind: 'other', message: 'Disconnected' } };
    expect(await hub!.page(1, req(id, 'orders'))).toEqual(gone);
    expect(await hub!.connect(1, id)).toEqual(gone);
    expect(await hub!.overview(1, id)).toEqual(gone);
    expect(await hub!.password(1, { connId: id, password: SECRET, save: false })).toEqual(gone);
    expect(await hub!.test(1, { form: form(), password: SECRET, id: null })).toEqual(gone);
    await hub!.select(1, id);
    await hub!.refresh(1);
    expect(h.driver.connects).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DbSnapshot } from '@shared/databases';
import { compileWorld } from '../compile/index';
import { createClock } from '../engine/clock';
import { CONNECT_MS, OVERVIEW_IDLE_MS, TX_MAX, TX_MIN } from '../engine/databases';
import { instantOf } from '../engine/databases-rows';
import { ACME_DB } from '../world/databases-conn';
import { acmeDatabase } from '../world/databases';
import { createDatabases } from './databases';
import { createDemo } from './index';

// `window.atelier.databases` in the live demo: the acme-store's Postgres as
// one saved connection, selected; nothing loads before the visitor connects (the engine and its world are a chunk of
// their own); then main's DbHub as the view sees it — connect, the catalog, Disconnect's hold, the schema chip, Mask,
// Refresh, every read, the overview ticking on the demo clock — and the actions that need the Mac say so.

const compiled = compileWorld();
let now = 0;
beforeEach(() => { vi.useFakeTimers(); now = compiled.t0 + 86_400_000; });
afterEach(() => { vi.useRealTimers(); });
const make = () => createDemo(compiled, { version: '0.0.0-test', now: () => now, clock: createClock() });
const advance = async (ms: number) => { for (let t = 0; t < ms; t += 50) { now += 50; await vi.advanceTimersByTimeAsync(50); } };
const ID = ACME_DB.id;
const ref = { connId: ID, schema: 'public', name: 'orders' };
const page = { ref, columns: [], derived: [], filters: [], sort: [], page: 0, size: 100 };
/** Settles a call that waits on the demo clock (connecting takes CONNECT_MS). */
const settle = async <T>(p: Promise<T>): Promise<T> => { await advance(CONNECT_MS + 100); return p; };

describe('startup', () => {
  test('one saved connection, selected and idle (the view connects it when shown); nothing looked for', async () => {
    const { api } = make();
    const snap = await api.databases.snapshot();
    expect(snap).toEqual({ selected: ID, catalog: null, connections: snap.connections });
    expect(snap.connections).toHaveLength(1);
    expect(snap.connections[0]).toMatchObject({
      conn: { id: ID, name: 'acme', engine: 'postgres', env: 'local', host: '127.0.0.1', port: 5432, database: 'acme', user: 'acme', ssh: null, mask: false, scope: { kind: 'project', root: compiled.project.root } },
      state: 'idle', problem: null, server: null, hasPassword: true, provider: null, held: false
    });
  });

  test('nothing of the engine loads before a connect or a read: the snapshot is answered without it', async () => {
    const { context } = make();
    const load = vi.fn(() => Promise.reject(new Error('not yet')));
    const dbs = createDatabases(context, { load });
    await dbs.snapshot();
    expect(load).not.toHaveBeenCalled();
    await expect(dbs.connect(ID)).rejects.toThrow('not yet');
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('connecting', () => {
  test('connect: connecting, then connected with the server and the catalog, every step a snapshot event', async () => {
    const { api } = make();
    const seen: DbSnapshot[] = [];
    api.on.databases((s) => seen.push(s));
    const r = await settle(api.databases.connect(ID));
    expect(r).toEqual({ ok: true, value: { version: '16.4', versionNum: 160004, tls: false, role: 'acme', canWrite: false, latencyMs: expect.any(Number) } });
    expect(seen.map((s) => s.connections[0]!.state)).toEqual(['connecting', 'connected']);
    expect(seen.at(-1)!.catalog).toMatchObject({ connId: ID, schema: 'public', schemas: ['public', 'analytics'] });
    expect(seen.at(-1)!.catalog!.rels.map((r) => r.name)).toContain('webhook_events');
    expect((await api.databases.snapshot()).connections[0]!.server?.role).toBe('acme');
  });

  test('the database is placed at the demo\'s start: however late the view opens, its ages agree with Redis and Docker', async () => {
    const start = now;
    const { api } = make();
    // Ten minutes in the demo before the visitor opens Databases.
    await advance(10 * 60_000);
    await settle(api.databases.connect(ID));
    const r = await api.databases.page({ ...page, filters: [{ column: 'id', op: 'eq', values: ['10442'] }] });
    if (!r.ok) throw new Error(r.problem.message);
    const created = instantOf(r.value.rows[0]![r.value.columns.findIndex((c) => c.name === 'created_at')]!.v!)! / 1000;
    // The Redis stream's order.created 10442: twenty seconds before the start, not before the view opened.
    expect(start - created).toBeGreaterThanOrEqual(20_000);
    expect(start - created).toBeLessThan(21_000);
    const o = await api.databases.overview(ID);
    if (!o.ok) throw new Error(o.problem.message);
    expect(o.value.uptimeSec).toBe(acmeDatabase(start).overview.uptimeSec + Math.floor((now - start) / 1000));
  });

  test('a read on an idle connection connects it first (a read the user caused), then answers', async () => {
    const { api } = make();
    const r = await settle(api.databases.page(page));
    expect(r.ok && r.value.rows.length).toBe(100);
    expect((await api.databases.snapshot()).connections[0]!.state).toBe('connected');
  });

  test('Disconnect holds it: reads say so and contact nothing, until a select (or Connect) lets it go', async () => {
    const { api } = make();
    await settle(api.databases.connect(ID));
    await api.databases.disconnect(ID);
    const held = await api.databases.snapshot();
    expect(held.connections[0]).toMatchObject({ state: 'idle', held: true, server: null });
    expect(held.catalog).toBeNull();
    expect(await api.databases.page(page)).toEqual({ ok: false, problem: { kind: 'held', message: 'Disconnected' } });
    expect(await api.databases.overview(ID)).toEqual({ ok: false, problem: { kind: 'held', message: 'Disconnected' } });
    await settle(api.databases.select(ID));
    expect((await api.databases.snapshot()).connections[0]).toMatchObject({ state: 'connected', held: false });
    expect((await api.databases.page(page)).ok).toBe(true);
  });

  test('select none: nothing selected, no catalog; an unknown connection is refused', async () => {
    const { api } = make();
    await settle(api.databases.connect(ID));
    await api.databases.select(null);
    expect(await api.databases.snapshot()).toMatchObject({ selected: null, catalog: null });
    expect(await api.databases.connect('c000000000000')).toEqual({ ok: false, problem: { kind: 'other', message: 'Unknown connection' } });
    expect(await api.databases.page({ ...page, ref: { ...ref, connId: 'c000000000000' } })).toEqual({ ok: false, problem: { kind: 'other', message: 'Unknown connection' } });
  });

  test('the schema chip, Mask values, Refresh: remembered on the connection, the catalog read again', async () => {
    const { api } = make();
    await settle(api.databases.connect(ID));
    await api.databases.setSchema(ID, 'analytics');
    let snap = await api.databases.snapshot();
    expect(snap.connections[0]!.conn.schema).toBe('analytics');
    expect(snap.catalog).toMatchObject({ schema: 'analytics', rels: [{ name: 'daily_revenue' }] });
    await api.databases.setMask(ID, true);
    expect((await api.databases.snapshot()).connections[0]!.conn.mask).toBe(true);
    const before = (await api.databases.snapshot()).catalog!.readAt;
    now += 5000;
    await api.databases.refresh();
    snap = await api.databases.snapshot();
    expect(snap.catalog!.readAt).toBeGreaterThan(before);
    expect(snap.catalog!.schema).toBe('analytics');
  });
});

describe('reads through the bridge', () => {
  test('every read answers in DbResult form; a refusal is a problem, never a throw', async () => {
    const { api } = make();
    await settle(api.databases.connect(ID));
    expect(await api.databases.estimate({ ref, filters: [] })).toMatchObject({ ok: true, value: expect.any(Number) });
    expect(await api.databases.count({ ref, filters: [{ column: 'status', op: 'in', values: ['failed'] }] })).toMatchObject({ ok: true });
    expect(await api.databases.peek({ ref: { ...ref, name: 'customers' }, cols: ['id'], values: ['4021'] })).toMatchObject({ ok: true, value: { row: expect.any(Array) } });
    expect(await api.databases.refs({ ref, key: { id: '10442' } })).toMatchObject({ ok: true });
    expect(await api.databases.full({ ref, key: { id: '10442' }, column: 'total' })).toEqual({ ok: true, value: '54.00' });
    expect(await api.databases.structure(ref)).toMatchObject({ ok: true, value: { name: 'orders' } });
    expect(await api.databases.relations(ref)).toMatchObject({ ok: true, value: { out: [expect.anything()] } });
    expect(await api.databases.ddl(ref)).toMatchObject({ ok: true, value: expect.stringMatching(/^CREATE TABLE public\.orders/) });
    expect(await api.databases.page({ ...page, ref: { ...ref, name: 'nope' } })).toEqual({ ok: false, problem: { kind: 'unknown-table', message: 'No table or view public.nope' } });
  });

  test('Copy SQL for a Read-only Role: the script for the server, once connected', async () => {
    const { api } = make();
    expect(await api.databases.readOnlySql(ID)).toEqual({ ok: false, problem: { kind: 'other', message: 'Connect first: the script depends on the server version' } });
    await settle(api.databases.connect(ID));
    const r = await api.databases.readOnlySql(ID);
    expect(r.ok && r.value).toContain('GRANT pg_read_all_data TO "atelier_readonly";');
  });
});

describe('the overview', () => {
  test('ticks on the demo clock: transactions count up, the reporting query runs longer, our own session is there', async () => {
    const { api } = make();
    await settle(api.databases.connect(ID));
    const a = await api.databases.overview(ID);
    if (!a.ok) throw new Error(a.problem.message);
    expect(a.value).toMatchObject({ server: { role: 'acme', canWrite: false }, connections: { max: 100 }, extensions: expect.arrayContaining([{ name: 'plpgsql', version: '1.0' }]) });
    expect(a.value.activity.filter((x) => x.ours)).toEqual([expect.objectContaining({ app: 'atelier', state: 'active' })]);
    expect(a.value.connections.total).toBe(a.value.activity.length);
    expect(a.value.biggest.length).toBeGreaterThan(0);
    expect(a.value.biggest.map((b) => b.bytes)).toEqual([...a.value.biggest.map((b) => b.bytes)].sort((x, y) => y - x));
    await advance(5000);
    const b = await api.databases.overview(ID);
    if (!b.ok) throw new Error(b.problem.message);
    expect(b.value.xacts).toBeGreaterThan(a.value.xacts);
    expect(b.value.at).toBeGreaterThan(a.value.at);
    expect(b.value.longest!.seconds).toBeGreaterThan(a.value.longest!.seconds);
  });

  test('costs nothing when nobody looks: the tick stops a while after the last read', async () => {
    const { api } = make();
    await settle(api.databases.connect(ID));
    const a = await api.databases.overview(ID);
    // A minute with nobody reading: the counter moved for OVERVIEW_IDLE_MS at most (at most TX_MAX a second), never
    // for the whole minute (at least TX_MIN a second).
    await advance(60_000);
    const b = await api.databases.overview(ID);
    if (!a.ok || !b.ok) throw new Error('no overview');
    const moved = b.value.xacts - a.value.xacts;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(TX_MAX * (OVERVIEW_IDLE_MS / 1000 + 1));
    expect(moved).toBeLessThan(TX_MIN * 60);
  });
});

describe('what needs the Mac', () => {
  test('Add, Edit, Test, a password, Duplicate: "Runs on your Mac"; Remove keeps it', async () => {
    const { api } = make();
    const mac = { ok: false, problem: { kind: 'other', message: 'Runs on your Mac' } };
    const form = { name: 'x', engine: 'postgres' as const, env: 'local' as const, host: 'localhost', port: 5432, database: 'x', user: 'x', tls: 'prefer' as const, ssh: null, scope: { kind: 'all' as const } };
    expect(await api.databases.save({ form, password: null, id: null })).toEqual(mac);
    expect(await api.databases.save({ form, password: null, id: ID })).toEqual(mac);
    expect(await api.databases.test({ form, password: null, id: null })).toEqual(mac);
    expect(await api.databases.password({ connId: ID, password: 'p', save: true })).toEqual(mac);
    expect(await api.databases.duplicate(ID)).toEqual(mac);
    expect(await api.databases.remove(ID)).toBeUndefined();
    expect((await api.databases.snapshot()).connections).toHaveLength(1);
  });
});

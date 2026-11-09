import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MonitorLine } from '@shared/redis-monitor';
import { compileDemoWorld } from '../compile/index';
import { createDemo } from '../bridge/index';
import type { DemoWorld } from '../types';
import { createClock } from './clock';
import { STATUS_FAST_MS, STATUS_SLOW_MS, TRAFFIC_MS } from './redis';
import { UNDO_MS } from './redis-keyspace';

// Redis's live part in the demo: the keyspace as the Keys tab reads it, TTLs on the
// visitor's clock, writes with main's 30-second undo, the queues from main's adapters with retry/remove, and the
// traffic, monitor and status ticks only while a view shows.

let world: DemoWorld;
let now = 0;
beforeAll(async () => { world = await compileDemoWorld(); });
beforeEach(() => { vi.useFakeTimers(); now = world.t0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const make = () => createDemo(world, { version: '0.0.0-test', now: () => now, clock: createClock() });
const advance = async (ms: number) => { for (let t = 0; t < ms; t += 50) { now += 50; await vi.advanceTimersByTimeAsync(50); } };
const instance = 'tcp:6379';
const off = { db: 0, sidebar: false, queues: false, overview: false, live: false };

describe('keys', () => {
  test('a SCAN page: every live key of the database with its type, PTTL and size; MATCH filters', async () => {
    const { api } = make();
    const page = await api.redis.scan({ db: 0, match: '*', cursor: '0' });
    expect(page.cursor).toBe('0');
    expect(page.total).toBe(page.keys.length);
    expect(page.keys.find((k) => k.key === 'sess:u:4021:a91f')).toEqual({ key: 'sess:u:4021:a91f', type: 'hash', ttl: 7_080_000, size: expect.any(Number) });
    expect(page.keys.find((k) => k.key === 'leaderboard:bestsellers:week')).toMatchObject({ type: 'zset', ttl: -1 });
    const cache = await api.redis.scan({ db: 0, match: 'cache:products:*', cursor: '0' });
    expect(cache.keys.map((k) => k.key)).toEqual(['cache:products:page:1', 'cache:products:page:2', 'cache:products:page:3']);
    expect((await api.redis.scan({ db: 1, match: '*', cursor: '0' })).keys).toHaveLength(12);
  });

  test('values by type: hash fields, JSON strings, zset by score, stream newest first, JSON documents; missing', async () => {
    const { api } = make();
    const v = (key: string) => api.redis.value({ db: 0, key, page: {} });
    expect(await v('cache:product:8812')).toMatchObject({ meta: { type: 'hash', length: 8, encoding: 'listpack' }, body: { kind: 'hash', cursor: '0', total: 8, fields: expect.arrayContaining([['sku', 'MUG-CERAMIC-BLK']]) } });
    expect(await v('cache:products:page:1')).toMatchObject({ meta: { type: 'string', ttl: 54_000 }, body: { kind: 'string', format: 'json', value: { page: 1, total: 412 } } });
    expect(await v('rate:login:ip:127.0.0.1')).toMatchObject({ meta: { encoding: 'int' }, body: { kind: 'string', format: 'int', text: '17' } });
    expect(await v('cache:home:hero:it')).toMatchObject({ body: { kind: 'string', format: 'text' } });
    expect((await v('leaderboard:bestsellers:week')).body).toMatchObject({ kind: 'zset', members: [['product:8812', 1204], ['product:7731', 988], ['product:8813', 871], ['product:5120', 640], ['product:9002', 512], ['product:4410', 497], ['product:7004', 388]] });
    const stream = (await v('events:orders')).body;
    expect(stream.kind === 'stream' && stream.entries.map((e) => e.fields[0]![1])).toEqual(['order.paid', 'order.created', 'order.failed', 'order.created', 'order.shipped']);
    expect(stream).toMatchObject({ groups: [{ name: 'mailer', consumers: 1, pending: 0, lag: 0 }] });
    expect(await v('feature-flags:storefront')).toMatchObject({ meta: { type: 'ReJSON-RL' }, body: { kind: 'json', value: { newCheckout: true } } });
    expect(await v('nope')).toEqual({ meta: { type: 'none', ttl: -2, memory: null, encoding: null, idle: null, length: null }, body: { kind: 'missing' } });
  });

  test('TTLs run on the clock: the counter view counts down, an expired key leaves scans and values', async () => {
    const { api } = make();
    await advance(5000);
    expect(await api.redis.counter({ db: 0, key: 'cache:products:page:3' })).toMatchObject({ ttl: 7000 });
    await advance(7000);
    expect((await api.redis.scan({ db: 0, match: 'cache:products:*', cursor: '0' })).keys.map((k) => k.key)).toEqual(['cache:products:page:1', 'cache:products:page:2']);
    expect((await api.redis.value({ db: 0, key: 'cache:products:page:3', page: {} })).body).toEqual({ kind: 'missing' });
  });
});

describe('writes', () => {
  test('delete, then undo within 30 s: back with the TTL it had left; after 30 s the undo has expired', async () => {
    const { api } = make();
    const r = await api.redis.write({ db: 0, op: { op: 'delete', keys: ['sess:u:4022:77c0'] }, instance });
    expect(r).toEqual({ ok: true, count: 1, undo: expect.any(String) });
    expect((await api.redis.value({ db: 0, key: 'sess:u:4022:77c0', page: {} })).body.kind).toBe('missing');
    await advance(10_000);
    expect(await api.redis.undo(r.ok ? r.undo! : '')).toEqual({ ok: true, kept: 0 });
    expect((await api.redis.counter({ db: 0, key: 'sess:u:4022:77c0' })).ttl).toBe(2_460_000 - 10_000);
    const again = await api.redis.write({ db: 0, op: { op: 'delete', keys: ['sess:u:4022:77c0'] }, instance });
    await advance(UNDO_MS + 50);
    expect(await api.redis.undo(again.ok ? again.undo! : '')).toEqual({ ok: false, reason: 'expired' });
  });

  test('edits only on their type, strings keep their TTL; delete matching with a preview; edits off or another instance refused', async () => {
    const { api } = make();
    expect(await api.redis.write({ db: 0, op: { op: 'setString', key: 'cache:product:8812', value: 'x' }, instance })).toEqual({ ok: false, reason: 'wrong-type' });
    expect(await api.redis.write({ db: 0, op: { op: 'setString', key: 'rate:api:user:4021', value: '0' }, instance })).toMatchObject({ ok: true });
    expect(await api.redis.counter({ db: 0, key: 'rate:api:user:4021' })).toEqual({ value: '0', ttl: 31_000 });
    expect(await api.redis.write({ db: 0, op: { op: 'hset', key: 'cache:product:8812', field: 'stock', value: '36' }, instance })).toMatchObject({ ok: true });
    expect((await api.redis.value({ db: 0, key: 'cache:product:8812', page: {} })).body).toMatchObject({ fields: expect.arrayContaining([['stock', '36']]) });
    expect(await api.redis.preview({ db: 0, pattern: 'cache:legacy:*', instance })).toEqual({ count: 14, sample: ['cache:legacy:banner:0', 'cache:legacy:banner:1', 'cache:legacy:banner:10'], capped: false, undo: true });
    expect(await api.redis.write({ db: 0, op: { op: 'deleteMatching', pattern: 'cache:legacy:*' }, instance })).toMatchObject({ ok: true, count: 14 });
    expect(await api.redis.write({ db: 0, op: { op: 'delete', keys: ['x'] }, instance: 'tcp:6380' })).toEqual({ ok: false, reason: 'moved' });
    await api.settings.set({ redisEdits: 'readonly' });
    expect(await api.redis.write({ db: 0, op: { op: 'delete', keys: ['events:orders'] }, instance })).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('queues', () => {
  const email = () => world.redis.queues!.infos.find((q) => q.name === 'email-queue')!;

  test("status lists main's queues; the failed list and a job's detail (stacks, data) come from its adapters", async () => {
    const { api } = make();
    expect((await api.redis.status()).queues?.map((q) => q.name)).toEqual(world.redis.queues!.infos.map((q) => q.name));
    const failed = await api.redis.jobs({ db: 0, queue: email().id, state: 'failed', start: 0, count: 50 });
    expect(failed.map((j) => j.id)).toEqual(['8812', '8809', '8801']);
    const d = await api.redis.job({ db: 0, queue: email().id, state: 'failed', id: '8812' });
    expect(d).toMatchObject({ job: { id: '8812', reason: 'connect ECONNREFUSED 127.0.0.1:1025', data: { orderId: 10442 } }, command: null });
    expect(d!.job.stacks[0]![0]).toBe('Error: connect ECONNREFUSED 127.0.0.1:1025');
  });

  test('retry: out of failed, first in waiting, counted; undo puts it back', async () => {
    const { api, events } = make();
    const statuses = vi.fn();
    events.on.redisStatus(statuses);
    const r = await api.redis.write({ db: 0, op: { op: 'retry', queue: { id: email().id }, id: '8812' }, instance });
    expect(r).toMatchObject({ ok: true, count: 1 });
    const q = (await api.redis.status()).queues!.find((x) => x.id === email().id)!;
    expect(q.counts).toMatchObject({ failed: 2, waiting: 13 });
    expect(statuses).toHaveBeenCalled();
    expect((await api.redis.jobs({ db: 0, queue: email().id, state: 'waiting', start: 0, count: 1 }))[0]).toMatchObject({ id: '8812', reason: '' });
    expect((await api.redis.value({ db: 0, key: 'bull:email-queue:failed', page: {} })).body).toMatchObject({ total: 2 });
    expect(await api.redis.write({ db: 0, op: { op: 'retry', queue: { id: email().id }, id: '8812' }, instance })).toEqual({ ok: false, reason: 'not-failed' });
    expect(await api.redis.undo(r.ok ? r.undo! : '')).toEqual({ ok: true, kept: 0 });
    expect((await api.redis.jobs({ db: 0, queue: email().id, state: 'failed', start: 0, count: 50 })).map((j) => j.id)).toEqual(['8812', '8809', '8801']);
    expect((await api.redis.status()).queues!.find((x) => x.id === email().id)!.counts).toMatchObject({ failed: 3, waiting: 12 });
  });

  test('remove deletes the job; "seen" moves the baseline, so a failure back by undo counts as new', async () => {
    const { api } = make();
    const r = await api.redis.write({ db: 0, op: { op: 'remove', queue: { id: email().id }, id: '8809' }, instance });
    expect((await api.redis.value({ db: 0, key: 'bull:email-queue:8809', page: {} })).body.kind).toBe('missing');
    api.redis.seen(email().id);
    await api.redis.undo(r.ok ? r.undo! : '');
    expect((await api.redis.status()).unseen).toEqual({ [email().id]: 1 });
    expect((await api.redis.value({ db: 0, key: 'bull:email-queue:8809', page: {} })).body.kind).toBe('hash');
  });

  test('a library Atelier does not write to: refused (its own retry command is offered instead)', async () => {
    const { api } = make();
    const rq = world.redis.queues!.infos.find((q) => q.lib === 'rq')!;
    const [j] = await api.redis.jobs({ db: 0, queue: rq.id, state: 'failed', start: 0, count: 1 });
    expect(await api.redis.write({ db: 0, op: { op: 'retry', queue: { id: rq.id }, id: j!.id }, instance })).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('traffic, monitor, status', () => {
  test('Live: monitor lines every tick for the picked instance, about 40 commands a second; stops when Live goes', async () => {
    const { api, events } = make();
    const lines: MonitorLine[] = [];
    events.on.redisMonitor((e) => { expect(e.key).toBe(instance); lines.push(...e.lines); });
    await advance(2000);
    expect(lines).toEqual([]);
    api.redis.watch({ ...off, live: true });
    await advance(5000);
    expect(lines.length).toBeGreaterThan(5 * 25);
    expect(lines.length).toBeLessThan(5 * 60);
    expect(new Set(lines.map((l) => l.cmd))).toEqual(expect.objectContaining({ size: expect.any(Number) }));
    expect(lines.some((l) => l.cmd === 'GET' && l.args[0]?.startsWith('cache:products:page:'))).toBe(true);
    expect(lines.some((l) => l.cmd === 'BZPOPMIN')).toBe(true);
    api.redis.watch(off);
    const n = lines.length;
    // Nothing shows: no traffic at all (the counters the api bumps stay put), not just no lines.
    const counter = await api.redis.counter({ db: 0, key: 'rate:api:user:4021' });
    await advance(3000);
    expect(lines.length).toBe(n);
    expect((await api.redis.counter({ db: 0, key: 'rate:api:user:4021' })).value).toBe(counter.value);
  });

  test("a tick's lines are spread over the tick, in order; the hit ratio keeps the queue polling's misses (about a third)", async () => {
    // A fixed sequence for Math.random (mulberry32): a short tick with its lines close together is possible, and made
    // this test fail about one run in ten.
    let seed = 0x5eed;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    });
    const { api, events } = make();
    const batches: MonitorLine[][] = [];
    events.on.redisMonitor((e) => batches.push(e.lines));
    const before = (await api.redis.status()).info!;
    api.redis.watch({ ...off, live: true });
    await advance(20_000);
    for (const b of batches.slice(1)) {
      expect(b.map((l) => l.at)).toEqual([...b.map((l) => l.at)].sort((x, y) => x - y));
      expect(b.at(-1)!.at - b[0]!.at).toBeGreaterThan(TRAFFIC_MS / 3);
    }
    const after = (await api.redis.status()).info!;
    const hits = after.hits - before.hits, misses = after.misses - before.misses;
    expect(hits / (hits + misses)).toBeGreaterThan(0.2);
    expect(hits / (hits + misses)).toBeLessThan(0.45);
  });

  test('the traffic writes: an expired cache page is refilled for a minute (GET miss, then SET … EX 60)', async () => {
    const { api, events } = make();
    const lines: MonitorLine[] = [];
    events.on.redisMonitor((e) => lines.push(...e.lines));
    await advance(13_000);
    api.redis.watch({ ...off, live: true });
    await advance(6000);
    const set = lines.find((l) => l.cmd === 'SET' && l.args[0] === 'cache:products:page:3');
    expect(set?.args.slice(2)).toEqual(['EX', '60']);
    const ttl = (await api.redis.counter({ db: 0, key: 'cache:products:page:3' })).ttl;
    expect(ttl).toBeGreaterThan(50_000);
  });

  test('Settings › Redis › monitor off: no lines, the traffic still runs', async () => {
    const { api, events } = make();
    await api.settings.set({ redisMonitor: false });
    const got = vi.fn();
    events.on.redisMonitor(got);
    api.redis.watch({ ...off, live: true });
    await advance(2000);
    expect(got).not.toHaveBeenCalled();
  });

  test('status: every 2 s with Overview or Live, every 10 s with only the sidebar, never with nothing; a sample per reading', async () => {
    const { api, events } = make();
    const got: number[] = [];
    events.on.redisStatus((s) => got.push(s.samples.length));
    await advance(STATUS_SLOW_MS * 2);
    expect(got).toEqual([]);
    api.redis.watch({ ...off, overview: true });
    const first = got.length;
    await advance(STATUS_FAST_MS * 3);
    expect(got.length - first).toBe(3);
    expect((await api.redis.status()).samples.at(-1)!.at).toBe(now);
    api.redis.watch({ ...off, sidebar: true });
    const k = got.length;
    await advance(STATUS_SLOW_MS);
    expect(got.length - k).toBe(1);
    const s = await api.redis.status();
    expect(s.info!.ops).toBeGreaterThan(20);
    expect(s.info!.keyspace[0]!.keys).toBeGreaterThan(50);
    expect(TRAFFIC_MS).toBeLessThan(1000);
  });

  test('clients and the slow log come from the compiled world; Live adds Atelier\'s monitor connection', async () => {
    const { api } = make();
    expect((await api.redis.clients()).map((c) => c.name)).toEqual(world.redis.clients.map((c) => c.name));
    api.redis.watch({ ...off, live: true });
    expect((await api.redis.clients()).at(-1)).toMatchObject({ name: 'atelier-monitor', kind: 'atelier', cmd: 'MONITOR' });
    expect(await api.redis.slowlog()).toEqual(world.redis.slowlog);
  });
});

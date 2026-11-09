import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FakeRedis } from '../support/fake-redis';
import { acmeStore, otherQueues } from '../support/redis-fixtures';
import { RedisClient } from '../../src/main/redis/client';
import { RedisWriter } from '../../src/main/redis/writes';
import { detect } from '../../src/main/redis/queues';
import type { QueueRef } from '../../src/shared/redis-queues';

let fake: FakeRedis;
let client: RedisClient;
let w: RedisWriter;
let now = 1_000_000;
beforeEach(async () => {
  fake = await FakeRedis.start();
  acmeStore(fake);
  client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier' });
  now = Date.now();
  w = new RedisWriter(() => client, { now: () => now, undoMs: 30_000 });
});
afterEach(async () => { client.close(); await fake.stop(); });

describe('key edits with undo', () => {
  test('delete one key, undo restores value and TTL', async () => {
    const r = await w.run(0, { op: 'delete', keys: ['cache:product:8812'] });
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(fake.get('cache:product:8812')).toBeNull();
    expect(fake.writes.map((x) => x[0])).toEqual(['UNLINK']);
    const u = await w.undo(r.ok ? r.undo! : '');
    expect(u).toMatchObject({ ok: true, kept: 0 });
    expect(fake.get('cache:product:8812')?.type).toBe('hash');
    expect(fake.ttlOf('cache:product:8812')).toBeGreaterThan(150_000);
  });
  test('undo keeps a key written again meanwhile, and expires after 30 s', async () => {
    const r = await w.run(0, { op: 'delete', keys: ['cache:products:page:1', 'cache:products:page:2'] });
    fake.str('cache:products:page:1', 'fresh');
    const u = await w.undo(r.ok ? r.undo! : '');
    expect(u).toMatchObject({ ok: true, kept: 1 });
    expect(fake.get('cache:products:page:1')).toMatchObject({ type: 'string' });
    expect((fake.get('cache:products:page:1') as { v: Buffer }).v.toString()).toBe('fresh');
    const r2 = await w.run(0, { op: 'delete', keys: ['rate:api:user:4021'] });
    now += 31_000;
    expect(await w.undo(r2.ok ? r2.undo! : '')).toEqual({ ok: false, reason: 'expired' });
  });
  test('delete matching: preview counts and samples, then UNLINK in batches; undo puts them back', async () => {
    const p = await w.preview(0, 'cache:legacy:*');
    expect(p).toMatchObject({ count: 14, capped: false, undo: true });
    expect(p.sample).toHaveLength(3);
    const r = await w.run(0, { op: 'deleteMatching', pattern: 'cache:legacy:*' });
    expect(r).toMatchObject({ ok: true, count: 14 });
    expect([...fake.db(0).keys()].some((k) => k.startsWith('cache:legacy:'))).toBe(false);
    await w.undo(r.ok ? r.undo! : '');
    expect([...fake.db(0).keys()].filter((k) => k.startsWith('cache:legacy:'))).toHaveLength(14);
  });
  test('TTL: set, persist, undo back to the old deadline', async () => {
    const r = await w.run(0, { op: 'ttl', key: 'cache:home:hero:it', ms: 60_000 });
    expect(fake.ttlOf('cache:home:hero:it')).toBeLessThanOrEqual(60_000);
    await w.undo(r.ok ? r.undo! : '');
    expect(fake.ttlOf('cache:home:hero:it')).toBeGreaterThan(20 * 60_000);
    const p = await w.run(0, { op: 'ttl', key: 'cache:home:hero:it', ms: null });
    expect(fake.ttlOf('cache:home:hero:it')).toBeNull();
    await w.undo(p.ok ? p.undo! : '');
    expect(fake.ttlOf('cache:home:hero:it')).toBeGreaterThan(20 * 60_000);
  });
  test('edit a string keeps its TTL; hash field, list item, zset score; undo restores the old value', async () => {
    const r = await w.run(0, { op: 'setString', key: 'cache:home:hero:it', value: 'new' });
    expect((fake.get('cache:home:hero:it') as { v: Buffer }).v.toString()).toBe('new');
    expect(fake.ttlOf('cache:home:hero:it')).toBeGreaterThan(20 * 60_000);
    await w.undo(r.ok ? r.undo! : '');
    expect((fake.get('cache:home:hero:it') as { v: Buffer }).v.toString()).toContain('Spedizione');
    await w.run(0, { op: 'hset', key: 'cache:product:8812', field: 'stock', value: '36' });
    expect((fake.get('cache:product:8812') as { v: Map<string, Buffer> }).v.get('stock')?.toString()).toBe('36');
    await w.run(0, { op: 'zscore', key: 'leaderboard:bestsellers:week', member: 'product:8812', score: 1300 });
    expect((fake.get('leaderboard:bestsellers:week') as { v: Map<string, number> }).v.get('product:8812')).toBe(1300);
  });
  test('an edit must match the key type: SET never replaces a hash; strings over the preview are not edited', async () => {
    expect(await w.run(0, { op: 'setString', key: 'cache:product:8812', value: 'oops' })).toEqual({ ok: false, reason: 'wrong-type' });
    expect(fake.get('cache:product:8812')?.type).toBe('hash');
    expect(await w.run(0, { op: 'hset', key: 'cache:home:hero:it', field: 'a', value: 'b' })).toEqual({ ok: false, reason: 'wrong-type' });
    expect(await w.run(0, { op: 'lset', key: 'cache:home:hero:it', index: 0, value: 'b' })).toEqual({ ok: false, reason: 'wrong-type' });
    expect(await w.run(0, { op: 'zscore', key: 'cache:home:hero:it', member: 'm', score: 1 })).toEqual({ ok: false, reason: 'wrong-type' });
    expect(await w.run(0, { op: 'jsonSet', key: 'cache:home:hero:it', value: '{}' })).toEqual({ ok: false, reason: 'wrong-type' });
    fake.str('big', 'x'.repeat(300_000));
    expect(await w.run(0, { op: 'setString', key: 'big', value: 'short' })).toEqual({ ok: false, reason: 'too-big' });
    expect(fake.writes).toEqual([]);
  });
  test('a key too big to dump is still deleted (no undo), the connection stays up', async () => {
    fake.str('huge', 'x'.repeat(13 * 1024 * 1024));
    const r = await w.run(0, { op: 'delete', keys: ['huge'] });
    expect(r).toEqual({ ok: true, count: 1, undo: null });
    expect(fake.get('huge')).toBeNull();
    expect(client.closed).toBe(false);
  });
  test('undo restores the TTL the key had left, and not a key that would have expired meanwhile', async () => {
    fake.str('short', 'a', 5000);
    fake.str('gone-soon', 'b', 1000);
    const r = await w.run(0, { op: 'delete', keys: ['short', 'gone-soon'] });
    now += 3000;
    expect(await w.undo(r.ok ? r.undo! : '')).toMatchObject({ ok: true });
    expect(fake.ttlOf('short')).toBeLessThanOrEqual(2100);
    expect(fake.get('gone-soon')).toBeNull();
  });

  test('empty a database: FLUSHDB ASYNC, no undo', async () => {
    const r = await w.run(1, { op: 'flushdb' });
    expect(r).toMatchObject({ ok: true, undo: null });
    expect(fake.db(1).size).toBe(0);
    expect(fake.writes.at(-1)).toEqual(['FLUSHDB', 'ASYNC']);
    expect(fake.db(0).size).toBeGreaterThan(0);
  });
});

describe('queue actions', () => {
  let refs: QueueRef[];
  beforeEach(async () => { otherQueues(fake); refs = await detect((c) => client.pipeline(c, 0), 20_000); });
  const ref = (lib: string, name: string) => refs.find((r) => r.lib === lib && r.name === name)!;

  test('BullMQ retry moves the job to wait, wakes workers, logs the event; undo while it waits', async () => {
    const q = ref('bullmq', 'email-queue');
    const r = await w.run(0, { op: 'retry', queue: q, id: '8812' });
    expect(r).toMatchObject({ ok: true, count: 1 });
    const wait = fake.get('bull:email-queue:wait') as { v: Buffer[] };
    expect(wait.v[0]?.toString()).toBe('8812');
    expect((fake.get('bull:email-queue:failed') as { v: Map<string, number> }).v.has('8812')).toBe(false);
    expect((fake.get('bull:email-queue:8812') as { v: Map<string, Buffer> }).v.has('failedReason')).toBe(false);
    expect((fake.get('bull:email-queue:marker') as { v: Map<string, number> }).v.has('0')).toBe(true);
    const u = await w.undo(r.ok ? r.undo! : '');
    expect(u).toMatchObject({ ok: true });
    expect((fake.get('bull:email-queue:failed') as { v: Map<string, number> }).v.has('8812')).toBe(true);
    expect((fake.get('bull:email-queue:8812') as { v: Map<string, Buffer> }).v.get('failedReason')?.toString()).toContain('ECONNREFUSED');
  });
  test('BullMQ retry refused on a paused queue; remove refused for flows; remove + undo', async () => {
    fake.hash('bull:canvas-queue:9', { name: 'x', opts: '{}' });
    fake.zset('bull:canvas-queue:failed', { 9: 1 });
    expect(await w.run(0, { op: 'retry', queue: ref('bullmq', 'canvas-queue'), id: '9' })).toEqual({ ok: false, reason: 'paused' });
    (fake.get('bull:email-queue:8809') as { v: Map<string, Buffer> }).v.set('parentKey', Buffer.from('bull:parent:1'));
    expect(await w.run(0, { op: 'remove', queue: ref('bullmq', 'email-queue'), id: '8809' })).toEqual({ ok: false, reason: 'flow' });
    const r = await w.run(0, { op: 'remove', queue: ref('bullmq', 'email-queue'), id: '8812' });
    expect(r).toMatchObject({ ok: true });
    expect(fake.get('bull:email-queue:8812')).toBeNull();
    await w.undo(r.ok ? r.undo! : '');
    expect(fake.get('bull:email-queue:8812')?.type).toBe('hash');
    expect((fake.get('bull:email-queue:failed') as { v: Map<string, number> }).v.has('8812')).toBe(true);
  });
  test('BullMQ remove undo leaves a new job with the same id alone (not put back in failed)', async () => {
    const q = ref('bullmq', 'email-queue');
    const r = await w.run(0, { op: 'remove', queue: q, id: '8812' });
    fake.hash('bull:email-queue:8812', { name: 'fresh', opts: '{}' });
    expect(await w.undo(r.ok ? r.undo! : '')).toMatchObject({ ok: true, kept: 1 });
    expect((fake.get('bull:email-queue:failed') as { v: Map<string, number> }).v.has('8812')).toBe(false);
    expect((fake.get('bull:email-queue:8812') as { v: Map<string, Buffer> }).v.get('name')?.toString()).toBe('fresh');
  });
  test('Sidekiq retry enqueues with retry_count − 1 and enqueued_at; undo while it waits; remove', async () => {
    const q = ref('sidekiq', 'mailers');
    const r = await w.run(0, { op: 'retry', queue: q, id: 'b4a577edbccf1d805744efa9' });
    expect(r).toMatchObject({ ok: true });
    const pushed = JSON.parse((fake.get('queue:mailers') as { v: Buffer[] }).v[0]!.toString()) as { retry_count: number; enqueued_at: number; jid: string };
    expect(pushed).toMatchObject({ jid: 'b4a577edbccf1d805744efa9', retry_count: 1 });
    expect(pushed.enqueued_at).toBeGreaterThan(0);
    expect(fake.get('retry')).toBeNull();
    await w.undo(r.ok ? r.undo! : '');
    expect((fake.get('retry') as { v: Map<string, number> }).v.size).toBe(1);
    expect((fake.get('queue:mailers') as { v: Buffer[] }).v).toHaveLength(1);
    const rm = await w.run(0, { op: 'remove', queue: q, id: 'b4a577edbccf1d805744efa9' });
    expect(rm).toMatchObject({ ok: true });
    expect(fake.get('retry')).toBeNull();
  });
  test('Sidekiq retry puts the job back in its own queue', async () => {
    const entry = JSON.stringify({ class: 'Other', args: [], jid: 'otherjid000000000000000', queue: 'default', retry_count: 0, retry: 3, error_message: 'x', error_class: 'E', failed_at: 1 });
    (fake.get('retry') as { v: Map<string, number> }).v.set(entry, 5);
    const r = await w.run(0, { op: 'retry', queue: ref('sidekiq', 'mailers'), id: 'otherjid000000000000000' });
    expect(r).toMatchObject({ ok: true });
    expect((fake.get('queue:default') as { v: Buffer[] }).v[0]!.toString()).toContain('otherjid000000000000000');
    expect((fake.get('queues') as { v: Set<string> }).v.has('default')).toBe(true);
  });
  test('libraries Atelier does not write to are refused', async () => {
    expect(await w.run(0, { op: 'retry', queue: ref('rq', 'default'), id: 'r-1' })).toEqual({ ok: false, reason: 'refused' });
  });
});

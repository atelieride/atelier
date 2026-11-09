import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { gzipSync } from 'node:zlib';
import { FakeRedis } from '../support/fake-redis';
import { acmeStore } from '../support/redis-fixtures';
import { RedisClient } from '../../src/main/redis/client';
import { readCounter, readValue, scanPage } from '../../src/main/redis/values';

let fake: FakeRedis;
let client: RedisClient;
beforeAll(async () => {
  fake = await FakeRedis.start();
  acmeStore(fake);
  fake.str('gz', gzipSync(Buffer.from('{"compressed":true}')));
  fake.str('bin', Buffer.from([0xff, 0xfe, 0x00]));
  fake.str('big', 'x'.repeat(300_000));
  fake.list('l', Array.from({ length: 150 }, (_, i) => `item-${i}`));
  fake.put('vec', { type: 'vectorset', v: { dim: 384, count: 1200, quant: 'int8' } });
  client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier' });
});
afterAll(async () => { client.close(); await fake.stop(); });

describe('scanPage', () => {
  test('keys with type, TTL and size; the total from DBSIZE', async () => {
    let cursor = '0';
    const all: { key: string; type: string; ttl: number; size: number | null }[] = [];
    let total = 0;
    do {
      const p = await scanPage(client, 0, 'cache:*', cursor);
      all.push(...p.keys);
      total = p.total;
      cursor = p.cursor;
    } while (cursor !== '0');
    expect(all.find((k) => k.key === 'cache:product:8812')).toMatchObject({ type: 'hash', size: expect.any(Number) });
    expect(all.find((k) => k.key === 'cache:products:page:1')!.ttl).toBeGreaterThan(40_000);
    expect(all.find((k) => k.key === 'cache:tags:product:8812')!.ttl).toBe(-1);
    expect(all.every((k) => k.key.startsWith('cache:'))).toBe(true);
    expect(total).toBeGreaterThan(all.length);
  });
});

describe('readValue', () => {
  test('a JSON string with its meta', async () => {
    const v = await readValue(client, 0, 'cache:products:page:1', {});
    expect(v.meta).toMatchObject({ type: 'string', encoding: 'raw', idle: 3 });
    expect(v.meta.ttl).toBeGreaterThan(40_000);
    expect(v.body).toMatchObject({ kind: 'string', format: 'json', gzip: false });
    expect((v.body as { value: { page: number } }).value.page).toBe(1);
  });
  test('gzip inflated, binary as hex, a big string previewed', async () => {
    expect((await readValue(client, 0, 'gz', {})).body).toMatchObject({ kind: 'string', format: 'json', gzip: true, value: { compressed: true } });
    expect((await readValue(client, 0, 'bin', {})).body).toMatchObject({ kind: 'string', format: 'binary' });
    expect((await readValue(client, 0, 'big', {})).body).toMatchObject({ kind: 'string', format: 'text', total: 300_000, shown: 262_144 });
  });
  test('hash, list pages, set, zset by rank, stream with groups, RedisJSON, vector set, missing', async () => {
    const h = await readValue(client, 0, 'cache:product:8812', {});
    expect(h.body).toMatchObject({ kind: 'hash', total: 8 });
    expect((h.body as { fields: [string, string][] }).fields).toContainEqual(['stock', '37']);
    const l1 = await readValue(client, 0, 'l', {});
    expect(l1.body).toMatchObject({ kind: 'list', start: 0, total: 150 });
    expect((l1.body as { items: string[] }).items).toHaveLength(100);
    const l2 = await readValue(client, 0, 'l', { start: 100 });
    expect((l2.body as { items: string[] }).items[0]).toBe('item-100');
    expect((await readValue(client, 0, 'cache:tags:product:8812', {})).body).toMatchObject({ kind: 'set', total: 3 });
    const z = await readValue(client, 0, 'leaderboard:bestsellers:week', {});
    expect((z.body as { members: [string, number][] }).members[0]).toEqual(['product:8812', 1204]);
    const s = await readValue(client, 0, 'events:orders', {});
    expect(s.body).toMatchObject({ kind: 'stream', total: 5, groups: [{ name: 'mailer', consumers: 1, pending: 0, lag: 0 }] });
    expect((s.body as { entries: { fields: [string, string][] }[] }).entries[0]!.fields).toContainEqual(['type', 'order.paid']);
    expect((await readValue(client, 0, 'feature-flags:storefront', {})).body).toMatchObject({ kind: 'json', value: { newCheckout: true } });
    expect((await readValue(client, 0, 'vec', {})).body).toEqual({ kind: 'vector', count: 1200, dim: 384, quant: 'int8' });
    expect((await readValue(client, 0, 'nope', {})).body).toEqual({ kind: 'missing' });
  });
  test('readCounter', async () => {
    expect(await readCounter(client, 0, 'rate:login:ip:127.0.0.1')).toMatchObject({ value: '17' });
  });
  test('only reads', () => { expect(fake.writes).toEqual([]); });
});

// Fixtures for the fake Redis: the fictional acme-store and one small queue of each other library.
// The data is the demo's world (src/demo/world/redis.ts); these apply it to the fake, in
// order. Used by integration tests, e2e and the site's screenshots.
import type { FakeRedis, FakeValue } from './fake-redis';
import { acmeStoreSeed, bullQueueSeed, otherQueuesSeed, type BullQueueOptions, type RedisSeed, type SeedKey, type SeedValue } from '../../src/demo/world/redis';

const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? Buffer.from(v) : Buffer.from(v));

function value(s: SeedValue): FakeValue {
  switch (s.type) {
    case 'string': return { type: 'string', v: bytes(s.v) };
    case 'hash': return { type: 'hash', v: new Map(Object.entries(s.v).map(([k, v]) => [k, bytes(v)])) };
    case 'list': return { type: 'list', v: s.v.map(bytes) };
    case 'set': return { type: 'set', v: new Set(s.v) };
    case 'zset': return { type: 'zset', v: new Map(Object.entries(s.v)) };
    case 'stream': return { type: 'stream', v: s.v.map((e) => ({ id: e.id, fields: Object.entries(e.fields).flat() })), groups: s.groups ?? [] };
    case 'ReJSON-RL': return { type: 'ReJSON-RL', v: s.v };
  }
}

const putKeys = (f: FakeRedis, keys: SeedKey[]) => { for (const k of keys) f.put(k.key, value(k.value), k.ttlMs ?? null, k.db ?? 0); };

export function applySeed(f: FakeRedis, seed: RedisSeed): void {
  putKeys(f, seed.keys);
  f.extraClients.push(...seed.clients);
  f.slowlog.push(...seed.slowlog);
}

/** The BullMQ layout of one queue (5.x): meta, id, lists, sets, job hashes and the events stream. */
export function bullQueue(f: FakeRedis, name: string, o: BullQueueOptions = {}): void {
  putKeys(f, bullQueueSeed(name, o, Date.now()));
}

export function acmeStore(f: FakeRedis): void {
  applySeed(f, acmeStoreSeed(Date.now()));
}

/** One small queue of each other library (layouts as their docs describe them). */
export function otherQueues(f: FakeRedis): void {
  applySeed(f, otherQueuesSeed(Date.now()));
}

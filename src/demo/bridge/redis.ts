// redis.* in the demo: one instance ("Docker · acme-store-redis-1", compiled with the app's
// INFO parser), its keyspace in memory with ticking TTLs, the queues read at build time by main's adapters, writes with
// main's 30-second undo, the monitor and status ticks (engine/redis.ts). The instance has no password: auth and forget
// have nothing to do.
import type { AtelierApi } from '@shared/api';
import { createRedisEngine } from '../engine/redis';
import { noop, resolved, type DemoContext } from './context';

export function createRedis(ctx: DemoContext): AtelierApi['redis'] {
  const r = createRedisEngine(ctx);
  const { snapshot, slowlog } = ctx.world.redis;
  return {
    snapshot: () => resolved(snapshot),
    status: () => resolved(r.status()),
    watch: (w) => r.watch(w),
    // One instance: already picked.
    pick: () => noop(),
    auth: () => resolved({ ok: true }),
    forget: () => noop(),
    seen: (queueId) => r.seen(queueId),
    scan: (a) => resolved(r.keyspace.scan(a)),
    value: (a) => resolved(r.keyspace.value(a)),
    counter: (a) => resolved(r.keyspace.counter(a)),
    clients: () => resolved(r.clients()),
    slowlog: () => resolved(slowlog),
    jobs: (a) => resolved(r.jobs(a)),
    job: (a) => resolved(r.job(a)),
    preview: (a) => (a.instance === snapshot.pick ? resolved(r.keyspace.preview(a.db, a.pattern)) : Promise.reject(new Error('moved: the window shows another instance'))),
    write: (a) => resolved(r.write(a)),
    undo: (id) => resolved(r.undo(id))
  };
}

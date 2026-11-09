// What this window shows of Redis, told to main: the sidebar, the Queues tab, Overview, Live
// and the database. Main polls INFO fast, counts queues and runs MONITOR only for what is on screen.
import { useEffect } from 'react';
import type { RedisWatch } from '@shared/redis';
import { useRedis } from './store';

type Part = 'sidebar' | 'queues' | 'overview' | 'live';
const on = new Map<Part, number>();
let sent = '';
let pending = false;

function flush(): void {
  pending = false;
  const w: RedisWatch = { db: useRedis.getState().db, sidebar: (on.get('sidebar') ?? 0) > 0, queues: (on.get('queues') ?? 0) > 0, overview: (on.get('overview') ?? 0) > 0, live: (on.get('live') ?? 0) > 0 };
  const key = JSON.stringify(w);
  if (key === sent) return;
  sent = key;
  window.atelier.redis.watch(w);
}

export function scheduleWatch(): void {
  if (pending) return;
  pending = true;
  queueMicrotask(flush);
}

/** This part of the Redis view is on screen while mounted and `active`. */
export function useRedisWatch(part: Part, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    on.set(part, (on.get(part) ?? 0) + 1);
    scheduleWatch();
    return () => { on.set(part, (on.get(part) ?? 1) - 1); scheduleWatch(); };
  }, [part, active]);
}

useRedis.subscribe((s, prev) => { if (s.db !== prev.db) scheduleWatch(); });

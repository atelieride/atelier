import { expect, test } from 'vitest';
import { compileDemoWorld } from '../compile/index';
import { TIME_MS_KEYS, TIME_S_KEYS } from './time';

// time.test.ts's guard over what only the shipped world has (compileDemoWorld: the Redis queues main's adapters read):
// a job's times (failed at, queued at…) must move to the visitor's clock like the rest.
test('every time in the Redis queues is under a key rebase knows', async () => {
  const world = await compileDemoWorld();
  expect(world.redis.queues?.infos.length).toBeGreaterThan(0);
  const unknown: string[] = [];
  const DAYS = 30 * 86_400_000;
  const walk = (v: unknown, path: string, key: string) => {
    if (typeof v === 'number') {
      if (Math.abs(v - world.t0) < DAYS && !TIME_MS_KEYS.has(key)) unknown.push(`${path} (ms)`);
      if (Math.abs(v - world.t0 / 1000) < DAYS / 1000 && !TIME_S_KEYS.has(key)) unknown.push(`${path} (s)`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, k);
  };
  walk(world.redis.queues, 'queues', '');
  expect(unknown).toEqual([]);
});

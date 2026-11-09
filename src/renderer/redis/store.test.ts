import { beforeEach, expect, test } from 'vitest';
import type { RedisStatus } from '@shared/redis';
import { useRedis } from './store';

const info = { usedMemory: 1 } as unknown as NonNullable<RedisStatus['info']>;
const status = (o: Partial<RedisStatus>): RedisStatus => ({ key: 'tcp:6379', info, samples: [], denied: [], queues: null, unseen: {}, db: 0, dir: null, error: null, ...o });
const sample = (at: number) => ({ at, usedMemory: 1, ops: 1, hits: 0, misses: 0, expired: 0, evicted: 0 });

beforeEach(() => useRedis.setState({ status: null }));

test('a status without samples (the Overview closed) keeps the last ones of the same instance: reopened, the charts are drawn at once', () => {
  useRedis.getState().setStatus(status({ samples: [sample(1), sample(2)] }));
  useRedis.getState().setStatus(status({ samples: [] }));
  expect(useRedis.getState().status!.samples).toHaveLength(2);
  useRedis.getState().setStatus(status({ samples: [sample(3)] }));
  expect(useRedis.getState().status!.samples).toEqual([sample(3)]);
});

test('another instance, or one no longer running (no INFO), never shows the old samples', () => {
  useRedis.getState().setStatus(status({ samples: [sample(1)] }));
  useRedis.getState().setStatus(status({ key: 'tcp:6380', samples: [] }));
  expect(useRedis.getState().status!.samples).toEqual([]);
  useRedis.getState().setStatus(status({ samples: [sample(1)] }));
  useRedis.getState().setStatus(status({ info: null, samples: [] }));
  expect(useRedis.getState().status!.samples).toEqual([]);
});

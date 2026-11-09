import { describe, expect, test } from 'vitest';

import { compileDocker } from './docker';
import { compileRedis, demoSeeds } from './redis';
import { DEMO_ROOT, T0 } from './sessions';

// The Redis instance through the app's INFO parser at build time: the footer's "redis · 2.5 MB ·
// 41 ops/s" of the overview shot, from the same numbers the fake Redis reports.

describe('compileRedis', () => {
  const docker = compileDocker(DEMO_ROOT, T0, { healthy: true });
  const { snapshot, status } = compileRedis(docker.snapshot.containers, T0);
  const redisContainer = docker.snapshot.containers.find((c) => c.containerName === 'acme-store-redis-1')!;

  test("one instance: the project's compose redis, picked", () => {
    expect(snapshot).toMatchObject({ pick: 'tcp:6379', mentions: true, brew: false, probed: true });
    expect(snapshot.instances).toEqual([expect.objectContaining({
      key: 'tcp:6379', endpoint: { kind: 'tcp', port: 6379 }, state: 'running', badge: 'docker', label: 'Docker · acme-store-redis-1',
      hint: "this project's compose (redis)", mine: true, server: { name: 'redis', version: '8.4.0', mode: 'standalone' }, db: 0,
      container: { id: redisContainer.id, name: 'acme-store-redis-1', service: 'redis', running: true, finishedAt: null }
    })]);
  });

  test('INFO as the fake Redis reports it, parsed by the app', () => {
    expect(status).toMatchObject({ key: 'tcp:6379', db: 0, denied: [], error: null });
    expect(status.info).toMatchObject({ name: 'redis', version: '8.4.0', usedMemory: 2642344, ops: 41 });
  });

  test("the keyspace counts the world's keys per database (the acme-store and the other libraries' queues)", () => {
    const seed = demoSeeds(T0).flatMap((s) => s.keys);
    const db0 = new Set(seed.filter((k) => !k.db).map((k) => k.key));
    const db1 = new Set(seed.filter((k) => k.db === 1).map((k) => k.key));
    expect(status.info?.keyspace).toEqual([{ db: 0, keys: db0.size, expires: expect.any(Number) }, { db: 1, keys: db1.size, expires: 0 }]);
  });

  test("Clients as main lists them: Atelier's own connection, the api, BullMQ workers named by their queue", () => {
    const { clients } = compileRedis(docker.snapshot.containers, T0);
    expect(clients.map((c) => [c.name, c.kind])).toEqual([['atelier', 'atelier'], ['api', 'app'], ['bull:email-queue', 'queue'], ['bull:report-queue', 'queue'], ['bull:transcription-queue', 'queue']]);
    expect(clients[2]).toMatchObject({ cmd: 'BZPOPMIN', from: '127.0.0.1:50212' });
    expect(status.info?.clients).toBe(clients.length);
  });

  test('the slow log: newest first, whole seconds, the command and its client', () => {
    const { slowlog } = compileRedis(docker.snapshot.containers, T0);
    expect(slowlog.threshold).toBe(10_000);
    expect(slowlog.entries[0]).toEqual({ id: 3, at: Math.floor((T0 - 12 * 60_000) / 1000) * 1000, micros: 48_000, command: 'KEYS cache:products:*', client: 'api' });
  });
});

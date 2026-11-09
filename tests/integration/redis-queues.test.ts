import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FakeRedis } from '../support/fake-redis';
import { acmeStore, otherQueues } from '../support/redis-fixtures';
import { RedisClient } from '../../src/main/redis/client';
import { detect, queueAdapter, type Read } from '../../src/main/redis/queues';
import type { QueueRef } from '../../src/shared/redis-queues';

let fake: FakeRedis;
let client: RedisClient;
let read: Read;
let refs: QueueRef[];
beforeAll(async () => {
  fake = await FakeRedis.start();
  acmeStore(fake);
  otherQueues(fake);
  client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier' });
  read = (cmds) => client.pipeline(cmds, 0);
  refs = await detect(read, 20_000);
});
afterAll(async () => { client.close(); await fake.stop(); });

const q = (lib: string, name: string) => { const r = refs.find((x) => x.lib === lib && x.name === name); if (!r) throw new Error(`no ${lib} ${name}`); return r; };

describe('queue detection over the fake', () => {
  test('finds every library', () => {
    expect(refs.map((r) => `${r.lib}:${r.name}`)).toEqual([
      'bullmq:canvas-queue', 'bullmq:email-queue', 'bullmq:report-queue', 'bullmq:transcription-queue',
      'sidekiq:mailers', 'laravel:default', 'celery:celery', 'rq:default', 'asynq:critical', 'resque:jobs'
    ]);
    expect(q('bullmq', 'email-queue').version).toBe('5.81.3');
  });
  test('never sends KEYS', () => { expect(fake.log.some((l) => l[0]?.toUpperCase() === 'KEYS')).toBe(false); });
});

describe('BullMQ', () => {
  test('counts, paused, workers, throughput', async () => {
    const a = queueAdapter('bullmq');
    expect(await a.counts(q('bullmq', 'email-queue'), read)).toEqual({ waiting: 12, active: 1, delayed: 2, failed: 3, paused: false });
    expect(await a.counts(q('bullmq', 'canvas-queue'), read)).toMatchObject({ waiting: 4, paused: true });
    const names = fake.extraClients.map((c) => c.name);
    expect(await a.workers(q('bullmq', 'email-queue'), read, names)).toBe(1);
    expect(await a.workers(q('bullmq', 'canvas-queue'), read, names)).toBe(0);
    const done = await a.done(q('bullmq', 'email-queue'), read, Date.now());
    expect(done).toHaveLength(26);
    expect(done!.reduce((x, y) => x + y, 0)).toBeGreaterThan(90);
  });
  test('failed jobs newest first, with stacks; one job by id', async () => {
    const a = queueAdapter('bullmq');
    const jobs = await a.jobs(q('bullmq', 'email-queue'), read, 'failed', 0, 50);
    expect(jobs.map((j) => j.id)).toEqual(['8812', '8809', '8801']);
    expect(jobs[0]).toMatchObject({ name: 'send-receipt', reason: 'connect ECONNREFUSED 127.0.0.1:1025', attempts: 3, maxAttempts: 3, key: 'bull:email-queue:8812' });
    const one = await a.job(q('bullmq', 'email-queue'), read, 'failed', '8812');
    expect(one?.stacks).toHaveLength(3);
    expect((one?.data as { to: string }).to).toBe('m.rossi@example.com');
    const waiting = await a.jobs(q('bullmq', 'email-queue'), read, 'waiting', 0, 5);
    expect(waiting).toHaveLength(5);
    const delayed = await a.jobs(q('bullmq', 'email-queue'), read, 'delayed', 0, 5);
    expect(delayed).toHaveLength(2);
    expect(delayed[0]!.at).toBeGreaterThan(Date.now());
  });
});

describe('the other libraries', () => {
  test('Sidekiq: counts from the queue list, retry entries and processes', async () => {
    const a = queueAdapter('sidekiq');
    expect(await a.counts(q('sidekiq', 'mailers'), read)).toEqual({ waiting: 1, active: 0, delayed: 0, failed: 1, paused: false });
    expect(await a.workers(q('sidekiq', 'mailers'), read, [])).toBe(1);
    // Two queues counted in one pass read Sidekiq's shared sets once.
    const before = fake.log.filter((l) => l[0] === 'ZRANGE' && l[1] === 'retry').length;
    const pass: typeof read = (cmds) => read(cmds);
    await a.counts(q('sidekiq', 'mailers'), pass);
    await a.counts({ ...q('sidekiq', 'mailers'), id: 'sidekiq||other', name: 'other' }, pass);
    expect(fake.log.filter((l) => l[0] === 'ZRANGE' && l[1] === 'retry').length - before).toBe(1);
    const failed = await a.jobs(q('sidekiq', 'mailers'), read, 'failed', 0, 50);
    expect(failed[0]).toMatchObject({ id: 'b4a577edbccf1d805744efa9', name: 'HardWorker', reason: 'NoMethodError: undefined method' });
  });
  test('Laravel with Horizon failures', async () => {
    const a = queueAdapter('laravel');
    expect(await a.counts(q('laravel', 'default'), read)).toEqual({ waiting: 1, active: 0, delayed: 0, failed: 1, paused: false });
    const w = await a.jobs(q('laravel', 'default'), read, 'waiting', 0, 50);
    expect(w[0]).toMatchObject({ id: 'u-1', name: 'App\\Jobs\\SendMail' });
    const f = await a.jobs(q('laravel', 'default'), read, 'failed', 0, 50);
    expect(f[0]).toMatchObject({ id: 'h-1', reason: 'RuntimeException: card declined in /app/app/Jobs/Charge.php:22' });
    expect(a.command(q('laravel', 'default'), f[0]!, 'failed')).toBe('php artisan queue:retry h-1');
  });
  test('Celery, RQ, Asynq, Resque', async () => {
    expect(await queueAdapter('celery').counts(q('celery', 'celery'), read)).toMatchObject({ waiting: 1, failed: 1 });
    expect((await queueAdapter('celery').jobs(q('celery', 'celery'), read, 'failed', 0, 50))[0]).toMatchObject({ id: 'c-2', reason: 'ValueError: bad' });
    expect(await queueAdapter('rq').counts(q('rq', 'default'), read)).toEqual({ waiting: 1, active: 0, delayed: 0, failed: 1, paused: false });
    expect(await queueAdapter('rq').workers(q('rq', 'default'), read, [])).toBe(1);
    expect((await queueAdapter('rq').jobs(q('rq', 'default'), read, 'failed', 0, 50))[0]).toMatchObject({ id: 'r-1', reason: 'ValueError: nope' });
    expect(queueAdapter('rq').command(q('rq', 'default'), { id: 'r-1' } as never, 'failed')).toBe('rq requeue --queue default r-1');
    // Names and ids come from Redis data: shell-quoted when they aren't plain.
    expect(queueAdapter('rq').command({ ...q('rq', 'default'), name: 'x; rm -rf ~' }, { id: "a'b" } as never, 'failed')).toBe("rq requeue --queue 'x; rm -rf ~' 'a'\\''b'");
    expect(queueAdapter('asynq').command({ ...q('asynq', 'critical'), name: 'a b' }, { id: '$(x)' } as never, 'failed')).toBe("asynq task run --queue='a b' --id='$(x)'");
    expect(queueAdapter('laravel').command(q('laravel', 'default'), { id: '1;x' } as never, 'failed')).toBe("php artisan queue:retry '1;x'");
    expect(await queueAdapter('asynq').counts(q('asynq', 'critical'), read)).toEqual({ waiting: 0, active: 0, delayed: 0, failed: 1, paused: false });
    expect((await queueAdapter('asynq').jobs(q('asynq', 'critical'), read, 'failed', 0, 50))[0]).toMatchObject({ id: 'a-1', name: 'email:send', reason: 'smtp down' });
    expect(await queueAdapter('resque').counts(q('resque', 'jobs'), read)).toMatchObject({ waiting: 1, failed: 1 });
    expect(await queueAdapter('resque').workers(q('resque', 'jobs'), read, [])).toBe(1);
    expect((await queueAdapter('resque').jobs(q('resque', 'jobs'), read, 'failed', 0, 50))[0]).toMatchObject({ name: 'Archive', reason: 'Resque::TermException: SIGTERM' });
  });
  test('reading never writes', () => { expect(fake.writes).toEqual([]); });
});

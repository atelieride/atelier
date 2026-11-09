import { describe, expect, test } from 'vitest';
import { compileQueues } from './redis-queues';
import { demoSeeds } from './redis';
import { T0 } from './sessions';

// The queues through main's own adapters at build time: what RedisHub would list
// for the acme-store and the other libraries' small queues.

describe('compileQueues', async () => {
  const q = await compileQueues(demoSeeds(T0), T0);
  const byName = (lib: string, name: string) => q.infos.find((i) => i.lib === lib && i.name === name)!;

  test("every library's queue is detected, BullMQ's four with their counts", () => {
    expect(new Set(q.infos.map((i) => i.lib))).toEqual(new Set(['bullmq', 'sidekiq', 'laravel', 'celery', 'rq', 'asynq', 'resque']));
    expect(byName('bullmq', 'email-queue')).toMatchObject({ version: '5.81.3', counts: { waiting: 12, active: 1, delayed: 2, failed: 3, paused: false }, workers: 1, actions: true });
    expect(byName('bullmq', 'canvas-queue').counts).toMatchObject({ waiting: 4, paused: true });
    expect(byName('bullmq', 'email-queue').done).toHaveLength(26);
  });

  test("email-queue's failed jobs: newest first, summarized for the list, in full (stacks, data, command) for the detail", () => {
    const failed = q.jobs[byName('bullmq', 'email-queue').id]!.failed!;
    expect(failed.map((j) => j.summary.id)).toEqual(['8812', '8809', '8801']);
    expect(failed[0]!.summary).toMatchObject({ name: 'send-receipt', reason: 'connect ECONNREFUSED 127.0.0.1:1025', data: null, raw: '' });
    expect(failed[0]!.detail!.job).toMatchObject({ id: '8812', attempts: 3, maxAttempts: 3, data: { orderId: 10442, to: 'm.rossi@example.com' } });
    expect(failed[0]!.detail!.job.stacks).toHaveLength(3);
    expect(failed[0]!.detail!.command).toBeNull();
  });

  test('waiting, active and delayed lists too; a library Atelier does not write to gives its own retry command', () => {
    const email = q.jobs[byName('bullmq', 'email-queue').id]!;
    expect(email.waiting).toHaveLength(12);
    expect(email.active).toHaveLength(1);
    expect(email.delayed).toHaveLength(2);
    const rq = q.infos.find((i) => i.lib === 'rq')!;
    expect(q.jobs[rq.id]!.failed![0]!.detail!.command).toEqual(expect.any(String));
  });
});

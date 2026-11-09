import { describe, expect, test } from 'vitest';
import {
  asynqTask, bullJob, celeryMessage, celeryResult, detectionReads, detectQueues, doneSeries, laravelPayload, queueKeyTest, queueNamespaces,
  resqueFailed, rqJob, sidekiqEntry, workerCount, jobsPrompt, jobPrompt
} from './redis-queues';

describe('detection', () => {
  const keys = [
    'bull:email-queue:meta', 'bull:email-queue:id', 'bull:email-queue:failed', 'bull:email-queue:57',
    'legacy:old:id', 'legacy:old:wait', 'legacy:old:failed',
    'shop_database_queues:default', 'shop_database_queues:default:reserved', 'shop_horizon:failed_jobs',
    'queues', 'queue:mailers', 'stat:processed', 'retry',
    'rq:queues', 'asynq:queues', 'resque:queues', '_kombu.binding.celery', 'celery',
    'cache:a'
  ];
  test('detectionReads: the registry sets and queue metas to read', () => {
    const r = detectionReads(keys);
    expect(r.sets.sort()).toEqual(['_kombu.binding.celery', 'asynq:queues', 'queues', 'resque:queues', 'rq:queues']);
    expect(r.metas).toEqual(['bull:email-queue:meta']);
  });
  test('detectQueues: every library with its prefix', () => {
    const got = detectQueues(keys, {
      sets: { queues: ['mailers'], 'rq:queues': ['rq:queue:default'], 'asynq:queues': ['critical'], 'resque:queues': ['jobs'], '_kombu.binding.celery': ['celery\u0006\u0016\u0006\u0016celery'] },
      metas: { 'bull:email-queue:meta': { 'opts.maxLenEvents': '10000', version: 'bullmq:5.81.3' } }
    });
    expect(got.map((q) => [q.lib, q.prefix, q.name, q.version])).toEqual([
      ['bullmq', 'bull', 'email-queue', '5.81.3'],
      ['bull', 'legacy', 'old', null],
      ['sidekiq', '', 'mailers', null],
      ['laravel', 'shop_database_', 'default', null],
      ['celery', '', 'celery', null],
      ['rq', 'rq:', 'default', null],
      ['asynq', 'asynq:', 'critical', null],
      ['resque', 'resque:', 'jobs', null]
    ]);
    expect(got.find((q) => q.lib === 'laravel')?.horizon).toBe('shop_horizon:');
  });
  test('namespaces owned by queues, and queue keys for the hit ratio', () => {
    const qs = detectQueues(['bull:q:meta', 'shop_database_queues:default'], { sets: {}, metas: { 'bull:q:meta': { version: 'bullmq:5.0.0' } } });
    expect(queueNamespaces(qs, 'shop_database_')).toEqual(['bull', 'queues']);
    const isQ = queueKeyTest(qs);
    expect(isQ('bull:q:wait')).toBe(true);
    expect(isQ('shop_database_queues:default')).toBe(true);
    expect(isQ('cache:x')).toBe(false);
  });
});

describe('jobs', () => {
  test('bullJob: name, reason, attempts (atm or attemptsMade), stacks, options and data', () => {
    const j = bullJob('8812', {
      name: 'send-receipt', data: '{"orderId":10442,"to":"m.rossi@example.com"}', opts: '{"attempts":3,"backoff":{"type":"exponential","delay":5000}}',
      timestamp: '1792055990112', processedOn: '1792056018000', finishedOn: '1792056018100', failedReason: 'connect ECONNREFUSED 127.0.0.1:1025',
      stacktrace: '["Error: connect ECONNREFUSED 127.0.0.1:1025\\n    at TCPConnectWrap.afterConnect (node:net:1607:16)","Error: x\\n    at y"]', atm: '3'
    }, 'bull:email-queue:8812');
    expect(j).toMatchObject({ id: '8812', name: 'send-receipt', reason: 'connect ECONNREFUSED 127.0.0.1:1025', attempts: 3, maxAttempts: 3, at: 1792056018100, queuedAt: 1792055990112, backoff: 'exponential, 5 s', key: 'bull:email-queue:8812' });
    expect(j.stacks).toHaveLength(2);
    expect(j.stacks[0]![0]).toContain('ECONNREFUSED');
    expect(j.data).toEqual({ orderId: 10442, to: 'm.rossi@example.com' });
    expect(bullJob('1', { attemptsMade: '2', opts: '{}' }, 'k').attempts).toBe(2);
  });
  test('sidekiqEntry', () => {
    const j = sidekiqEntry('{"class":"HardWorker","args":[1,"x"],"jid":"b4a577edbccf1d805744efa9","queue":"default","retry_count":2,"retry":5,"error_message":"undefined method","error_class":"NoMethodError","failed_at":1792055990.5,"error_backtrace":["app/workers/hard_worker.rb:5"]}');
    expect(j).toMatchObject({ id: 'b4a577edbccf1d805744efa9', name: 'HardWorker', reason: 'NoMethodError: undefined method', attempts: 3, maxAttempts: 6, at: 1792055990500 });
    expect(j.stacks[0]).toEqual(['app/workers/hard_worker.rb:5']);
  });
  test('laravelPayload, celery, rq, asynq, resque', () => {
    expect(laravelPayload('{"uuid":"u-1","displayName":"App\\\\Jobs\\\\SendMail","maxTries":3,"attempts":1,"data":{"commandName":"App\\\\Jobs\\\\SendMail"}}')).toMatchObject({ id: 'u-1', name: 'App\\Jobs\\SendMail', attempts: 1, maxAttempts: 3 });
    const body = Buffer.from('[[1, 2], {}, {}]').toString('base64');
    expect(celeryMessage(`{"body":"${body}","headers":{"task":"tasks.add","id":"c-1","retries":0,"argsrepr":"(1, 2)"}}`)).toMatchObject({ id: 'c-1', name: 'tasks.add', attempts: 0 });
    expect(celeryResult('{"status":"FAILURE","result":{"exc_type":"ValueError","exc_message":["bad"]},"traceback":"Traceback (most recent call last):\\n  File \\"tasks.py\\", line 4","task_id":"c-2","date_done":"2026-10-15T09:40:00.000000"}')).toMatchObject({ id: 'c-2', reason: 'ValueError: bad' });
    expect(rqJob('r-1', { description: 'app.tasks.send(1)', status: 'failed', exc_info: 'Traceback (most recent call last):\nValueError: nope', enqueued_at: '2026-10-15T09:40:00.000000Z', ended_at: '2026-10-15T09:41:00.000000Z' })).toMatchObject({ id: 'r-1', name: 'app.tasks.send(1)', reason: 'ValueError: nope' });
    // TaskMessage: type=1 "email:send", id=3 "a-1", retry=5 25, retried=6 2, error_msg=7 "smtp down"
    const msg = Buffer.from([0x0a, 10, ...Buffer.from('email:send'), 0x1a, 3, ...Buffer.from('a-1'), 0x28, 25, 0x30, 2, 0x3a, 9, ...Buffer.from('smtp down')]);
    expect(asynqTask('a-1', { msg: msg.toString('latin1'), state: 'retry' })).toMatchObject({ id: 'a-1', name: 'email:send', reason: 'smtp down', attempts: 2, maxAttempts: 25 });
    expect(resqueFailed('{"failed_at":"2026/10/15 09:40:00 UTC","payload":{"class":"Archive","args":[5]},"exception":"Resque::TermException","error":"SIGTERM","backtrace":["lib/a.rb:1"],"queue":"jobs"}', 0)).toMatchObject({ id: '0', name: 'Archive', reason: 'Resque::TermException: SIGTERM' });
  });
});

describe('workers, throughput, prompts', () => {
  test('workerCount from BullMQ connection names', () => {
    const names = ['bull:ZW1haWwtcXVldWU=', 'bull:ZW1haWwtcXVldWU=:w:mailer', 'bull:cmVwb3J0LXF1ZXVl', 'api'];
    expect(workerCount('bull', 'email-queue', names)).toBe(2);
    expect(workerCount('bull', 'canvas-queue', names)).toBe(0);
  });
  test('doneSeries: completed events by minute, oldest first', () => {
    const now = 1_000_000_000_000;
    const ev = [{ id: `${now - 30_000}-0`, event: 'completed' }, { id: `${now - 50_000}-0`, event: 'completed' }, { id: `${now - 90_000}-0`, event: 'completed' }, { id: `${now - 10_000}-0`, event: 'failed' }];
    const s = doneSeries(ev, now, 4);
    expect(s).toEqual([0, 0, 1, 2]);
  });
  test('prompts mask secrets and emails and carry the stack', () => {
    const j = bullJob('8812', { name: 'send-receipt', data: '{"to":"m.rossi@example.com","apiKey":"sk_live_abcdef"}', failedReason: 'boom', stacktrace: '["Error: boom\\n    at send (src/jobs/send.ts:31:9)"]', opts: '{"attempts":3}', atm: '3' }, 'bull:q:8812');
    const p = jobPrompt({ lib: 'bullmq', queue: 'email-queue', instance: 'redis 8.4 · :6379' }, j);
    expect(p).toContain('src/jobs/send.ts:31:9');
    expect(p).toContain('m••••@example.com');
    expect(p).not.toContain('sk_live_abcdef');
    expect(jobsPrompt({ lib: 'bullmq', queue: 'email-queue', instance: 'x' }, [j, j])).toContain('2 failed jobs');
  });
});

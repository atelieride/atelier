// The fictional Redis keyspace of the acme-store — cache, sessions,
// rate limits, a leaderboard, an event stream, feature flags — and BullMQ queues with failed jobs; plus one small queue
// of each other library. Pure data as a function of "now": tests/support/redis-fixtures.ts applies a seed to the fake
// Redis (keys in this order, which SCAN follows), the browser demo compiles it at build time.

export type SeedValue =
  | { type: 'string'; v: string }
  | { type: 'hash'; v: Record<string, string | Uint8Array> }
  | { type: 'list'; v: string[] }
  | { type: 'set'; v: string[] }
  | { type: 'zset'; v: Record<string, number> }
  | { type: 'stream'; v: { id: string; fields: Record<string, string> }[]; groups?: { name: string; consumers: number; pending: number; lag: number }[] }
  | { type: 'ReJSON-RL'; v: string };

/** One write, in order: a later write of the same key replaces the value and keeps the key's place. */
export interface SeedKey { key: string; value: SeedValue; ttlMs?: number; db?: number }
export interface SeedClient { id: number; addr: string; name: string; db: number; cmd: string; idle: number; lib?: string }
export interface SeedSlow { at: number; micros: number; args: string[]; addr: string; name: string }
export interface RedisSeed { keys: SeedKey[]; clients: SeedClient[]; slowlog: SeedSlow[] }

export interface FailedJob { id: string; name: string; reason: string; data: Record<string, unknown> }
export interface BullQueueOptions { paused?: boolean; waiting?: number; active?: number; delayed?: number; failed?: FailedJob[]; completedPerMin?: number[]; prefix?: string }

const utf8 = new TextEncoder();
/** Base64 of a UTF-8 string with the browser's btoa (the world runs in the demo too). */
const b64 = (s: string) => btoa(String.fromCharCode(...utf8.encode(s)));

const str = (key: string, v: string, ttlMs?: number, db?: number): SeedKey => ({ key, value: { type: 'string', v }, ...(ttlMs !== undefined ? { ttlMs } : {}), ...(db !== undefined ? { db } : {}) });
const hash = (key: string, v: Record<string, string | Uint8Array>, ttlMs?: number): SeedKey => ({ key, value: { type: 'hash', v }, ...(ttlMs !== undefined ? { ttlMs } : {}) });
const list = (key: string, v: string[]): SeedKey => ({ key, value: { type: 'list', v } });
const set = (key: string, v: string[]): SeedKey => ({ key, value: { type: 'set', v } });
const zset = (key: string, v: Record<string, number>): SeedKey => ({ key, value: { type: 'zset', v } });

const products = (page: number) => JSON.stringify({
  page, perPage: 24, total: 412, generatedAt: '2026-10-15T09:42:15.877Z',
  items: [
    { id: 8812, sku: 'MUG-CERAMIC-BLK', name: 'Ceramic mug, black', price: { amount: 1800, currency: 'EUR' }, inStock: true, tags: ['kitchen', 'gift'] },
    { id: 8813, sku: 'MUG-CERAMIC-WHT', name: 'Ceramic mug, white', price: { amount: 1800, currency: 'EUR' }, inStock: true, tags: ['kitchen'] },
    { id: 8814, sku: 'TEA-SENCHA-100', name: 'Sencha tea, 100 g', price: { amount: 1250, currency: 'EUR' }, inStock: false, tags: ['tea'] }
  ],
  facets: { color: ['black', 'white'], material: ['ceramic'], price: { min: 900, max: 4900 } }
});

/** The BullMQ layout of one queue (5.x): meta, id, lists, sets, job hashes and the events stream. */
export function bullQueueSeed(name: string, o: BullQueueOptions, now: number): SeedKey[] {
  const p = `${o.prefix ?? 'bull'}:${name}`;
  const out: SeedKey[] = [];
  out.push(hash(`${p}:meta`, { 'opts.maxLenEvents': '10000', version: 'bullmq:5.81.3', ...(o.paused ? { paused: '1' } : {}) }));
  let id = 8790;
  const job = (state: string, extra: Record<string, string> = {}) => {
    const jid = String(++id);
    out.push(hash(`${p}:${jid}`, { name: name === 'email-queue' ? 'send-receipt' : 'build-report', data: JSON.stringify({ orderId: 10400 + id - 8790 }), opts: JSON.stringify({ attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000 }), timestamp: String(now - 120_000), atm: '0', ...extra }));
    return jid;
  };
  const wait = Array.from({ length: o.waiting ?? 0 }, () => job('wait'));
  if (wait.length) out.push(list(`${p}:wait`, wait.reverse()));
  const active = Array.from({ length: o.active ?? 0 }, () => job('active', { processedOn: String(now - 8000), atm: '1' }));
  if (active.length) out.push(list(`${p}:active`, active));
  const delayed: Record<string, number> = {};
  for (let i = 0; i < (o.delayed ?? 0); i++) delayed[job('delayed', { delay: '60000' })] = (now + 60_000) * 4096;
  if (Object.keys(delayed).length) out.push(zset(`${p}:delayed`, delayed));
  const failed: Record<string, number> = {};
  (o.failed ?? []).forEach((j, i) => {
    const finished = now - 120_000 - i * 150_000;
    out.push(hash(`${p}:${j.id}`, {
      name: j.name, data: JSON.stringify(j.data), opts: JSON.stringify({ attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000 }),
      timestamp: String(finished - 16_000), processedOn: String(finished - 100), finishedOn: String(finished), failedReason: j.reason, atm: '3', ats: '3',
      stacktrace: JSON.stringify([1, 2, 3].map(() => `Error: ${j.reason}\n    at TCPConnectWrap.afterConnect (node:net:1607:16)\n    at sendReceipt (/app/src/jobs/send-receipt.ts:31:9)\n    at Worker.processJob (/app/node_modules/bullmq/dist/cjs/classes/worker.js:802:22)`))
    }));
    failed[j.id] = finished;
  });
  if (Object.keys(failed).length) out.push(zset(`${p}:failed`, failed));
  out.push(str(`${p}:id`, String(id)));
  const events = (o.completedPerMin ?? []).flatMap((n, i, all) => Array.from({ length: n }, (_, k) => ({ id: `${now - (all.length - 1 - i) * 60_000 - k * 1000}-0`, fields: { event: 'completed', jobId: String(8000 + i * 10 + k), prev: 'active' } })));
  out.push({ key: `${p}:events`, value: { type: 'stream', v: events.sort((a, b) => a.id.localeCompare(b.id)) } });
  return out;
}

/** The acme-store's keyspace, BullMQ queues, connected clients and slow log. */
export function acmeStoreSeed(now: number): RedisSeed {
  const keys: SeedKey[] = [
    str('cache:products:page:1', products(1), 54_000),
    str('cache:products:page:2', products(2), 41_000),
    str('cache:products:page:3', products(3), 12_000),
    hash('cache:product:8812', { id: '8812', sku: 'MUG-CERAMIC-BLK', name: 'Ceramic mug, black', price_amount: '1800', currency: 'EUR', stock: '37', updated_at: '2026-10-15 09:31:07', variants: '[{"color":"black","size":"350ml"}]' }, 192_000),
    str('cache:categories:tree', JSON.stringify({ roots: [{ id: 1, name: 'Kitchen', children: [{ id: 11, name: 'Mugs' }, { id: 12, name: 'Teapots' }] }, { id: 2, name: 'Tea', children: [] }] }), 58 * 60_000),
    str('cache:home:hero:it', '<section class="hero">Spedizione gratuita sopra i 49 €</section>', 22 * 60_000),
    set('cache:tags:product:8812', ['cache:products:page:1', 'cache:products:page:2', 'cache:product:8812']),
    str('cache:search:q=mug', JSON.stringify({ q: 'mug', hits: [8812, 8813] }), 4 * 60_000),
    ...Array.from({ length: 14 }, (_, i) => str(`cache:legacy:banner:${i}`, JSON.stringify({ v: i }))),
    hash('sess:u:4021:a91f', { user_id: '4021', csrf: 'f3a9c0d1e2b4', cart_id: 'c_88a1', locale: 'it-IT', created_at: '2026-10-15 07:44:02', ua: 'Mozilla/5.0 (Macintosh) Safari/605' }, 7_080_000),
    hash('sess:u:4022:77c0', { user_id: '4022', csrf: '9b8a7c6d5e4f', locale: 'en-GB' }, 2_460_000),
    hash('sess:guest:0b3e', { locale: 'it-IT' }, 720_000),
    str('rate:login:ip:127.0.0.1', '17', 47_000),
    str('rate:api:user:4021', '112', 31_000),
    str('rate:checkout:user:4021', '2', 240_000),
    zset('leaderboard:bestsellers:week', { 'product:8812': 1204, 'product:7731': 988, 'product:8813': 871, 'product:5120': 640, 'product:9002': 512, 'product:4410': 497, 'product:7004': 388 }),
    {
      key: 'events:orders',
      value: {
        type: 'stream',
        v: [
          { id: `${now - 300_000}-0`, fields: { type: 'order.shipped', order: '10437' } },
          { id: `${now - 160_000}-0`, fields: { type: 'order.created', order: '10441' } },
          { id: `${now - 130_000}-0`, fields: { type: 'order.failed', order: '10441', reason: 'jwt_expired' } },
          { id: `${now - 20_000}-0`, fields: { type: 'order.created', order: '10442' } },
          { id: `${now - 16_000}-0`, fields: { type: 'order.paid', order: '10442', total: '54.00' } }
        ],
        groups: [{ name: 'mailer', consumers: 1, pending: 0, lag: 0 }]
      }
    },
    { key: 'feature-flags:storefront', value: { type: 'ReJSON-RL', v: JSON.stringify({ newCheckout: true, giftWrap: false, searchV2: { enabled: true, rollout: 0.25 }, banner: 'Spedizione gratuita sopra i 49 €' }) } },
    str('2fa:verified:4021', '1', 600_000),
    ...bullQueueSeed('email-queue', {
      waiting: 12, active: 1, delayed: 2, completedPerMin: [3, 5, 4, 6, 2, 4, 5, 7, 3, 4, 6, 5, 4, 3, 5, 6, 4, 2, 5, 4, 6, 3, 4, 5, 4, 4],
      failed: [
        { id: '8812', name: 'send-receipt', reason: 'connect ECONNREFUSED 127.0.0.1:1025', data: { orderId: 10442, to: 'm.rossi@example.com', template: 'receipt-it', total: { amount: 5400, currency: 'EUR' } } },
        { id: '8809', name: 'send-receipt', reason: 'connect ECONNREFUSED 127.0.0.1:1025', data: { orderId: 10439, to: 'l.bianchi@example.com', template: 'receipt-it' } },
        { id: '8801', name: 'send-welcome', reason: 'connect ECONNREFUSED 127.0.0.1:1025', data: { userId: 4022, to: 'g.verdi@example.com', template: 'welcome-en' } }
      ]
    }, now),
    ...bullQueueSeed('report-queue', { active: 1, completedPerMin: [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0] }, now),
    ...bullQueueSeed('transcription-queue', {}, now),
    ...bullQueueSeed('canvas-queue', { paused: true, waiting: 4 }, now),
    ...Array.from({ length: 12 }, (_, i) => str(`test:fixture:${i}`, String(i), undefined, 1))
  ];
  const clients: SeedClient[] = [
    { id: 101, addr: '127.0.0.1:50211', name: 'api', db: 0, cmd: 'get', idle: 0, lib: 'ioredis' },
    { id: 102, addr: '127.0.0.1:50212', name: `bull:${b64('email-queue')}`, db: 0, cmd: 'bzpopmin', idle: 0, lib: 'ioredis' },
    { id: 103, addr: '127.0.0.1:50213', name: `bull:${b64('report-queue')}`, db: 0, cmd: 'evalsha', idle: 2, lib: 'ioredis' },
    { id: 104, addr: '127.0.0.1:50214', name: `bull:${b64('transcription-queue')}`, db: 0, cmd: 'bzpopmin', idle: 1, lib: 'ioredis' }
  ];
  const slowlog: SeedSlow[] = [
    { at: now - 12 * 60_000, micros: 48_000, args: ['KEYS', 'cache:products:*'], addr: '127.0.0.1:50211', name: 'api' },
    { at: now - 31 * 60_000, micros: 21_000, args: ['SMEMBERS', 'cache:tags:all'], addr: '127.0.0.1:50211', name: 'api' },
    { at: now - 45 * 60_000, micros: 12_000, args: ['DEL', 'cache:categories:tree'], addr: '127.0.0.1:50211', name: 'api' }
  ];
  return { keys, clients, slowlog };
}

/** One small queue of each other library (layouts as their docs describe them). */
export function otherQueuesSeed(now: number): RedisSeed {
  // Asynq's task message: a protobuf (type, id, queue, retry, retried, error message).
  const field = (tag: number, s: string) => { const b = utf8.encode(s); return [tag, b.length, ...b]; };
  const msg = new Uint8Array([...field(0x0a, 'email:send'), ...field(0x1a, 'a-1'), ...field(0x22, 'critical'), 0x28, 25, 0x30, 25, ...field(0x3a, 'smtp down')]);
  const keys: SeedKey[] = [
    // Sidekiq
    set('queues', ['mailers']),
    list('queue:mailers', [JSON.stringify({ class: 'WelcomeMailer', args: [7], jid: 'aaa111', queue: 'mailers', enqueued_at: now / 1000 })]),
    zset('retry', { [JSON.stringify({ class: 'HardWorker', args: [1, 'x'], jid: 'b4a577edbccf1d805744efa9', queue: 'mailers', retry_count: 2, retry: 5, error_message: 'undefined method', error_class: 'NoMethodError', failed_at: now / 1000 - 60 })]: now / 1000 + 300 }),
    str('stat:processed', '1204'),
    set('processes', ['host:123:abc']),
    hash('host:123:abc', { info: JSON.stringify({ hostname: 'host', pid: 123, queues: ['mailers', 'default'], concurrency: 5 }), busy: '0' }),
    // Laravel + Horizon
    list('shop_database_queues:default', [JSON.stringify({ uuid: 'u-1', displayName: 'App\\Jobs\\SendMail', maxTries: 3, attempts: 0, data: { commandName: 'App\\Jobs\\SendMail', command: 'O:17:"App\\Jobs\\SendMail":1:{s:5:"email";s:15:"a@b.example.com";}' } })]),
    zset('shop_horizon:failed_jobs', { 'h-1': -(now / 1000 - 30) }),
    hash('shop_horizon:h-1', { id: 'h-1', queue: 'default', status: 'failed', payload: JSON.stringify({ uuid: 'h-1', displayName: 'App\\Jobs\\Charge', maxTries: 1, attempts: 1 }), exception: 'RuntimeException: card declined in /app/app/Jobs/Charge.php:22\n#0 /app/vendor/laravel/framework/src/Illuminate/Queue/CallQueuedHandler.php(130)', failed_at: String(now / 1000 - 30) }),
    // Celery
    set('_kombu.binding.celery', ['celery\u0006\u0016\u0006\u0016celery']),
    list('celery', [JSON.stringify({ body: b64('[[1, 2], {}, {}]'), headers: { task: 'tasks.add', id: 'c-1', retries: 0, argsrepr: '(1, 2)' } })]),
    str('celery-task-meta-c-2', JSON.stringify({ status: 'FAILURE', result: { exc_type: 'ValueError', exc_message: ['bad'] }, traceback: 'Traceback (most recent call last):\n  File "tasks.py", line 4, in add\nValueError: bad', task_id: 'c-2', date_done: new Date(now - 60_000).toISOString() })),
    // RQ
    set('rq:queues', ['rq:queue:default']),
    list('rq:queue:default', ['r-0']),
    hash('rq:job:r-0', { description: 'app.tasks.resize(42)', status: 'queued', enqueued_at: new Date(now - 5000).toISOString().replace('Z', '') }),
    zset('rq:failed:default', { 'r-1': now / 1000 - 60 }),
    hash('rq:job:r-1', { description: 'app.tasks.send(1)', status: 'failed', exc_info: 'Traceback (most recent call last):\n  File "app/tasks.py", line 9, in send\nValueError: nope', enqueued_at: new Date(now - 90_000).toISOString().replace('Z', ''), ended_at: new Date(now - 60_000).toISOString().replace('Z', '') }),
    set('rq:workers:default', ['rq:worker:w1']),
    // Asynq
    set('asynq:queues', ['critical']),
    zset('asynq:{critical}:archived', { 'a-1': now / 1000 - 30 }),
    hash('asynq:{critical}:t:a-1', { msg, state: 'archived' }),
    // Resque
    set('resque:queues', ['jobs']),
    list('resque:queue:jobs', [JSON.stringify({ class: 'Archive', args: [5] })]),
    list('resque:failed', [JSON.stringify({ failed_at: '2026/10/15 09:40:00 UTC', payload: { class: 'Archive', args: [5] }, exception: 'Resque::TermException', error: 'SIGTERM', backtrace: ['lib/archive.rb:12'], queue: 'jobs' })]),
    set('resque:workers', ['host:77:jobs'])
  ];
  return { keys, clients: [], slowlog: [] };
}

/** The live demo's keyspace: the acme-store and one small queue of each other library. */
export const demoRedisSeeds = (now: number): RedisSeed[] => [acmeStoreSeed(now), otherQueuesSeed(now)];

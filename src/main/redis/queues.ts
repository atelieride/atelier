// Queue adapters: each library read through its own layout — counts, workers, throughput, jobs —
// with reads only (pipelines through the client's allowlist). Retry and Remove live in writes.ts.
import { inflateSync } from 'node:zlib';
import {
  asynqTask, bullJob, celeryMessage, celeryResult, detectionReads, detectQueues, doneSeries, horizonFailed, laravelPayload, resqueFailed, resqueItem,
  rqJob, sidekiqEntry, workerCount, type JobInfo, type JobState, type QueueCounts, type QueueLib, type QueueRef
} from '@shared/redis-queues';
import { shellArg } from '@shared/redis';
import { RespError, text, type Arg, type Reply } from './resp';

export type Read = (cmds: Arg[][]) => Promise<Reply[]>;

export interface Adapter {
  counts(q: QueueRef, read: Read): Promise<QueueCounts>;
  /** `clients`: CLIENT LIST names, null when not readable. */
  workers(q: QueueRef, read: Read, clients: string[] | null): Promise<number | null>;
  done(q: QueueRef, read: Read, now: number): Promise<number[] | null>;
  jobs(q: QueueRef, read: Read, list: JobState, start: number, count: number): Promise<JobInfo[]>;
  job(q: QueueRef, read: Read, list: JobState, id: string): Promise<JobInfo | null>;
  /** The command that retries a failed job in its own tooling, for libraries Atelier doesn't write to. */
  command(q: QueueRef, job: JobInfo, list: JobState): string | null;
}

const num = (r: Reply | undefined): number => (typeof r === 'number' ? r : Number(text(r ?? null)) || 0);
const arr = (r: Reply | undefined): Reply[] => (Array.isArray(r) ? r : []);
const strs = (r: Reply | undefined): string[] => arr(r).map((x) => text(x));
const isErr = (r: Reply | undefined) => r instanceof RespError;

function rawHash(r: Reply | undefined): Map<string, Buffer> {
  const a = arr(r);
  const m = new Map<string, Buffer>();
  for (let i = 0; i + 1 < a.length; i += 2) {
    const v = a[i + 1];
    m.set(text(a[i]!), Buffer.isBuffer(v) ? v : Buffer.from(text(v ?? null)));
  }
  return m;
}
const hash = (r: Reply | undefined, latin1: readonly string[] = []): Record<string, string> =>
  Object.fromEntries([...rawHash(r)].map(([k, v]) => [k, v.toString(latin1.includes(k) ? 'latin1' : 'utf8')]));

/** Zlib-compressed text (RQ's exc_info, Sidekiq's backtrace) inflated; anything else as UTF-8. */
function maybeInflate(b: Buffer): string {
  if (b.length > 2 && b[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(b[1]!)) {
    try { return inflateSync(b, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8'); } catch { /* not zlib */ }
  }
  return b.toString('utf8');
}

/** A page of a list read from its right end (the next job first): Redis lists LPUSHed and popped from the right. */
async function rightPage(read: Read, key: string, start: number, count: number): Promise<string[]> {
  const [len] = await read([['LLEN', key]]);
  const L = num(len);
  if (start >= L) return [];
  const hi = L - 1 - start;
  const lo = Math.max(0, L - start - count);
  const [r] = await read([['LRANGE', key, lo, hi]]);
  return strs(r).reverse();
}

const leftPage = async (read: Read, key: string, start: number, count: number) => strs((await read([['LRANGE', key, start, start + count - 1]]))[0]);

/** Detection: one SCAN pass over at most `maxKeys` keys, then the registry sets and BullMQ metas. */
export async function detect(read: Read, maxKeys: number): Promise<QueueRef[]> {
  const relevant = /:(meta|id|wait|active|failed|completed|delayed|paused|events)$|queues|queue:|horizon:failed_jobs$|^_kombu\.binding\.|(^|:)(stat:processed|processes|retry|dead|schedule)$/;
  const keys: string[] = [];
  let cursor = '0';
  let scanned = 0;
  do {
    const [r] = await read([['SCAN', cursor, 'COUNT', 1000]]);
    const a = arr(r);
    cursor = text(a[0] ?? '0');
    const batch = strs(a[1]);
    scanned += Math.max(batch.length, 1);
    for (const k of batch) if (relevant.test(k)) keys.push(k);
  } while (cursor !== '0' && scanned < maxKeys);
  const { sets, metas } = detectionReads(keys);
  const replies = await read([...sets.map((k) => ['SMEMBERS', k] as Arg[]), ...metas.map((k) => ['HGETALL', k] as Arg[])]);
  const setVals: Record<string, string[]> = {};
  const metaVals: Record<string, Record<string, string>> = {};
  sets.forEach((k, i) => { if (!isErr(replies[i])) setVals[k] = strs(replies[i]); });
  metas.forEach((k, i) => { const r = replies[sets.length + i]; if (!isErr(r)) metaVals[k] = hash(r); });
  return detectQueues(keys, { sets: setVals, metas: metaVals });
}

// —— BullMQ and Bull ——

const bullBase = (q: QueueRef) => `${q.prefix}:${q.name}`;

async function bullHashes(q: QueueRef, read: Read, ids: string[]): Promise<JobInfo[]> {
  if (!ids.length) return [];
  const base = bullBase(q);
  const rs = await read(ids.map((id) => ['HGETALL', `${base}:${id}`]));
  return ids.flatMap((id, i) => { const h = hash(rs[i]); return Object.keys(h).length ? [bullJob(id, h, `${base}:${id}`)] : []; });
}

const bull: Adapter = {
  async counts(q, read) {
    const b = bullBase(q);
    const r = await read([['LLEN', `${b}:wait`], ['LLEN', `${b}:paused`], ['ZCARD', `${b}:prioritized`], ['LLEN', `${b}:active`], ['ZCARD', `${b}:delayed`], ['ZCARD', `${b}:failed`], ['HGET', `${b}:meta`, 'paused'], ['EXISTS', `${b}:meta-paused`]]);
    return { waiting: num(r[0]) + num(r[1]) + num(r[2]), active: num(r[3]), delayed: num(r[4]), failed: num(r[5]), paused: (r[6] !== null && !isErr(r[6])) || num(r[7]) > 0 };
  },
  async workers(q, _read, clients) { return q.lib === 'bullmq' && clients ? workerCount(q.prefix, q.name, clients) : null; },
  async done(q, read, now) {
    if (q.lib !== 'bullmq') return null;
    const [r] = await read([['XRANGE', `${bullBase(q)}:events`, String(now - 26 * 60_000), '+', 'COUNT', 20_000]]);
    if (isErr(r)) return null;
    return doneSeries(arr(r).map((e) => { const [id, fields] = arr(e); const f = strs(fields); const i = f.indexOf('event'); return { id: text(id ?? null), event: i >= 0 ? f[i + 1] ?? '' : '' }; }), now);
  },
  async jobs(q, read, list, start, count) {
    const b = bullBase(q);
    let ids: string[] = [];
    if (list === 'waiting') {
      // Next first: the wait list from its right end, then paused, then prioritized by score.
      const [w, p, z] = await read([['LLEN', `${b}:wait`], ['LLEN', `${b}:paused`], ['ZCARD', `${b}:prioritized`]]);
      const segs: [number, (s: number, c: number) => Promise<string[]>][] = [
        [num(w), (s, c) => rightPage(read, `${b}:wait`, s, c)],
        [num(p), (s, c) => rightPage(read, `${b}:paused`, s, c)],
        [num(z), async (s, c) => strs((await read([['ZRANGE', `${b}:prioritized`, s, s + c - 1]]))[0])]
      ];
      let skip = start;
      for (const [len, page] of segs) {
        if (ids.length >= count) break;
        if (skip >= len) { skip -= len; continue; }
        ids.push(...(await page(skip, count - ids.length)));
        skip = 0;
      }
    } else if (list === 'active') ids = await leftPage(read, `${b}:active`, start, count);
    else if (list === 'delayed') {
      // The score is when it runs: BullMQ 5 packs it as ms × 4096 + a counter, Bull keeps plain ms.
      const a = strs((await read([['ZRANGE', `${b}:delayed`, start, start + count - 1, 'WITHSCORES']]))[0]);
      const due = new Map<string, number>();
      for (let i = 0; i + 1 < a.length; i += 2) { const sc = Number(a[i + 1]); due.set(a[i]!, sc > 1e15 ? Math.floor(sc / 4096) : sc); }
      return (await bullHashes(q, read, [...due.keys()])).map((j) => ({ ...j, at: due.get(j.id) ?? j.at }));
    } else ids = strs((await read([['ZREVRANGE', `${b}:failed`, start, start + count - 1]]))[0]);
    return bullHashes(q, read, ids);
  },
  async job(q, read, _state, id) { return (await bullHashes(q, read, [id]))[0] ?? null; },
  command(q, j) {
    if (q.lib === 'bullmq' && bullActions(q)) return null;
    return q.lib === 'bullmq' ? `await (await Job.fromId(queue, ${JSON.stringify(j.id)}))?.retry()` : `await (await queue.getJob(${JSON.stringify(j.id)}))?.retry()`;
  }
};

/** Retry and Remove are mirrored for BullMQ 5 only (its layout: marker, meta paused, atm). */
export function bullActions(q: QueueRef): boolean {
  return q.lib === 'bullmq' && !!q.version && Number(q.version.split('.')[0]) === 5;
}

// —— Sidekiq ——

/** One read of a library's shared registry per counting pass (a pass reads every queue with the same `read`), for 2 s. */
const passCache = new WeakMap<Read, Map<string, { at: number; p: Promise<unknown> }>>();
function perPass<T>(read: Read, key: string, fn: () => Promise<T>): Promise<T> {
  let m = passCache.get(read);
  if (!m) { m = new Map(); passCache.set(read, m); }
  const hit = m.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.p as Promise<T>;
  const p = fn();
  m.set(key, { at: Date.now(), p });
  return p;
}

interface SidekiqEntry { raw: string; score: number; set: 'retry' | 'dead' | 'schedule'; queue: string }

async function sidekiqSets(q: QueueRef, read: Read, sets: ('retry' | 'dead' | 'schedule')[], limit = 1000): Promise<SidekiqEntry[]> {
  const rs = await read(sets.map((s) => ['ZRANGE', `${q.prefix}${s}`, 0, limit - 1, 'WITHSCORES']));
  return sets.flatMap((set, i) => {
    const a = strs(rs[i]);
    const out: SidekiqEntry[] = [];
    for (let k = 0; k + 1 < a.length; k += 2) {
      let queue = '';
      try { queue = String((JSON.parse(a[k]!) as { queue?: unknown }).queue ?? ''); } catch { /* not JSON */ }
      out.push({ raw: a[k]!, score: Number(a[k + 1]), set, queue });
    }
    return out;
  });
}

function sidekiqJob(raw: string): JobInfo {
  let bt: string[] | undefined;
  try {
    const e = JSON.parse(raw) as { error_backtrace?: unknown };
    // Sidekiq 6+: the backtrace is Base64(zlib(JSON)).
    if (typeof e.error_backtrace === 'string') bt = JSON.parse(maybeInflate(Buffer.from(e.error_backtrace, 'base64'))) as string[];
  } catch { bt = undefined; }
  return sidekiqEntry(raw, Array.isArray(bt) ? bt.map(String) : undefined);
}

async function sidekiqWork(q: QueueRef, read: Read): Promise<{ queue: string; raw: string }[]> {
  const [p] = await read([['SMEMBERS', `${q.prefix}processes`]]);
  const ids = strs(p);
  if (!ids.length) return [];
  const rs = await read(ids.flatMap((id) => [['HGETALL', `${q.prefix}${id}:work`], ['HGETALL', `${q.prefix}${id}:workers`]] as Arg[][]));
  return rs.flatMap((r) => Object.values(hash(r)).flatMap((v) => {
    try {
      const w = JSON.parse(v) as { queue?: unknown; payload?: unknown };
      const payload = typeof w.payload === 'string' ? w.payload : JSON.stringify(w.payload ?? {});
      return [{ queue: String(w.queue ?? ''), raw: payload }];
    } catch { return []; }
  }));
}

const sidekiq: Adapter = {
  async counts(q, read) {
    const [len] = await read([['LLEN', `${q.prefix}queue:${q.name}`]]);
    const entries = await perPass(read, `sk-sets:${q.prefix}`, () => sidekiqSets(q, read, ['schedule', 'retry', 'dead'], 5000));
    const work = await perPass(read, `sk-work:${q.prefix}`, () => sidekiqWork(q, read));
    return {
      waiting: num(len), active: work.filter((w) => w.queue === q.name).length, delayed: entries.filter((e) => e.set === 'schedule' && e.queue === q.name).length,
      failed: entries.filter((e) => e.set !== 'schedule' && e.queue === q.name).length, paused: false
    };
  },
  async workers(q, read) {
    const [p] = await read([['SMEMBERS', `${q.prefix}processes`]]);
    const ids = strs(p);
    if (!ids.length) return 0;
    const rs = await read(ids.map((id) => ['HGET', `${q.prefix}${id}`, 'info']));
    return rs.filter((r) => { try { return ((JSON.parse(text(r)) as { queues?: unknown[] }).queues ?? []).map(String).includes(q.name); } catch { return false; } }).length;
  },
  async done() { return null; },
  async jobs(q, read, list, start, count) {
    if (list === 'waiting') return (await rightPage(read, `${q.prefix}queue:${q.name}`, start, count)).map(sidekiqJob);
    if (list === 'active') return (await sidekiqWork(q, read)).filter((w) => w.queue === q.name).slice(start, start + count).map((w) => sidekiqJob(w.raw));
    const entries = (await sidekiqSets(q, read, list === 'delayed' ? ['schedule'] : ['retry', 'dead'])).filter((e) => e.queue === q.name);
    const jobs = entries.map((e) => sidekiqJob(e.raw));
    if (list === 'failed') jobs.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return jobs.slice(start, start + count);
  },
  async job(q, read, list, id) {
    const pool = list === 'waiting' ? await this.jobs(q, read, list, 0, 10_000) : list === 'active' ? await this.jobs(q, read, list, 0, 1000) : (await sidekiqSets(q, read, list === 'delayed' ? ['schedule'] : ['retry', 'dead'], 10_000)).map((e) => sidekiqJob(e.raw));
    return pool.find((j) => j.id === id) ?? null;
  },
  command() { return null; }
};

/** The Sidekiq retry/dead entry of a job id (for Retry and Remove), with its set and score. */
export async function sidekiqFailedEntry(q: QueueRef, read: Read, jid: string): Promise<SidekiqEntry | null> {
  const entries = await sidekiqSets(q, read, ['retry', 'dead'], 10_000);
  return entries.find((e) => { try { return (JSON.parse(e.raw) as { jid?: unknown }).jid === jid; } catch { return false; } }) ?? null;
}

// —— Laravel (+ Horizon) ——

async function horizonIds(q: QueueRef, read: Read, limit = 500): Promise<string[]> {
  if (!q.horizon) return [];
  const [r] = await read([['ZRANGE', `${q.horizon}failed_jobs`, 0, limit - 1]]);
  const ids = strs(r);
  if (!ids.length) return [];
  const qs = await read(ids.map((id) => ['HGET', `${q.horizon}${id}`, 'queue']));
  return ids.filter((_id, i) => text(qs[i] ?? null) === q.name);
}

const laravel: Adapter = {
  async counts(q, read) {
    const k = `${q.prefix}queues:${q.name}`;
    const r = await read([['LLEN', k], ['ZCARD', `${k}:reserved`], ['ZCARD', `${k}:delayed`]]);
    return { waiting: num(r[0]), active: num(r[1]), delayed: num(r[2]), failed: q.horizon ? (await horizonIds(q, read)).length : null, paused: false };
  },
  async workers() { return null; },
  async done() { return null; },
  async jobs(q, read, list, start, count) {
    const k = `${q.prefix}queues:${q.name}`;
    if (list === 'waiting') return (await leftPage(read, k, start, count)).map(laravelPayload);
    if (list === 'active' || list === 'delayed') {
      const a = strs((await read([['ZRANGE', `${k}:${list === 'active' ? 'reserved' : 'delayed'}`, start, start + count - 1, 'WITHSCORES']]))[0]);
      const out: JobInfo[] = [];
      for (let i = 0; i + 1 < a.length; i += 2) out.push({ ...laravelPayload(a[i]!), at: Number(a[i + 1]) * 1000 });
      return out;
    }
    const ids = (await horizonIds(q, read, 10_000)).slice(start, start + count);
    if (!ids.length) return [];
    const rs = await read(ids.map((id) => ['HGETALL', `${q.horizon}${id}`]));
    return ids.map((id, i) => horizonFailed(id, hash(rs[i])));
  },
  async job(q, read, list, id) { return (await this.jobs(q, read, list, 0, 10_000)).find((j) => j.id === id) ?? null; },
  command(_q, j, list) { return list === 'failed' ? `php artisan queue:retry ${shellArg(j.id)}` : null; }
};

// —— Celery ——

const PRIORITY = ['', '\u0006\u00163', '\u0006\u00166', '\u0006\u00169'];

async function celeryResults(read: Read, limit = 500): Promise<JobInfo[]> {
  const keys: string[] = [];
  let cursor = '0';
  let rounds = 0;
  do {
    const [r] = await read([['SCAN', cursor, 'MATCH', 'celery-task-meta-*', 'COUNT', 1000]]);
    cursor = text(arr(r)[0] ?? '0');
    keys.push(...strs(arr(r)[1]));
  } while (cursor !== '0' && ++rounds < 20 && keys.length < limit);
  if (!keys.length) return [];
  const rs = await read(keys.slice(0, limit).map((k) => ['GET', k]));
  return rs.flatMap((r) => { const s = text(r); return /"status"\s*:\s*"FAILURE"/.test(s) ? [celeryResult(s)] : []; }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

async function celeryUnacked(q: QueueRef, read: Read): Promise<JobInfo[] | null> {
  const [len] = await read([['HLEN', 'unacked']]);
  if (num(len) > 2000) return null;
  if (!num(len)) return [];
  const h = hash((await read([['HGETALL', 'unacked']]))[0]);
  return Object.values(h).flatMap((v) => {
    try { const [msg, , rk] = JSON.parse(v) as [unknown, unknown, unknown]; return rk === q.name ? [celeryMessage(JSON.stringify(msg))] : []; } catch { return []; }
  });
}

const celery: Adapter = {
  async counts(q, read) {
    const r = await read(PRIORITY.map((p) => ['LLEN', `${q.name}${p}`]));
    const active = await celeryUnacked(q, read);
    return { waiting: r.reduce<number>((s, x) => s + num(x), 0), active: active ? active.length : null, delayed: null, failed: (await celeryResults(read)).length, paused: false };
  },
  async workers() { return null; },
  async done() { return null; },
  async jobs(q, read, list, start, count) {
    if (list === 'waiting') return (await rightPage(read, q.name, start, count)).map(celeryMessage);
    if (list === 'active') return ((await celeryUnacked(q, read)) ?? []).slice(start, start + count);
    if (list === 'failed') return (await celeryResults(read)).slice(start, start + count);
    return [];
  },
  async job(q, read, list, id) { return (await this.jobs(q, read, list, 0, 10_000)).find((j) => j.id === id) ?? null; },
  command() { return null; }
};

// —— RQ ——

async function rqJobs(read: Read, ids: string[]): Promise<JobInfo[]> {
  if (!ids.length) return [];
  const rs = await read(ids.flatMap((id) => [['HGETALL', `rq:job:${id}`], ['XREVRANGE', `rq:results:${id}`, '+', '-', 'COUNT', 1]] as Arg[][]));
  return ids.flatMap((id, i) => {
    const raw = rawHash(rs[i * 2]);
    if (!raw.size) return [];
    const h = Object.fromEntries([...raw].filter(([k]) => k !== 'data').map(([k, v]) => [k, k === 'exc_info' ? maybeInflate(v) : v.toString('utf8')]));
    if (!h.exc_info) {
      // RQ 1.12+ keeps the outcome in a results stream.
      const last = arr(rs[i * 2 + 1])[0];
      const f = strs(arr(last)[1]);
      const at = f.indexOf('exc_string');
      if (at >= 0) h.exc_info = f[at + 1] ?? '';
    }
    if (raw.has('data')) h.data = '1';
    return [rqJob(id, h)];
  });
}

const rq: Adapter = {
  async counts(q, read) {
    const r = await read([['LLEN', `rq:queue:${q.name}`], ['ZCARD', `rq:wip:${q.name}`], ['ZCARD', `rq:scheduled:${q.name}`], ['ZCARD', `rq:deferred:${q.name}`], ['ZCARD', `rq:failed:${q.name}`]]);
    return { waiting: num(r[0]), active: num(r[1]), delayed: num(r[2]) + num(r[3]), failed: num(r[4]), paused: false };
  },
  async workers(q, read) { return num((await read([['SCARD', `rq:workers:${q.name}`]]))[0]); },
  async done() { return null; },
  async jobs(q, read, list, start, count) {
    const stop = start + count - 1;
    const ids = list === 'waiting' ? await leftPage(read, `rq:queue:${q.name}`, start, count)
      : list === 'active' ? strs((await read([['ZRANGE', `rq:wip:${q.name}`, start, stop]]))[0])
      : list === 'delayed' ? strs((await read([['ZRANGE', `rq:scheduled:${q.name}`, start, stop]]))[0])
      : strs((await read([['ZREVRANGE', `rq:failed:${q.name}`, start, stop]]))[0]);
    return rqJobs(read, ids);
  },
  async job(_q, read, _state, id) { return (await rqJobs(read, [id]))[0] ?? null; },
  command(q, j, list) { return list === 'failed' ? `rq requeue --queue ${shellArg(q.name)} ${shellArg(j.id)}` : null; }
};

// —— Asynq ——

const asynqBase = (q: QueueRef) => `asynq:{${q.name}}:`;

async function asynqTasks(q: QueueRef, read: Read, ids: string[]): Promise<JobInfo[]> {
  if (!ids.length) return [];
  const rs = await read(ids.map((id) => ['HGETALL', `${asynqBase(q)}t:${id}`]));
  return ids.flatMap((id, i) => { const h = hash(rs[i], ['msg']); return Object.keys(h).length ? [{ ...asynqTask(id, h), key: `${asynqBase(q)}t:${id}` }] : []; });
}

const asynq: Adapter = {
  async counts(q, read) {
    const b = asynqBase(q);
    const r = await read([['LLEN', `${b}pending`], ['LLEN', `${b}active`], ['ZCARD', `${b}scheduled`], ['ZCARD', `${b}retry`], ['ZCARD', `${b}archived`], ['EXISTS', `${b}paused`]]);
    return { waiting: num(r[0]), active: num(r[1]), delayed: num(r[2]) + num(r[3]), failed: num(r[4]), paused: num(r[5]) > 0 };
  },
  async workers() { return null; },
  async done() { return null; },
  async jobs(q, read, list, start, count) {
    const b = asynqBase(q);
    const stop = start + count - 1;
    let ids: string[];
    if (list === 'waiting') ids = await rightPage(read, `${b}pending`, start, count);
    else if (list === 'active') ids = await leftPage(read, `${b}active`, start, count);
    else if (list === 'delayed') {
      const [s, r] = await read([['ZRANGE', `${b}scheduled`, 0, stop, 'WITHSCORES'], ['ZRANGE', `${b}retry`, 0, stop, 'WITHSCORES']]);
      const pairs = (x: Reply | undefined) => { const a = strs(x); const o: [string, number][] = []; for (let i = 0; i + 1 < a.length; i += 2) o.push([a[i]!, Number(a[i + 1])]); return o; };
      ids = [...pairs(s), ...pairs(r)].sort((a, z) => a[1] - z[1]).slice(start, start + count).map(([id]) => id);
    } else ids = strs((await read([['ZREVRANGE', `${b}archived`, start, stop]]))[0]);
    return asynqTasks(q, read, ids);
  },
  async job(q, read, _state, id) { return (await asynqTasks(q, read, [id]))[0] ?? null; },
  command(q, j, list) { return list === 'failed' ? `asynq task run --queue=${shellArg(q.name)} --id=${shellArg(j.id)}` : null; }
};

// —— Resque ——

async function resqueWork(read: Read): Promise<{ id: string; queue: string; raw: string }[]> {
  const ids = strs((await read([['SMEMBERS', 'resque:workers']]))[0]);
  if (!ids.length) return [];
  const rs = await read(ids.map((id) => ['GET', `resque:worker:${id}`]));
  return ids.flatMap((id, i) => {
    try { const w = JSON.parse(text(rs[i] ?? null)) as { queue?: unknown; payload?: unknown }; return [{ id, queue: String(w.queue ?? ''), raw: JSON.stringify(w.payload ?? {}) }]; } catch { return []; }
  });
}

async function resqueFailures(q: QueueRef, read: Read): Promise<JobInfo[]> {
  const items = strs((await read([['LRANGE', 'resque:failed', 0, 999]]))[0]);
  return items.flatMap((s, i) => { try { return (JSON.parse(s) as { queue?: unknown }).queue === q.name ? [resqueFailed(s, i)] : []; } catch { return []; } }).reverse();
}

const resque: Adapter = {
  async counts(q, read) {
    const [len] = await read([['LLEN', `resque:queue:${q.name}`]]);
    return { waiting: num(len), active: (await resqueWork(read)).filter((w) => w.queue === q.name).length, delayed: null, failed: (await resqueFailures(q, read)).length, paused: false };
  },
  async workers(q, read) {
    const ids = strs((await read([['SMEMBERS', 'resque:workers']]))[0]);
    return ids.filter((id) => { const queues = id.split(':').slice(2).join(':').split(','); return queues.includes(q.name) || queues.includes('*'); }).length;
  },
  async done() { return null; },
  async jobs(q, read, list, start, count) {
    if (list === 'waiting') return (await leftPage(read, `resque:queue:${q.name}`, start, count)).map((s, i) => resqueItem(s, start + i));
    if (list === 'active') return (await resqueWork(read)).filter((w) => w.queue === q.name).slice(start, start + count).map((w, i) => resqueItem(w.raw, i));
    if (list === 'failed') return (await resqueFailures(q, read)).slice(start, start + count);
    return [];
  },
  async job(q, read, list, id) { return (await this.jobs(q, read, list, 0, 10_000)).find((j) => j.id === id) ?? null; },
  command(_q, j, list) { return list === 'failed' ? `Resque::Failure.requeue(${Number(j.id) || 0})` : null; }
};

const ADAPTERS: Record<QueueLib, Adapter> = { bullmq: bull, bull, sidekiq, laravel, celery, rq, asynq, resque };

export const queueAdapter = (lib: QueueLib): Adapter => ADAPTERS[lib];

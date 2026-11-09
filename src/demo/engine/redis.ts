// Redis's live part in the demo. The instance, its INFO, clients, slow log
// and queues are compiled (compile/redis.ts, redis-queues.ts: the app's parsers and main's adapters); the keyspace is
// seeded from the world and held in memory (redis-keyspace.ts). This plays what changes, as main's RedisHub sends it:
// - traffic: while a Redis view is on screen, the acme-store's clients keep working — the api reads its cache (a miss
//   refills it with SET … EX 60), slides its sessions, counts rate limits; the BullMQ workers poll — applied to the
//   keyspace, and streamed to the Live tab as monitor lines when it watches;
// - status: INFO's ops/s, memory, hits and expiries move with that traffic, a sample per reading for the sparklines,
//   every 2 s while Overview or Live shows, every 10 s otherwise, never when nothing shows;
// - queues: retry and remove on BullMQ 5 and Sidekiq failures (moved, counted, undoable for 30 s), "seen" failures.
// TTLs run on the visitor's clock; every timer is the engine's clock (paused with the page).
import type { ClientRow, InfoSample, KeyWriteOp, RedisInfo, RedisStatus, RedisWatch, RedisWriteOp, UndoResult, WriteResult } from '@shared/redis';
import { trimMonitorLine, type MonitorLine } from '@shared/redis-monitor';
import type { JobInfo, JobState, QueueInfo } from '@shared/redis-queues';
import type { DemoContext } from '../bridge/context';
import type { CompiledJob } from '../types';
import { demoRedisSeeds, type RedisSeed } from '../world/redis';
import type { Cancel } from './clock';
import { createKeyspace, type Keyspace } from './redis-keyspace';

export const TRAFFIC_MS = 250;
/** main's infoFastMs / infoSlowMs. */
export const STATUS_FAST_MS = 2000;
export const STATUS_SLOW_MS = 10_000;
/** main keeps ten minutes of samples. */
const SAMPLES_MS = 10 * 60_000;

type Rand = () => number;
const ADDR = { api: '127.0.0.1:50211', email: '127.0.0.1:50212', report: '127.0.0.1:50213', transcription: '127.0.0.1:50214' };
const pick = <T>(r: Rand, l: readonly T[]): T => l[Math.floor(r() * l.length)]!;
const sha = (seed: string) => [...seed.padEnd(40, seed)].map((c) => (c.charCodeAt(0) % 16).toString(16)).join('').slice(0, 40);
const MOVE_TO_ACTIVE = sha('moveToActive-11');
const STALLED = sha('moveStalledJobsToWait-8');

export interface RedisEngine {
  status(): RedisStatus;
  watch(w: RedisWatch): void;
  seen(queueId: string): void;
  keyspace: Keyspace;
  clients(): ClientRow[];
  jobs(a: { queue: string; state: JobState; start: number; count: number }): JobInfo[];
  job(a: { queue: string; state: JobState; id: string }): { job: JobInfo; command: string | null } | null;
  write(a: { db: number; op: RedisWriteOp; instance: string }): WriteResult;
  undo(id: string): UndoResult;
}

export function createRedisEngine(ctx: DemoContext, opts: { rand?: Rand; seeds?: RedisSeed[] } = {}): RedisEngine {
  const rand = opts.rand ?? Math.random;
  const { redis } = ctx.world;
  const seeds = opts.seeds ?? demoRedisSeeds(ctx.now());
  const ks = createKeyspace(seeds, ctx.now);
  /** What the api writes back on a cache miss: the value the world started with. */
  const original = new Map(seeds.flatMap((s) => s.keys).map((k) => [k.key, k]));
  const instance = redis.snapshot.pick!;

  // —— queues ——
  const infos: QueueInfo[] = (redis.queues?.infos ?? []).map((q) => ({ ...q, counts: { ...q.counts } }));
  const lists: Record<string, Partial<Record<JobState, CompiledJob[]>>> = Object.fromEntries(Object.entries(redis.queues?.jobs ?? {}).map(([id, byState]) => [id, Object.fromEntries(Object.entries(byState).map(([s, l]) => [s, [...l]]))]));
  // Failures seen at the first reading: only newer ones are "new" (main's baseline).
  const baseline = new Map(infos.map((q) => [q.id, q.counts.failed ?? 0]));

  // —— INFO ——
  const base = redis.status.info!;
  const info: RedisInfo = { ...base, keyspace: ks.counts() };
  const samples: InfoSample[] = [];
  let mem = base.usedMemory;
  const ops: number[] = [];
  const sample = (at: number, o: number) => {
    mem = Math.max(base.usedMemory * 0.9, mem + (base.usedMemory - mem) * 0.2 + (rand() - 0.5) * 60_000);
    samples.push({ at, usedMemory: Math.round(mem), ops: o, hits: info.hits, misses: info.misses, expired: info.expired, evicted: 0 });
    while (samples.length && at - samples[0]!.at > SAMPLES_MS) samples.shift();
  };
  {
    // Ten minutes of readings before the visit, so the tiles open with their sparklines drawn.
    const now = ctx.now();
    for (let i = 60; i > 0; i--) {
      const o = Math.round(base.ops + (rand() - 0.5) * 18);
      info.hits += Math.round(o * 3); info.misses += Math.round(o * 6.4); info.expired += rand() < 0.3 ? 1 : 0;
      sample(now - i * STATUS_FAST_MS * 5, o);
    }
    info.usedMemory = Math.round(mem);
  }

  let watching: RedisWatch = { db: 0, sidebar: false, queues: false, overview: false, live: false };
  const any = () => watching.sidebar || watching.queues || watching.overview || watching.live;
  const fast = () => watching.overview || watching.live;

  const status = (): RedisStatus => {
    const unseen: Record<string, number> = {};
    for (const q of infos) { const n = (q.counts.failed ?? 0) - (baseline.get(q.id) ?? 0); if (n > 0) unseen[q.id] = n; }
    return { ...redis.status, info: { ...info, keyspace: ks.counts() }, samples: [...samples], queues: ctx.state.settings.redisQueues ? infos.map((q) => ({ ...q, counts: { ...q.counts } })) : null, unseen, db: watching.db };
  };
  const pushStatus = () => ctx.events.emit('redisStatus', status());
  const poll = () => {
    info.expired += ks.sweep();
    const now = ctx.now();
    const recent = ops.filter((t) => now - t < 1000).length;
    info.ops = traffic ? Math.max(1, recent) : base.ops;
    info.usedMemory = Math.round(mem);
    sample(now, info.ops);
    pushStatus();
  };

  // —— traffic and the monitor ——
  let traffic: Cancel | null = null;
  let statusTask: Cancel | null = null;
  let statusEvery = 0;
  let nextEmail = 0, nextReport = 0, nextTranscription = 0, nextOrder = 0;
  let order = 10_443;
  const tick = () => {
    const now = ctx.now();
    const out: MonitorLine[] = [];
    const cmd = (addr: string, name: string, args: string[], db = 0) => { out.push(trimMonitorLine({ at: now, db, addr, cmd: name, args })); ops.push(now); };
    const hitsBefore = info.hits;
    const get = (key: string, refill: boolean) => {
      cmd(ADDR.api, 'GET', [key]);
      const v = ks.get(0, key);
      if (v) { info.hits++; return; }
      info.misses++;
      const o = original.get(key);
      if (refill && o?.value.type === 'string') {
        // Cache-aside: read through to Postgres, then SET it back for a minute.
        cmd(ADDR.api, 'SET', [key, o.value.v, 'EX', '60']);
        ks.put(0, key, { type: 'string', v: o.value.v }, 60_000);
      }
    };
    const n = 6 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const x = rand();
      if (x < 0.32) get(`cache:products:page:${1 + Math.floor(rand() * 3)}`, true);
      else if (x < 0.42) { cmd(ADDR.api, 'HGETALL', ['cache:product:8812']); if (ks.get(0, 'cache:product:8812')) info.hits++; else info.misses++; }
      else if (x < 0.55) {
        const key = pick(rand, ['sess:u:4021:a91f', 'sess:u:4022:77c0']);
        cmd(ADDR.api, 'HGETALL', [key]);
        if (ks.get(0, key)) { cmd(ADDR.api, 'EXPIRE', [key, '7200']); ks.expire(0, key, 7_200_000); }
      } else if (x < 0.68) {
        const key = 'rate:api:user:4021';
        cmd(ADDR.api, 'INCR', [key]);
        const v = ks.get(0, key);
        if (v?.type === 'string') v.v = String((Number(v.v) || 0) + 1);
        else { ks.put(0, key, { type: 'string', v: '1' }); cmd(ADDR.api, 'PEXPIRE', [key, '60000']); ks.expire(0, key, 60_000); }
      } else if (x < 0.74) get('cache:search:q=mug', true);
      else if (x < 0.78) { cmd(ADDR.api, 'JSON.GET', ['feature-flags:storefront', '$']); info.hits++; }
      else if (x < 0.82) get('2fa:verified:4021', false);
      else if (x < 0.85) get(`cache:home:hero:it`, true);
      else if (x < 0.87) {
        const member = pick(rand, ['product:8812', 'product:7731', 'product:8813', 'product:5120']);
        cmd(ADDR.api, 'ZINCRBY', ['leaderboard:bestsellers:week', '1', member]);
        const v = ks.get(0, 'leaderboard:bestsellers:week');
        if (v?.type === 'zset') v.v.set(member, (v.v.get(member) ?? 0) + 1);
      } else get('cache:categories:tree', true);
    }
    // The BullMQ workers: blocking polls on the queues' markers, a job moved now and then.
    if (now >= nextEmail) {
      nextEmail = now + 1500 + rand() * 1500;
      cmd(ADDR.email, 'BZPOPMIN', ['bull:email-queue:marker', '5']);
      if (rand() < 0.4) cmd(ADDR.email, 'EVALSHA', [MOVE_TO_ACTIVE, '11', 'bull:email-queue:wait', 'bull:email-queue:active', 'bull:email-queue:prioritized', 'bull:email-queue:events']);
    }
    if (now >= nextReport) { nextReport = now + 5000; cmd(ADDR.report, 'EVALSHA', [STALLED, '8', 'bull:report-queue:stalled', 'bull:report-queue:wait', 'bull:report-queue:active']); }
    if (now >= nextTranscription) { nextTranscription = now + 5000; cmd(ADDR.transcription, 'BZPOPMIN', ['bull:transcription-queue:marker', '5']); }
    if (now >= nextOrder) {
      if (nextOrder) {
        const type = pick(rand, ['order.created', 'order.paid', 'order.shipped']);
        const id = `${now}-0`;
        cmd(ADDR.api, 'XADD', ['events:orders', '*', 'type', type, 'order', String(order)]);
        const v = ks.get(0, 'events:orders');
        if (v?.type === 'stream') v.v.push({ id, fields: [['type', type], ['order', String(order)]] });
        if (type !== 'order.created') order++;
      }
      nextOrder = now + 15_000 + rand() * 20_000;
    }
    // The workers' scripts and blocking pops look up empty lists all the time: Redis counts those as misses, which is
    // why INFO's hit ratio sits near a third while the cache's own reads hit (the Overview's hint explains it).
    info.misses += Math.round((info.hits - hitsBefore) * (1.8 + rand() * 0.6));
    // The tick's commands as they came in over the last TRAFFIC_MS, in order (a refill's SET right after its GET).
    const offsets = out.map(() => Math.floor(rand() * TRAFFIC_MS)).sort((a, b) => a - b);
    out.forEach((l, i) => { l.at = now - TRAFFIC_MS + 1 + offsets[i]!; });
    while (ops.length && now - ops[0]! > 1000) ops.shift();
    if (watching.live && ctx.state.settings.redisMonitor) ctx.events.emit('redisMonitor', { key: instance, lines: out });
  };

  const schedule = () => {
    if (any() && !traffic) traffic = ctx.clock.every(TRAFFIC_MS, tick);
    if (!any() && traffic) { traffic(); traffic = null; }
    const every = !any() ? 0 : fast() ? STATUS_FAST_MS : STATUS_SLOW_MS;
    if (every !== statusEvery) {
      statusTask?.();
      statusTask = every ? ctx.clock.every(every, poll) : null;
      statusEvery = every;
    }
  };

  // —— queue writes ——
  const queueWrite = (op: 'retry' | 'remove', qid: string, id: string): WriteResult => {
    const q = infos.find((x) => x.id === qid);
    if (!q || !q.actions) return { ok: false, reason: 'refused' };
    const l = (lists[qid] ??= {});
    const failed = l.failed ?? [];
    const i = failed.findIndex((j) => j.summary.id === id);
    if (i < 0) return { ok: false, reason: 'not-failed' };
    const [entry] = failed.splice(i, 1);
    q.counts.failed = Math.max(0, (q.counts.failed ?? 1) - 1);
    const bull = q.lib === 'bullmq' ? `${q.prefix}:${q.name}` : null;
    const hashKey = entry!.summary.key ?? (bull ? `${bull}:${id}` : null);
    const failedSet = bull ? `${bull}:failed` : `${q.prefix}retry`;
    const fz = ks.get(0, failedSet);
    const member = fz?.type === 'zset' ? [...fz.v.keys()].find((m) => m === id || m.includes(`"jid":"${id}"`)) : undefined;
    const score = member !== undefined && fz?.type === 'zset' ? fz.v.get(member)! : 0;
    if (member !== undefined && fz?.type === 'zset') fz.v.delete(member);
    let restore: () => boolean;
    if (op === 'retry') {
      // Back to waiting, next in line: BullMQ clears the failure (attempts stay counted), Sidekiq enqueues it now.
      const at = ctx.now();
      const moved: CompiledJob = {
        summary: { ...entry!.summary, reason: '', finishedOn: null, processedOn: null, at },
        ...(entry!.detail ? { detail: { ...entry!.detail, job: { ...entry!.detail.job, reason: '', finishedOn: null, processedOn: null, at } } } : {})
      };
      (l.waiting ??= []).unshift(moved);
      q.counts.waiting++;
      const waitKey = bull ? `${bull}:wait` : `${q.prefix}queue:${q.name}`;
      const wl = ks.get(0, waitKey);
      if (wl?.type === 'list') wl.v.unshift(bull ? id : member ?? id);
      restore = () => {
        const w = l.waiting ?? [];
        const k = w.indexOf(moved);
        // Picked by a worker meanwhile: nothing to put back.
        if (k < 0) return false;
        w.splice(k, 1);
        q.counts.waiting = Math.max(0, q.counts.waiting - 1);
        const wl2 = ks.get(0, waitKey);
        if (wl2?.type === 'list') { const p = wl2.v.indexOf(bull ? id : member ?? id); if (p >= 0) wl2.v.splice(p, 1); }
        return true;
      };
    } else {
      const hash = bull && hashKey ? ks.get(0, hashKey) : undefined;
      if (bull && hashKey) ks.del(0, hashKey);
      restore = () => { if (bull && hashKey && hash && !ks.get(0, hashKey)) ks.put(0, hashKey, hash); return true; };
    }
    pushStatus();
    return {
      ok: true, count: 1, undo: ks.keep(() => {
        if (!restore()) return { ok: false, reason: 'picked' };
        failed.splice(Math.min(i, failed.length), 0, entry!);
        q.counts.failed = (q.counts.failed ?? 0) + 1;
        const z = ks.get(0, failedSet);
        if (member !== undefined && z?.type === 'zset') z.v.set(member, score);
        pushStatus();
        return { ok: true, kept: 0 };
      })
    };
  };

  return {
    keyspace: ks,
    status,
    watch(w) {
      watching = w;
      schedule();
      if (any()) pushStatus();
    },
    seen(queueId) {
      const q = infos.find((x) => x.id === queueId);
      if (!q) return;
      baseline.set(queueId, q.counts.failed ?? 0);
      pushStatus();
    },
    clients: () => [...redis.clients, ...(watching.live && ctx.state.settings.redisMonitor ? [{ id: 10, name: 'atelier-monitor', kind: 'atelier' as const, from: 'Atelier (this view)', cmd: 'MONITOR', idle: 0, db: 0, addr: '127.0.0.1:50101' }] : [])],
    jobs: ({ queue, state, start, count }) => (lists[queue]?.[state] ?? []).slice(start, start + count).map((j) => j.summary),
    job: ({ queue, state, id }) => lists[queue]?.[state]?.find((j) => j.summary.id === id)?.detail ?? null,
    write({ db, op, instance: on }) {
      if (ctx.state.settings.redisEdits !== 'ask') return { ok: false, reason: 'refused' };
      if (on !== instance) return { ok: false, reason: 'moved' };
      if (op.op === 'retry' || op.op === 'remove') return queueWrite(op.op, op.queue.id, op.id);
      const r = ks.write(db, op as KeyWriteOp);
      if (r.ok && op.op === 'flushdb') pushStatus();
      return r;
    },
    undo(id) {
      if (ctx.state.settings.redisEdits !== 'ask') return { ok: false, reason: 'error', message: 'Edits are off' };
      return ks.undo(id);
    }
  };
}

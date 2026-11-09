// The Redis queues, compiled: the world's keyspace — the
// acme-store's BullMQ queues and one small queue of each other library — read by main's own queue code (detection, the
// eight adapters, counts, workers, throughput, jobs, the retry command) exactly as RedisHub reads a real server, over the
// fake Redis the app's tests use (commands executed in process, no socket). The runtime gets QueueInfo and JobInfo and
// never the parsers. Node only, and async (the adapters are): compileDemoWorld awaits it.
import { parseClientList } from '../../shared/redis-monitor';
import { summarize, type JobInfo, type JobState, type QueueInfo } from '../../shared/redis-queues';
import { bullActions, detect, queueAdapter, type Read } from '../../main/redis/queues';
import { RespError, text, type Reply } from '../../main/redis/resp';
import { FakeRedis } from '../../../tests/support/fake-redis';
import { applySeed } from '../../../tests/support/redis-fixtures';
import type { CompiledQueues } from '../types';
import type { RedisSeed } from '../world/redis';

const STATES: JobState[] = ['waiting', 'active', 'delayed', 'failed'];

/** A `Read` over the fake's command table (FakeRedis.command, in process): what main's client pipeline would answer,
 *  errors as RespError. */
function readerOf(fake: FakeRedis, db = 0): Read {
  const reply = (r: unknown): Reply => (Array.isArray(r) ? r.map(reply) : r && typeof r === 'object' && !Buffer.isBuffer(r) ? new RespError(String((r as { message: unknown }).message)) : (r as Reply));
  return async (cmds) => cmds.map((c) => reply(fake.command(c.map((a) => (Buffer.isBuffer(a) ? a : String(a))), db)));
}

/** The queues of `seeds` at `t0`, as RedisHub's countQueues and its jobs/job answers would give them. */
export async function compileQueues(seeds: readonly RedisSeed[], t0: number): Promise<CompiledQueues> {
  const fake = new FakeRedis();
  for (const s of seeds) applySeed(fake, s);
  const read = readerOf(fake);
  const refs = await detect(read, 20_000);
  const [clientList] = await read([['CLIENT', 'LIST']]);
  const names = parseClientList(text(clientList ?? null)).map((c) => c.name);
  const infos: QueueInfo[] = [];
  const jobs: CompiledQueues['jobs'] = {};
  for (const r of refs) {
    const a = queueAdapter(r.lib);
    const [counts, workers, done] = await Promise.all([a.counts(r, read), a.workers(r, read, names), a.done(r, read, t0)]);
    infos.push({ ...r, counts, workers, done, actions: bullActions(r) || r.lib === 'sidekiq' });
    const byState: CompiledQueues['jobs'][string] = {};
    for (const state of STATES) {
      const list = await a.jobs(r, read, state, 0, 1000).catch((): JobInfo[] => []);
      if (!list.length) continue;
      const details = await Promise.all(list.map(async (j) => {
        const job = await a.job(r, read, state, j.id).catch(() => null);
        return job ? { job, command: a.command(r, job, state) } : null;
      }));
      byState[state] = list.map((j, i) => ({ summary: summarize(j), ...(details[i] ? { detail: details[i] } : {}) }));
    }
    jobs[r.id] = byState;
  }
  return { infos, jobs };
}

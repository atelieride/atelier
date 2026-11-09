// The Redis world, compiled: the keyspace's INFO goes through the app's own
// parser as main's RedisHub reads it, the one instance is described as main describes a project's compose redis, and
// the Clients and Slow log tables are built as main builds them from CLIENT LIST / SLOWLOG GET. The queues come from
// main's own adapters (redis-queues.ts, async: compileDemoWorld). The runtime gets RedisSnapshot / RedisStatus /
// ClientRow / SlowEntry / QueueInfo, never parseInfo or bullJob; it seeds the keys themselves (engine/redis.ts).
import type { DockerContainer } from '../../shared/docker';
import { endpointKey, infoOf, parseInfo, type ClientRow, type SlowEntry } from '../../shared/redis';
import { clientDisplayName } from '../../shared/redis-monitor';
import type { CompiledRedis } from '../types';
import { demoRedisSeeds, type RedisSeed, type SeedKey } from '../world/redis';
import { compileQueues } from './redis-queues';

/** What the screenshots' fake Redis runs (FakeRedis.start({ version: '8.4.0' })) and its fixed numbers. */
const VERSION = '8.4.0';
const PORT = 6379;
/** The fake's slowlog-log-slower-than. */
const SLOW_THRESHOLD = 10_000;
/** Atelier's own connection, as CLIENT LIST shows it to main. */
const ATELIER: ClientRow = { id: 9, name: 'atelier', kind: 'atelier', from: 'Atelier (this view)', cmd: 'CLIENT LIST', idle: 0, db: 0, addr: '127.0.0.1:50100' };

/** The demo's keyspace: the acme-store and one small queue of each other library. */
export const demoSeeds = demoRedisSeeds;

/** INFO as tests/support/fake-redis.ts answers it for the seeded keyspace (its memory and stats are constants). */
export function infoText(keys: readonly SeedKey[], clients: number, t0: number): string {
  const dbs = new Map<number, Map<string, boolean>>();
  for (const k of keys) {
    const db = dbs.get(k.db ?? 0) ?? new Map<string, boolean>();
    db.set(k.key, k.ttlMs !== undefined);
    dbs.set(k.db ?? 0, db);
  }
  const keyspace = [...dbs].sort(([a], [b]) => a - b).map(([n, d]) => `db${n}:keys=${d.size},expires=${[...d.values()].filter(Boolean).length},avg_ttl=0`);
  const sections: Record<string, string[]> = {
    server: [`redis_version:${VERSION}`, 'redis_mode:standalone', 'os:Linux 6.10.14-linuxkit aarch64', 'arch_bits:64', `tcp_port:${PORT}`, 'uptime_in_seconds:316707', 'executable:/data/redis-server', 'config_file:'],
    clients: [`connected_clients:${clients}`],
    memory: ['used_memory:2642344', 'used_memory_human:2.52M', 'used_memory_peak:4299161', 'used_memory_peak_human:4.10M', 'maxmemory:0', 'maxmemory_policy:noeviction', 'mem_fragmentation_ratio:1.20'],
    persistence: ['rdb_changes_since_last_save:0', `rdb_last_save_time:${Math.floor(t0 / 1000) - 240}`, 'rdb_last_bgsave_status:ok', 'aof_enabled:0', 'aof_last_bgrewrite_status:ok'],
    stats: ['total_commands_processed:1398600', 'instantaneous_ops_per_sec:41', 'keyspace_hits:178651', 'keyspace_misses:380817', 'expired_keys:25309', 'evicted_keys:0'],
    replication: ['role:master', 'connected_slaves:0'],
    cluster: ['cluster_enabled:0'],
    keyspace
  };
  return Object.entries(sections).map(([s, lines]) => `# ${s[0]!.toUpperCase()}${s.slice(1)}\r\n${lines.join('\r\n')}`).join('\r\n\r\n') + '\r\n';
}

/** main's clients(): CLIENT LIST rows, named, sorted into kinds, with where they connect from (here: their address). */
function clientRows(seeds: readonly RedisSeed[]): ClientRow[] {
  return [ATELIER, ...seeds.flatMap((s) => s.clients).map((x): ClientRow => {
    const display = clientDisplayName(x.name);
    const kind: ClientRow['kind'] = !x.name ? 'unnamed' : display !== x.name || /^(sidekiq|rq:worker|asynq|resque)/i.test(x.name) ? 'queue' : 'app';
    return { id: x.id, name: display, kind, from: x.addr, cmd: x.cmd.replace('|', ' ').toUpperCase(), idle: x.idle, db: x.db, addr: x.addr };
  })];
}

/** main's slowlog(): SLOWLOG GET 10, newest first, at whole seconds as Redis keeps them. */
function slowEntries(seeds: readonly RedisSeed[]): SlowEntry[] {
  const all = seeds.flatMap((s) => s.slowlog);
  return all.slice(0, 10).map((s, i) => ({ id: all.length - i, at: Math.floor(s.at / 1000) * 1000, micros: s.micros, command: s.args.join(' ').slice(0, 200), client: s.name }));
}

/** `containers`: the compiled Docker world; the instance is its acme-store redis, published on 6379. Queues: null. */
export function compileRedis(containers: readonly DockerContainer[], t0: number): CompiledRedis {
  const seeds = demoSeeds(t0);
  const c = containers.find((x) => x.project === 'acme-store' && x.service === 'redis');
  if (!c) throw new Error('redis: no acme-store redis container in the Docker world');
  const clients = clientRows(seeds);
  const info = infoOf(parseInfo(infoText(seeds.flatMap((s) => s.keys), clients.length, t0)));
  const endpoint = { kind: 'tcp' as const, port: PORT };
  const key = endpointKey(endpoint);
  return {
    snapshot: {
      instances: [{
        key, endpoint, state: 'running', badge: 'docker', label: `Docker · ${c.containerName}`, hint: `this project's compose (${c.service})`, mine: true,
        server: { name: info.name, version: info.version, mode: info.mode }, db: 0, prefix: null, hasPassword: false, envPassword: null,
        container: { id: c.id, name: c.containerName, service: c.service, running: c.state === 'running', finishedAt: c.finishedAt }
      }],
      pick: key, mentions: true, brew: false, probed: true
    },
    status: { key, info, samples: [], denied: [], queues: null, unseen: {}, db: 0, dir: '/data', error: null },
    clients,
    slowlog: { threshold: SLOW_THRESHOLD, entries: slowEntries(seeds) },
    queues: null
  };
}

/** The same with the queues, read by main's adapters (async). */
export async function compileRedisWithQueues(containers: readonly DockerContainer[], t0: number): Promise<CompiledRedis> {
  return { ...compileRedis(containers, t0), queues: await compileQueues(demoSeeds(t0), t0) };
}

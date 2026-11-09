// Finding Redis instances: candidates from the open projects' .env files, Docker containers of
// Redis-like images, servers running in Atelier terminals, the common ports and Settings' custom instances, merged by
// endpoint. Pure: main gathers the inputs, the hub probes what comes out.
import type { DockerContainer } from '@shared/docker';
import { isInside } from '@shared/paths';
import {
  endpointKey, isLoopback, isRedisImage, normalizeCustom, orderInstances, parseRedisUrl, REDIS_PROCS, redisFromEnv,
  type Endpoint, type RedisSource
} from '@shared/redis';

export interface EnvHit { project: string; var: string; db: number; password?: string; user?: string; prefix?: string }
export interface ContainerHit { id: string; name: string; service: string | null; running: boolean; finishedAt: number | null; project: string | null; image: string }
export interface TerminalHit { name: string; title: string; project: string }

export interface Candidate {
  key: string;
  endpoint: Endpoint;
  sources: RedisSource[];
  /** The first .env that named it (and every one, for per-project hints). */
  env?: EnvHit;
  envs: EnvHit[];
  container?: ContainerHit;
  terminal?: TerminalHit;
  tls: boolean;
}

export interface DiscoverInputs {
  projects: readonly string[];
  /** A project's .env files merged (later files win). */
  env(root: string): Record<string, string>;
  containers: readonly DockerContainer[];
  terminals: readonly { project: string; port: number; name: string; title: string }[];
  ports: readonly number[];
  custom: readonly string[];
}

const inside = (dir: string | null, root: string) => !!dir && isInside(root, dir);

export function gatherCandidates(i: DiscoverInputs): Candidate[] {
  const map = new Map<string, Candidate>();
  const add = (endpoint: Endpoint, source: RedisSource, patch: Partial<Candidate> = {}): Candidate => {
    const key = endpointKey(endpoint);
    const c = map.get(key) ?? { key, endpoint, sources: [], envs: [], tls: false };
    if (!c.sources.includes(source)) c.sources.push(source);
    if (patch.env) { c.envs.push(patch.env); c.env ??= patch.env; }
    if (patch.container && !c.container) c.container = patch.container;
    if (patch.terminal && !c.terminal) c.terminal = patch.terminal;
    if (patch.tls) c.tls = true;
    map.set(key, c);
    return c;
  };
  const projectOf = (dir: string | null) => i.projects.find((r) => inside(dir, r)) ?? null;
  const hit = (c: DockerContainer): ContainerHit => ({ id: c.id, name: c.containerName, service: c.service, running: c.state === 'running' || c.state === 'restarting', finishedAt: c.finishedAt, project: projectOf(c.workingDir), image: c.image });
  const redisContainers = i.containers.filter((c) => isRedisImage(c.image));

  for (const root of i.projects) {
    for (const e of redisFromEnv(i.env(root))) {
      const env: EnvHit = { project: root, var: e.var, db: e.db, ...(e.password !== undefined ? { password: e.password } : {}), ...(e.user ? { user: e.user } : {}), ...(e.prefix ? { prefix: e.prefix } : {}) };
      if (e.path) { add({ kind: 'unix', path: e.path }, 'env', { env }); continue; }
      if (isLoopback(e.host)) { add({ kind: 'tcp', port: e.port }, 'env', { env, tls: e.tls }); continue; }
      // REDIS_HOST=redis inside compose: the service's port published on the host.
      const c = i.containers.find((x) => projectOf(x.workingDir) === root && (x.service === e.host || x.containerName === e.host));
      const m = c?.ports.find((p) => p.proto === 'tcp' && p.container === e.port);
      if (c && m) add({ kind: 'tcp', port: m.host }, 'env', { env, container: hit(c), tls: e.tls });
    }
  }
  for (const c of redisContainers) {
    const tcp = c.ports.filter((p) => p.proto === 'tcp');
    const m = tcp.find((p) => p.container === 6379) ?? (tcp.length === 1 ? tcp[0] : undefined);
    if (m && hit(c).running) { add({ kind: 'tcp', port: m.host }, 'docker', { container: hit(c) }); continue; }
    // Not running (no published port now): it explains why the endpoint its project expects is silent.
    const root = projectOf(c.workingDir);
    if (!root) continue;
    for (const cand of map.values()) if (!cand.container && cand.envs.some((e) => e.project === root)) cand.container = hit(c);
  }
  for (const t of i.terminals) if (REDIS_PROCS.has(t.name)) add({ kind: 'tcp', port: t.port }, 'terminal', { terminal: { name: t.name, title: t.title, project: t.project } });
  for (const p of i.ports) add({ kind: 'tcp', port: p }, 'port');
  for (const s of i.custom) {
    const n = normalizeCustom(s);
    const p = n ? parseRedisUrl(n) : null;
    if (p) add(p.kind === 'unix' ? { kind: 'unix', path: p.path } : { kind: 'tcp', port: p.port }, 'custom');
  }
  const pos = (c: Candidate) => (c.endpoint.kind === 'tcp' ? c.endpoint.port : 70000);
  return [...map.values()].sort((a, b) => pos(a) - pos(b) || a.key.localeCompare(b.key));
}

export interface CandidateView extends Candidate { label: string; hint: string | null; mine: boolean; fromEnv: boolean }

/** The candidates as one window's project sees them: its own config first, labeled and hinted. */
export function viewFor(cands: readonly Candidate[], root: string): CandidateView[] {
  return orderInstances(cands.map((c) => {
    const env = c.envs.find((e) => e.project === root);
    const label = c.container && c.sources.includes('docker') ? `Docker · ${c.container.name}` : c.terminal ? `Terminal · ${c.terminal.name}` : c.sources.includes('custom') ? 'custom' : 'local';
    const hint = env ? `this project's .env (${env.var})` : c.container?.project === root && c.container.service ? `this project's compose (${c.container.service})` : null;
    const mine = !!env || c.container?.project === root || c.terminal?.project === root;
    return { ...c, label, hint, mine, fromEnv: !!env };
  }));
}

/** The project mentions Redis without a server answering: a REDIS_* in .env or a Redis-like service in a root compose file. */
export function mentionsRedis(env: Record<string, string>, composeTexts: readonly string[]): boolean {
  if (redisFromEnv(env).length) return true;
  return composeTexts.some((t) => /^\s*image:\s*['"]?[^\s'"]*\b(redis|valkey|keydb|dragonfly)\b/im.test(t));
}

// The Redis hub's real dependencies: the project's .env and compose files (inside the
// project, cached a few seconds), Docker's containers and a Redis container's own password, terminals' servers and
// connections, Homebrew's redis-server (a stat), the Keychain store. Nothing here talks to Redis.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from '@shared/redis';
import type { DockerHub } from '../docker/hub';
import type { PortsHub } from '../ports-hub';
import { descendants, MAX_PIDS, readEstablished } from '../procs/exec';
import { sharedProcessTree } from '../procs/shared-tree';

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
const COMPOSE_FILES = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'];
const MAX_FILE = 256 * 1024;
const CACHE_MS = 5000;

function readSmall(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

/**
 * A project's files read at most every few seconds (the hub asks on every broadcast); `forget`: the next read is fresh
 * (the Databases sidebar's Refresh).
 */
export function projectFiles(): { env(root: string): Record<string, string>; compose(root: string): string[]; forget(root: string): void } {
  const cache = new Map<string, { at: number; env: Record<string, string>; compose: string[] }>();
  const get = (root: string) => {
    const hit = cache.get(root);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const env = Object.assign({}, ...ENV_FILES.map((f) => { const t = readSmall(join(root, f)); return t ? parseEnvFile(t) : {}; })) as Record<string, string>;
    const compose = COMPOSE_FILES.flatMap((f) => { const t = readSmall(join(root, f)); return t ? [t] : []; });
    const v = { at: Date.now(), env, compose };
    cache.set(root, v);
    return v;
  };
  return { env: (r) => get(r).env, compose: (r) => get(r).compose, forget: (r) => { cache.delete(r); } };
}

/** A Redis container's own password: REDIS_PASSWORD (official/bitnami images) or --requirepass in its command. */
export async function dockerRedisSecret(docker: DockerHub, id: string): Promise<string | null> {
  const r = await docker.inspect(id);
  if (!r) return null;
  const env = new Map(r.detail.env.map((e) => [e.key, e.value]));
  const fromEnv = env.get('REDIS_PASSWORD') ?? env.get('VALKEY_PASSWORD');
  if (fromEnv) return fromEnv;
  const m = /--requirepass\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(`${r.detail.command} ${env.get('REDIS_ARGS') ?? ''}`);
  return m ? m[2] ?? m[3] ?? m[4] ?? null : null;
}

/** Running containers' IPs → names, cached a minute (clients coming from containers). */
export function dockerIpsOf(docker: DockerHub): () => Promise<Map<string, string>> {
  let cache: { at: number; map: Map<string, string> } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < 60_000) return cache.map;
    const map = new Map<string, string>();
    const running = docker.snapshot().containers.filter((c) => c.state === 'running').slice(0, 20);
    for (const c of running) {
      const r = await docker.inspect(c.id).catch(() => null);
      for (const n of r?.detail.networks ?? []) if (n.ip) map.set(n.ip, c.containerName);
    }
    cache = { at: Date.now(), map };
    return map;
  };
}

/** Client local port → the terminal whose processes hold that connection to a host Redis on `port`. */
export function clientOriginsOf(ports: PortsHub): (port: number) => Promise<Map<number, string>> {
  return async (port) => {
    const terms = ports.terminalList().filter((t) => t.pid);
    if (!terms.length) return new Map();
    const tree = await sharedProcessTree();
    const owner = new Map<number, string>();
    for (const t of terms) for (const pid of descendants(tree, t.pid!)) if (!owner.has(pid)) owner.set(pid, t.title);
    const est = await readEstablished(port, [...owner.keys()].slice(0, MAX_PIDS));
    return new Map([...est].flatMap(([local, pid]) => (owner.has(pid) ? [[local, owner.get(pid)!] as [number, string]] : [])));
  };
}

export const brewRedisInstalled = (): boolean => existsSync('/opt/homebrew/bin/redis-server') || existsSync('/usr/local/bin/redis-server');

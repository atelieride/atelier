// Docker view: the model the main process builds from the Engine API and the renderer
// shows. Pure: parsing of `GET /containers/{id}/json`, grouping by project, dots, stats formulas, env masking, the
// loopback hint, where a service sits in a compose file, the engine's name.

import { isBelow, samePath, trimOneSep } from './paths';

export type ContainerState = 'running' | 'restarting' | 'paused' | 'exited' | 'created' | 'dead';
export type Health = 'healthy' | 'unhealthy' | 'starting';
export type Dot = 'ok' | 'warn' | 'err' | 'off';

/** The engine as found: no socket, a silent one, one we may not read, too old, or running. */
export type EngineState =
  | { state: 'absent' }
  | { state: 'stopped'; socket: string }
  | { state: 'denied'; socket: string }
  | { state: 'unsupported'; socket: string; version: string }
  | { state: 'running'; socket: string; name: string; version: string; apiVersion: string; os: string; arch: string; cpus: number; memory: number };

/** `ip`: the one address of this machine it is bound to, when not every one (0.0.0.0, ::). */
export interface PublishedPort { host: number; container: number; proto: 'tcp' | 'udp'; ip?: string }

export interface DockerContainer {
  id: string;
  /** The compose service when composed, else the container's own name. */
  name: string;
  containerName: string;
  /** com.docker.compose.project */
  project: string | null;
  service: string | null;
  /** com.docker.compose.project.working_dir: the folder compose ran in, on the host. */
  workingDir: string | null;
  configFiles: string[];
  image: string;
  state: ContainerState;
  health: Health | null;
  /** Null while running. */
  exitCode: number | null;
  restarts: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Published on the host, each once (v4 and v6 bindings are one). */
  ports: PublishedPort[];
  /** Container ports it exposes (published or not): what another service reaches it on. */
  exposed: number[];
  tty: boolean;
  oomKilled: boolean;
  restartPolicy: string;
}

export interface EnvVar { key: string; value: string }
export interface Mount { type: string; name: string | null; source: string; target: string; rw: boolean }
export interface NetworkInfo { name: string; ip: string; aliases: string[] }
export interface HealthProbe { at: number; exitCode: number; output: string }

/** What Inspect shows beyond the row. */
export interface DockerDetail {
  env: EnvVar[];
  command: string;
  workingDir: string;
  imageId: string;
  created: number | null;
  mounts: Mount[];
  networks: NetworkInfo[];
  healthLog: HealthProbe[];
  restartPolicy: { name: string; max: number };
  hostNetwork: boolean;
  error: string;
  labels: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
export const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const STATES = new Set(['running', 'restarting', 'paused', 'exited', 'created', 'dead']);
const HEALTH = new Set(['healthy', 'unhealthy', 'starting']);

/** Docker's zero time ("0001-01-01T00:00:00Z") and anything unparsable: null. */
function time(v: unknown): number | null {
  const s = str(v);
  if (!s || s.startsWith('0001-')) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : null;
}

function labelsOf(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(config.Labels))) if (typeof v === 'string') out[k] = v;
  return out;
}

const portNum = (key: string): number | null => { const n = Number(key.split('/')[0]); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };

/** One container of `GET /containers/{id}/json`; null when it isn't one. */
export function containerFromInspect(raw: unknown): DockerContainer | null {
  if (!isObj(raw)) return null;
  const id = str(raw.Id);
  const rawName = str(raw.Name);
  if (!id || !CONTAINER_ID.test(id) || rawName === null) return null;
  const state = obj(raw.State);
  const config = obj(raw.Config);
  const labels = labelsOf(config);
  const net = obj(raw.NetworkSettings);
  const status = str(state.Status) ?? '';
  const st: ContainerState = status === 'removing' ? 'exited' : STATES.has(status) ? (status as ContainerState) : 'exited';
  const healthStatus = str(obj(state.Health).Status);
  const ports: PublishedPort[] = [];
  const exposed = new Set<number>();
  for (const k of Object.keys(obj(config.ExposedPorts))) { const p = portNum(k); if (p) exposed.add(p); }
  for (const [k, binds] of Object.entries(obj(net.Ports))) {
    const container = portNum(k);
    if (!container) continue;
    exposed.add(container);
    const proto = k.endsWith('/udp') ? 'udp' : 'tcp';
    if (!Array.isArray(binds)) continue;
    for (const b of binds) {
      const host = Number(obj(b).HostPort);
      const ip = str(obj(b).HostIp) ?? '';
      if (Number.isInteger(host) && host > 0 && host < 65536 && !ports.some((p) => p.host === host && p.proto === proto)) {
        ports.push({ host, container, proto, ...(ip && ip !== '0.0.0.0' && ip !== '::' ? { ip } : {}) });
      }
    }
  }
  ports.sort((a, b) => a.host - b.host);
  const project = labels['com.docker.compose.project'] ?? null;
  const service = labels['com.docker.compose.service'] ?? null;
  const containerName = rawName.replace(/^\//, '');
  const exit = num(state.ExitCode);
  return {
    id, name: service ?? containerName, containerName, project, service,
    workingDir: labels['com.docker.compose.project.working_dir'] ?? null,
    configFiles: (labels['com.docker.compose.project.config_files'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    image: str(config.Image) ?? '',
    state: st,
    health: healthStatus && HEALTH.has(healthStatus) ? (healthStatus as Health) : null,
    exitCode: st === 'running' || st === 'paused' || st === 'restarting' ? null : exit,
    restarts: num(raw.RestartCount) ?? 0,
    startedAt: time(state.StartedAt),
    finishedAt: time(state.FinishedAt),
    ports, exposed: [...exposed].sort((a, b) => a - b),
    tty: config.Tty === true,
    oomKilled: state.OOMKilled === true,
    restartPolicy: str(obj(obj(raw.HostConfig).RestartPolicy).Name) || 'no'
  };
}

const MAX_PROBE_OUTPUT = 500;

export function detailFromInspect(raw: unknown): DockerDetail | null {
  if (!containerFromInspect(raw)) return null;
  const r = raw as Record<string, unknown>;
  const config = obj(r.Config);
  const state = obj(r.State);
  const host = obj(r.HostConfig);
  const env = (Array.isArray(config.Env) ? config.Env : []).filter((e): e is string => typeof e === 'string').map((e) => {
    const i = e.indexOf('=');
    return i < 0 ? { key: e, value: '' } : { key: e.slice(0, i), value: e.slice(i + 1) };
  });
  const args = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
  const mounts = (Array.isArray(r.Mounts) ? r.Mounts : []).map((m) => {
    const o = obj(m);
    return { type: str(o.Type) ?? 'bind', name: str(o.Name), source: str(o.Source) ?? '', target: str(o.Destination) ?? '', rw: o.RW !== false };
  });
  const networks = Object.entries(obj(obj(r.NetworkSettings).Networks)).map(([name, n]) => {
    const o = obj(n);
    return { name, ip: str(o.IPAddress) ?? '', aliases: args(o.Aliases) };
  });
  const log = Array.isArray(obj(state.Health).Log) ? (obj(state.Health).Log as unknown[]) : [];
  const healthLog = log.slice(-5).map((p) => {
    const o = obj(p);
    return { at: time(o.End) ?? time(o.Start) ?? 0, exitCode: num(o.ExitCode) ?? -1, output: (str(o.Output) ?? '').trim().slice(0, MAX_PROBE_OUTPUT) };
  });
  const policy = obj(host.RestartPolicy);
  return {
    env,
    command: [...args(config.Entrypoint), ...args(config.Cmd)].join(' '),
    workingDir: str(config.WorkingDir) ?? '',
    imageId: str(r.Image) ?? '',
    created: time(r.Created),
    mounts, networks, healthLog,
    restartPolicy: { name: str(policy.Name) || 'no', max: num(policy.MaximumRetryCount) ?? 0 },
    hostNetwork: host.NetworkMode === 'host',
    error: str(state.Error) ?? '',
    labels: labelsOf(config)
  };
}

/** Exits that mean "stopped" (docker stop's SIGTERM, a kill, Ctrl-C), not "failed". */
export const isStopExit = (code: number | null): boolean => code === 0 || code === 130 || code === 137 || code === 143;

/** The row's dot: green running, amber in between, rose failing, grey stopped. */
export function dotOf(c: Pick<DockerContainer, 'state' | 'health' | 'exitCode' | 'oomKilled'>): Dot {
  if (c.state === 'running') return c.health === 'unhealthy' ? 'err' : c.health === 'starting' ? 'warn' : 'ok';
  if (c.state === 'restarting' || c.state === 'paused') return 'warn';
  if (c.state === 'dead' || c.oomKilled) return 'err';
  if (c.state === 'exited') return isStopExit(c.exitCode) ? 'off' : 'err';
  return 'off';
}

/** Problems first, then by name. */
export function sortForList(list: readonly DockerContainer[]): DockerContainer[] {
  return [...list].sort((a, b) => Number(dotOf(a) !== 'err') - Number(dotOf(b) !== 'err') || a.name.localeCompare(b.name));
}

export interface ContainerGroup { project: string; workingDir: string | null; containers: DockerContainer[]; running: number; total: number }
export interface Grouped { mine: ContainerGroup[]; others: ContainerGroup[]; standalone: DockerContainer[] }

const inside = (dir: string, root: string) => samePath(dir, root) || isBelow(trimOneSep(root), dir);

/** This project's compose projects (its root's first), the others by name, then standalone containers. */
export function groupContainers(list: readonly DockerContainer[], where: { root: string; realRoot: string }, showOthers: boolean): Grouped {
  const byProject = new Map<string, DockerContainer[]>();
  const standalone: DockerContainer[] = [];
  for (const c of list) {
    if (!c.project) { standalone.push(c); continue; }
    const l = byProject.get(c.project);
    if (l) l.push(c); else byProject.set(c.project, [c]);
  }
  const mine: ContainerGroup[] = [];
  const others: ContainerGroup[] = [];
  for (const [project, cs] of byProject) {
    const workingDir = cs.find((c) => c.workingDir)?.workingDir ?? null;
    const g = { project, workingDir, containers: sortForList(cs), running: cs.filter((c) => c.state === 'running').length, total: cs.length };
    if (workingDir && (inside(workingDir, where.root) || inside(workingDir, where.realRoot))) mine.push(g); else others.push(g);
  }
  const atRoot = (g: ContainerGroup) => (g.workingDir === where.root || g.workingDir === where.realRoot ? 0 : 1);
  mine.sort((a, b) => atRoot(a) - atRoot(b) || (a.workingDir ?? '').localeCompare(b.workingDir ?? ''));
  others.sort((a, b) => a.project.localeCompare(b.project));
  return showOthers ? { mine, others, standalone: sortForList(standalone) } : { mine, others: [], standalone: [] };
}

/**
 * A stop worth a notification: exit ≠ 0 that no kill asked for (`docker stop`, `compose down` send one
 * first), or the kernel's OOM killer. Null: a normal stop.
 */
export function crashKind(e: { exitCode: number; killed: boolean; oom: boolean }): 'crash' | 'oom' | null {
  if (e.oom) return 'oom';
  if (e.killed || e.exitCode === 0) return null;
  return 'crash';
}

// Stats (`GET /containers/{id}/stats`, one JSON object per second).
const n0 = (v: unknown) => num(v) ?? 0;

export function cpuPercent(s: unknown): number {
  const o = obj(s);
  const cur = obj(o.cpu_stats);
  const pre = obj(o.precpu_stats);
  const cpu = n0(obj(cur.cpu_usage).total_usage) - n0(obj(pre.cpu_usage).total_usage);
  const sys = n0(cur.system_cpu_usage) - n0(pre.system_cpu_usage);
  if (cpu <= 0 || sys <= 0) return 0;
  const cpus = num(cur.online_cpus) ?? (Array.isArray(obj(cur.cpu_usage).percpu_usage) ? (obj(cur.cpu_usage).percpu_usage as unknown[]).length : 1);
  return (cpu / sys) * cpus * 100;
}

/** Used memory without the page cache (what `docker stats` shows), and the limit. */
export function memoryOf(s: unknown): { used: number; limit: number } {
  const m = obj(obj(s).memory_stats);
  const st = obj(m.stats);
  const cache = num(st.inactive_file) ?? num(st.total_inactive_file) ?? 0;
  return { used: Math.max(0, n0(m.usage) - cache), limit: n0(m.limit) };
}

export function netTotals(s: unknown): { rx: number; tx: number } {
  let rx = 0; let tx = 0;
  for (const n of Object.values(obj(obj(s).networks))) { rx += n0(obj(n).rx_bytes); tx += n0(obj(n).tx_bytes); }
  return { rx, tx };
}

export const pidsOf = (s: unknown): number => n0(obj(obj(s).pids_stats).current);

// Environment.
const SECRET_PARTS = new Set(['KEY', 'PWD', 'PASS', 'AUTH', 'PRIVATE', 'SALT', 'CREDENTIAL', 'CREDENTIALS', 'APIKEY', 'DSN']);
const SECRET_WORDS = ['SECRET', 'TOKEN', 'PASSWORD', 'PASSWD'];

/** Names that hold secrets: SECRET, TOKEN, PASSWORD anywhere; KEY, PWD, AUTH, PRIVATE, SALT… as a word of the name. */
export function isSecretKey(key: string): boolean {
  const k = key.toUpperCase();
  if (SECRET_WORDS.some((w) => k.includes(w))) return true;
  return k.split(/[^A-Z0-9]+/).some((p) => SECRET_PARTS.has(p));
}

export interface ValuePart { text: string; secret: boolean }
// The password runs to the last "@" before the host (a password may hold "@"); the host has neither "@" nor "/".
const URL_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)(\S+)(@[^@/\s]*(?:[/?#].*)?)$/is;

/** A value in parts: secret ones masked by the UI (and never sent to Claude). */
export function maskValue(key: string, value: string): ValuePart[] {
  if (isSecretKey(key)) return value ? [{ text: value, secret: true }] : [];
  const m = URL_PASSWORD.exec(value);
  if (m) return [{ text: m[1]!, secret: false }, { text: m[2]!, secret: true }, { text: m[3]!, secret: false }];
  return [{ text: value, secret: false }];
}

/** The value with its secret parts replaced (prompts, Copy as JSON). */
export const maskedText = (key: string, value: string): string => maskValue(key, value).map((p) => (p.secret ? '••••••••' : p.text)).join('');

const SCHEME_PORT: Record<string, number> = { redis: 6379, rediss: 6379, postgres: 5432, postgresql: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, amqp: 5672, nats: 4222, http: 80, https: 443, smtp: 25 };
const LOOPBACK = /(?<![\w.-])(localhost|127\.0\.0\.1|0\.0\.0\.0)(?![\w-]|\.\w)(?::(\d{1,5}))?/i;

/**
 * A value pointing at the container itself (localhost inside a container) where a sibling service was meant. The
 * suggestion: the service (not this one) that exposes that port.
 */
export function loopbackHint(value: string, hostNetwork: boolean, services: readonly { name: string; exposed: readonly number[] }[], self: string, key = ''): { host: string; port: number | null; suggestion: string | null } | null {
  if (hostNetwork) return null;
  // Where it listens (HOST=0.0.0.0, BIND_ADDRESS, LISTEN_HOST): right inside a container. Only addresses it connects to
  // (URLs, host:port of another service) can be the mistake.
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!url && /(^|_)(HOST|HOSTNAME|BIND|LISTEN|ADDR|ADDRESS|INTERFACE)(_|$)/i.test(key)) return null;
  const m = LOOPBACK.exec(value);
  if (m && !url && m[1] === '0.0.0.0') return null;
  if (!m) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  const port = m[2] ? Number(m[2]) : scheme ? SCHEME_PORT[scheme] ?? null : null;
  const svc = port ? services.find((s) => s.name !== self && s.exposed.includes(port)) : undefined;
  return { host: m[1]!, port, suggestion: svc && port ? `${svc.name}:${port}` : null };
}

/** 1-based line of `<service>:` under the top-level `services:` key of a compose file; null when it isn't there. */
export function serviceLine(yaml: string, service: string): number | null {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^services\s*:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let indent: number | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (/^\S/.test(l)) return null;
    const lead = l.length - l.trimStart().length;
    if (indent === null) indent = lead;
    if (lead !== indent) continue;
    const m = /^\s+(["']?)([^"':#]+)\1\s*:(\s|$)/.exec(l);
    if (m && m[2]!.trim() === service) return i + 1;
  }
  return null;
}

/** The service's lines (its key and body), at most 80: what a prompt quotes. */
export function serviceBlock(yaml: string, service: string): string | null {
  const at = serviceLine(yaml, service);
  if (at === null) return null;
  const lines = yaml.split(/\r?\n/);
  const head = lines[at - 1]!;
  const indent = head.length - head.trimStart().length;
  const out = [head];
  for (let i = at; i < lines.length && out.length < 80; i++) {
    const l = lines[i]!;
    if (l.trim() && !/^\s*#/.test(l) && l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  // Blank lines and comments of the next key at the end belong to what follows.
  const outer = (l: string) => !l.trim() || (/^\s*#/.test(l) && l.length - l.trimStart().length <= indent);
  while (out.length > 1 && outer(out.at(-1)!)) out.pop();
  return out.join('\n');
}

export interface DfSummary {
  images: { size: number; count: number; dangling: number; reclaimable: number };
  buildCache: { size: number; reclaimable: number };
  volumes: { size: number; count: number; unused: number; reclaimable: number };
  containers: { size: number; count: number; stopped: number; reclaimable: number };
}

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const size = (v: unknown) => Math.max(0, n0(v));

/** `GET /system/df` as the overview shows it (reclaimable: what nothing uses). */
export function dfSummary(raw: unknown): DfSummary {
  const o = obj(raw);
  const images = arr(o.Images);
  const unusedImages = images.filter((i) => n0(i.Containers) === 0);
  const dangling = images.filter((i) => !Array.isArray(i.RepoTags) || (i.RepoTags as unknown[]).every((t) => t === '<none>:<none>'));
  const cache = arr(o.BuildCache);
  const volumes = arr(o.Volumes);
  const vsize = (v: Record<string, unknown>) => size(obj(v.UsageData).Size);
  const unused = volumes.filter((v) => n0(obj(v.UsageData).RefCount) === 0);
  const containers = arr(o.Containers);
  const stopped = containers.filter((c) => c.State !== 'running');
  const sum = <T>(l: T[], f: (x: T) => number) => l.reduce((a, x) => a + f(x), 0);
  return {
    images: { size: num(o.LayersSize) ?? sum(images, (i) => size(i.Size)), count: images.length, dangling: dangling.length, reclaimable: sum(unusedImages, (i) => size(i.Size)) },
    buildCache: { size: sum(cache, (c) => size(c.Size)), reclaimable: sum(cache.filter((c) => c.InUse !== true), (c) => size(c.Size)) },
    volumes: { size: sum(volumes, vsize), count: volumes.length, unused: unused.length, reclaimable: sum(unused, vsize) },
    containers: { size: sum(containers, (c) => size(c.SizeRw)), count: containers.length, stopped: stopped.length, reclaimable: sum(stopped, (c) => size(c.SizeRw)) }
  };
}

export type EventType = 'container' | 'image' | 'volume' | 'network';
export interface DockerEventEntry { at: number; type: EventType; action: string; name: string; detail: string; id: string }

const KEPT: Record<EventType, Set<string>> = {
  container: new Set(['create', 'start', 'restart', 'die', 'stop', 'destroy', 'oom', 'pause', 'unpause', 'rename', 'health']),
  image: new Set(['pull', 'push', 'tag', 'untag', 'delete', 'import', 'load', 'save']),
  volume: new Set(['create', 'destroy']),
  network: new Set(['create', 'destroy'])
};

/** One `/events` message as the overview lists it; null for noise (health-check execs, attach, mounts…). */
export function eventEntry(raw: unknown): DockerEventEntry | null {
  const o = obj(raw);
  const type = str(o.Type) as EventType | null;
  const full = str(o.Action) ?? '';
  if (!type || !(type in KEPT)) return null;
  const health = /^health_status:\s*(\w+)/.exec(full);
  const action = health ? 'health' : full;
  if (!KEPT[type].has(action)) return null;
  const actor = obj(o.Actor);
  const attrs = obj(actor.Attributes);
  const id = str(actor.ID) ?? '';
  const nano = num(o.timeNano);
  const at = nano !== null ? Math.floor(nano / 1e6) : (num(o.time) ?? 0) * 1000;
  const detail = health ? health[1]! : action === 'die' ? `exit ${str(attrs.exitCode) ?? '?'}` : action === 'start' || action === 'create' ? str(attrs.image) ?? '' : '';
  return { at, type, action, name: str(attrs.name) ?? id, detail, id };
}

/** What main pushes to every window: the engine and every container (each window groups them for its project). */
export interface DockerSnapshot { engine: EngineState; containers: DockerContainer[] }

/** One stats sample, computed in main from two consecutive readings. */
export interface StatsSample { at: number; cpu: number; mem: number; memLimit: number; rx: number; tx: number; pids: number }

/** A container that failed, for the Notification Center and the toast. */
export interface DockerNote {
  id: string; at: number;
  container: { id: string; name: string; project: string | null };
  reason: 'crash' | 'oom' | 'unhealthy';
  exitCode: number | null;
  /** Its last error-looking log line, redacted. */
  line: string;
}

/** "Docker Desktop", "OrbStack", "Colima", "Rancher Desktop", else "Docker". */
export function engineName(version: unknown, info: unknown, socket: string): string {
  const platform = str(obj(obj(version).Platform).Name) ?? '';
  const os = str(obj(info).OperatingSystem) ?? '';
  const host = (str(obj(info).Name) ?? '').toLowerCase();
  if (/^docker desktop/i.test(platform) || /docker desktop/i.test(os)) return 'Docker Desktop';
  if (/orbstack/i.test(os) || host.includes('orbstack')) return 'OrbStack';
  if (host.includes('rancher')) return 'Rancher Desktop';
  if (host.includes('colima')) return 'Colima';
  if (socket.includes('/.orbstack/')) return 'OrbStack';
  if (socket.includes('/.colima/')) return 'Colima';
  if (socket.includes('/.rd/')) return 'Rancher Desktop';
  if (socket.includes('/.docker/run/')) return 'Docker Desktop';
  return 'Docker';
}

/**
 * A Docker engine on Windows is a named pipe of this machine: `\\.\pipe\name`, or a context's
 * `npipe:////./pipe/name`, as the pipe's name; null for anything else (another host's pipe included).
 */
export function dockerPipeName(v: string): string | null {
  // This machine's pipes only (`.`): a pipe on another host is an SMB connection, with the user's credentials, to it.
  if (v.length > 256) return null;
  if (v.startsWith('npipe://')) {
    const rest = v.slice('npipe://'.length);
    return /^\/\/\.\/pipe\/[^/\\\0]+$/.test(rest) ? rest.replace(/\//g, '\\') : null;
  }
  return /^\\\\\.\\pipe\\[^\\\0]+$/.test(v) ? v : null;
}

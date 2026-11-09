// Redis view: the model main builds and the renderer shows. Pure: `.env` and URL parsing,
// INFO, instances, namespaces, formatting, hints, redis-cli commands, masking and the prompts sent to Claude.
import { isSecretKey } from './docker';
import { redactSecrets } from './session';
import { currentPlatform, type Platform } from './platform';

// —— instances ——

export type Endpoint = { kind: 'tcp'; port: number } | { kind: 'unix'; path: string };
export type RedisSource = 'env' | 'docker' | 'terminal' | 'port' | 'custom';
export type RedisBadge = 'brew' | 'docker' | 'terminal' | 'custom' | 'local';
export type InstanceState = 'running' | 'auth' | 'stopped' | 'unsupported' | 'denied';
export type ServerName = 'redis' | 'valkey' | 'dragonfly' | 'keydb';
export type ServerMode = 'standalone' | 'cluster' | 'sentinel';

export interface RedisInstance {
  /** `tcp:<port>` or `unix:<path>`. */
  key: string;
  endpoint: Endpoint;
  state: InstanceState;
  badge: RedisBadge;
  /** "Docker · acme-store-redis-1", "Terminal · redis-server", "local". */
  label: string;
  /** Under the project's own: "this project's .env (REDIS_URL)". */
  hint: string | null;
  /** Found by this project's config or its compose services. */
  mine: boolean;
  server: { name: ServerName; version: string; mode: ServerMode } | null;
  /** The database the project's config names (REDIS_DB, /2 in a URL). */
  db: number;
  /** Laravel's REDIS_PREFIX from the project's .env. */
  prefix: string | null;
  /** 'tls' for rediss://, 'not-redis' when something else answers. */
  why?: 'tls' | 'not-redis';
  /** A password is known (from .env, the container, the Keychain): never the password itself. */
  hasPassword: boolean;
  /** The variable of a password in the project's .env not tried on this server yet ("Found REDIS_PASSWORD in .env ·
   * Use It"): only its name ever reaches the renderer. */
  envPassword: string | null;
  /** The Docker container behind it (state for "not running", "Open in Docker"). */
  container: { id: string; name: string; service: string | null; running: boolean; finishedAt: number | null } | null;
}

export interface RedisSnapshot {
  instances: RedisInstance[];
  /** The picked instance of this window's project. */
  pick: string | null;
  /** The project mentions Redis (.env or a Redis service in a root compose file). */
  mentions: boolean;
  /** redis-server installed by Homebrew (for "brew services start redis"). */
  brew: boolean;
  /** Probing at least once finished. */
  probed: boolean;
}

export const endpointKey = (e: Endpoint): string => (e.kind === 'tcp' ? `tcp:${e.port}` : `unix:${e.path}`);
export const endpointLabel = (e: Endpoint): string => (e.kind === 'tcp' ? `:${e.port}` : e.path);
export const instanceTitle = (i: Pick<RedisInstance, 'server' | 'endpoint'>): string =>
  `${i.server ? `${i.server.name} ${shortVersion(i.server.version)}` : 'redis'} · ${endpointLabel(i.endpoint)}`;
export const shortVersion = (v: string): string => v.split('.').slice(0, 2).join('.');

/** Picked instance first by the project's own sources, then this project's containers, then the rest by port/path. */
export function orderInstances<T extends Pick<RedisInstance, 'mine' | 'endpoint'> & { fromEnv?: boolean }>(list: readonly T[]): T[] {
  const rank = (i: T) => (i.fromEnv ? 0 : i.mine ? 1 : 2);
  const pos = (i: T) => (i.endpoint.kind === 'tcp' ? i.endpoint.port : 70000);
  return [...list].sort((a, b) => rank(a) - rank(b) || pos(a) - pos(b) || endpointKey(a.endpoint).localeCompare(endpointKey(b.endpoint)));
}

// —— .env and URLs ——

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^"/.test(v)) v = (/^"((?:[^"\\]|\\.)*)"/.exec(v)?.[1] ?? v.slice(1)).replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
    else if (/^'/.test(v)) v = /^'([^']*)'/.exec(v)?.[1] ?? v.slice(1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]!] = v;
  }
  return out;
}

export type ParsedUrl =
  | { kind: 'tcp'; host: string; port: number; user?: string; password?: string; db: number; tls: boolean }
  | { kind: 'unix'; path: string; password?: string; db: number; tls: false };

export function parseRedisUrl(u: string): ParsedUrl | null {
  const s = u.trim();
  if (s.startsWith('/')) return { kind: 'unix', path: s, db: 0, tls: false };
  if (s.startsWith('unix://')) {
    const path = s.slice('unix://'.length).split('?')[0]!;
    return path.startsWith('/') ? { kind: 'unix', path, db: 0, tls: false } : null;
  }
  const m = /^(rediss?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?(?:\/(\d+))?\/?(?:[?#].*)?$/.exec(s);
  if (!m) return null;
  const port = m[5] ? Number(m[5]) : 6379;
  if (!(port >= 1 && port <= 65535)) return null;
  const dec = (x: string | undefined) => { if (x === undefined || x === '') return undefined; try { return decodeURIComponent(x); } catch { return x; } };
  const user = dec(m[2]);
  const password = dec(m[3]);
  return {
    kind: 'tcp', host: m[4]!.replace(/^\[|\]$/g, ''), port, ...(user ? { user } : {}), ...(password !== undefined ? { password } : {}),
    db: m[6] ? Number(m[6]) : 0, tls: m[1] === 'rediss'
  };
}

export interface EnvCandidate { var: string; host: string; port: number; db: number; tls: boolean; user?: string; password?: string; path?: string; prefix?: string }

const URL_VARS = /(^|_)REDIS(_|$).*URL$|^REDIS_URL$|^(CELERY_BROKER_URL|BROKER_URL|CACHE_URL|CELERY_RESULT_BACKEND)$/;

/** The Redis endpoints a project's `.env` names: URL variables, then REDIS_HOST/REDIS_PORT (Laravel, Rails, Django…). */
export function redisFromEnv(vars: Record<string, string>): EnvCandidate[] {
  const out: EnvCandidate[] = [];
  const prefix = vars.REDIS_PREFIX || undefined;
  for (const [k, v] of Object.entries(vars)) {
    if (!URL_VARS.test(k) || !/^(rediss?|unix):\/\//.test(v)) continue;
    const p = parseRedisUrl(v);
    if (!p) continue;
    if (p.kind === 'unix') out.push({ var: k, host: '', port: 0, path: p.path, db: p.db, tls: false, ...(prefix ? { prefix } : {}) });
    else out.push({ var: k, host: p.host, port: p.port, db: p.db, tls: p.tls, ...(p.user ? { user: p.user } : {}), ...(p.password !== undefined ? { password: p.password } : {}), ...(prefix ? { prefix } : {}) });
  }
  if (vars.REDIS_HOST) {
    const port = Number(vars.REDIS_PORT || 6379);
    if (port >= 1 && port <= 65535) {
      const pw = vars.REDIS_PASSWORD && vars.REDIS_PASSWORD !== 'null' ? vars.REDIS_PASSWORD : undefined;
      const user = vars.REDIS_USERNAME && vars.REDIS_USERNAME !== 'null' ? vars.REDIS_USERNAME : undefined;
      out.push({
        var: 'REDIS_HOST', host: vars.REDIS_HOST, port, db: Number(vars.REDIS_DB || 0) || 0, tls: /^tls|^rediss/.test(vars.REDIS_SCHEME ?? ''),
        ...(user ? { user } : {}), ...(pw ? { password: pw } : {}), ...(prefix ? { prefix } : {})
      });
    }
  }
  return out;
}

export const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';

/**
 * A custom instance as stored in Settings: a passwordless loopback URL or an absolute socket path; null when refused.
 * Windows has no Unix sockets for Redis: loopback URLs only.
 */
export function normalizeCustom(input: string, platform: Platform = currentPlatform()): string | null {
  const p = parseRedisUrl(input);
  if (!p || p.tls) return null;
  if (p.kind === 'unix') return platform === 'win32' ? null : p.path;
  if (!isLoopback(p.host)) return null;
  return `redis://127.0.0.1:${p.port}${p.db ? `/${p.db}` : ''}`;
}

/** A Redis-like server image (Redis, Valkey, Redis Stack, KeyDB, Dragonfly), not tools named after it. */
export function isRedisImage(image: string): boolean {
  const name = image.split('@')[0]!.replace(/:[^/]*$/, '').toLowerCase();
  const last = name.split('/').slice(-2).join('/');
  return /(^|\/)(redis|valkey|keydb|dragonfly)$/.test(name) || /^redis\/redis-stack(-server)?$/.test(last) || /(^|\/)valkey\/valkey$/.test(name) || /dragonflydb\/dragonfly$/.test(name) || /eqalpha\/keydb$/.test(name);
}

/** Terminal processes that are Redis-like servers. */
export const REDIS_PROCS = new Set(['redis-server', 'valkey-server', 'keydb-server', 'redis-stack-server', 'dragonfly']);

// —— INFO ——

export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export interface RedisInfo {
  name: ServerName;
  version: string;
  mode: ServerMode;
  uptime: number;
  usedMemory: number;
  peakMemory: number;
  maxmemory: number;
  policy: string;
  ops: number;
  hits: number;
  misses: number;
  expired: number;
  evicted: number;
  clients: number;
  keyspace: { db: number; keys: number; expires: number }[];
  rdbLastSave: number | null;
  rdbChanges: number;
  rdbStatus: string;
  aof: boolean;
  aofStatus: string;
  executable: string;
  configFile: string;
  /** Installed by Homebrew (executable or config under /opt/homebrew or /usr/local). */
  brew: boolean;
}

const n = (v: string | undefined) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export function serverOf(f: Record<string, string>): { name: ServerName; version: string } {
  if (f.valkey_version) return { name: 'valkey', version: f.valkey_version };
  if (f.dragonfly_version) return { name: 'dragonfly', version: f.dragonfly_version.replace(/^df-v?/, '') };
  if (/keydb/i.test(`${f.redis_build_id ?? ''} ${f.executable ?? ''}`)) return { name: 'keydb', version: f.redis_version ?? '' };
  return { name: 'redis', version: f.redis_version ?? '' };
}

export function infoOf(f: Record<string, string>): RedisInfo {
  const { name, version } = serverOf(f);
  const mode: ServerMode = f.cluster_enabled === '1' || f.redis_mode === 'cluster' ? 'cluster' : f.redis_mode === 'sentinel' ? 'sentinel' : 'standalone';
  const keyspace = Object.entries(f).flatMap(([k, v]) => {
    const m = /^db(\d+)$/.exec(k);
    if (!m) return [];
    const kv = Object.fromEntries(v.split(',').map((p) => p.split('=') as [string, string]));
    return [{ db: Number(m[1]), keys: n(kv.keys), expires: n(kv.expires) }];
  }).sort((a, b) => a.db - b.db);
  const executable = f.executable ?? '';
  const configFile = f.config_file ?? '';
  return {
    name, version, mode, uptime: n(f.uptime_in_seconds), usedMemory: n(f.used_memory), peakMemory: n(f.used_memory_peak),
    maxmemory: n(f.maxmemory), policy: f.maxmemory_policy ?? '', ops: n(f.instantaneous_ops_per_sec), hits: n(f.keyspace_hits),
    misses: n(f.keyspace_misses), expired: n(f.expired_keys), evicted: n(f.evicted_keys), clients: n(f.connected_clients), keyspace,
    rdbLastSave: f.rdb_last_save_time ? n(f.rdb_last_save_time) * 1000 : null, rdbChanges: n(f.rdb_changes_since_last_save),
    rdbStatus: f.rdb_last_bgsave_status ?? 'ok', aof: f.aof_enabled === '1', aofStatus: f.aof_last_bgrewrite_status ?? 'ok',
    executable, configFile, brew: /^(\/opt\/homebrew|\/usr\/local)\//.test(executable) || /^(\/opt\/homebrew|\/usr\/local)\//.test(configFile)
  };
}

/** One INFO reading kept for the tiles' sparklines. */
export interface InfoSample { at: number; usedMemory: number; ops: number; hits: number; misses: number; expired: number; evicted: number }

// —— keys ——

export interface KeyEntry { key: string; type: string; ttl: number; size: number | null }

/** Keys that are not valid UTF-8 travel as this marker + base64, so an operation on them reaches the same bytes. */
const BIN = '\u0000b64:';

export function keyToWire(raw: Uint8Array): string {
  const s = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  const back = new TextEncoder().encode(s);
  if (back.length === raw.length && back.every((x, i) => x === raw[i]) && !s.startsWith(BIN)) return s;
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return BIN + btoa(bin);
}

export function keyFromWire(key: string): Uint8Array {
  if (!key.startsWith(BIN)) return new TextEncoder().encode(key);
  const bin = atob(key.slice(BIN.length));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** For the screen: escapes for bytes that aren't text. */
export function displayKey(key: string): string {
  if (!key.startsWith(BIN)) return key;
  return [...keyFromWire(key)].map((b) => (b >= 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)).join('');
}

export const NO_NAMESPACE = '';

/** A framework prefix most keys share: Laravel's `<app>_database_`, Django's `:<version>:`. */
export function frameworkPrefix(keys: readonly string[], hint: string | null = null): string | null {
  if (!keys.length) return null;
  const counts = new Map<string, number>();
  for (const k of keys) {
    const m = /^([a-z0-9_]+_database_)/i.exec(k) ?? /^(:\d+:)/.exec(k);
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  if (hint && keys.some((k) => k.startsWith(hint))) counts.set(hint, keys.filter((k) => k.startsWith(hint)).length);
  let best: string | null = null;
  let max = 0;
  for (const [p, c] of counts) if (c > max) { best = p; max = c; }
  return best && max / keys.length >= 0.6 ? best : null;
}

export function stripPrefix(key: string, prefix: string | null): string {
  return prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function namespaceOf(key: string, prefix: string | null): string {
  const k = stripPrefix(key, prefix);
  const i = k.indexOf(':');
  return i > 0 ? k.slice(0, i) : NO_NAMESPACE;
}

export interface Namespace { name: string; count: number; bytes: number; withTtl: number }

export function groupNamespaces(keys: readonly KeyEntry[], prefix: string | null): Namespace[] {
  const map = new Map<string, Namespace>();
  for (const k of keys) {
    const name = namespaceOf(k.key, prefix);
    const ns = map.get(name) ?? { name, count: 0, bytes: 0, withTtl: 0 };
    ns.count++;
    ns.bytes += k.size ?? 0;
    if (k.ttl >= 0) ns.withTtl++;
    map.set(name, ns);
  }
  return [...map.values()].sort((a, b) => (a.name === NO_NAMESPACE ? 1 : 0) - (b.name === NO_NAMESPACE ? 1 : 0) || b.count - a.count || a.name.localeCompare(b.name));
}

/** The sidebar filter as a SCAN MATCH glob: text without glob characters matches anywhere. */
export function globOf(filter: string): string {
  const f = filter.trim();
  if (!f) return '*';
  return /[*?[]/.test(f) ? f : `*${f}*`;
}

/** The pattern of a namespace's keys (glob characters in its name escaped). */
export function namespacePattern(ns: string, prefix: string | null): string {
  const esc = (s: string) => s.replace(/([*?[\]\\])/g, '\\$1');
  return `${esc(prefix ?? '')}${esc(ns)}:*`;
}

// —— formatting ——

export function fmtTtl(ms: number): string {
  if (ms < 0) return 'none';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function fmtTtlLong(ms: number): string {
  if (ms < 0) return 'no expiry';
  return fmtTtl(ms).replace(/(\d+)d/, '$1 d').replace(/(\d+)h/, '$1 h').replace(/(\d+)m(?!s)/, '$1 min').replace(/(\d+)s/, '$1 s');
}

export function fmtBytes(b: number): string {
  if (b < 1000) return `${b} B`;
  if (b < 1000 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1000 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function shortCount(x: number): string {
  if (x < 1000) return String(x);
  if (x < 1_000_000) return `${Math.floor(x / 1000)}k`;
  return `${(x / 1_000_000).toFixed(1)}M`;
}

export const fmtCount = (x: number): string => x.toLocaleString('en-US');

export function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `up ${d}d ${h}h`;
  if (h) return `up ${h}h ${m}m`;
  return `up ${m}m`;
}

// —— hints ——

export interface Hint { id: 'queue-polling' | 'no-ttl' | 'evicting' | 'rdb-failing'; tone: 'info' | 'amber'; cacheOnly?: number | null; ns?: string; count?: number }

export interface HintContext {
  queues: boolean;
  /** Cache keys' own hit ratio, estimated from Live (null: Live hasn't run long enough). */
  cacheOnly: number | null;
  /** A cache-looking namespace with keys that never expire. */
  cacheNoTtl: { ns: string; count: number } | null;
}

export function hints(i: Pick<RedisInfo, 'maxmemory' | 'policy' | 'hits' | 'misses' | 'evicted' | 'rdbStatus'>, ctx: HintContext): Hint[] {
  const out: Hint[] = [];
  const total = i.hits + i.misses;
  if (ctx.queues && total > 0 && i.hits / total < 0.5) out.push({ id: 'queue-polling', tone: 'info', cacheOnly: ctx.cacheOnly });
  if (i.maxmemory === 0 && i.policy === 'noeviction' && ctx.cacheNoTtl && ctx.cacheNoTtl.count > 0) out.push({ id: 'no-ttl', tone: 'amber', ns: ctx.cacheNoTtl.ns, count: ctx.cacheNoTtl.count });
  if (i.evicted > 0) out.push({ id: 'evicting', tone: 'amber', count: i.evicted });
  if (i.rdbStatus && i.rdbStatus !== 'ok') out.push({ id: 'rdb-failing', tone: 'amber' });
  return out;
}

// —— commands to copy ——

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** One shell word: as it is when plain, single-quoted otherwise (names and ids come from Redis data). */
export const shellArg = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : shq(s));

const READ_OF: Record<string, string> = {
  string: 'GET {k}', hash: 'HGETALL {k}', list: 'LRANGE {k} 0 -1', set: 'SMEMBERS {k}', zset: 'ZRANGE {k} 0 -1 WITHSCORES',
  stream: 'XRANGE {k} - +', 'ReJSON-RL': 'JSON.GET {k}', vectorset: 'VINFO {k}'
};

/** The redis-cli command that reads this key (never a password: --askpass when one is needed). */
export function cliCommand(e: Endpoint, db: number, key: string, type: string, auth: boolean): string {
  const where = e.kind === 'tcp' ? `-p ${e.port}` : `-s ${shellArg(e.path)}`;
  const read = (READ_OF[type] ?? 'TYPE {k}').replace('{k}', shq(displayKey(key)));
  return `redis-cli ${where} -n ${db}${auth ? ' --askpass' : ''} ${read}`;
}

export function cliBase(e: Endpoint, db: number, auth: boolean): string {
  return `redis-cli ${e.kind === 'tcp' ? `-p ${e.port}` : `-s ${shellArg(e.path)}`} -n ${db}${auth ? ' --askpass' : ''}`;
}

// —— masking ——

export const MASK = '••••';

/** A hash field or JSON key whose value is a secret (Docker's rule, plus CSRF/XSRF tokens). */
export function maskField(name: string, _value?: string): boolean {
  return isSecretKey(name) || /csrf|xsrf/i.test(name);
}

export function maskEmails(text: string): string {
  return text.replace(/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m, first: string, domain: string) => `${first}${MASK}@${domain}`);
}

/** A JSON-like value with secret keys masked (and emails, when asked), for the screen and for Claude. */
export function maskTree(v: unknown, emails = false): unknown {
  if (Array.isArray(v)) return v.map((x) => maskTree(x, emails));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskField(k) && x !== null && x !== '' ? `${MASK} (masked)` : maskTree(x, emails)]));
  return emails && typeof v === 'string' ? maskEmails(v) : v;
}

// —— prompts ——

const fence = (s: string) => { const t = s.includes('```') ? '````' : '```'; return `${t}\n${s}\n${t}`; };

export function keyPrompt(k: { instance: string; db: number; key: string; type: string; ttl: number; value: string }): string {
  return redactSecrets([
    `This is a Redis key from my local ${k.instance}, db${k.db}.`,
    `Key: ${displayKey(k.key)} (${k.type}, TTL ${fmtTtl(k.ttl)})`,
    '',
    fence(k.value.slice(0, 64 * 1024))
  ].join('\n'));
}

// —— values (what main reads for the value pane) ——

export interface ValueMeta { type: string; ttl: number; memory: number | null; encoding: string | null; idle: number | null; length: number | null }
export type ValueBody =
  | { kind: 'missing' }
  | { kind: 'string'; format: 'int' | 'json' | 'php' | 'msgpack' | 'text' | 'binary'; text?: string; value?: unknown; hex?: string[]; total: number; shown: number; gzip: boolean }
  | { kind: 'hash'; fields: [string, string][]; cursor: string; total: number }
  | { kind: 'list'; items: string[]; start: number; total: number }
  | { kind: 'set'; members: string[]; cursor: string; total: number }
  | { kind: 'zset'; members: [string, number][]; start: number; total: number }
  | { kind: 'stream'; entries: { id: string; fields: [string, string][] }[]; total: number; groups: { name: string; consumers: number; pending: number; lag: number | null }[] }
  | { kind: 'json'; value: unknown; text: string }
  | { kind: 'vector'; count: number; dim: number; quant: string }
  | { kind: 'other' };
export interface RedisValueReply { meta: ValueMeta; body: ValueBody }
export interface ValuePage { cursor?: string; start?: number }

export const VALUE_PAGE = 100;
export const STRING_PREVIEW = 256 * 1024;

/** A client of the picked instance, as the Clients table shows it. */
export interface ClientRow { id: number; name: string; kind: 'app' | 'queue' | 'atelier' | 'unnamed'; from: string; cmd: string; idle: number; db: number; addr: string }
export interface SlowEntry { id: number; at: number; micros: number; command: string; client: string }

/** What a window shows about its picked instance, pushed when it changes. */
export interface RedisStatus {
  key: string | null;
  info: RedisInfo | null;
  samples: InfoSample[];
  /** Features this user may not use (NOPERM / unknown command): 'info', 'monitor', 'clients', 'slowlog', 'config', 'dump'. */
  denied: string[];
  queues: import('./redis-queues').QueueInfo[] | null;
  /** Failures not looked at yet, by queue id (new since the first reading or the last look). */
  unseen: Record<string, number>;
  /** The window's database. */
  db: number;
  /** Where the server keeps its files (CONFIG GET dir; null when not allowed). */
  dir: string | null;
  error: string | null;
}

/** The writes the renderer can ask for; a queue is named by its id, main holds the rest. */
export type KeyWriteOp =
  | { op: 'delete'; keys: string[] }
  | { op: 'deleteMatching'; pattern: string }
  | { op: 'ttl'; key: string; ms: number | null }
  | { op: 'setString'; key: string; value: string }
  | { op: 'hset'; key: string; field: string; value: string }
  | { op: 'lset'; key: string; index: number; value: string }
  | { op: 'zscore'; key: string; member: string; score: number }
  | { op: 'jsonSet'; key: string; value: string }
  | { op: 'flushdb' };
export type RedisWriteOp = KeyWriteOp | { op: 'retry' | 'remove'; queue: { id: string }; id: string };
export type WriteResult =
  | { ok: true; count: number; undo: string | null }
  | { ok: false; reason: 'gone' | 'not-failed' | 'paused' | 'flow' | 'refused' | 'too-many' | 'big-numbers' | 'wrong-type' | 'too-big' | 'moved' | 'error'; message?: string };
export type UndoResult = { ok: true; kept: number } | { ok: false; reason: 'expired' | 'picked' | 'error'; message?: string };
export interface Preview { count: number; sample: string[]; capped: boolean; undo: boolean }

/** A failed job worth telling about (Settings › Redis › Notify when a job fails). */
export interface RedisNote { id: string; at: number; instance: string; queue: { id: string; name: string; lib: string }; job: { id: string; name: string; reason: string } }

/** Which views of the Redis tab a window shows: what main polls and streams for it. */
export interface RedisWatch { db: number; sidebar: boolean; queues: boolean; overview: boolean; live: boolean }

export function slowlogPrompt(instance: string, entries: { at: number; micros: number; command: string; client: string }[]): string {
  return redactSecrets([
    `These are the slowest recent commands on my local ${instance} (Redis slow log). What is slow and how would you fix it in my code?`,
    '',
    fence(entries.map((e) => `${new Date(e.at).toISOString()}  ${(e.micros / 1000).toFixed(1)} ms  ${e.command}${e.client ? `  (${e.client})` : ''}`).join('\n'))
  ].join('\n'));
}

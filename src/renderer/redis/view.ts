// Redis view helpers: pure — visibility, queue dots and rates, key parts, TTL ticking, the JSON
// tree as foldable lines, series for the tiles, the monitor's key filter.
import { NO_NAMESPACE, groupNamespaces, namespaceOf, stripPrefix, type InfoSample, type KeyEntry, type Namespace, type RedisSnapshot } from '@shared/redis';
import type { QueueInfo } from '@shared/redis-queues';
import type { ShowRedis } from '@shared/settings';

export function redisShown(show: ShowRedis, snap: RedisSnapshot | null): boolean {
  if (show === 'never') return false;
  if (show === 'always') return true;
  return !!snap && (snap.instances.length > 0 || snap.mentions);
}

/** The database to show first for the picked instance: the one its project's config names (REDIS_DB, `/2`), else 0. */
export function dbOfPick(snap: RedisSnapshot): number {
  return snap.instances.find((i) => i.key === snap.pick)?.db ?? 0;
}

// —— queues ——

export type QueueDot = 'err' | 'warn' | 'work' | 'ok';

export function queueDot(q: QueueInfo): QueueDot {
  if ((q.counts.failed ?? 0) > 0) return 'err';
  if (q.counts.paused) return 'warn';
  if ((q.counts.active ?? 0) > 0) return 'work';
  return 'ok';
}

export function queueDepth(q: QueueInfo): string {
  if (q.counts.waiting > 0) return String(q.counts.waiting);
  if ((q.counts.active ?? 0) > 0) return `${q.counts.active} active`;
  return '0';
}

/** Jobs done per minute over the last 10 minutes: "4.3", "idle", or "—" when the library doesn't say. */
export function doneRate(done: readonly number[] | null): string {
  if (!done) return '—';
  const last = done.slice(-10);
  const avg = last.reduce((a, b) => a + b, 0) / Math.max(1, last.length);
  return avg === 0 ? 'idle' : (Math.round(avg * 10) / 10).toFixed(1);
}

// —— keys ——

/** The key as the list shows it: namespace (and framework prefix) dimmed, the rest bright. */
export function splitKey(key: string, prefix: string | null): { pre: string; rest: string } {
  const k = stripPrefix(key, prefix);
  const i = k.indexOf(':');
  if (i <= 0) return { pre: prefix && key.startsWith(prefix) ? prefix : '', rest: k };
  const head = (prefix && key.startsWith(prefix) ? prefix : '') + k.slice(0, i + 1);
  return { pre: head, rest: k.slice(i + 1) };
}

export type TypeClass = 'string' | 'json' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'vector' | 'other';

export function typeClass(type: string, format: string | null): TypeClass {
  if (type === 'ReJSON-RL') return 'json';
  if (type === 'vectorset') return 'vector';
  if (type === 'string') return format === 'json' || format === 'php' || format === 'msgpack' ? 'json' : 'string';
  return (['hash', 'list', 'set', 'zset', 'stream'] as const).find((t) => t === type) ?? 'other';
}

export const typeLabel = (type: string): string => (type === 'ReJSON-RL' ? 'json' : type === 'vectorset' ? 'vector' : type);

/** A TTL read at `at` (ms; -1 none), as it stands now. */
export function tickTtl(ttl: number, at: number, now: number): number {
  if (ttl < 0) return ttl;
  return Math.max(0, ttl - (now - at));
}

/** A cache-looking namespace whose keys don't expire (the noeviction hint). */
export function cacheNoTtl(keys: readonly KeyEntry[], prefix: string | null): { ns: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const k of keys) {
    if (k.ttl >= 0) continue;
    const ns = namespaceOf(k.key, prefix);
    if (ns !== NO_NAMESPACE && /cache/i.test(ns)) counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? { ns: best[0], count: best[1] } : null;
}

export function keyspaceBar(ns: readonly Namespace[]): { name: string; pct: number }[] {
  const total = ns.reduce((n, x) => n + x.count, 0);
  if (!total) return [];
  const top = [...ns].filter((x) => x.name !== NO_NAMESPACE).sort((a, b) => b.count - a.count).slice(0, 3);
  const rest = total - top.reduce((n, x) => n + x.count, 0);
  const out = top.map((x) => ({ name: x.name, pct: Math.round((x.count / total) * 100) }));
  if (rest > 0) out.push({ name: 'other', pct: Math.max(1, 100 - out.reduce((n, x) => n + x.pct, 0)) });
  return out;
}

export { groupNamespaces };

// —— JSON tree ——

export interface JsonLine {
  id: string;
  depth: number;
  key: string | null;
  text: string;
  comma: boolean;
  cls: 'punct' | 'str' | 'num' | 'bool' | 'fold';
  /** The node this line opens or shows folded (click toggles it). */
  path: string | null;
  folded?: boolean;
  /** Keys or items of a folded node. */
  count?: number;
  isArray?: boolean;
  /** "… N more items" */
  more?: number;
}

/**
 * A JSON number kept as its source text: the Databases inspector's lossless trees (json-text.ts parseJson)
 * hold them, so 12345678901234567890 never shows as 12345678901234567000. A leaf, shown as written.
 */
export class JsonNum { constructor(readonly text: string) {} }

const MAX_ITEMS = 50;
const leaf = (v: unknown) => v === null || typeof v !== 'object' || v instanceof JsonNum;
const isObj = (v: unknown): v is Record<string, unknown> => !leaf(v) && !Array.isArray(v);
const lit = (v: unknown): { text: string; cls: JsonLine['cls'] } =>
  v instanceof JsonNum ? { text: v.text, cls: 'num' } : typeof v === 'string' ? { text: JSON.stringify(v), cls: 'str' } : typeof v === 'number' ? { text: String(v), cls: 'num' } : { text: String(v), cls: 'bool' };

function preview(v: Record<string, unknown> | unknown[]): string {
  const parts: string[] = [];
  let len = 0;
  const entries = Array.isArray(v) ? v.map((x) => [null, x] as const) : Object.entries(v);
  for (const [k, x] of entries) {
    const s = `${k !== null ? `${JSON.stringify(k)}: ` : ''}${leaf(x) ? lit(x).text : Array.isArray(x) ? '[…]' : '{…}'}`;
    if (len + s.length > 48 && parts.length) { parts.push('…'); break; }
    parts.push(s);
    len += s.length;
  }
  return Array.isArray(v) ? `[ ${parts.join(', ')} ]` : `{ ${parts.join(', ')} }`;
}

/**
 * A JSON-like value as lines: objects and arrays fold. By default, depth ≥ 3 starts folded and, in an array of objects,
 * every item after the first shows folded as a one-line preview; `toggled` holds the paths the viewer flipped.
 */
export function jsonLines(value: unknown, toggled: ReadonlySet<string>): JsonLine[] {
  const out: JsonLine[] = [];
  const walk = (v: unknown, path: string, depth: number, key: string | null, comma: boolean, defaultFolded: boolean) => {
    if (v === null || typeof v !== 'object' || v instanceof JsonNum) { out.push({ id: path, depth, key, ...lit(v), comma, path: null }); return; }
    const arr = Array.isArray(v);
    const size = arr ? v.length : Object.keys(v).length;
    if (size === 0) { out.push({ id: path, depth, key, text: arr ? '[]' : '{}', cls: 'punct', comma, path: null }); return; }
    const folded = defaultFolded !== toggled.has(path);
    if (folded) {
      const objItem = !arr && key === null && depth > 0;
      out.push({ id: path, depth, key, text: objItem ? preview(v as Record<string, unknown>) : arr ? '[…]' : '{…}', cls: objItem ? 'punct' : 'fold', comma, path, folded: true, count: size, isArray: arr });
      return;
    }
    // The same id as its folded line: the fold button stays the same element, and keeps the keyboard (the e2e).
    out.push({ id: path, depth, key, text: arr ? '[' : '{', cls: 'punct', comma: false, path, folded: false, count: size, isArray: arr });
    if (arr) {
      const items = v.slice(0, MAX_ITEMS);
      const objects = items.length > 1 && items.every(isObj);
      items.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1, null, i < items.length - 1 || v.length > MAX_ITEMS, depth + 1 >= 3 || (objects && i > 0)));
      if (v.length > MAX_ITEMS) out.push({ id: `${path}:more`, depth: depth + 1, key: null, text: '', cls: 'punct', comma: false, path: null, more: v.length - MAX_ITEMS });
    } else {
      const entries = Object.entries(v);
      entries.forEach(([k, x], i) => walk(x, `${path}.${k}`, depth + 1, k, i < entries.length - 1, depth + 1 >= 3));
    }
    out.push({ id: `${path}:close`, depth, key: null, text: arr ? ']' : '}', cls: 'punct', comma, path: null });
  };
  walk(value, '$', 0, null, false, false);
  return out;
}

// —— time and series ——

export function relTime(at: number, now: number): string {
  const d = Math.round((now - at) / 1000);
  const abs = Math.abs(d);
  const v = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return d >= 0 ? `${v} ago` : `in ${v}`;
}

export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}

/** Hit ratio per reading, from the counters' deltas (%, readings with no reads skipped). */
export function hitSeries(s: readonly InfoSample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const h = s[i]!.hits - s[i - 1]!.hits;
    const m = s[i]!.misses - s[i - 1]!.misses;
    if (h + m > 0) out.push(Math.round((h / (h + m)) * 100));
  }
  return out;
}

export function deltaSeries(s: readonly InfoSample[], pick: (x: InfoSample) => number): number[] {
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) out.push(Math.max(0, pick(s[i]!) - pick(s[i - 1]!)));
  return out;
}

export function peakOps(s: readonly InfoSample[]): { ops: number; at: number } | null {
  let best: InfoSample | null = null;
  for (const x of s) if (!best || x.ops > best.ops) best = x;
  return best ? { ops: best.ops, at: best.at } : null;
}

/** The monitor's filter: a glob (or plain text, anywhere) over the command's first argument. */
export function liveMatches(filter: string, args: readonly string[]): boolean {
  const f = filter.trim();
  if (!f) return true;
  const key = args[0] ?? '';
  if (!/[*?]/.test(f)) return key.includes(f);
  const re = new RegExp(`^${f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(key);
}

// The demo's Redis keyspace: the world's seeds (world/redis.ts, the same data the app's
// tests load into the fake Redis) held in memory with TTLs that run out, and read and written the way main's Redis code
// answers the Keys tab — SCAN pages with type / PTTL / MEMORY USAGE (src/main/redis/values.ts), a value by its type,
// paged, and the edits with their 30-second undo (src/main/redis/writes.ts). Pure and Node-free; time comes in.
import { STRING_PREVIEW, VALUE_PAGE, keyFromWire, type KeyEntry, type KeyWriteOp, type Preview, type RedisValueReply, type UndoResult, type ValueBody, type WriteResult } from '@shared/redis';
import type { RedisSeed, SeedValue } from '../world/redis';

export type Value =
  | { type: 'string'; v: string }
  | { type: 'hash'; v: Map<string, string | Uint8Array> }
  | { type: 'list'; v: string[] }
  | { type: 'set'; v: Set<string> }
  | { type: 'zset'; v: Map<string, number> }
  | { type: 'stream'; v: { id: string; fields: [string, string][] }[]; groups: { name: string; consumers: number; pending: number; lag: number }[] }
  | { type: 'ReJSON-RL'; v: string };

interface Entry { value: Value; expireAt: number | null; touched: number }

/** main's LIMITS (writes.ts): a pattern deletes at most this many keys; undo keeps at most this many. */
const MATCH_CAP = 100_000;
const UNDO_KEYS = 10_000;
const EDIT_MAX = 256 * 1024;
export const UNDO_MS = 30_000;

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;
const strict = new TextDecoder('utf-8', { fatal: true });
/** main's shown(): text when the bytes are UTF-8, escapes where they aren't. */
const shown = (v: string | Uint8Array): string => {
  if (typeof v === 'string') return v;
  try { return strict.decode(v); } catch { return [...v].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)).join(''); }
};
const len = (v: string | Uint8Array) => (typeof v === 'string' ? bytes(v) : v.length);

/** A Redis glob (MATCH) as a RegExp: *, ?, [..] / [^..], and \ escapes. */
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '\\' && i + 1 < glob.length) re += glob[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's');
}

function fromSeed(s: SeedValue): Value {
  switch (s.type) {
    case 'string': return { type: 'string', v: s.v };
    case 'hash': return { type: 'hash', v: new Map(Object.entries(s.v)) };
    case 'list': return { type: 'list', v: [...s.v] };
    case 'set': return { type: 'set', v: new Set(s.v) };
    case 'zset': return { type: 'zset', v: new Map(Object.entries(s.v)) };
    case 'stream': return { type: 'stream', v: s.v.map((e) => ({ id: e.id, fields: Object.entries(e.fields) })), groups: s.groups ?? [] };
    case 'ReJSON-RL': return { type: 'ReJSON-RL', v: s.v };
  }
}

const copy = (v: Value): Value => {
  switch (v.type) {
    case 'hash': return { type: 'hash', v: new Map(v.v) };
    case 'list': return { type: 'list', v: [...v.v] };
    case 'set': return { type: 'set', v: new Set(v.v) };
    case 'zset': return { type: 'zset', v: new Map(v.v) };
    case 'stream': return { type: 'stream', v: v.v.map((e) => ({ id: e.id, fields: [...e.fields] })), groups: [...v.groups] };
    default: return { ...v };
  }
};

/** The fake's MEMORY USAGE: an overhead, the key, the value's bytes. */
function sizeOf(key: string, v: Value): number {
  const of = (): number => {
    switch (v.type) {
      case 'string': case 'ReJSON-RL': return bytes(v.v);
      case 'hash': return [...v.v].reduce((n, [k, x]) => n + bytes(k) + len(x), 0);
      case 'list': return v.v.reduce((n, x) => n + bytes(x), 0);
      case 'set': return [...v.v].reduce((n, x) => n + bytes(x), 0);
      case 'zset': return [...v.v.keys()].reduce((n, x) => n + bytes(x) + 8, 0);
      case 'stream': return v.v.reduce((n, x) => n + x.fields.flat().join('').length + 16, 0);
    }
  };
  return 56 + bytes(key) + of();
}

const ENCODING: Record<Value['type'], string> = { string: 'raw', hash: 'listpack', list: 'quicklist', set: 'listpack', zset: 'listpack', stream: 'stream', 'ReJSON-RL': 'raw' };
const INT = /^-?\d{1,18}$/;

/** A string as the value pane shows it: an integer, JSON, or text (the only kinds the demo's keyspace holds). */
function stringBody(text: string): ValueBody {
  const total = bytes(text);
  const head = total > STRING_PREVIEW ? text.slice(0, STRING_PREVIEW) : text;
  const base = { total, shown: bytes(head), gzip: false };
  if (head === text && INT.test(text)) return { kind: 'string', format: 'int', text, ...base };
  if (head === text && /^[[{]/.test(text.trim())) {
    try { return { kind: 'string', format: 'json', value: JSON.parse(text.trim()) as unknown, text, ...base }; } catch { /* text */ }
  }
  return { kind: 'string', format: 'text', text: head, ...base };
}

interface Dumped { key: string; value: Value; deadline: number | null }

export interface Keyspace {
  /** The entry, or undefined when missing or expired (an expired key is removed on access, as Redis does). */
  get(db: number, key: string): Value | undefined;
  put(db: number, key: string, value: Value, ttlMs?: number | null): void;
  /** PTTL: ms left, -1 without one, -2 missing. */
  pttl(db: number, key: string): number;
  expire(db: number, key: string, ms: number | null): void;
  del(db: number, key: string): boolean;
  /** Live keys of a database in SCAN's order (sorted, as the fake Redis). */
  keys(db: number): string[];
  /** Live keys per database and how many have a TTL (INFO keyspace). */
  counts(): { db: number; keys: number; expires: number }[];
  scan(a: { db: number; match: string; cursor: string }): { cursor: string; keys: KeyEntry[]; total: number };
  value(a: { db: number; key: string; page: { cursor?: string; start?: number } }): RedisValueReply;
  counter(a: { db: number; key: string }): { value: string | null; ttl: number };
  preview(db: number, pattern: string): Preview;
  /** A key write as main's RedisWriter runs it; `keep` registers its undo. */
  write(db: number, op: KeyWriteOp): WriteResult;
  undo(id: string): UndoResult;
  /** Registers an undo (queue writes too) for 30 s; its id. */
  keep(run: () => UndoResult): string;
  /** Drops the keys whose TTL ran out (Redis's active expiry); how many. */
  sweep(): number;
}

const SCAN_COUNT = 1000;

export function createKeyspace(seeds: readonly RedisSeed[], now: () => number): Keyspace {
  const dbs = new Map<number, Map<string, Entry>>();
  const db = (n: number) => { let d = dbs.get(n); if (!d) { d = new Map(); dbs.set(n, d); } return d; };
  const t0 = now();
  for (const s of seeds) for (const k of s.keys) db(k.db ?? 0).set(k.key, { value: fromSeed(k.value), expireAt: k.ttlMs === undefined ? null : t0 + k.ttlMs, touched: t0 - 3000 });

  const live = (n: number, key: string): Entry | undefined => {
    const e = db(n).get(key);
    if (e && e.expireAt !== null && e.expireAt <= now()) { db(n).delete(key); return undefined; }
    return e;
  };
  const keys = (n: number) => [...db(n).keys()].filter((k) => live(n, k)).sort();
  const pttl = (n: number, key: string) => { const e = live(n, key); return !e ? -2 : e.expireAt === null ? -1 : e.expireAt - now(); };
  const undos = new Map<string, { at: number; run: () => UndoResult }>();
  let undoSeq = 0;
  const keep = (run: () => UndoResult): string => {
    for (const [id, u] of undos) if (now() - u.at > UNDO_MS) undos.delete(id);
    const id = `demo-undo-${++undoSeq}`;
    undos.set(id, { at: now(), run });
    return id;
  };
  const dump = (n: number, list: string[]): Dumped[] => list.flatMap((key) => {
    const e = live(n, key);
    return e ? [{ key, value: copy(e.value), deadline: e.expireAt }] : [];
  });
  /** main's restore(): back with the TTL they had left (gone if it ran out); a key written meanwhile is kept, unless `replace`. */
  const restore = (n: number, list: Dumped[], replace: boolean): number => {
    let kept = 0;
    for (const d of list) {
      if (d.deadline !== null && d.deadline <= now()) continue;
      if (!replace && live(n, d.key)) { kept++; continue; }
      db(n).set(d.key, { value: copy(d.value), expireAt: d.deadline, touched: now() });
    }
    return kept;
  };
  const delete_ = (n: number, list: string[]): WriteResult => {
    if (!list.length) return { ok: true, count: 0, undo: null };
    const dumped = list.length <= UNDO_KEYS ? dump(n, list) : null;
    let count = 0;
    for (const k of list) if (live(n, k) && db(n).delete(k)) count++;
    return { ok: true, count, undo: dumped ? keep(() => ({ ok: true, kept: restore(n, dumped, false) })) : null };
  };
  const edit = (n: number, key: string, types: string[], apply: (e: Entry | undefined) => boolean): WriteResult => {
    const e = live(n, key);
    const type = e?.value.type ?? 'none';
    if (!types.includes(type)) return { ok: false, reason: 'wrong-type' };
    if (e?.value.type === 'string' && bytes(e.value.v) > EDIT_MAX) return { ok: false, reason: 'too-big' };
    const dumped = dump(n, [key]);
    if (!apply(e)) return { ok: false, reason: 'error', message: 'ERR index out of range' };
    return { ok: true, count: 1, undo: dumped.length ? keep(() => ({ ok: true, kept: restore(n, dumped, true) })) : null };
  };
  const matching = (n: number, pattern: string) => { const re = globRe(pattern); return keys(n).filter((k) => re.test(k)); };

  return {
    get: (n, key) => { const e = live(n, key); if (e) e.touched = now(); return e?.value; },
    put(n, key, value, ttlMs = null) {
      db(n).set(key, { value, expireAt: ttlMs === null ? null : now() + ttlMs, touched: now() });
    },
    pttl,
    expire(n, key, ms) { const e = live(n, key); if (e) e.expireAt = ms === null ? null : now() + Math.max(1, ms); },
    del: (n, key) => !!live(n, key) && db(n).delete(key),
    keys,
    counts: () => [...dbs.keys()].sort((a, b) => a - b).flatMap((n) => {
      const list = keys(n);
      return list.length ? [{ db: n, keys: list.length, expires: list.filter((k) => db(n).get(k)!.expireAt !== null).length }] : [];
    }),
    scan({ db: n, match, cursor }) {
      const all = keys(n);
      const from = Number(cursor) || 0;
      const re = globRe(match);
      const slice = all.slice(from, from + SCAN_COUNT).filter((k) => re.test(k));
      const next = from + SCAN_COUNT >= all.length ? 0 : from + SCAN_COUNT;
      return {
        cursor: String(next), total: all.length,
        keys: slice.map((key) => { const e = live(n, key)!; return { key, type: e.value.type, ttl: pttl(n, key), size: sizeOf(key, e.value) }; })
      };
    },
    value({ db: n, key: wire, page }) {
      const key = new TextDecoder().decode(keyFromWire(wire));
      const e = live(n, key);
      if (!e) return { meta: { type: 'none', ttl: -2, memory: null, encoding: null, idle: null, length: null }, body: { kind: 'missing' } };
      const v = e.value;
      const idle = Math.max(0, Math.floor((now() - e.touched) / 1000));
      e.touched = now();
      const length = v.type === 'string' ? bytes(v.v) : v.type === 'hash' ? v.v.size : v.type === 'list' ? v.v.length : v.type === 'set' ? v.v.size : v.type === 'zset' ? v.v.size : v.type === 'stream' ? v.v.length : null;
      const meta = { type: v.type, ttl: pttl(n, key), memory: sizeOf(key, v), encoding: v.type === 'string' && INT.test(v.v) ? 'int' : ENCODING[v.type], idle, length };
      const at = (c?: string) => Number(c ?? '0') || 0;
      const paged = <T>(list: T[], from: number) => ({ items: list.slice(from, from + VALUE_PAGE), next: from + VALUE_PAGE >= list.length ? '0' : String(from + VALUE_PAGE) });
      let body: ValueBody;
      switch (v.type) {
        case 'string': body = stringBody(v.v); break;
        case 'hash': { const p = paged([...v.v], at(page.cursor)); body = { kind: 'hash', fields: p.items.map(([f, x]) => [f, shown(x)]), cursor: p.next, total: v.v.size }; break; }
        case 'list': { const start = page.start ?? 0; body = { kind: 'list', items: v.v.slice(start, start + VALUE_PAGE), start, total: v.v.length }; break; }
        case 'set': { const p = paged([...v.v], at(page.cursor)); body = { kind: 'set', members: p.items, cursor: p.next, total: v.v.size }; break; }
        case 'zset': {
          const start = page.start ?? 0;
          // ZREVRANGE: highest score first.
          const sorted = [...v.v].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
          body = { kind: 'zset', members: sorted.slice(start, start + VALUE_PAGE), start, total: v.v.size };
          break;
        }
        case 'stream': {
          // XREVRANGE key <cursor> - COUNT 100: newest first, `(id` excludes the last one shown.
          const c = page.cursor ?? '+';
          const newest = [...v.v].reverse();
          const from = c === '+' ? 0 : newest.findIndex((x) => (c.startsWith('(') ? x.id < c.slice(1) : x.id <= c));
          body = { kind: 'stream', entries: from < 0 ? [] : newest.slice(from, from + VALUE_PAGE).map((x) => ({ id: x.id, fields: x.fields })), total: v.v.length, groups: v.groups };
          break;
        }
        case 'ReJSON-RL': { let value: unknown = v.v; try { value = JSON.parse(v.v); } catch { /* as text */ } body = { kind: 'json', value, text: v.v }; break; }
      }
      return { meta, body };
    },
    counter({ db: n, key }) {
      const e = live(n, key);
      return { value: e?.value.type === 'string' ? e.value.v : null, ttl: pttl(n, key) };
    },
    preview(n, pattern) {
      const list = matching(n, pattern);
      return { count: Math.min(list.length, MATCH_CAP), sample: list.slice(0, 3), capped: list.length > MATCH_CAP, undo: list.length <= UNDO_KEYS };
    },
    write(n, op) {
      switch (op.op) {
        case 'delete': return delete_(n, op.keys.map((k) => new TextDecoder().decode(keyFromWire(k))));
        case 'deleteMatching': { const list = matching(n, op.pattern); return list.length > MATCH_CAP ? { ok: false, reason: 'too-many' } : delete_(n, list); }
        case 'ttl': {
          const e = live(n, op.key);
          if (!e) return { ok: false, reason: 'gone' };
          const deadline = e.expireAt;
          e.expireAt = op.ms === null ? null : now() + Math.max(1, Math.round(op.ms));
          return { ok: true, count: 1, undo: keep(() => { const x = live(n, op.key); if (x) x.expireAt = deadline; return { ok: true, kept: 0 }; }) };
        }
        case 'setString': return edit(n, op.key, ['string', 'none'], (e) => {
          // SET … KEEPTTL.
          db(n).set(op.key, { value: { type: 'string', v: op.value }, expireAt: e?.expireAt ?? null, touched: now() });
          return true;
        });
        case 'hset': return edit(n, op.key, ['hash', 'none'], (e) => {
          if (e?.value.type === 'hash') e.value.v.set(op.field, op.value);
          else db(n).set(op.key, { value: { type: 'hash', v: new Map([[op.field, op.value]]) }, expireAt: null, touched: now() });
          return true;
        });
        case 'lset': return edit(n, op.key, ['list'], (e) => {
          if (e?.value.type !== 'list') return false;
          const i = op.index < 0 ? e.value.v.length + op.index : op.index;
          if (i < 0 || i >= e.value.v.length) return false;
          e.value.v[i] = op.value;
          return true;
        });
        case 'zscore': return edit(n, op.key, ['zset'], (e) => {
          // ZADD XX: only an existing member.
          if (e?.value.type === 'zset' && e.value.v.has(op.member)) e.value.v.set(op.member, op.score);
          return true;
        });
        case 'jsonSet': return edit(n, op.key, ['ReJSON-RL', 'none'], (e) => {
          db(n).set(op.key, { value: { type: 'ReJSON-RL', v: op.value }, expireAt: e?.expireAt ?? null, touched: now() });
          return true;
        });
        case 'flushdb': db(n).clear(); return { ok: true, count: 1, undo: null };
      }
    },
    undo(id) {
      const u = undos.get(id);
      undos.delete(id);
      if (!u || now() - u.at > UNDO_MS) return { ok: false, reason: 'expired' };
      return u.run();
    },
    keep,
    sweep() {
      let n = 0;
      for (const [d, m] of dbs) for (const k of [...m.keys()]) if (!live(d, k)) n++;
      return n;
    }
  };
}

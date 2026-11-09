// Keys and values for the Keys tab: a SCAN page with each key's type, TTL and size, and one key's
// value read by its type — paged, previewed, gzip inflated — classified for the viewers. Reads only.
import { gunzipSync } from 'node:zlib';
import { keyFromWire, keyToWire, STRING_PREVIEW, VALUE_PAGE, type KeyEntry, type RedisValueReply, type ValueBody, type ValuePage } from '@shared/redis';
import { classifyString } from '@shared/redis-values';
import type { RedisClient } from './client';
import { RespError, text, type Reply } from './resp';

const kb = (k: string) => Buffer.from(keyFromWire(k));
const num = (r: Reply | undefined): number | null => (r instanceof RespError || r === null || r === undefined ? null : typeof r === 'number' ? r : Number.isFinite(Number(text(r))) ? Number(text(r)) : null);
const arr = (r: Reply | undefined): Reply[] => (Array.isArray(r) ? r : []);

/** Text when the bytes are UTF-8, escapes where they aren't (binary members, fields). */
export function shown(r: Reply | undefined): string {
  if (!Buffer.isBuffer(r)) return text(r ?? null);
  const s = r.toString('utf8');
  return Buffer.from(s, 'utf8').equals(r) ? s : [...r].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)).join('');
}

export async function scanPage(c: RedisClient, db: number, match: string, cursor: string, count = 1000): Promise<{ cursor: string; keys: KeyEntry[]; total: number }> {
  const [scan, size] = await c.pipeline([['SCAN', cursor, 'MATCH', match, 'COUNT', count], ['DBSIZE']], db);
  const a = arr(scan);
  const raw = arr(a[1]).filter((k): k is Buffer => Buffer.isBuffer(k));
  const rs = raw.length ? await c.pipeline(raw.flatMap((k) => [['TYPE', k], ['PTTL', k], ['MEMORY', 'USAGE', k]]), db, 20_000) : [];
  const keys = raw.map((k, i) => ({ key: keyToWire(k), type: text(rs[i * 3] ?? null) || 'none', ttl: num(rs[i * 3 + 1]) ?? -1, size: num(rs[i * 3 + 2]) }))
    .filter((k) => k.type !== 'none' && k.ttl !== -2);
  return { cursor: text(a[0] ?? '0'), keys, total: num(size) ?? 0 };
}

const LENGTH: Record<string, string> = { hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN', string: 'STRLEN', vectorset: 'VCARD' };

export async function readValue(c: RedisClient, db: number, key: string, page: ValuePage): Promise<RedisValueReply> {
  const k = kb(key);
  const [type] = await c.pipeline([['TYPE', k]], db);
  const t = text(type ?? null);
  if (!t || t === 'none') return { meta: { type: 'none', ttl: -2, memory: null, encoding: null, idle: null, length: null }, body: { kind: 'missing' } };
  const len = LENGTH[t];
  const [ttl, mem, enc, idle, length] = await c.pipeline([
    ['PTTL', k], ['MEMORY', 'USAGE', k], ['OBJECT', 'ENCODING', k], ['OBJECT', 'IDLETIME', k], ...(len ? [[len, k]] : [['PTTL', k]])
  ], db);
  const meta = { type: t, ttl: num(ttl) ?? -1, memory: num(mem), encoding: enc instanceof RespError ? null : text(enc ?? null) || null, idle: num(idle), length: len ? num(length) : null };
  return { meta, body: await body(c, db, k, t, meta.length ?? 0, page) };
}

async function body(c: RedisClient, db: number, k: Buffer, t: string, total: number, page: ValuePage): Promise<ValueBody> {
  switch (t) {
    case 'string': {
      const [head] = await c.pipeline([['GETRANGE', k, 0, STRING_PREVIEW - 1]], db);
      let bytes = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
      let gzip = false;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b && total <= 8 * 1024 * 1024) {
        const [whole] = await c.pipeline([['GET', k]], db, 20_000);
        try {
          bytes = gunzipSync(Buffer.isBuffer(whole) ? whole : bytes, { maxOutputLength: 8 * 1024 * 1024 });
          gzip = true;
          total = bytes.length;
          bytes = bytes.subarray(0, STRING_PREVIEW);
        } catch { /* not gzip after all */ }
      }
      const cl = classifyString(bytes, total);
      return { kind: 'string', ...cl, total, shown: bytes.length, gzip };
    }
    case 'hash': {
      const [r] = await c.pipeline([['HSCAN', k, page.cursor ?? '0', 'COUNT', VALUE_PAGE]], db);
      const a = arr(arr(r)[1]);
      const fields: [string, string][] = [];
      for (let i = 0; i + 1 < a.length; i += 2) fields.push([shown(a[i]), shown(a[i + 1])]);
      return { kind: 'hash', fields, cursor: text(arr(r)[0] ?? '0'), total };
    }
    case 'list': {
      const start = page.start ?? 0;
      const [r] = await c.pipeline([['LRANGE', k, start, start + VALUE_PAGE - 1]], db);
      return { kind: 'list', items: arr(r).map(shown), start, total };
    }
    case 'set': {
      const [r] = await c.pipeline([['SSCAN', k, page.cursor ?? '0', 'COUNT', VALUE_PAGE]], db);
      return { kind: 'set', members: arr(arr(r)[1]).map(shown), cursor: text(arr(r)[0] ?? '0'), total };
    }
    case 'zset': {
      const start = page.start ?? 0;
      // ZREVRANGE (not ZRANGE … REV): works on every server version.
      const [r] = await c.pipeline([['ZREVRANGE', k, start, start + VALUE_PAGE - 1, 'WITHSCORES']], db);
      const a = arr(r);
      const members: [string, number][] = [];
      for (let i = 0; i + 1 < a.length; i += 2) members.push([shown(a[i]), Number(text(a[i + 1] ?? null))]);
      return { kind: 'zset', members, start, total };
    }
    case 'stream': {
      const [r, g] = await c.pipeline([['XREVRANGE', k, page.cursor ?? '+', '-', 'COUNT', VALUE_PAGE], ['XINFO', 'GROUPS', k]], db);
      const entries = arr(r).map((e) => {
        const [id, fields] = arr(e);
        const f = arr(fields);
        const pairs: [string, string][] = [];
        for (let i = 0; i + 1 < f.length; i += 2) pairs.push([shown(f[i]), shown(f[i + 1])]);
        return { id: text(id ?? null), fields: pairs };
      });
      const groups = g instanceof RespError ? [] : arr(g).map((x) => {
        const f = arr(x);
        const m = new Map<string, Reply>();
        for (let i = 0; i + 1 < f.length; i += 2) m.set(text(f[i]!), f[i + 1]!);
        return { name: text(m.get('name') ?? null), consumers: num(m.get('consumers')) ?? 0, pending: num(m.get('pending')) ?? 0, lag: num(m.get('lag')) };
      });
      return { kind: 'stream', entries, total, groups };
    }
    case 'ReJSON-RL': {
      const [r] = await c.pipeline([['JSON.GET', k]], db, 20_000);
      const s = text(r ?? null);
      try { return { kind: 'json', value: JSON.parse(s) as unknown, text: s }; } catch { return { kind: 'json', value: s, text: s }; }
    }
    case 'vectorset': {
      const [dim, info] = await c.pipeline([['VDIM', k], ['VINFO', k]], db);
      const a = arr(info);
      let quant = '';
      for (let i = 0; i + 1 < a.length; i += 2) if (text(a[i]!) === 'quant-type') quant = text(a[i + 1]!);
      return { kind: 'vector', count: total, dim: num(dim) ?? 0, quant };
    }
    default: return { kind: 'other' };
  }
}

/** An integer string re-read every second by the counter view. */
export async function readCounter(c: RedisClient, db: number, key: string): Promise<{ value: string | null; ttl: number }> {
  const [v, t] = await c.pipeline([['GET', kb(key)], ['PTTL', kb(key)]], db);
  return { value: v === null || v instanceof RespError ? null : text(v ?? null), ttl: num(t) ?? -2 };
}

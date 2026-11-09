// What Redis is doing: MONITOR lines parsed and colored by what the command does, cache misses
// inferred (a GET followed by a SET of the same key from the same client), and CLIENT LIST parsed. Pure.
import { MASK, maskField } from './redis';

export interface MonitorLine { at: number; db: number; addr: string; cmd: string; args: string[] }
export type CommandClass = 'read' | 'write' | 'del' | 'script' | 'other';

function unquote(s: string, start: number): { value: string; end: number } | null {
  if (s[start] !== '"') return null;
  let out = '';
  let i = start + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') return { value: out, end: i + 1 };
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'x') { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; continue; }
      out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === 'a' ? '\u0007' : n === 'b' ? '\b' : n ?? '';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return null;
}

/** What of a monitor line goes to the window: at most 16 arguments, each cut at 200 characters. */
export function trimMonitorLine(l: MonitorLine): MonitorLine {
  if (l.args.length <= 16 && l.args.every((a) => a.length <= 200)) return l;
  return { ...l, args: l.args.slice(0, 16).map((a) => (a.length > 200 ? `${a.slice(0, 199)}…` : a)) };
}

export function parseMonitorLine(line: string): MonitorLine | null {
  const m = /^(\d+)\.(\d+) \[(\d+) ([^\]]+)\] /.exec(line);
  if (!m) return null;
  const args: string[] = [];
  let i = m[0].length;
  while (i < line.length) {
    const q = unquote(line, i);
    if (!q) break;
    args.push(q.value);
    i = q.end + 1;
  }
  if (!args.length) return null;
  const frac = (m[2]! + '000').slice(0, 3);
  return { at: Number(m[1]) * 1000 + Number(frac), db: Number(m[3]), addr: m[4]!, cmd: args[0]!.toUpperCase(), args: args.slice(1) };
}

const DEL = new Set(['DEL', 'UNLINK', 'HDEL', 'SREM', 'ZREM', 'LREM', 'XDEL', 'XTRIM', 'FLUSHDB', 'FLUSHALL', 'GETDEL', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYRANK', 'ZREMRANGEBYLEX', 'LTRIM', 'JSON.DEL']);
const SCRIPT = new Set(['EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO', 'FCALL', 'FCALL_RO', 'SCRIPT', 'FUNCTION']);
const READ = new Set([
  'GET', 'MGET', 'GETRANGE', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'EXPIRETIME', 'HGET', 'HGETALL', 'HMGET', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS',
  'HSCAN', 'HSTRLEN', 'HRANDFIELD', 'LRANGE', 'LLEN', 'LINDEX', 'LPOS', 'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SSCAN', 'SRANDMEMBER', 'SINTER',
  'SUNION', 'SDIFF', 'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZRANK', 'ZREVRANK',
  'ZSCAN', 'XRANGE', 'XREVRANGE', 'XLEN', 'XREAD', 'XINFO', 'XPENDING', 'SCAN', 'KEYS', 'DUMP', 'JSON.GET', 'JSON.MGET', 'JSON.TYPE', 'GETBIT', 'BITCOUNT',
  'PFCOUNT', 'GEORADIUS_RO', 'GEOSEARCH', 'GEOPOS', 'GEODIST', 'VSIM', 'VCARD', 'VDIM', 'VINFO', 'VEMB', 'OBJECT', 'MEMORY', 'RANDOMKEY', 'DBSIZE'
]);
const WRITE = new Set([
  'SET', 'SETEX', 'PSETEX', 'SETNX', 'MSET', 'MSETNX', 'GETSET', 'GETEX', 'INCR', 'INCRBY', 'INCRBYFLOAT', 'DECR', 'DECRBY', 'APPEND', 'SETRANGE', 'SETBIT',
  'HSET', 'HMSET', 'HSETNX', 'HINCRBY', 'HINCRBYFLOAT', 'HEXPIRE', 'LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP', 'BLPOP', 'BRPOP', 'BLMOVE', 'LMOVE',
  'BRPOPLPUSH', 'RPOPLPUSH', 'LSET', 'LINSERT', 'LMPOP', 'BLMPOP', 'SADD', 'SPOP', 'SMOVE', 'SINTERSTORE', 'SUNIONSTORE', 'ZADD', 'ZINCRBY', 'ZPOPMIN',
  'ZPOPMAX', 'BZPOPMIN', 'BZPOPMAX', 'ZMPOP', 'BZMPOP', 'ZUNIONSTORE', 'ZINTERSTORE', 'XADD', 'XACK', 'XCLAIM', 'XAUTOCLAIM', 'XGROUP', 'XREADGROUP',
  'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST', 'RENAME', 'RENAMENX', 'COPY', 'MOVE', 'RESTORE', 'JSON.SET', 'JSON.MERGE', 'JSON.ARRAPPEND',
  'JSON.NUMINCRBY', 'PFADD', 'GEOADD', 'VADD', 'VREM', 'PUBLISH', 'SPUBLISH'
]);

export function classifyCommand(cmd: string): CommandClass {
  const c = cmd.toUpperCase();
  if (DEL.has(c)) return 'del';
  if (SCRIPT.has(c)) return 'script';
  if (READ.has(c)) return 'read';
  if (WRITE.has(c)) return 'write';
  return 'other';
}

const cut = (s: string, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The key that queue scripts are about: `bull:email-queue:wait` → `bull:email-queue`. */
function queueOfKey(key: string): string {
  const parts = key.split(':');
  return parts.length >= 3 ? parts.slice(0, -1).join(':') : key;
}

/** A command's arguments for the monitor: keys first, values cut and masked, scripts summarized. */
export function displayArgs(cmd: string, args: readonly string[]): string {
  const c = cmd.toUpperCase();
  if (c === 'EVAL' || c === 'EVALSHA' || c === 'EVAL_RO' || c === 'EVALSHA_RO' || c === 'FCALL' || c === 'FCALL_RO') {
    const nk = Number(args[1] ?? 0) || 0;
    const first = args[2];
    return first ? `script · ${queueOfKey(first)} · ${nk} key${nk === 1 ? '' : 's'}` : 'script';
  }
  const out: string[] = [];
  const key = args[0] ?? '';
  const secretKey = maskField(key.split(':').at(-1) ?? key) || /(^|:)(token|secret|password|apikey|api_key)(:|$)/i.test(key);
  if ((c === 'HSET' || c === 'HMSET' || c === 'HSETNX') && args.length > 2) {
    out.push(cut(key));
    for (let i = 1; i + 1 < args.length; i += 2) out.push(cut(args[i]!), maskField(args[i]!) ? MASK : cut(args[i + 1]!));
    return out.join(' ');
  }
  if ((c === 'SET' || c === 'SETEX' || c === 'PSETEX' || c === 'SETNX' || c === 'GETSET') && secretKey) {
    const valueAt = c === 'SETEX' || c === 'PSETEX' ? 2 : 1;
    return args.map((a, i) => (i === valueAt ? MASK : cut(a))).join(' ');
  }
  return args.map((a) => cut(a)).join(' ');
}

const SETS = new Set(['SET', 'SETEX', 'PSETEX', 'SETNX']);

/** Indexes of GETs that were misses: the same client SET the same key within 2 s (cache-aside's refill). */
export function markMisses(lines: readonly MonitorLine[], windowMs = 2000): Set<number> {
  const out = new Set<number>();
  const open = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const k = l.args[0];
    if (!k) continue;
    const id = `${l.addr}\u0000${l.db}\u0000${k}`;
    if (l.cmd === 'GET') { open.set(id, i); continue; }
    if (SETS.has(l.cmd)) {
      const g = open.get(id);
      if (g !== undefined && l.at - lines[g]!.at <= windowMs) out.add(g);
      open.delete(id);
    }
  }
  return out;
}

/** The hit ratio of GETs on keys that aren't queue keys, over the last `windowMs`; null under 20 such reads. */
export function cacheOnlyRatio(lines: readonly MonitorLine[], now: number, isQueueKey: (k: string) => boolean, windowMs = 5 * 60_000): number | null {
  const recent = lines.filter((l) => now - l.at <= windowMs);
  const misses = markMisses(recent);
  let gets = 0;
  let missed = 0;
  recent.forEach((l, i) => {
    if (l.cmd !== 'GET' || !l.args[0] || isQueueKey(l.args[0])) return;
    gets++;
    if (misses.has(i)) missed++;
  });
  return gets >= 20 ? 1 - missed / gets : null;
}

// —— CLIENT LIST ——

export interface ClientInfo { id: number; addr: string; laddr: string; name: string; age: number; idle: number; db: number; cmd: string; flags: string; lib: string }

export function parseClientList(text: string): ClientInfo[] {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const f: Record<string, string> = {};
    for (const part of line.split(' ')) { const i = part.indexOf('='); if (i > 0) f[part.slice(0, i)] = part.slice(i + 1); }
    return {
      id: Number(f.id ?? 0), addr: f.addr ?? '', laddr: f.laddr ?? '', name: f.name ?? '', age: Number(f.age ?? 0), idle: Number(f.idle ?? 0),
      db: Number(f.db ?? 0), cmd: f.cmd ?? '', flags: f.flags ?? '', lib: f['lib-name'] ?? ''
    };
  });
}

function b64(s: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4) return null;
  try {
    const bin = atob(s);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    return /^[\x20-\x7e]+$/.test(text) ? text : null;
  } catch { return null; }
}

/** BullMQ names its connections `<prefix>:<base64 queue>` (`:w:<worker>` for named workers): shown decoded. */
export function clientDisplayName(name: string): string {
  if (!name) return 'unnamed';
  const m = /^(.+?):([A-Za-z0-9+/]+={0,2})(?::w:(.+))?$/.exec(name);
  if (m) {
    const q = b64(m[2]!);
    if (q) return `${m[1]}:${q}${m[3] ? ` · ${m[3]}` : ''}`;
  }
  return name;
}

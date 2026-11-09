// A fake Redis on 127.0.0.1, for vitest integration tests and Playwright e2e: the app never meets
// a real Redis in tests. RESP2 with an in-memory keyspace (strings, hashes, lists, sets, zsets, streams, RedisJSON and
// vector sets as opaque types), INFO, CLIENT LIST, SLOWLOG, CONFIG GET, MONITOR, DUMP/RESTORE, optional requirepass,
// commands denied (NOPERM) or unknown, and Atelier's queue scripts done in JS. It records every command and every
// write, so a test can assert what was (not) sent.
import { createServer, type Server, type Socket } from 'node:net';
import { RespParser, type Reply } from '../../src/main/redis/resp';
import { QUEUE_SCRIPTS, SCRIPT_SHAS, scriptSha } from '../../src/main/redis/queue-scripts';
import { WRITE_COMMANDS } from '../../src/main/redis/commands';

export type FakeValue =
  | { type: 'string'; v: Buffer }
  | { type: 'hash'; v: Map<string, Buffer> }
  | { type: 'list'; v: Buffer[] }
  | { type: 'set'; v: Set<string> }
  | { type: 'zset'; v: Map<string, number> }
  | { type: 'stream'; v: { id: string; fields: string[] }[]; groups: { name: string; consumers: number; pending: number; lag: number }[] }
  | { type: 'ReJSON-RL'; v: string }
  | { type: 'vectorset'; v: { dim: number; count: number; quant: string } };

interface Entry { value: FakeValue; expireAt: number | null }

export interface FakeClient { id: number; addr: string; name: string; db: number; cmd: string; idle: number; lib?: string }
export interface SlowEntry { at: number; micros: number; args: string[]; addr: string; name: string }

export interface FakeRedisOptions {
  port?: number;
  password?: string;
  version?: string;
  server?: 'redis' | 'valkey' | 'dragonfly' | 'keydb';
  mode?: 'standalone' | 'cluster' | 'sentinel';
  /** Commands (upper case, `CLIENT LIST` style for subcommands) answered with NOPERM. */
  deny?: string[];
  /** Commands answered with "unknown command" (renamed or disabled). */
  unknown?: string[];
  executable?: string;
  maxmemory?: number;
  policy?: string;
}

export interface Conn { id: number; socket: Socket; db: number; authed: boolean; name: string; monitor: boolean; lastCmd: string; addr: string }

const ok = 'OK';
class Err { constructor(readonly message: string) {} }

function encode(r: Reply | Err | undefined): Buffer {
  if (r instanceof Err) return Buffer.from(`-${r.message}\r\n`);
  if (r === null || r === undefined) return Buffer.from('$-1\r\n');
  if (typeof r === 'number') return Buffer.from(`:${Math.trunc(r)}\r\n`);
  if (typeof r === 'string') return Buffer.from(`+${r}\r\n`);
  if (Buffer.isBuffer(r)) return Buffer.concat([Buffer.from(`$${r.length}\r\n`), r, Buffer.from('\r\n')]);
  if (Array.isArray(r)) return Buffer.concat([Buffer.from(`*${r.length}\r\n`), ...r.map((x) => encode(x as Reply))]);
  return Buffer.from(`-ERR ${(r as { message: string }).message}\r\n`);
}

const b = (s: string | number) => Buffer.from(String(s));
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^')}$`, 's');

export class FakeRedis {
  readonly dbs = new Map<number, Map<string, Entry>>();
  readonly log: string[][] = [];
  readonly writes: string[][] = [];
  readonly extraClients: FakeClient[] = [];
  readonly slowlog: SlowEntry[] = [];
  readonly config: Record<string, string> = { 'slowlog-log-slower-than': '10000', dir: '/data', maxmemory: '0', 'maxmemory-policy': 'noeviction' };
  readonly info: Record<string, string> = {};
  private conns = new Set<Conn>();
  private nextId = 10;
  private loaded = new Set<string>();
  private server!: Server;
  port = 0;
  stats = { hits: 178_651, misses: 380_817, expired: 25_309, evicted: 0, ops: 41, commands: 1_398_600 };

  constructor(readonly opts: FakeRedisOptions = {}) {
    if (opts.maxmemory !== undefined) this.config.maxmemory = String(opts.maxmemory);
    if (opts.policy) this.config['maxmemory-policy'] = opts.policy;
  }

  static async start(opts: FakeRedisOptions = {}): Promise<FakeRedis> {
    const f = new FakeRedis(opts);
    await f.listen(opts.port ?? 0);
    return f;
  }

  private listen(port: number): Promise<void> {
    this.server = createServer((socket) => this.accept(socket));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.port = (this.server.address() as { port: number }).port; resolve(); });
    });
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.socket.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Closes every client connection (the server "restarts" while keeping its port). */
  dropConnections(): void { for (const c of this.conns) c.socket.destroy(); }

  get connections(): Conn[] { return [...this.conns]; }

  // —— fixtures ——

  db(n = 0): Map<string, Entry> {
    let d = this.dbs.get(n);
    if (!d) { d = new Map(); this.dbs.set(n, d); }
    return d;
  }
  put(key: string, value: FakeValue, ttlMs: number | null = null, db = 0): void {
    this.db(db).set(key, { value, expireAt: ttlMs === null ? null : Date.now() + ttlMs });
  }
  str(key: string, v: string | Buffer, ttlMs: number | null = null, db = 0): void { this.put(key, { type: 'string', v: Buffer.isBuffer(v) ? v : b(v) }, ttlMs, db); }
  hash(key: string, fields: Record<string, string>, ttlMs: number | null = null, db = 0): void {
    this.put(key, { type: 'hash', v: new Map(Object.entries(fields).map(([k, v]) => [k, b(v)])) }, ttlMs, db);
  }
  list(key: string, items: string[], db = 0): void { this.put(key, { type: 'list', v: items.map(b) }, null, db); }
  set(key: string, members: string[], db = 0): void { this.put(key, { type: 'set', v: new Set(members) }, null, db); }
  zset(key: string, members: Record<string, number>, db = 0): void { this.put(key, { type: 'zset', v: new Map(Object.entries(members)) }, null, db); }
  stream(key: string, entries: { id: string; fields: Record<string, string> }[], groups: { name: string; consumers: number; pending: number; lag: number }[] = [], db = 0): void {
    this.put(key, { type: 'stream', v: entries.map((e) => ({ id: e.id, fields: Object.entries(e.fields).flat() })), groups }, null, db);
  }
  get(key: string, db = 0): FakeValue | null { return this.live(this.db(db), key)?.value ?? null; }
  ttlOf(key: string, db = 0): number | null { const e = this.live(this.db(db), key); return e?.expireAt ? e.expireAt - Date.now() : null; }

  /** A line every MONITOR connection sees, as a client would have produced it. */
  emitMonitor(args: string[], addr = '127.0.0.1:50000', db = 0): void {
    const line = `${(Date.now() / 1000).toFixed(6)} [${db} ${addr}] ${args.map((a) => JSON.stringify(a)).join(' ')}`;
    for (const c of this.conns) if (c.monitor) c.socket.write(`+${line}\r\n`);
  }

  // —— protocol ——

  private accept(socket: Socket): void {
    const conn: Conn = { id: this.nextId++, socket, db: 0, authed: !this.opts.password, name: '', monitor: false, lastCmd: '', addr: `${socket.remoteAddress ?? '127.0.0.1'}:${socket.remotePort ?? 0}` };
    this.conns.add(conn);
    const parser = new RespParser();
    socket.on('data', (chunk) => {
      let replies: Reply[];
      try { replies = parser.push(chunk); } catch { socket.destroy(); return; }
      for (const r of replies) {
        if (!Array.isArray(r)) continue;
        const args = r.map((x) => (Buffer.isBuffer(x) ? x : b(String(x))));
        socket.write(encode(this.exec(conn, args)));
      }
    });
    socket.on('close', () => this.conns.delete(conn));
    socket.on('error', () => {});
  }

  private live(d: Map<string, Entry>, key: string): Entry | undefined {
    const e = d.get(key);
    if (e && e.expireAt !== null && e.expireAt <= Date.now()) { d.delete(key); return undefined; }
    return e;
  }

  /**
   * One command run in process, with no socket, as an authenticated connection on `db` would run it: the live demo's
   * build reads its queues through it (src/demo/compile/redis-queues.ts). Errors come back as values with a message.
   */
  command(argv: readonly (string | Buffer)[], db = 0): Reply | { readonly message: string } {
    const conn = { id: 1, socket: null, db, authed: true, name: 'atelier', monitor: false, lastCmd: '', addr: '127.0.0.1:50100' } as unknown as Conn;
    return this.exec(conn, argv.map((a) => (Buffer.isBuffer(a) ? a : Buffer.from(a))));
  }

  private exec(conn: Conn, argv: Buffer[]): Reply | Err {
    const args = argv.map((a) => a.toString('utf8'));
    const cmd = (args[0] ?? '').toUpperCase();
    const sub = (args[1] ?? '').toUpperCase();
    this.log.push(args);
    conn.lastCmd = cmd.toLowerCase();
    if (cmd === 'AUTH') {
      const pass = args.length >= 3 ? args[2] : args[1];
      if (!this.opts.password || pass !== this.opts.password) return new Err('WRONGPASS invalid username-password pair or user is disabled.');
      conn.authed = true;
      return ok;
    }
    if (!conn.authed) return new Err('NOAUTH Authentication required.');
    if (this.opts.unknown?.includes(cmd) || this.opts.unknown?.includes(`${cmd} ${sub}`)) return new Err(`ERR unknown command '${args[0]}', with args beginning with: `);
    if (this.opts.deny?.includes(cmd) || this.opts.deny?.includes(`${cmd} ${sub}`)) return new Err(`NOPERM User default has no permissions to run the '${args[0]?.toLowerCase()}' command`);
    if (Object.hasOwn(WRITE_COMMANDS, cmd)) this.writes.push(args);
    if (!conn.monitor) for (const m of this.conns) if (m.monitor && m !== conn) m.socket.write(`+${(Date.now() / 1000).toFixed(6)} [${conn.db} ${conn.addr}] ${args.map((a) => JSON.stringify(a)).join(' ')}\r\n`);
    const d = this.db(conn.db);
    const e = (k: string) => this.live(d, k);
    const typed = <T extends FakeValue['type']>(k: string, t: T): Extract<FakeValue, { type: T }> | null | Err => {
      const x = e(k);
      if (!x) return null;
      return x.value.type === t ? (x.value as Extract<FakeValue, { type: T }>) : new Err('WRONGTYPE Operation against a key holding the wrong kind of value');
    };
    switch (cmd) {
      case 'PING': return 'PONG';
      case 'SELECT': conn.db = Number(args[1]); return ok;
      case 'CLIENT':
        if (sub === 'SETNAME') { conn.name = args[2] ?? ''; return ok; }
        if (sub === 'LIST') return b(this.clientList());
        return new Err('ERR unknown subcommand');
      case 'INFO': return b(this.infoText((args[1] ?? 'default').toLowerCase()));
      case 'DBSIZE': { let n = 0; for (const k of d.keys()) if (e(k)) n++; return n; }
      case 'TIME': { const now = Date.now(); return [b(Math.floor(now / 1000)), b((now % 1000) * 1000)]; }
      case 'ACL': return b('default');
      case 'CONFIG': {
        const re = globRe(args[2] ?? '*');
        return Object.entries(this.config).filter(([k]) => re.test(k)).flatMap(([k, v]) => [b(k), b(v)]);
      }
      case 'SLOWLOG':
        if (sub === 'LEN') return this.slowlog.length;
        return this.slowlog.slice(0, Number(args[2] ?? 10)).map((s, i) => [this.slowlog.length - i, Math.floor(s.at / 1000), s.micros, s.args.map(b), b(s.addr), b(s.name)]);
      case 'MONITOR': conn.monitor = true; return ok;
      case 'SCAN': {
        const cursor = Number(args[1]);
        let match: RegExp | null = null; let count = 10; let type: string | null = null;
        for (let i = 2; i < args.length; i += 2) {
          const o = args[i]!.toUpperCase();
          if (o === 'MATCH') match = globRe(args[i + 1]!);
          if (o === 'COUNT') count = Number(args[i + 1]);
          if (o === 'TYPE') type = args[i + 1]!;
        }
        const keys = [...d.keys()].filter((k) => e(k)).sort();
        const slice = keys.slice(cursor, cursor + count);
        const next = cursor + count >= keys.length ? 0 : cursor + count;
        return [b(next), slice.filter((k) => (!match || match.test(k)) && (!type || e(k)!.value.type === type)).map(b)];
      }
      case 'TYPE': return e(args[1]!)?.value.type ?? 'none';
      case 'EXISTS': return args.slice(1).filter((k) => e(k)).length;
      case 'PTTL': case 'TTL': {
        const x = e(args[1]!);
        if (!x) return -2;
        if (x.expireAt === null) return -1;
        const ms = x.expireAt - Date.now();
        return cmd === 'PTTL' ? ms : Math.ceil(ms / 1000);
      }
      case 'MEMORY': { const x = e(args[2]!); return x ? 56 + args[2]!.length + this.sizeOf(x.value) : null; }
      case 'OBJECT': {
        const x = e(args[2]!);
        if (!x) return null;
        if (sub === 'IDLETIME') return 3;
        if (sub === 'FREQ') return new Err('ERR An LFU maxmemory policy is not selected');
        const enc: Record<string, string> = { string: 'raw', hash: 'listpack', list: 'quicklist', set: 'listpack', zset: 'listpack', stream: 'stream', 'ReJSON-RL': 'raw', vectorset: 'raw' };
        if (x.value.type === 'string' && /^-?\d{1,18}$/.test(x.value.v.toString())) return b('int');
        return b(enc[x.value.type] ?? 'raw');
      }
      case 'GET': { const v = typed(args[1]!, 'string'); if (v instanceof Err) return v; if (v) this.stats.hits++; else this.stats.misses++; return v ? v.v : null; }
      case 'STRLEN': { const v = typed(args[1]!, 'string'); return v instanceof Err ? v : v ? v.v.length : 0; }
      case 'GETRANGE': {
        const v = typed(args[1]!, 'string'); if (v instanceof Err) return v;
        if (!v) return b('');
        const start = Number(args[2]); const end = Number(args[3]);
        return v.v.subarray(start, end < 0 ? v.v.length + end + 1 : end + 1);
      }
      case 'SET': {
        const opts = args.slice(3).map((a) => a.toUpperCase());
        const prev = e(args[1]!);
        if (opts.includes('NX') && prev) return null;
        if (opts.includes('XX') && !prev) return null;
        let expireAt: number | null = null;
        const ex = opts.indexOf('EX'); const px = opts.indexOf('PX');
        if (ex >= 0) expireAt = Date.now() + Number(args[3 + ex + 1]) * 1000;
        if (px >= 0) expireAt = Date.now() + Number(args[3 + px + 1]);
        if (opts.includes('KEEPTTL')) expireAt = prev?.expireAt ?? null;
        d.set(args[1]!, { value: { type: 'string', v: argv[2]! }, expireAt });
        return ok;
      }
      case 'HLEN': { const v = typed(args[1]!, 'hash'); return v instanceof Err ? v : v ? v.v.size : 0; }
      case 'HGET': { const v = typed(args[1]!, 'hash'); return v instanceof Err ? v : v?.v.get(args[2]!) ?? null; }
      case 'HMGET': { const v = typed(args[1]!, 'hash'); return v instanceof Err ? v : args.slice(2).map((f) => v?.v.get(f) ?? null); }
      case 'HGETALL': { const v = typed(args[1]!, 'hash'); return v instanceof Err ? v : v ? [...v.v].flatMap(([k, x]) => [b(k), x]) : []; }
      case 'HSCAN': case 'SSCAN': {
        const isHash = cmd === 'HSCAN';
        const v = isHash ? typed(args[1]!, 'hash') : typed(args[1]!, 'set');
        if (v instanceof Err) return v;
        const cursor = Number(args[2]);
        const ci = args.findIndex((a, i) => i > 2 && a.toUpperCase() === 'COUNT');
        const count = ci > 0 ? Number(args[ci + 1]) : 10;
        const all = v ? (isHash ? [...(v.v as Map<string, Buffer>).keys()] : [...(v.v as Set<string>)]) : [];
        const slice = all.slice(cursor, cursor + count);
        const next = cursor + count >= all.length ? 0 : cursor + count;
        return [b(next), isHash ? slice.flatMap((k) => [b(k), (v!.v as Map<string, Buffer>).get(k)!]) : slice.map(b)];
      }
      case 'HSET': {
        let v = typed(args[1]!, 'hash'); if (v instanceof Err) return v;
        if (!v) { v = { type: 'hash', v: new Map() }; d.set(args[1]!, { value: v, expireAt: null }); }
        let added = 0;
        for (let i = 2; i + 1 < args.length; i += 2) { if (!v.v.has(args[i]!)) added++; v.v.set(args[i]!, argv[i + 1]!); }
        return added;
      }
      case 'LLEN': { const v = typed(args[1]!, 'list'); return v instanceof Err ? v : v ? v.v.length : 0; }
      case 'LINDEX': { const v = typed(args[1]!, 'list'); if (v instanceof Err) return v; const i = Number(args[2]); return v?.v.at(i) ?? null; }
      case 'LRANGE': {
        const v = typed(args[1]!, 'list'); if (v instanceof Err) return v;
        if (!v) return [];
        const n = v.v.length; let s = Number(args[2]); let t = Number(args[3]);
        if (s < 0) s = n + s; if (t < 0) t = n + t;
        return v.v.slice(Math.max(0, s), t + 1);
      }
      case 'LSET': { const v = typed(args[1]!, 'list'); if (v instanceof Err) return v; if (!v) return new Err('ERR no such key'); const i = Number(args[2]); if (i >= v.v.length) return new Err('ERR index out of range'); v.v[i] = argv[3]!; return ok; }
      case 'LPUSH': case 'RPUSH': {
        let v = typed(args[1]!, 'list'); if (v instanceof Err) return v;
        if (!v) { v = { type: 'list', v: [] }; d.set(args[1]!, { value: v, expireAt: null }); }
        for (const x of argv.slice(2)) { if (cmd === 'LPUSH') v.v.unshift(x); else v.v.push(x); }
        return v.v.length;
      }
      case 'LREM': {
        const v = typed(args[1]!, 'list'); if (v instanceof Err) return v;
        if (!v) return 0;
        let n = Math.abs(Number(args[2])) || Infinity; let removed = 0;
        v.v = v.v.filter((x) => { if (n > 0 && x.toString() === args[3]) { n--; removed++; return false; } return true; });
        if (!v.v.length) d.delete(args[1]!);
        return removed;
      }
      case 'SCARD': { const v = typed(args[1]!, 'set'); return v instanceof Err ? v : v ? v.v.size : 0; }
      case 'SMEMBERS': { const v = typed(args[1]!, 'set'); return v instanceof Err ? v : v ? [...v.v].map(b) : []; }
      case 'SADD': {
        let v = typed(args[1]!, 'set'); if (v instanceof Err) return v;
        if (!v) { v = { type: 'set', v: new Set() }; d.set(args[1]!, { value: v, expireAt: null }); }
        let n = 0; for (const m of args.slice(2)) if (!v.v.has(m)) { v.v.add(m); n++; }
        return n;
      }
      case 'ZCARD': { const v = typed(args[1]!, 'zset'); return v instanceof Err ? v : v ? v.v.size : 0; }
      case 'ZSCORE': { const v = typed(args[1]!, 'zset'); if (v instanceof Err) return v; const s = v?.v.get(args[2]!); return s === undefined ? null : b(s); }
      case 'ZCOUNT': {
        const v = typed(args[1]!, 'zset'); if (v instanceof Err) return v;
        const lo = args[2] === '-inf' ? -Infinity : Number(args[2]); const hi = args[3] === '+inf' ? Infinity : Number(args[3]);
        return v ? [...v.v.values()].filter((s) => s >= lo && s <= hi).length : 0;
      }
      case 'ZRANGE': case 'ZREVRANGE': case 'ZRANGEBYSCORE': {
        const v = typed(args[1]!, 'zset'); if (v instanceof Err) return v;
        const flags = args.slice(4).map((a) => a.toUpperCase());
        const rev = cmd === 'ZREVRANGE' || flags.includes('REV');
        const withScores = flags.includes('WITHSCORES');
        let sorted = v ? [...v.v].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1)) : [];
        if (cmd === 'ZRANGEBYSCORE') {
          const lo = args[2] === '-inf' ? -Infinity : Number(args[2]); const hi = args[3] === '+inf' ? Infinity : Number(args[3]);
          sorted = sorted.filter(([, s]) => s >= lo && s <= hi);
          const li = flags.indexOf('LIMIT');
          if (li >= 0) sorted = sorted.slice(Number(args[4 + li + 1]), Number(args[4 + li + 1]) + Number(args[4 + li + 2]));
        } else {
          if (rev) sorted.reverse();
          const n = sorted.length; let s = Number(args[2]); let t = Number(args[3]);
          if (s < 0) s = n + s; if (t < 0) t = n + t;
          sorted = sorted.slice(Math.max(0, s), t + 1);
        }
        return sorted.flatMap(([m, s]) => (withScores ? [b(m), b(s)] : [b(m)]));
      }
      case 'ZADD': {
        let v = typed(args[1]!, 'zset'); if (v instanceof Err) return v;
        let i = 2; const flags: string[] = [];
        while (['XX', 'NX', 'GT', 'LT', 'CH'].includes((args[i] ?? '').toUpperCase())) flags.push(args[i++]!.toUpperCase());
        if (!v) { if (flags.includes('XX')) return 0; v = { type: 'zset', v: new Map() }; d.set(args[1]!, { value: v, expireAt: null }); }
        let n = 0;
        for (; i + 1 < args.length; i += 2) {
          const m = args[i + 1]!; const has = v.v.has(m);
          if (flags.includes('XX') && !has) continue;
          if (flags.includes('NX') && has) continue;
          if (!has) n++;
          v.v.set(m, Number(args[i]));
        }
        return n;
      }
      case 'ZREM': {
        const v = typed(args[1]!, 'zset'); if (v instanceof Err) return v;
        if (!v) return 0;
        let n = 0; for (const m of args.slice(2)) if (v.v.delete(m)) n++;
        if (!v.v.size) d.delete(args[1]!);
        return n;
      }
      case 'XLEN': { const v = typed(args[1]!, 'stream'); return v instanceof Err ? v : v ? v.v.length : 0; }
      case 'XRANGE': case 'XREVRANGE': {
        const v = typed(args[1]!, 'stream'); if (v instanceof Err) return v;
        const ci = args.findIndex((a) => a.toUpperCase() === 'COUNT');
        const count = ci > 0 ? Number(args[ci + 1]) : Infinity;
        const idNum = (id: string) => { const [ms, seq] = id.split('-'); return Number(ms) * 1e4 + Number(seq ?? 0); };
        const [lo, hi] = cmd === 'XRANGE' ? [args[2]!, args[3]!] : [args[3]!, args[2]!];
        const loN = lo === '-' ? -Infinity : idNum(lo); const hiN = hi === '+' ? Infinity : idNum(hi);
        let list = (v?.v ?? []).filter((x) => idNum(x.id) >= loN && idNum(x.id) <= hiN);
        if (cmd === 'XREVRANGE') list = [...list].reverse();
        return list.slice(0, count).map((x) => [b(x.id), x.fields.map(b)]);
      }
      case 'XINFO': {
        const v = typed(args[2]!, 'stream'); if (v instanceof Err) return v;
        if (!v) return new Err('ERR no such key');
        return v.groups.map((g) => [b('name'), b(g.name), b('consumers'), g.consumers, b('pending'), g.pending, b('lag'), g.lag]);
      }
      case 'JSON.GET': { const v = typed(args[1]!, 'ReJSON-RL'); return v instanceof Err ? v : v ? b(v.v) : null; }
      case 'JSON.TYPE': return e(args[1]!) ? b('object') : null;
      case 'JSON.SET': { d.set(args[1]!, { value: { type: 'ReJSON-RL', v: args[3]! }, expireAt: e(args[1]!)?.expireAt ?? null }); return ok; }
      case 'VCARD': { const v = typed(args[1]!, 'vectorset'); return v instanceof Err ? v : v ? v.v.count : 0; }
      case 'VDIM': { const v = typed(args[1]!, 'vectorset'); return v instanceof Err ? v : v ? v.v.dim : 0; }
      case 'VINFO': { const v = typed(args[1]!, 'vectorset'); return v instanceof Err ? v : v ? [b('quant-type'), b(v.v.quant), b('vector-dim'), v.v.dim, b('size'), v.v.count] : null; }
      case 'DEL': case 'UNLINK': { let n = 0; for (const k of args.slice(1)) if (e(k)) { d.delete(k); n++; } return n; }
      case 'EXPIRE': case 'PEXPIRE': {
        const x = e(args[1]!); if (!x) return 0;
        x.expireAt = Date.now() + Number(args[2]) * (cmd === 'EXPIRE' ? 1000 : 1);
        return 1;
      }
      case 'PERSIST': { const x = e(args[1]!); if (!x || x.expireAt === null) return 0; x.expireAt = null; return 1; }
      case 'FLUSHDB': d.clear(); return ok;
      case 'DUMP': { const x = e(args[1]!); return x ? Buffer.concat([b('FAKEDUMP'), b(JSON.stringify(serialize(x.value)))]) : null; }
      case 'RESTORE': {
        const key = args[1]!; const ttl = Number(args[2]);
        const replace = args.slice(4).some((a) => a.toUpperCase() === 'REPLACE');
        if (e(key) && !replace) return new Err('BUSYKEY Target key name already exists.');
        const raw = argv[3]!;
        if (!raw.subarray(0, 8).equals(b('FAKEDUMP'))) return new Err('ERR DUMP payload version or checksum are wrong');
        d.set(key, { value: deserialize(JSON.parse(raw.subarray(8).toString())), expireAt: ttl > 0 ? Date.now() + ttl : null });
        return ok;
      }
      case 'EVAL': case 'EVALSHA': {
        const sha = cmd === 'EVAL' ? scriptSha(args[1]!) : args[1]!.toLowerCase();
        if (cmd === 'EVALSHA' && !this.loaded.has(sha)) return new Err('NOSCRIPT No matching script. Please use EVAL.');
        this.loaded.add(sha);
        const name = SCRIPT_SHAS.get(sha);
        if (!name) return new Err('ERR unknown script');
        const nk = Number(args[2]);
        return this.script(name, conn, args.slice(3, 3 + nk), args.slice(3 + nk));
      }
      default: return new Err(`ERR unknown command '${args[0]}'`);
    }
  }

  /** Atelier's queue scripts (queue-scripts.ts), the same effects in JS. */
  private script(name: keyof typeof QUEUE_SCRIPTS, conn: Conn, keys: string[], argv: string[]): Reply | Err {
    const run = (...a: string[]) => this.exec({ ...conn, monitor: true }, a.map((x) => b(x)));
    const num = (r: Reply | Err) => (typeof r === 'number' ? r : 0);
    switch (name) {
      case 'bullmqRetry': {
        if (num(run('EXISTS', keys[0]!)) === 0) return -1;
        const meta = this.get(keys[3]!, conn.db);
        if (meta?.type === 'hash' && meta.v.has('paused')) return -4;
        if (run('ZSCORE', keys[1]!, argv[0]!) === null) return -3;
        run('ZREM', keys[1]!, argv[0]!);
        const job = this.get(keys[0]!, conn.db);
        if (job?.type === 'hash') for (const f of ['finishedOn', 'processedOn', 'failedReason']) job.v.delete(f);
        run(argv[1] === 'RPUSH' ? 'RPUSH' : 'LPUSH', keys[2]!, argv[0]!);
        run('ZADD', keys[5]!, '0', '0');
        const s = this.get(keys[6]!, conn.db);
        const entry = { id: `${Date.now()}-0`, fields: ['event', 'waiting', 'jobId', argv[0]!, 'prev', 'failed'] };
        if (s?.type === 'stream') s.v.push(entry); else this.put(keys[6]!, { type: 'stream', v: [entry], groups: [] }, null, conn.db);
        return 1;
      }
      case 'bullmqUnretry': {
        if (num(run('LREM', keys[2]!, '1', argv[0]!)) === 0) return 0;
        run('ZADD', keys[1]!, argv[1]!, argv[0]!);
        const fields: string[] = [];
        if (argv[2]) fields.push('finishedOn', argv[2]);
        if (argv[3]) fields.push('processedOn', argv[3]);
        if (argv[4]) fields.push('failedReason', argv[4]);
        if (fields.length) run('HSET', keys[0]!, ...fields);
        return 1;
      }
      case 'bullmqRemove': {
        if (num(run('EXISTS', keys[0]!)) === 0) return -1;
        if (run('ZSCORE', keys[1]!, argv[0]!) === null) return -3;
        const job = this.get(keys[0]!, conn.db);
        if (job?.type === 'hash' && (job.v.has('parentKey') || job.v.has('parent') || job.v.has('deid'))) return -6;
        if (num(run('EXISTS', keys[5]!, keys[6]!, keys[7]!, keys[8]!)) > 0) return -6;
        run('ZREM', keys[1]!, argv[0]!);
        run('DEL', keys[0]!, keys[4]!);
        return 1;
      }
      case 'sidekiqRetry': {
        if (num(run('ZREM', keys[0]!, argv[0]!)) === 0) return -3;
        run('LPUSH', keys[1]!, argv[1]!);
        run('SADD', keys[2]!, argv[2]!);
        return 1;
      }
      case 'sidekiqUnretry': {
        if (num(run('LREM', keys[1]!, '1', argv[2]!)) === 0) return 0;
        run('ZADD', keys[0]!, argv[1]!, argv[0]!);
        return 1;
      }
    }
  }

  private sizeOf(v: FakeValue): number {
    switch (v.type) {
      case 'string': return v.v.length;
      case 'hash': return [...v.v].reduce((n, [k, x]) => n + k.length + x.length, 0);
      case 'list': return v.v.reduce((n, x) => n + x.length, 0);
      case 'set': return [...v.v].reduce((n, x) => n + x.length, 0);
      case 'zset': return [...v.v.keys()].reduce((n, x) => n + x.length + 8, 0);
      case 'stream': return v.v.reduce((n, x) => n + x.fields.join('').length + 16, 0);
      case 'ReJSON-RL': return v.v.length;
      case 'vectorset': return v.v.count * v.v.dim;
    }
  }

  private clientList(): string {
    const own = [...this.conns].map((c) => `id=${c.id} addr=${c.addr} laddr=127.0.0.1:${this.port} fd=8 name=${c.name} age=12 idle=0 flags=${c.monitor ? 'O' : 'N'} db=${c.db} cmd=${c.lastCmd || 'NULL'} user=default lib-name= lib-ver=`);
    const extra = this.extraClients.map((c) => `id=${c.id} addr=${c.addr} laddr=127.0.0.1:${this.port} fd=9 name=${c.name} age=40 idle=${c.idle} flags=N db=${c.db} cmd=${c.cmd} user=default lib-name=${c.lib ?? ''} lib-ver=`);
    return [...own, ...extra].join('\n') + '\n';
  }

  private infoText(section: string): string {
    const server = this.opts.server ?? 'redis';
    const version = this.opts.version ?? '7.4.1';
    const mode = this.opts.mode ?? 'standalone';
    const keyspace = [...this.dbs].filter(([, d]) => [...d.keys()].some((k) => this.live(d, k))).map(([n, d]) => {
      const keys = [...d.keys()].filter((k) => this.live(d, k));
      const expires = keys.filter((k) => d.get(k)!.expireAt !== null).length;
      return `db${n}:keys=${keys.length},expires=${expires},avg_ttl=0`;
    });
    const sections: Record<string, string[]> = {
      server: [
        `redis_version:${server === 'redis' || server === 'keydb' ? version : '7.2.4'}`,
        ...(server === 'valkey' ? [`valkey_version:${version}`, 'server_name:valkey'] : []),
        ...(server === 'dragonfly' ? [`dragonfly_version:df-v${version}`] : []),
        ...(server === 'keydb' ? ['redis_build_id:keydb'] : []),
        `redis_mode:${mode}`, 'os:Linux 6.10.14-linuxkit aarch64', 'arch_bits:64', `tcp_port:${this.port}`, 'uptime_in_seconds:316707',
        `executable:${this.opts.executable ?? '/data/redis-server'}`, 'config_file:'
      ],
      clients: [`connected_clients:${this.conns.size + this.extraClients.length}`],
      memory: ['used_memory:2642344', 'used_memory_human:2.52M', 'used_memory_peak:4299161', 'used_memory_peak_human:4.10M', `maxmemory:${this.config.maxmemory}`, `maxmemory_policy:${this.config['maxmemory-policy']}`, 'mem_fragmentation_ratio:1.20'],
      persistence: ['rdb_changes_since_last_save:0', `rdb_last_save_time:${Math.floor(Date.now() / 1000) - 240}`, 'rdb_last_bgsave_status:ok', 'aof_enabled:0', 'aof_last_bgrewrite_status:ok', ...Object.entries(this.info).filter(([k]) => k.startsWith('rdb') || k.startsWith('aof')).map(([k, v]) => `${k}:${v}`)],
      stats: [`total_commands_processed:${this.stats.commands}`, `instantaneous_ops_per_sec:${this.stats.ops}`, `keyspace_hits:${this.stats.hits}`, `keyspace_misses:${this.stats.misses}`, `expired_keys:${this.stats.expired}`, `evicted_keys:${this.stats.evicted}`],
      replication: ['role:master', 'connected_slaves:0'],
      cluster: [`cluster_enabled:${mode === 'cluster' ? 1 : 0}`],
      keyspace
    };
    const pick = section === 'default' || section === 'all' || section === 'everything' ? Object.keys(sections) : [section];
    return pick.filter((s) => sections[s]).map((s) => `# ${s[0]!.toUpperCase()}${s.slice(1)}\r\n${sections[s]!.join('\r\n')}`).join('\r\n\r\n') + '\r\n';
  }
}

type Ser = { t: string; v: unknown };
function serialize(v: FakeValue): Ser {
  switch (v.type) {
    case 'string': return { t: v.type, v: v.v.toString('base64') };
    case 'hash': return { t: v.type, v: [...v.v].map(([k, x]) => [k, x.toString('base64')]) };
    case 'list': return { t: v.type, v: v.v.map((x) => x.toString('base64')) };
    case 'set': return { t: v.type, v: [...v.v] };
    case 'zset': return { t: v.type, v: [...v.v] };
    case 'stream': return { t: v.type, v: { e: v.v, g: v.groups } };
    default: return { t: v.type, v: v.v };
  }
}
function deserialize(s: Ser): FakeValue {
  switch (s.t) {
    case 'string': return { type: 'string', v: Buffer.from(s.v as string, 'base64') };
    case 'hash': return { type: 'hash', v: new Map((s.v as [string, string][]).map(([k, x]) => [k, Buffer.from(x, 'base64')])) };
    case 'list': return { type: 'list', v: (s.v as string[]).map((x) => Buffer.from(x, 'base64')) };
    case 'set': return { type: 'set', v: new Set(s.v as string[]) };
    case 'zset': return { type: 'zset', v: new Map(s.v as [string, number][]) };
    case 'stream': { const x = s.v as { e: { id: string; fields: string[] }[]; g: { name: string; consumers: number; pending: number; lag: number }[] }; return { type: 'stream', v: x.e, groups: x.g }; }
    case 'ReJSON-RL': return { type: 'ReJSON-RL', v: s.v as string };
    default: return { type: 'vectorset', v: s.v as { dim: number; count: number; quant: string } };
  }
}

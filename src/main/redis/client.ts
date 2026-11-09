// The Redis client: the only module that opens a connection to Redis — loopback TCP or a Unix
// socket, never another host. Commands are checked against commands.ts before a byte is written; reads through
// call/pipeline, writes through unsafeWrite/unsafeWritePipeline, which only writes.ts calls (a static guard keeps it so).
import { createConnection, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { assertRead, assertWrite } from './commands';
import { encodeCommand, RespError, RespParser, text, type Arg, type Reply } from './resp';

export const LOOPBACK = ['127.0.0.1', '::1'] as const;
export type Endpoint = { kind: 'tcp'; port: number; host?: (typeof LOOPBACK)[number] } | { kind: 'unix'; path: string };

export class Refused extends Error { constructor() { super('Redis refused the connection'); } }
export class Denied extends Error { constructor() { super('Permission denied on the Redis socket'); } }
export class Gone extends Error { constructor() { super('Redis connection lost'); } }
export class NoAuth extends Error { constructor() { super('Redis needs a password'); } }
export class NoPerm extends Error { constructor(readonly command: string) { super(`Not allowed for this Redis user: ${command}`); } }
export class Unknown extends Error { constructor(readonly command: string) { super(`Unknown Redis command: ${command}`); } }
export class Moved extends Error { constructor() { super('Key on another cluster node'); } }
export class ServerError extends Error { constructor(message: string) { super(message); } }

/** A server error reply as a typed error. The message names the command, never its arguments (values). */
export function errorOf(r: RespError, command = ''): Error {
  const m = r.message;
  if (/^(NOAUTH|WRONGPASS)\b/.test(m) || /^ERR (invalid password|Client sent AUTH)/.test(m)) return new NoAuth();
  if (/^NOPERM\b/.test(m)) return new NoPerm(command);
  if (/^ERR unknown (sub)?command/i.test(m) || /^ERR Unknown subcommand/i.test(m)) return new Unknown(command);
  if (/^(MOVED|ASK|CLUSTERDOWN)\b/.test(m)) return new Moved();
  return new ServerError(m.split(' ')[0] === 'ERR' ? m.slice(0, 200) : m.slice(0, 200));
}

export interface ConnectOptions {
  name: string;
  auth?: { user?: string; password: string };
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxReply?: number;
  onClose?: () => void;
}

interface Batch { expect: number; got: Reply[]; select: boolean; resolve(r: Reply[]): void; reject(e: Error): void; timer: NodeJS.Timeout; monitor?: (line: string) => void }

const cmdName = (args: readonly Arg[]) => [args[0], /^(MEMORY|OBJECT|CLIENT|SLOWLOG|CONFIG|XINFO|ACL)$/i.test(String(args[0])) ? args[1] : undefined].filter((x) => x !== undefined).map((x) => String(x).toUpperCase()).join(' ');

export class RedisClient {
  private parser: RespParser;
  private batches: Batch[] = [];
  private db = 0;
  private monitoring: ((line: string) => void) | null = null;
  private isClosed = false;

  private constructor(private socket: Socket, private o: ConnectOptions) {
    this.parser = new RespParser(o.maxReply ?? 16 * 1024 * 1024);
    socket.on('data', (c: Buffer) => this.onData(c));
    socket.on('close', () => this.onClosed());
    socket.on('error', () => {});
  }

  static connect(ep: Endpoint, o: ConnectOptions): Promise<RedisClient> {
    if (ep.kind === 'tcp') {
      const host = ep.host ?? '127.0.0.1';
      if (!(LOOPBACK as readonly string[]).includes(host)) return Promise.reject(new Error('redis: loopback hosts only'));
      if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) return Promise.reject(new Error('redis: bad port'));
    } else if (!isAbsolute(ep.path)) return Promise.reject(new Error('redis: socket path must be absolute'));
    return new Promise((resolve, reject) => {
      const socket = ep.kind === 'tcp' ? createConnection({ host: ep.host ?? '127.0.0.1', port: ep.port }) : createConnection({ path: ep.path });
      socket.setNoDelay(true);
      const timer = setTimeout(() => { socket.destroy(); reject(new Gone()); }, o.connectTimeoutMs ?? 500);
      socket.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? new Refused() : e.code === 'EACCES' || e.code === 'EPERM' ? new Denied() : new Gone());
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        const c = new RedisClient(socket, o);
        void (async () => {
          try {
            if (o.auth) await c.call(o.auth.user ? ['AUTH', o.auth.user, o.auth.password] : ['AUTH', o.auth.password]);
            await c.pipeline([['CLIENT', 'SETNAME', o.name]]).catch(() => []);
            resolve(c);
          } catch (e) {
            c.close();
            reject(e);
          }
        })();
      });
    });
  }

  get closed(): boolean { return this.isClosed; }

  /** This connection's own address as the server sees it on a host Redis (`127.0.0.1:51234`). */
  get localAddr(): string { return `${this.socket.localAddress ?? ''}:${this.socket.localPort ?? 0}`; }

  /** One read; a server error reply throws (typed). */
  async call(args: readonly Arg[], db?: number): Promise<Reply> {
    assertRead(args);
    const [r] = await this.send([args], db);
    if (r instanceof RespError) throw errorOf(r, cmdName(args));
    return r ?? null;
  }

  /** Reads in one round trip; error replies stay in place (callers decide what a missing feature means). */
  async pipeline(cmds: readonly (readonly Arg[])[], db?: number, timeoutMs?: number): Promise<Reply[]> {
    for (const c of cmds) assertRead(c);
    return this.send(cmds, db, timeoutMs);
  }

  /** The write path (writes.ts only). */
  async unsafeWrite(args: readonly Arg[], db?: number): Promise<Reply> {
    assertWrite(args);
    const [r] = await this.send([args], db);
    if (r instanceof RespError) throw errorOf(r, cmdName(args));
    return r ?? null;
  }

  async unsafeWritePipeline(cmds: readonly (readonly Arg[])[], db?: number, timeoutMs?: number): Promise<Reply[]> {
    for (const c of cmds) assertWrite(c);
    return this.send(cmds, db, timeoutMs);
  }

  /** Turns this connection into a MONITOR stream: every command the server runs, one line each, until close(). */
  async monitor(onLine: (line: string) => void): Promise<void> {
    assertRead(['MONITOR']);
    // Lines can follow the +OK in the same chunk: the stream starts the moment that reply is read.
    const [r] = await this.send([['MONITOR']], 0, undefined, onLine);
    if (r instanceof RespError) throw errorOf(r, 'MONITOR');
  }

  close(): void {
    if (this.isClosed) return;
    this.socket.destroy();
    this.onClosed();
  }

  /** `db` defaults to 0: every command says which database it is about, so none runs on another by accident. */
  private send(cmds: readonly (readonly Arg[])[], db = 0, timeoutMs?: number, monitor?: (line: string) => void): Promise<Reply[]> {
    if (this.isClosed) return Promise.reject(new Gone());
    if (this.monitoring) return Promise.reject(new Error('redis: a monitor connection runs nothing else'));
    if (!cmds.length) return Promise.resolve([]);
    const select = db !== this.db;
    const all = select ? [['SELECT', db] as Arg[], ...cmds] : cmds;
    if (select) this.db = db;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), timeoutMs ?? this.o.commandTimeoutMs ?? 5000);
      this.batches.push({ expect: all.length, got: [], select, resolve, reject, timer, ...(monitor ? { monitor } : {}) });
      this.socket.write(Buffer.concat(all.map((c) => encodeCommand(c))));
    });
  }

  private onData(chunk: Buffer): void {
    let replies: Reply[];
    try { replies = this.parser.push(chunk); } catch { this.close(); return; }
    for (const r of replies) {
      if (this.monitoring && !this.batches.length) { this.monitoring(text(r)); continue; }
      const b = this.batches[0];
      if (!b) continue;
      b.got.push(r);
      if (b.got.length < b.expect) continue;
      this.batches.shift();
      clearTimeout(b.timer);
      if (b.select && b.got[0] instanceof RespError) {
        this.db = -1;
        b.reject(errorOf(b.got[0], 'SELECT'));
      } else {
        const last = b.got[b.got.length - 1];
        if (b.monitor && !(last instanceof RespError)) this.monitoring = b.monitor;
        b.resolve(b.select ? b.got.slice(1) : b.got);
      }
    }
  }

  private onClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const b of this.batches) { clearTimeout(b.timer); b.reject(new Gone()); }
    this.batches = [];
    this.monitoring = null;
    this.o.onClose?.();
  }
}

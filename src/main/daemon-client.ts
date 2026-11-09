import { EventEmitter } from 'node:events';
import net from 'node:net';
import { LineDecoder, daemonCapabilities, encode, type ClientRequest, type DaemonCapability, type DaemonInfo, type Resumable, type ServerMessage, type TerminalInfo } from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/version';
import { canonicalRequest } from './daemon-wire';
import { INCOMPATIBLE, NOT_CONNECTED } from '@shared/daemon-errors';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type WithRid = Extract<ClientRequest, { rid: number }>;
type NoRid = Exclude<ClientRequest, { rid: number }>;
export type RequestMessage = DistributiveOmit<WithRid, 'rid'>;

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** A list of atelierd's that names projects (terminals, resume entries), as main shows it (terminal-homes.ts). */
type Relabel = <T extends { id: string; projectRoot: string }>(list: T[]) => T[];

export interface DaemonClientOptions {
  backoffMs?: number[]; requestTimeoutMs?: number; welcomeTimeoutMs?: number;
  /** Tests only: ignore the capabilities in welcome (all, or the ones listed), as with an atelierd older than them. */
  hideCapabilities?: boolean | readonly string[];
}

export class DaemonClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private pending = new Map<number, Pending>();
  private rid = 0;
  private stopped = false;
  private attempt = 0;
  private version: string | null = null;
  private everConnected = false;
  private snapshotParts = new Map<string, string>();
  private incompatible = false;
  private capabilities: string[] = [];
  /** Moved terminals' projects, and atelierd's last lists to send again. */
  private relabel: Relabel = (list) => list;
  private lastTerminals: TerminalInfo[] | null = null;
  private lastResumables: Resumable[] | null = null;

  constructor(private readonly getInfo: () => Promise<DaemonInfo>, private readonly opts: DaemonClientOptions = {}) { super(); }

  get connected(): boolean { return this.socket !== null && !this.socket.destroyed && this.version !== null; }
  get daemonVersion(): string | null { return this.version; }

  /**
   * Every terminal and resumable list goes out through `fn` (terminal-homes.ts): terminals moved to another project's
   * window read as that project's for every listener.
   */
  setRelabel(fn: Relabel): void { this.relabel = fn; }

  /** The project atelierd knows a terminal by (never relabelled), from its last list. */
  listedProject(id: string): string | null {
    return this.lastTerminals?.find((t) => t.id === id)?.projectRoot ?? null;
  }

  /** atelierd's last terminal and resumable lists again, relabelled as now (a terminal just moved). */
  reemit(): void {
    if (this.lastTerminals) this.emit('terminals', this.relabel(this.lastTerminals));
    if (this.lastResumables) this.emit('resumables', this.relabel(this.lastResumables));
  }

  /** What the connected atelierd can do beyond the protocol version (none while disconnected). */
  hasCapability(c: DaemonCapability): boolean { return this.connected && this.capabilities.includes(c); }

  /** First connection: resolves once the service has said welcome; if it fails, it retries on its own. */
  start(): Promise<void> {
    this.stopped = false;
    return this.connectOnce().catch((err: Error) => {
      if (!this.stopped && !this.incompatible) this.scheduleReconnect();
      throw err;
    });
  }

  get isIncompatible(): boolean { return this.incompatible; }

  /** After stopping an incompatible service: start over (getInfo starts the new one). */
  retry(): Promise<void> {
    this.incompatible = false;
    this.attempt = 0;
    return this.start();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
  }

  /**
   * Requests made while the service starts or reconnects wait for the connection,
   * within the same timeout: a click right after the window opens must not get lost.
   * A message given as a function is built only then, so it can depend on the connected atelierd (capabilities).
   */
  request<T = unknown>(msg: RequestMessage | (() => RequestMessage), o: { timeoutMs?: number } = {}): Promise<T> {
    const rid = ++this.rid;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = o.timeoutMs ?? this.opts.requestTimeoutMs ?? 10000;
      let onStatus: ((s: string) => void) | null = null;
      const timer = setTimeout(() => {
        if (onStatus) this.off('status', onStatus);
        this.pending.delete(rid);
        reject(new Error(this.connected ? 'atelierd not responding' : NOT_CONNECTED));
      }, timeoutMs);
      const sendNow = () => {
        let built: RequestMessage;
        try { built = typeof msg === 'function' ? msg() : msg; } catch (err) { clearTimeout(timer); reject(err as Error); return; }
        this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer });
        this.socket!.write(encode({ ...canonicalRequest(built), rid }));
      };
      if (this.connected) { sendNow(); return; }
      if (this.stopped || this.incompatible) { clearTimeout(timer); reject(new Error(NOT_CONNECTED)); return; }
      onStatus = (s: string) => {
        if (s === 'connected') { this.off('status', onStatus!); onStatus = null; sendNow(); }
        else if (s === 'incompatible') { this.off('status', onStatus!); clearTimeout(timer); reject(new Error(INCOMPATIBLE)); }
      };
      this.on('status', onStatus);
    });
  }

  send(msg: NoRid): void {
    if (this.connected) this.socket!.write(encode(msg));
  }

  private async connectOnce(): Promise<void> {
    const info = await this.getInfo();
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(info.sock);
      const decoder = new LineDecoder();
      let welcomed = false;
      // A service that accepts but does not respond (stuck) must not leave the app waiting forever.
      const timer = setTimeout(() => { if (!welcomed) { socket.destroy(); reject(new Error('atelierd did not send welcome')); } }, this.opts.welcomeTimeoutMs ?? 5000);
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(encode({ t: 'hello', token: info.token, v: PROTOCOL_VERSION })));
      socket.on('data', (chunk: string) => {
        let lines: string[];
        try { lines = decoder.push(chunk); } catch { socket.destroy(); return; }
        for (const line of lines) {
          let msg: ServerMessage;
          try { msg = JSON.parse(line) as ServerMessage; } catch { continue; }
          if (msg.t === 'incompatible') {
            clearTimeout(timer);
            this.incompatible = true;
            this.emit('status', 'incompatible');
            socket.destroy();
            reject(new Error('atelierd is incompatible with this app version'));
            return;
          }
          if (msg.t === 'welcome') {
            clearTimeout(timer);
            welcomed = true;
            this.socket = socket;
            this.version = msg.version;
            // Before 'connected' is announced: listeners read the capabilities right away.
            const hide = this.opts.hideCapabilities;
            this.capabilities = hide === true ? [] : daemonCapabilities(msg).filter((c) => !Array.isArray(hide) || !hide.includes(c));
            this.attempt = 0;
            const again = this.everConnected;
            this.everConnected = true;
            this.emit('status', 'connected');
            if (again) this.emit('reconnected');
            resolve();
          } else {
            this.dispatch(msg);
          }
        }
      });
      socket.on('error', (err) => { if (!welcomed) reject(err); });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!welcomed) { reject(new Error('atelierd closed the connection')); return; }
        if (this.socket === socket || this.socket === null) this.onClosed();
      });
    });
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.t) {
      case 'reply': {
        const p = this.pending.get(msg.rid);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.rid);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
        return;
      }
      case 'snapshot': {
        // The screen arrives in pieces: reassemble it and emit it whole, once.
        const acc = (this.snapshotParts.get(msg.id) ?? '') + msg.data;
        if (!msg.done) { this.snapshotParts.set(msg.id, acc); return; }
        this.snapshotParts.delete(msg.id);
        this.emit('snapshot', msg.id, acc);
        return;
      }
      case 'data': this.emit('data', msg.id, msg.data); return;
      case 'exit': this.emit('exit', msg.id, msg.code); return;
      case 'terminals': this.lastTerminals = msg.list; this.emit('terminals', this.relabel(msg.list)); return;
      case 'usage':
        this.emit('usage', msg.usage);
        // An atelierd without config dirs: its app-wide value is the only entry.
        if (!this.capabilities.includes('config-dirs')) this.emit('usageByConfigDir', msg.usage ? [{ configDir: null, usage: msg.usage }] : []);
        return;
      case 'usageByConfigDir': if (this.capabilities.includes('config-dirs')) this.emit('usageByConfigDir', msg.list); return;
      case 'attributions': this.emit('attributions', msg.list); return;
      case 'toolCalls': if (this.capabilities.includes('toolcalls')) this.emit('toolCalls', msg.list, msg.full); return;
      case 'resumables': this.lastResumables = msg.list; this.emit('resumables', this.relabel(msg.list)); return;
      case 'shellEnv': { const { t: _t, ...state } = msg; this.emit('shellEnv', state); return; }
      case 'schedules': if (this.capabilities.includes('schedules')) this.emit('schedules', msg.list); return;
      case 'signals': if (this.capabilities.includes('signals')) this.emit('signals', msg.book); return;
      default: return;
    }
  }

  private onClosed(): void {
    this.socket = null;
    this.snapshotParts.clear();
    // Its lists went with it: a terminal moved meanwhile never re-sends what a gone atelierd had.
    this.lastTerminals = null;
    this.lastResumables = null;
    this.version = null;
    this.capabilities = [];
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('atelierd disconnected')); }
    this.pending.clear();
    this.emit('status', 'disconnected');
    if (!this.stopped && !this.incompatible) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const steps = this.opts.backoffMs ?? [250, 500, 1000, 2000, 5000];
    const delay = steps[Math.min(this.attempt, steps.length - 1)]!;
    this.attempt += 1;
    setTimeout(() => {
      if (this.stopped) return;
      this.connectOnce().catch(() => { if (!this.incompatible) this.scheduleReconnect(); });
    }, delay);
  }
}

// The main process's only WebSocket: this computer's connection to the relay for iPhone access. It dials out (Atelier
// never listens), proves the room with its secret, keeps the pairing offers the relay resolves codes with, and
// multiplexes the phones' channels over one connection: binary frames are the channel id (4 bytes, big-endian) then
// one Noise message, opaque here. It reconnects by itself with jittered backoff, keeps the connection alive with
// pings, and paces what it sends under the relay's per-connection traffic limits so a busy terminal never gets the
// whole connection closed: frames wait in per-channel queues, served in turn. Relay URLs are checked by relayBase
// (https anywhere, http only to loopback and private addresses) before anything dials them.
import { relayBase } from '@shared/remote';
import { channelFrame, parseChannelFrame, type ChannelKind } from './wire';

export type RelayState = 'connecting' | 'online' | 'offline' | 'error';

export interface RelayTiming {
  /** The relay's answer to the auth frame, at most. */
  readyMs: number;
  /** A ping this often while online. */
  pingMs: number;
  /** Nothing heard from the relay for this long: the connection is given up for a new one. */
  deadMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
}

/** A token bucket's burst and refill per second. */
export interface Bucket { burst: number; perSec: number }
/**
 * What may leave per connection. The relay closes a connection past 400 frames or 4 MiB in 10 s: bursts plus 10 s of
 * refill stay under both in any 10 s window.
 */
export interface RelayBudget { frames: Bucket; bytes: Bucket }

const TIMING: RelayTiming = { readyMs: 15_000, pingMs: 25_000, deadMs: 60_000, backoffMinMs: 1000, backoffMaxMs: 30_000 };
const BUDGET: RelayBudget = { frames: { burst: 60, perSec: 30 }, bytes: { burst: 512 * 1024, perSec: 320 * 1024 } };
/** Bytes the socket may hold unsent before the queues wait for it. */
const SOCKET_HIGH_WATER = 1024 * 1024;

export interface RelayLinkOptions {
  /** The relay's base URL; one relayBase refuses is never dialed. */
  base: string;
  roomId: string;
  secret: Buffer;
  onState(state: RelayState, message?: string): void;
  /** A phone's channel opened (a new one, or one waiting while this computer was away). */
  onOpen(ch: number, kind: ChannelKind): void;
  /** A channel ended: the phone left, the relay closed it, or this connection dropped. */
  onClosed(ch: number): void;
  onData(ch: number, payload: Buffer): void;
  /** Everything queued for a channel has left. */
  onDrain?(ch: number): void;
  timing?: Partial<RelayTiming>;
  budget?: Partial<RelayBudget>;
  random?: () => number;
}

/** The relay's host endpoint for a room: wss:// for https, ws:// for http. */
export function relayEndpoint(base: string, roomId: string): string {
  return `${base.replace(/^http/, 'ws')}/v1/host/${roomId}`;
}

type Entry = { frame: Buffer } | { close: number };
interface Queue { entries: Entry[]; bytes: number }

class TokenBucket {
  private tokens: number;
  private at = Date.now();
  constructor(private readonly b: Bucket) { this.tokens = b.burst; }
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.b.burst, this.tokens + ((now - this.at) / 1000) * this.b.perSec);
    this.at = now;
  }
  /** Ms until `n` tokens are there (0: now). */
  wait(n: number): number {
    this.refill();
    const need = Math.min(n, this.b.burst) - this.tokens;
    return need <= 0 ? 0 : Math.ceil((need / this.b.perSec) * 1000);
  }
  take(n: number): void { this.refill(); this.tokens -= n; }
}

/** The relay's close codes that mean this computer must not simply retry at once. */
const REFUSED: Record<number, string> = {
  4401: 'The relay refused this computer\'s identity.',
  4409: 'Another Atelier with this identity connected to the relay.',
  4429: 'The relay closed the connection: too much traffic.'
};

export class RelayLink {
  private ws: WebSocket | null = null;
  private stopped = true;
  private current: RelayState = 'offline';
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private heardAt = 0;
  private readonly channels = new Set<number>();
  private readonly queues = new Map<number, Queue>();
  /** Channels with something queued, in the order they are served. */
  private turn: number[] = [];
  /** Live offers: lookup → when it expires. */
  private readonly offers = new Map<string, number>();
  private readonly timing: RelayTiming;
  private frames: TokenBucket;
  private bytes: TokenBucket;
  private readonly budget: RelayBudget;
  private closedWaiters: (() => void)[] = [];

  constructor(private readonly o: RelayLinkOptions) {
    this.timing = { ...TIMING, ...o.timing };
    this.budget = { ...BUDGET, ...o.budget };
    this.frames = new TokenBucket(this.budget.frames);
    this.bytes = new TokenBucket(this.budget.bytes);
  }

  get state(): RelayState { return this.current; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  /** Closes the connection cleanly (what is queued goes first, for up to `flushMs`) and stays offline. */
  async stop(flushMs = 0): Promise<void> {
    if (this.stopped && !this.ws) { this.setState('offline'); return; }
    this.stopped = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const ws = this.ws;
    if (ws && flushMs > 0 && ws.readyState === WebSocket.OPEN) {
      const until = Date.now() + flushMs;
      while (Date.now() < until && (this.turn.length > 0 || ws.bufferedAmount > 0)) await new Promise((r) => setTimeout(r, 10));
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => { this.closedWaiters.push(resolve); setTimeout(resolve, 1000).unref?.(); });
      try { ws.close(1000); } catch { /* closing already */ }
      await closed;
    }
    this.teardown();
    this.setState('offline');
  }

  /** Queues one Noise message for a channel; dropped when the channel isn't open. */
  send(ch: number, payload: Uint8Array): void {
    if (!this.channels.has(ch)) return;
    this.enqueue(ch, { frame: channelFrame(ch, payload) });
  }

  /** Bytes waiting to leave for a channel. */
  queued(ch: number): number { return this.queues.get(ch)?.bytes ?? 0; }

  /** Ends a channel with a close code (4000…4999) once what was queued for it has left. */
  closeChannel(ch: number, code: number): void {
    if (!this.channels.has(ch)) return;
    this.enqueue(ch, { close: code });
    this.channels.delete(ch);
  }

  /** The relay resolves `lookup` to this room for `ttlSec` seconds (sent again after a reconnection, for the time left). */
  offer(lookup: string, ttlSec: number): void {
    const ttl = Math.max(1, Math.min(300, Math.floor(ttlSec)));
    this.offers.set(lookup, Date.now() + ttl * 1000);
    if (this.current === 'online') this.text({ t: 'offer', lookup, ttl });
  }

  withdraw(lookup: string): void {
    if (!this.offers.delete(lookup)) return;
    if (this.current === 'online') this.text({ t: 'withdraw', lookup });
  }

  private setState(state: RelayState, message?: string): void {
    if (state === this.current && !message) return;
    this.current = state;
    this.o.onState(state, message);
  }

  private connect(): void {
    if (this.stopped) return;
    const base = relayBase(this.o.base);
    if (!base) { this.setState('error', 'The relay address is not one Atelier can use.'); return; }
    this.setState('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(relayEndpoint(base, this.o.roomId)); } catch { this.scheduleRetry('offline'); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.heardAt = Date.now();
      ws.send(JSON.stringify({ t: 'auth', secret: this.o.secret.toString('base64url') }));
      this.readyTimer = setTimeout(() => { try { ws.close(4000); } catch { /* gone */ } }, this.timing.readyMs);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (ws !== this.ws) return;
      this.heardAt = Date.now();
      if (typeof e.data === 'string') this.onText(e.data);
      else if (e.data instanceof ArrayBuffer) this.onBinary(new Uint8Array(e.data));
    };
    ws.onclose = (e: CloseEvent) => {
      if (ws !== this.ws) return;
      this.teardown();
      for (const w of this.closedWaiters.splice(0)) w();
      if (this.stopped) return;
      const refused = REFUSED[e.code];
      this.scheduleRetry(refused ? 'error' : 'offline', refused);
    };
    ws.onerror = () => { /* a close event follows */ };
  }

  /** The socket is gone: its channels with it. */
  private teardown(): void {
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; }
    const gone = [...this.channels];
    this.channels.clear();
    this.queues.clear();
    this.turn = [];
    for (const ch of gone) this.o.onClosed(ch);
  }

  private scheduleRetry(state: 'offline' | 'error', message?: string): void {
    this.setState(state, message);
    if (this.stopped || this.retry) return;
    // Full backoff for a refusal; else doubling from the minimum, with jitter so many computers don't come back at once.
    const ceiling = state === 'error' ? this.timing.backoffMaxMs : Math.min(this.timing.backoffMaxMs, this.timing.backoffMinMs * 2 ** this.attempts);
    this.attempts++;
    const delay = Math.round(ceiling * (0.5 + 0.5 * (this.o.random ?? Math.random)()));
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, delay);
    this.retry.unref?.();
  }

  private onText(text: string): void {
    let f: { t?: unknown; ch?: unknown; kind?: unknown };
    try { f = JSON.parse(text) as typeof f; } catch { return; }
    if (!f || typeof f !== 'object') return;
    switch (f.t) {
      case 'ready': {
        if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
        this.attempts = 0;
        this.setState('online');
        const now = Date.now();
        for (const [lookup, exp] of this.offers) {
          const left = Math.floor((exp - now) / 1000);
          if (left < 1) this.offers.delete(lookup);
          else this.text({ t: 'offer', lookup, ttl: Math.min(300, left) });
        }
        this.pingTimer = setInterval(() => this.keepAlive(), this.timing.pingMs);
        this.pingTimer.unref?.();
        return;
      }
      case 'open': {
        const ch = f.ch;
        if (typeof ch !== 'number' || !Number.isInteger(ch) || ch < 0 || ch > 0xffffffff || (f.kind !== 'device' && f.kind !== 'pair')) return;
        // A channel id opened again: the earlier channel is over.
        if (this.channels.has(ch)) { this.dropChannel(ch); this.o.onClosed(ch); }
        this.channels.add(ch);
        this.o.onOpen(ch, f.kind);
        return;
      }
      case 'closed': {
        const ch = f.ch;
        if (typeof ch !== 'number' || !this.channels.has(ch)) return;
        this.dropChannel(ch);
        this.o.onClosed(ch);
        return;
      }
      default:
        // pong, and anything newer: hearing from the relay is all a pong is for.
    }
  }

  private onBinary(bytes: Uint8Array): void {
    const f = parseChannelFrame(bytes);
    if (f && this.channels.has(f.ch)) this.o.onData(f.ch, f.payload);
  }

  private dropChannel(ch: number): void {
    this.channels.delete(ch);
    this.queues.delete(ch);
    this.turn = this.turn.filter((x) => x !== ch);
  }

  private keepAlive(): void {
    const ws = this.ws;
    if (!ws) return;
    if (Date.now() - this.heardAt > this.timing.deadMs) {
      // Silent for too long: a dead connection the OS hasn't noticed. Given up for a new one.
      this.teardown();
      try { ws.close(4000); } catch { /* gone */ }
      this.scheduleRetry('offline');
      return;
    }
    this.text({ t: 'ping' });
  }

  /** A control frame: never queued behind channel traffic, but counted in the budget. */
  private text(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const s = JSON.stringify(frame);
    this.frames.take(1);
    this.bytes.take(s.length);
    ws.send(s);
  }

  private enqueue(ch: number, entry: Entry): void {
    let q = this.queues.get(ch);
    if (!q) { q = { entries: [], bytes: 0 }; this.queues.set(ch, q); }
    q.entries.push(entry);
    if ('frame' in entry) q.bytes += entry.frame.length;
    if (!this.turn.includes(ch)) this.turn.push(ch);
    this.pump();
  }

  /** Sends what the budget and the socket allow now, one frame per channel in turn; waits for the rest. */
  private pump(): void {
    if (this.pumpTimer) return;
    const ws = this.ws;
    while (ws && ws.readyState === WebSocket.OPEN && this.turn.length > 0) {
      if (ws.bufferedAmount > SOCKET_HIGH_WATER) { this.later(20); return; }
      const ch = this.turn[0]!;
      const q = this.queues.get(ch);
      const entry = q?.entries[0];
      if (!q || !entry) { this.turn.shift(); continue; }
      if ('close' in entry) {
        q.entries.shift();
        this.text({ t: 'close', ch, code: entry.close });
      } else {
        const wait = Math.max(this.frames.wait(1), this.bytes.wait(entry.frame.length));
        if (wait > 0) { this.later(wait); return; }
        q.entries.shift();
        q.bytes -= entry.frame.length;
        this.frames.take(1);
        this.bytes.take(entry.frame.length);
        ws.send(entry.frame);
      }
      this.turn.shift();
      if (q.entries.length > 0) this.turn.push(ch);
      else {
        this.queues.delete(ch);
        if (this.channels.has(ch)) this.o.onDrain?.(ch);
      }
    }
  }

  private later(ms: number): void {
    this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, ms);
    this.pumpTimer.unref?.();
  }
}

// A relay for tests, on 127.0.0.1: the WebSocket service Atelier and the iPhone app dial, forwarding opaque bytes
// between them, in Node with the `ws` package. It keeps the relay's rules — host authentication by room secret, a
// newer host replacing the older, pairing offers (at most two per room, a TTL), channel ids, binary framing, status
// frames to devices, the size, channel and traffic limits and close codes — so the main process's tests and the e2e
// talk to something that behaves like the real one. Used from vitest and Playwright alike (no import.meta).
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export interface TestRelayOptions {
  /** How long a device may wait for an offline host before 4408 (the relay's own: 10 minutes). */
  waitHostMs?: number;
  /** How long a host has to authenticate (10 s). */
  authMs?: number;
  /** Per connection and per window: frames and bytes (400 and 4 MiB per 10 s). null: no traffic limit. */
  traffic?: { frames: number; bytes: number; windowMs: number } | null;
  /** At most this many device channels per room (8). */
  maxChannels?: number;
}

export interface TestRelay {
  /** http://127.0.0.1:<port>, the base URL both sides take. */
  url: string;
  port: number;
  /** Rooms whose host is connected and authenticated now. */
  hostOnline(roomId: string): boolean;
  /** How many authenticated host connections a room has had (reconnects count). */
  hostConnections(roomId: string): number;
  /** The lookups of a room's live offers, oldest first (every room's when none is named). */
  offers(roomId?: string): string[];
  /** The text frames hosts sent (auth secrets left out), in order: what the host asked of the relay. */
  hostFrames: { roomId: string | null; frame: Record<string, unknown> }[];
  /** Close codes the relay closed connections with, in order (`host 4401`, `device 4410`…). */
  closes: string[];
  /** Pongs stop: the host's keep-alive goes unanswered (a relay that hangs). */
  mutePongs(on: boolean): void;
  /** Every connection dropped at once, as a relay restart or a network cut. */
  dropAll(): void;
  close(): Promise<void>;
}

const ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_BINARY = 65535;
const MAX_TEXT = 1024;

interface Channel { ch: number; kind: 'device' | 'pair'; ws: WebSocket; waitTimer: ReturnType<typeof setTimeout> | null }
interface Room { id: string; host: WebSocket | null; channels: Map<number, Channel>; nextCh: number; offers: Map<string, number>; connections: number }

const roomIdOf = (secret: Buffer) => createHash('sha256').update('atelier-room-v1').update(secret).digest('base64url');

export async function startTestRelay(o: TestRelayOptions = {}): Promise<TestRelay> {
  const waitHostMs = o.waitHostMs ?? 10 * 60_000;
  const authMs = o.authMs ?? 10_000;
  const traffic = o.traffic === undefined ? { frames: 400, bytes: 4 * 1024 * 1024, windowMs: 10_000 } : o.traffic;
  const maxChannels = o.maxChannels ?? 8;
  const rooms = new Map<string, Room>();
  const hostFrames: TestRelay['hostFrames'] = [];
  const closes: string[] = [];
  let pongsMuted = false;

  const room = (id: string): Room => {
    let r = rooms.get(id);
    if (!r) { r = { id, host: null, channels: new Map(), nextCh: 1, offers: new Map(), connections: 0 }; rooms.set(id, r); }
    return r;
  };
  const liveOffer = (lookup: string): Room | null => {
    for (const r of rooms.values()) {
      const exp = r.offers.get(lookup);
      if (exp !== undefined && exp > Date.now()) return r;
    }
    return null;
  };
  const shut = (ws: WebSocket, who: string, code: number) => {
    closes.push(`${who} ${code}`);
    try { ws.close(code); } catch { /* already closing */ }
  };
  const send = (ws: WebSocket | null, frame: unknown) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); };

  /** Frames and bytes per window and connection: past either, 4429. */
  const meter = (ws: WebSocket, who: string) => {
    let start = Date.now(); let frames = 0; let bytes = 0;
    return (size: number): boolean => {
      if (!traffic) return true;
      const now = Date.now();
      if (now - start >= traffic.windowMs) { start = now; frames = 0; bytes = 0; }
      frames++; bytes += size;
      if (frames > traffic.frames || bytes > traffic.bytes) { shut(ws, who, 4429); return false; }
      return true;
    };
  };

  const server: Server = createServer((req, res) => {
    if (req.url === '/v1/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  // Large enough to see an oversized frame and answer it with the relay's own 4413.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const refuse = (socket: Duplex, status: number, text: string) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const m = /^\/v1\/(host|device|pair)\/([^/?]+)$/.exec(req.url ?? '');
    if (!m) { refuse(socket, 404, 'Not Found'); return; }
    const [, kind, id] = m as unknown as [string, 'host' | 'device' | 'pair', string];
    if (!ID.test(id)) { refuse(socket, 400, 'Bad Request'); return; }
    let target: Room | null = null;
    if (kind === 'pair') {
      target = liveOffer(id);
      if (!target) { refuse(socket, 404, 'Not Found'); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (kind === 'host') hostConnection(ws, id);
      else deviceConnection(ws, kind === 'pair' ? target! : room(id), kind === 'pair' ? 'pair' : 'device');
    });
  });

  function hostConnection(ws: WebSocket, roomId: string): void {
    let authed: Room | null = null;
    const count = meter(ws, 'host');
    const authTimer = setTimeout(() => shut(ws, 'host', 4408), authMs);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!count(buf.length)) return;
      if (isBinary) {
        if (!authed) { shut(ws, 'host', 4400); return; }
        if (buf.length - 4 > MAX_BINARY) { shut(ws, 'host', 4413); return; }
        if (buf.length < 4) { shut(ws, 'host', 4400); return; }
        const c = authed.channels.get(buf.readUInt32BE(0));
        if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(buf.subarray(4), { binary: true });
        return;
      }
      if (buf.length > MAX_TEXT) { shut(ws, 'host', 4413); return; }
      let f: Record<string, unknown>;
      try { f = JSON.parse(buf.toString('utf8')) as Record<string, unknown>; } catch { shut(ws, 'host', 4400); return; }
      if (!f || typeof f !== 'object' || typeof f.t !== 'string') { shut(ws, 'host', 4400); return; }
      if (!authed) {
        if (f.t !== 'auth' || typeof f.secret !== 'string') { shut(ws, 'host', 4401); return; }
        const secret = Buffer.from(f.secret, 'base64url');
        if (secret.length === 0 || roomIdOf(secret) !== roomId) { shut(ws, 'host', 4401); return; }
        clearTimeout(authTimer);
        const r = room(roomId);
        // A newer host replaces the older.
        if (r.host && r.host !== ws) shut(r.host, 'host', 4409);
        r.host = ws;
        r.connections++;
        authed = r;
        hostFrames.push({ roomId, frame: { t: 'auth' } });
        send(ws, { t: 'ready' });
        for (const c of r.channels.values()) {
          if (c.waitTimer) { clearTimeout(c.waitTimer); c.waitTimer = null; }
          send(c.ws, { t: 'status', host: 'online' });
          send(ws, { t: 'open', ch: c.ch, kind: c.kind });
        }
        return;
      }
      hostFrames.push({ roomId, frame: f });
      const r = authed;
      switch (f.t) {
        case 'offer': {
          const ttl = f.ttl;
          if (typeof f.lookup !== 'string' || !ID.test(f.lookup) || typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > 300) { shut(ws, 'host', 4400); return; }
          r.offers.delete(f.lookup);
          // At most two live offers: a third replaces the oldest.
          for (const [k, exp] of r.offers) if (exp <= Date.now()) r.offers.delete(k);
          while (r.offers.size >= 2) r.offers.delete(r.offers.keys().next().value as string);
          r.offers.set(f.lookup, Date.now() + ttl * 1000);
          return;
        }
        case 'withdraw':
          if (typeof f.lookup !== 'string') { shut(ws, 'host', 4400); return; }
          r.offers.delete(f.lookup);
          return;
        case 'close': {
          const code = f.code;
          if (typeof f.ch !== 'number' || typeof code !== 'number' || !Number.isInteger(code) || code < 4000 || code > 4999) { shut(ws, 'host', 4400); return; }
          const c = r.channels.get(f.ch);
          if (c) { r.channels.delete(c.ch); shut(c.ws, 'device', code); }
          return;
        }
        case 'ping':
          if (!pongsMuted) send(ws, { t: 'pong' });
          return;
        default:
          shut(ws, 'host', 4400);
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!authed || authed.host !== ws) return;
      const r = authed;
      r.host = null;
      for (const c of r.channels.values()) {
        send(c.ws, { t: 'status', host: 'offline' });
        armWait(r, c);
      }
    });
    ws.on('error', () => {});
  }

  function armWait(r: Room, c: Channel): void {
    if (c.waitTimer) clearTimeout(c.waitTimer);
    c.waitTimer = setTimeout(() => { r.channels.delete(c.ch); shut(c.ws, 'device', 4408); }, waitHostMs);
  }

  function deviceConnection(ws: WebSocket, r: Room, kind: 'device' | 'pair'): void {
    if (r.channels.size >= maxChannels) { shut(ws, 'device', 4429); return; }
    const c: Channel = { ch: r.nextCh++, kind, ws, waitTimer: null };
    r.channels.set(c.ch, c);
    const count = meter(ws, 'device');
    send(ws, { t: 'status', host: r.host ? 'online' : 'offline' });
    if (r.host) send(r.host, { t: 'open', ch: c.ch, kind });
    else armWait(r, c);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!count(buf.length)) return;
      if (isBinary) {
        if (buf.length > MAX_BINARY) { shut(ws, 'device', 4413); return; }
        if (r.host && r.host.readyState === r.host.OPEN) {
          const out = Buffer.alloc(4 + buf.length);
          out.writeUInt32BE(c.ch, 0);
          buf.copy(out, 4);
          r.host.send(out, { binary: true });
        }
        return;
      }
      if (buf.length > MAX_TEXT) { shut(ws, 'device', 4413); return; }
      let f: { t?: unknown };
      try { f = JSON.parse(buf.toString('utf8')) as { t?: unknown }; } catch { shut(ws, 'device', 4400); return; }
      if (f?.t === 'ping') { send(ws, { t: 'pong' }); return; }
      shut(ws, 'device', 4400);
    });
    ws.on('close', () => {
      if (c.waitTimer) clearTimeout(c.waitTimer);
      if (r.channels.get(c.ch) !== c) return;
      r.channels.delete(c.ch);
      send(r.host, { t: 'closed', ch: c.ch });
    });
    ws.on('error', () => {});
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hostOnline: (id) => !!rooms.get(id)?.host,
    hostConnections: (id) => rooms.get(id)?.connections ?? 0,
    offers: (id) => [...rooms.values()].filter((r) => !id || r.id === id).flatMap((r) => [...r.offers].filter(([, exp]) => exp > Date.now()).map(([k]) => k)),
    hostFrames,
    closes,
    mutePongs: (on) => { pongsMuted = on; },
    dropAll: () => { for (const ws of wss.clients) ws.terminate(); },
    close: () => new Promise<void>((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      for (const r of rooms.values()) for (const c of r.channels.values()) if (c.waitTimer) clearTimeout(c.waitTimer);
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}

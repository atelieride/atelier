import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { startTestRelay, type TestRelay } from '../../../tests/support/test-relay';
import { roomIdOf } from './identity';
import { RelayLink, relayEndpoint, type RelayLinkOptions, type RelayState } from './relay-link';

let relay: TestRelay;
const links: RelayLink[] = [];
const sockets: WebSocket[] = [];

beforeEach(async () => { relay = await startTestRelay(); });
afterEach(async () => {
  for (const l of links.splice(0)) await l.stop();
  for (const s of sockets.splice(0)) s.terminate();
  await relay.close();
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeLink(o: Partial<RelayLinkOptions> = {}) {
  const secret = randomBytes(32);
  const roomId = roomIdOf(secret);
  const states: { state: RelayState; message?: string }[] = [];
  const opened: [number, string, string?][] = [];
  const closed: number[] = [];
  const data: [number, string][] = [];
  const drained: number[] = [];
  const link = new RelayLink({
    base: relay.url, roomId, secret,
    onState: (state, message) => states.push({ state, ...(message ? { message } : {}) }),
    onOpen: (ch, kind, lookup) => opened.push(lookup ? [ch, kind, lookup] : [ch, kind]),
    onClosed: (ch) => closed.push(ch),
    onData: (ch, payload) => data.push([ch, payload.toString()]),
    onDrain: (ch) => drained.push(ch),
    timing: { backoffMinMs: 20, backoffMaxMs: 80, ...(o.timing ?? {}) },
    ...o
  });
  links.push(link);
  return { link, roomId, secret, states, opened, closed, data, drained };
}

/** A phone at the byte level: its frames, the status frames, the close code. */
function device(path: string) {
  const ws = new WebSocket(relay.url.replace('http', 'ws') + path);
  sockets.push(ws);
  const got: { binary: string[]; text: unknown[]; close: number | null; status: number | null } = { binary: [], text: [], close: null, status: null };
  ws.on('message', (d, bin) => { if (bin) got.binary.push((d as Buffer).toString()); else got.text.push(JSON.parse(d.toString())); });
  ws.on('close', (code) => { got.close = code; });
  ws.on('unexpected-response', (_req, res) => { got.status = res.statusCode ?? null; });
  ws.on('error', () => {});
  return { ws, got, open: () => new Promise<void>((r) => ws.once('open', () => r())) };
}

test('the endpoint: wss for https, ws for http, the path after the base', () => {
  expect(relayEndpoint('https://relay.test', 'R')).toBe('wss://relay.test/v1/host/R');
  expect(relayEndpoint('http://127.0.0.1:8787/x', 'R')).toBe('ws://127.0.0.1:8787/x/v1/host/R');
});

test('connects, authenticates with the room secret, and is online', async () => {
  const { link, roomId, states } = makeLink();
  link.start();
  await until(() => link.state === 'online');
  expect(relay.hostOnline(roomId)).toBe(true);
  expect(states.map((s) => s.state)).toEqual(['connecting', 'online']);
});

test('a wrong secret is refused (4401): an error with a message, and it keeps trying', async () => {
  // The room of one secret, authenticated with another.
  const { link, roomId, states } = makeLink({ secret: randomBytes(32) });
  link.start();
  await until(() => states.some((s) => s.state === 'error'));
  expect(states.find((s) => s.state === 'error')?.message).toMatch(/refused/i);
  expect(relay.hostOnline(roomId)).toBe(false);
  await until(() => relay.closes.filter((c) => c === 'host 4401').length >= 2);
});

describe('channels', () => {
  test('a device channel opens, carries bytes both ways, and its end is reported', async () => {
    const { link, roomId, opened, data, closed } = makeLink();
    link.start();
    await until(() => link.state === 'online');
    const d = device(`/v1/device/${roomId}`);
    await d.open();
    await until(() => opened.length === 1);
    const [ch, kind] = opened[0]!;
    expect(kind).toBe('device');
    d.ws.send(Buffer.from('hello host'));
    await until(() => data.length === 1);
    expect(data[0]).toEqual([ch, 'hello host']);
    link.send(ch, Buffer.from('hello phone'));
    await until(() => d.got.binary.length === 1);
    expect(d.got.binary).toEqual(['hello phone']);
    d.ws.close();
    await until(() => closed.includes(ch));
  });

  test('a device already waiting is opened once the host is ready', async () => {
    const { link, roomId, opened } = makeLink();
    const d = device(`/v1/device/${roomId}`);
    await d.open();
    await until(() => d.got.text.length === 1);
    expect(d.got.text[0]).toEqual({ t: 'status', host: 'offline' });
    link.start();
    await until(() => opened.length === 1);
    expect(d.got.text.at(-1)).toEqual({ t: 'status', host: 'online' });
  });

  test('closing a channel goes after what was queued for it, with its own code', async () => {
    // A budget of one frame at a time: what precedes the close is still queued when the close is asked for.
    const { link, roomId, opened } = makeLink({ budget: { frames: { burst: 1, perSec: 20 }, bytes: { burst: 64 * 1024, perSec: 512 * 1024 } } });
    link.start();
    await until(() => link.state === 'online');
    const d = device(`/v1/device/${roomId}`);
    await d.open();
    await until(() => opened.length === 1);
    const ch = opened[0]![0];
    for (const m of ['one', 'two', 'bye']) link.send(ch, Buffer.from(m));
    link.closeChannel(ch, 4401);
    // Nothing after the close reaches it.
    link.send(ch, Buffer.from('late'));
    await until(() => d.got.close !== null);
    expect(d.got.binary).toEqual(['one', 'two', 'bye']);
    expect(d.got.close).toBe(4401);
  });

  test('a channel id the relay opens again starts empty: nothing queued for the earlier channel, nor its close, goes to the new one', async () => {
    // A relay at the byte level, to open the same id twice (the test relay never reuses one).
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const got: { ch: number; data?: string; close?: number }[] = [];
    let host: WebSocket | null = null;
    wss.on('connection', (ws) => {
      host = ws;
      ws.on('message', (d, bin) => {
        const buf = d as Buffer;
        if (bin) { got.push({ ch: buf.readUInt32BE(0), data: buf.subarray(4).toString() }); return; }
        const f = JSON.parse(buf.toString()) as { t: string; ch?: number; code?: number };
        if (f.t === 'auth') ws.send(JSON.stringify({ t: 'ready' }));
        else if (f.t === 'close') got.push({ ch: f.ch!, close: f.code! });
      });
    });
    try {
      const { port } = wss.address() as { port: number };
      // One frame at once, then one every half second: what follows the first stays queued.
      const { link, opened } = makeLink({ base: `http://127.0.0.1:${port}`, budget: { frames: { burst: 1, perSec: 2 }, bytes: { burst: 64 * 1024, perSec: 512 * 1024 } } });
      link.start();
      await until(() => link.state === 'online');
      host!.send(JSON.stringify({ t: 'open', ch: 5, kind: 'device' }));
      await until(() => opened.length === 1);
      for (const m of ['old1', 'old2', 'old3']) link.send(5, Buffer.from(m));
      link.closeChannel(5, 4401);
      // The relay saw that phone go and gives its id to another one.
      host!.send(JSON.stringify({ t: 'open', ch: 5, kind: 'device' }));
      await until(() => opened.length === 2);
      link.send(5, Buffer.from('new'));
      await until(() => got.some((g) => g.data === 'new'), 4000);
      await new Promise((r) => setTimeout(r, 100));
      expect(got).toEqual([{ ch: 5, data: 'old1' }, { ch: 5, data: 'new' }]);
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  test('a close that drops what is queued goes at once', async () => {
    const { link, roomId, opened } = makeLink({ budget: { frames: { burst: 1, perSec: 2 }, bytes: { burst: 64 * 1024, perSec: 512 * 1024 } } });
    link.start();
    await until(() => link.state === 'online');
    const d = device(`/v1/device/${roomId}`);
    await d.open();
    await until(() => opened.length === 1);
    const ch = opened[0]![0];
    for (let i = 0; i < 20; i++) link.send(ch, Buffer.from(`m${i}`));
    const started = Date.now();
    link.closeChannel(ch, 4429, { drop: true });
    await until(() => d.got.close !== null);
    expect(Date.now() - started).toBeLessThan(400);
    expect(d.got.close).toBe(4429);
    expect(d.got.binary.length).toBeLessThan(3);
    expect(link.queued(ch)).toBe(0);
  });
});

describe('offers', () => {
  const lookup = () => randomBytes(32).toString('base64url');

  test('an offer makes a pairing lookup resolve; withdrawn, it is gone', async () => {
    const { link, roomId, opened } = makeLink();
    link.start();
    await until(() => link.state === 'online');
    const l = lookup();
    link.offer(l, 60);
    await until(() => relay.offers(roomId).includes(l));
    const d = device(`/v1/pair/${l}`);
    await d.open();
    await until(() => opened.length === 1);
    // A pairing channel's open names the offer it came through.
    expect(opened[0]!.slice(1)).toEqual(['pair', l]);
    link.withdraw(l);
    await until(() => relay.offers(roomId).length === 0);
    const late = device(`/v1/pair/${l}`);
    await until(() => late.got.status !== null);
    expect(late.got.status).toBe(404);
  });

  test('made while offline, sent once online; sent again after a reconnection, with the time left', async () => {
    const { link, roomId } = makeLink();
    const l = lookup();
    link.offer(l, 120);
    link.start();
    await until(() => relay.offers(roomId).includes(l));
    relay.dropAll();
    // The relay keeps a room's offers across a dropped connection and counts the new one before the link has proved
    // its room: only the offer frame itself says the offer went again.
    const offerFrames = () => relay.hostFrames.filter((f) => f.frame.t === 'offer');
    await until(() => relay.hostConnections(roomId) === 2 && offerFrames().length === 2);
    const offers = offerFrames().map((f) => f.frame.ttl as number);
    expect(offers).toHaveLength(2);
    expect(offers[1]).toBeLessThanOrEqual(120);
    expect(offers[1]).toBeGreaterThan(100);
  });
});

describe('push notifications', () => {
  const frame = (id: string) => ({ id, to: 'ab'.repeat(32), env: 'sandbox' as const, k: 'kkkkkkkkkkk', p: 'cGF5bG9hZA', c: 'sAbC' });

  test('a push frame goes to the relay while online; its answer comes back by id', async () => {
    const pushed: [string, number, string | undefined][] = [];
    const { link, roomId } = makeLink({ onPushed: (id, status, reason) => pushed.push([id, status, reason]) });
    relay.pushAnswer(({ id }) => (id === 'dead' ? { status: 410, reason: 'Unregistered' } : { status: 200 }));
    // Offline: nothing to send it with, and it says so.
    expect(link.push(frame('early'))).toBe(false);
    link.start();
    await until(() => link.state === 'online');
    expect(link.push(frame('p1'))).toBe(true);
    expect(link.push(frame('dead'))).toBe(true);
    await until(() => pushed.length === 2);
    expect(pushed).toEqual([['p1', 200, undefined], ['dead', 410, 'Unregistered']]);
    expect(relay.pushes(roomId).map((f) => f.id)).toEqual(['p1', 'dead']);
    expect(relay.pushes(roomId)[0]).toEqual({ t: 'push', ...frame('p1') });
  });
});

describe('the connection', () => {
  test('a dropped connection reports its channels closed, goes offline and comes back by itself', async () => {
    const { link, roomId, opened, closed, states } = makeLink();
    link.start();
    await until(() => link.state === 'online');
    const d = device(`/v1/device/${roomId}`);
    await d.open();
    await until(() => opened.length === 1);
    relay.dropAll();
    await until(() => closed.length === 1);
    await until(() => link.state === 'online' && relay.hostConnections(roomId) === 2);
    expect(states.map((s) => s.state)).toEqual(['connecting', 'online', 'offline', 'connecting', 'online']);
  });

  test('keep-alive: pings are answered; a relay that stops answering is left for a new connection', async () => {
    // Short, but with room for a busy machine: silence is only taken for death after several missed pongs.
    const { link, roomId } = makeLink({ timing: { pingMs: 50, deadMs: 600, backoffMinMs: 20, backoffMaxMs: 40 } });
    link.start();
    await until(() => link.state === 'online');
    await until(() => relay.hostFrames.filter((f) => f.frame.t === 'ping').length >= 2);
    expect(relay.hostConnections(roomId)).toBe(1);
    relay.mutePongs(true);
    await until(() => relay.hostConnections(roomId) >= 2, 4000);
    relay.mutePongs(false);
  });

  test('a newer connection for the same room replaces this one (4409): an error, and it keeps trying', async () => {
    const a = makeLink({ timing: { backoffMinMs: 2000, backoffMaxMs: 2000 } });
    a.link.start();
    await until(() => a.link.state === 'online');
    const b = new RelayLink({ base: relay.url, roomId: a.roomId, secret: a.secret, onState: () => {}, onOpen: () => {}, onClosed: () => {}, onData: () => {} });
    links.push(b);
    b.start();
    await until(() => a.states.some((s) => s.state === 'error'));
    expect(a.states.at(-1)?.message).toMatch(/another/i);
  });

  test('stop closes cleanly and never reconnects', async () => {
    const { link, roomId, states } = makeLink();
    link.start();
    await until(() => link.state === 'online');
    await link.stop();
    expect(link.state).toBe('offline');
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.hostConnections(roomId)).toBe(1);
    expect(relay.hostOnline(roomId)).toBe(false);
    expect(states.at(-1)?.state).toBe('offline');
  });
});

describe('pacing under the relay\'s traffic limits', () => {
  test('frames beyond the budget wait their turn, in order, without the relay closing the connection', async () => {
    await relay.close();
    relay = await startTestRelay({ traffic: { host: { frames: 40, bytes: 1024 * 1024 }, device: { frames: 40, bytes: 1024 * 1024 }, windowMs: 1000 } });
    const { link, roomId, opened, drained } = makeLink({ budget: { frames: { burst: 5, perSec: 30 }, bytes: { burst: 64 * 1024, perSec: 512 * 1024 } } });
    link.start();
    await until(() => link.state === 'online');
    const d = device(`/v1/device/${roomId}`);
    await d.open();
    await until(() => opened.length === 1);
    const ch = opened[0]![0];
    const started = Date.now();
    for (let i = 0; i < 30; i++) link.send(ch, Buffer.from(`m${i}`));
    expect(link.queued(ch)).toBeGreaterThan(0);
    await until(() => d.got.binary.length === 30, 5000);
    // 5 at once, then 30 per second: at least ~0.8 s for the other 25.
    expect(Date.now() - started).toBeGreaterThan(600);
    expect(d.got.binary).toEqual(Array.from({ length: 30 }, (_, i) => `m${i}`));
    expect(link.queued(ch)).toBe(0);
    expect(drained).toContain(ch);
    expect(relay.closes).toEqual([]);
  });

  test('channels take turns: a busy one does not hold back another', async () => {
    const { link, roomId, opened } = makeLink({ budget: { frames: { burst: 2, perSec: 40 }, bytes: { burst: 64 * 1024, perSec: 512 * 1024 } } });
    link.start();
    await until(() => link.state === 'online');
    const a = device(`/v1/device/${roomId}`); await a.open();
    const b = device(`/v1/device/${roomId}`); await b.open();
    await until(() => opened.length === 2);
    for (let i = 0; i < 20; i++) link.send(opened[0]![0], Buffer.from(`a${i}`));
    link.send(opened[1]![0], Buffer.from('b0'));
    await until(() => b.got.binary.length === 1);
    expect(a.got.binary.length).toBeLessThan(10);
  });
});

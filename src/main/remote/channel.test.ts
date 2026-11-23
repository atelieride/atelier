import { describe, expect, test, vi } from 'vitest';
import { PhoneChannel, type Msg } from '../../../tests/support/fake-phone';
import { SecureChannel, type Admission, type ChannelDeps, type PairCode } from './channel';
import { CLOSE, type DeviceMessage } from './messages';
import { generateKeyPair } from './noise';
import { MAX_FRAGMENT, b64url } from './wire';

const host = generateKeyPair();
const ROOM = 'R'.repeat(43);
const code = (n: number): PairCode => ({ lookup: String.fromCharCode(65 + n).repeat(43), psk: Buffer.alloc(32, n) });

function setup(o: { kind?: 'pair' | 'device'; codes?: PairCode[]; admit?: (c: SecureChannel) => Promise<Admission>; limits?: ChannelDeps['limits']; now?: () => number; lookup?: string } = {}) {
  const kind = o.kind ?? 'device';
  const sent: Buffer[] = [];
  const closes: number[] = [];
  const received: DeviceMessage[] = [];
  const events: string[] = [];
  const deps: ChannelDeps = {
    link: { send: (_ch, p) => { sent.push(Buffer.from(p)); }, closeChannel: (_ch, c) => { closes.push(c); }, queued: () => 0 },
    host, roomId: ROOM, hello: { name: 'Studio Mac', app: '0.3.0', platform: 'darwin' },
    pairCodes: () => o.codes ?? [],
    pairFailed: () => events.push('pair-failed'),
    admit: o.admit ?? (async () => ({ ok: true })),
    opened: (c) => { events.push('opened'); c.send({ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin' } }); },
    message: (_c, m) => received.push(m),
    closed: () => events.push('closed'),
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.now ? { now: o.now } : {})
  };
  const ch = new SecureChannel(7, kind, deps, o.lookup);
  return { ch, sent, closes, received, events };
}

/** Runs the handshake from a phone's side; returns the phone and what it got. */
async function handshake(s: ReturnType<typeof setup>, phone: PhoneChannel) {
  const got: Msg[] = [];
  const pump = () => {
    while (s.sent.length) {
      const frame = s.sent.shift()!;
      const r = phone.receive(frame);
      if (r.reply) s.ch.receive(r.reply);
      got.push(...r.messages);
    }
  };
  s.ch.receive(phone.start());
  pump();
  await vi.waitFor(() => { pump(); if (s.ch.state !== 'open' && s.ch.state !== 'closed') throw new Error('not yet'); });
  pump();
  return { got, pump };
}

describe('the handshake', () => {
  test('device: the phone is admitted, learns the host by its hello and key; the host learns the phone\'s key and hello', async () => {
    const s = setup();
    const phoneKey = generateKeyPair();
    const phone = new PhoneChannel({ kind: 'device', id: ROOM, key: phoneKey, hostKey: host.publicKey });
    const { got } = await handshake(s, phone);
    expect(phone.hostHello).toEqual({ v: 1, name: 'Studio Mac', app: '0.3.0', platform: 'darwin' });
    expect(s.ch.deviceKey).toBe(b64url(phoneKey.publicKey));
    expect(s.ch.hello).toEqual({ v: 1, name: 'Test iPhone', model: 'iPhone17,1', app: '1.0.0' });
    expect(s.events).toEqual(['opened']);
    expect(got).toEqual([{ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin' } }]);
  });

  test('device: a phone that dialed another room fails (prologue), and the channel closes as malformed', async () => {
    const s = setup();
    const phone = new PhoneChannel({ kind: 'device', id: 'X'.repeat(43), key: generateKeyPair() });
    s.ch.receive(phone.start());
    // Message 2 can't be read with another prologue: the phone gives up; a message 3 it forged would not decrypt.
    expect(() => phone.receive(s.sent.shift()!)).toThrow();
    s.ch.receive(Buffer.alloc(96, 1));
    expect(s.closes).toEqual([CLOSE.malformed]);
    expect(s.events).toEqual(['closed']);
  });

  test('device: refused admission (an unknown key) says denied, then closes with its code', async () => {
    const s = setup({ admit: async () => ({ ok: false, reason: 'unknown-device', code: CLOSE.unknownDevice }) });
    const phone = new PhoneChannel({ kind: 'device', id: ROOM, key: generateKeyPair() });
    const { got } = await handshake(s, phone);
    expect(got).toEqual([{ t: 'denied', reason: 'unknown-device' }]);
    expect(s.closes).toEqual([CLOSE.unknownDevice]);
  });

  test('pair: the live code the phone presents is found among them by its prologue and key', async () => {
    const codes = [code(1), code(2)];
    const s = setup({ kind: 'pair', codes });
    const phone = new PhoneChannel({ kind: 'pair', id: codes[1]!.lookup, key: generateKeyPair(), psk: codes[1]!.psk });
    await handshake(s, phone);
    expect(s.ch.state).toBe('open');
    expect(s.ch.code?.lookup).toBe(codes[1]!.lookup);
  });

  test('pair: the offer the relay names picks the code; one that is not live closes the channel', async () => {
    const codes = [code(1), code(2)];
    const s = setup({ kind: 'pair', codes, lookup: codes[0]!.lookup });
    const phone = new PhoneChannel({ kind: 'pair', id: codes[0]!.lookup, key: generateKeyPair(), psk: codes[0]!.psk });
    await handshake(s, phone);
    expect(s.ch.code?.lookup).toBe(codes[0]!.lookup);
    const gone = setup({ kind: 'pair', codes, lookup: code(3).lookup });
    gone.ch.receive(new PhoneChannel({ kind: 'pair', id: code(3).lookup, key: generateKeyPair(), psk: code(3).psk }).start());
    expect(gone.closes).toEqual([CLOSE.noCode]);
    expect(gone.events).toEqual(['closed']);
  });

  test('pair: a wrong code is a failed attempt and closes the channel', async () => {
    const s = setup({ kind: 'pair', codes: [code(1)] });
    const phone = new PhoneChannel({ kind: 'pair', id: code(1).lookup, key: generateKeyPair(), psk: Buffer.alloc(32, 99) });
    s.ch.receive(phone.start());
    const r = phone.receive(s.sent.shift()!);
    s.ch.receive(r.reply!);
    expect(s.events).toEqual(['pair-failed', 'closed']);
    expect(s.closes).toEqual([CLOSE.malformed]);
  });

  test('pair: a code no longer live by message 3 (renewed, or pairing stopped) is expired: denied, never asked about', async () => {
    for (const later of [[code(2)], []]) {
      const codes = [code(1)];
      const admit = vi.fn(async (): Promise<Admission> => ({ ok: true }));
      const s = setup({ kind: 'pair', codes, admit });
      const phone = new PhoneChannel({ kind: 'pair', id: code(1).lookup, key: generateKeyPair(), psk: code(1).psk });
      s.ch.receive(phone.start());
      const m3 = phone.receive(s.sent.shift()!).reply!;
      // Between messages 2 and 3 the code went: denied and replaced, run out, or the sheet closed.
      codes.splice(0, codes.length, ...later);
      s.ch.receive(m3);
      expect(admit).not.toHaveBeenCalled();
      expect(phone.receive(s.sent.shift()!).messages).toEqual([{ t: 'denied', reason: 'expired' }]);
      expect(s.closes).toEqual([CLOSE.normal]);
      // Not an attempt at the code live now.
      expect(s.events).toEqual(['closed']);
    }
  });

  test('pair: a wrong code for one no longer live is no attempt at the code live now', () => {
    const codes = [code(1)];
    const s = setup({ kind: 'pair', codes });
    const phone = new PhoneChannel({ kind: 'pair', id: code(1).lookup, key: generateKeyPair(), psk: Buffer.alloc(32, 99) });
    s.ch.receive(phone.start());
    const m3 = phone.receive(s.sent.shift()!).reply!;
    codes.splice(0, 1, code(2));
    s.ch.receive(m3);
    expect(s.closes).toEqual([CLOSE.malformed]);
    expect(s.events).toEqual(['closed']);
  });

  test('pair: with no live code the channel closes at once, no attempt counted', () => {
    const s = setup({ kind: 'pair', codes: [] });
    s.ch.receive(new PhoneChannel({ kind: 'pair', id: code(1).lookup, key: generateKeyPair(), psk: code(1).psk }).start());
    expect(s.closes).toEqual([CLOSE.noCode]);
    expect(s.events).toEqual(['closed']);
  });

  test('a hello that is not one (strict: an unknown field) closes the channel', async () => {
    const s = setup();
    const phone = new PhoneChannel({ kind: 'device', id: ROOM, key: generateKeyPair(), hello: { extra: true } });
    s.ch.receive(phone.start());
    s.ch.receive(phone.receive(s.sent.shift()!).reply!);
    expect(s.closes).toEqual([CLOSE.malformed]);
  });

  test('a handshake that stalls is closed after its time', () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.ch.receive(new PhoneChannel({ kind: 'device', id: ROOM, key: generateKeyPair() }).start());
      vi.advanceTimersByTime(31_000);
      expect(s.closes).toEqual([CLOSE.timeout]);
    } finally { vi.useRealTimers(); }
  });
});

describe('messages', () => {
  async function open(o: Parameters<typeof setup>[0] = {}) {
    const s = setup(o);
    const phone = new PhoneChannel({ kind: 'device', id: ROOM, key: generateKeyPair() });
    const h = await handshake(s, phone);
    const send = (m: object) => { for (const f of phone.encode(m)) s.ch.receive(f); h.pump(); };
    return { ...s, ...h, phone, send };
  }

  test('a valid message reaches the hub; a long one in many fragments too', async () => {
    const o = await open();
    o.send({ t: 'attach', rid: 1, id: 't1', cols: 80, rows: 24 });
    const big = 'x'.repeat(60_000);
    o.send({ t: 'input', id: 't1', data: big });
    expect(o.received).toEqual([{ t: 'attach', rid: 1, id: 't1', cols: 80, rows: 24 }, { t: 'input', id: 't1', data: big }]);
  });

  test('host messages over a fragment\'s size reach the phone whole', async () => {
    const o = await open();
    const data = 'y'.repeat(MAX_FRAGMENT * 2);
    o.ch.send({ t: 'out', id: 't1', data });
    o.pump();
    expect(o.got.at(-1)).toEqual({ t: 'out', id: 't1', data });
  });

  test('an unknown field or kind is refused with `invalid` (its rid when it has one), the channel stays', async () => {
    const o = await open();
    o.send({ t: 'attach', rid: 3, id: 't1', cols: 80, rows: 24, path: '/etc' });
    o.send({ t: 'shell', rid: 4, command: 'rm -rf /' });
    o.send({ t: 'resize', id: 't1', cols: 1, rows: 24 });
    expect(o.received).toEqual([]);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual([[3, 'invalid'], [4, 'invalid'], [0, 'invalid']]);
    expect(o.ch.state).toBe('open');
  });

  test('input beyond 64 KiB per message is refused', async () => {
    const o = await open();
    o.send({ t: 'input', id: 't1', data: 'é'.repeat(40_000) });
    expect(o.received).toEqual([]);
    expect(o.got.at(-1)).toMatchObject({ t: 'error', code: 'invalid' });
  });

  test('a phone\'s fragments are up to Noise\'s 65535 bytes, and a full one is taken', async () => {
    const o = await open();
    // 64 KiB of input and its JSON: more than one fragment, the first at the full size.
    const data = 'x'.repeat(64 * 1024);
    const frames = o.phone.encode({ t: 'input', id: 't1', data });
    expect(frames[0]).toHaveLength(65535);
    for (const f of frames) o.ch.receive(f);
    expect(o.received).toEqual([{ t: 'input', id: 't1', data }]);
  });

  test('a frame larger than a Noise message is refused unread, in every state: the channel closes as too large', async () => {
    const big = Buffer.alloc(65536, 7);
    // During the handshake.
    const hello = setup();
    hello.ch.receive(big);
    expect(hello.closes).toEqual([CLOSE.tooLarge]);
    // While the hub decides (frames are kept then: never one this large).
    const s = setup({ admit: () => new Promise(() => {}) });
    const phone = new PhoneChannel({ kind: 'device', id: ROOM, key: generateKeyPair() });
    s.ch.receive(phone.start());
    s.ch.receive(phone.receive(s.sent.shift()!).reply!);
    expect(s.ch.state).toBe('admitting');
    s.ch.receive(big);
    expect(s.closes).toEqual([CLOSE.tooLarge]);
    // Open.
    const o = await open();
    o.ch.receive(big);
    expect(o.closes).toEqual([CLOSE.tooLarge]);
    expect(o.received).toEqual([]);
  });

  test('a frame that does not decrypt, or JSON that is not an object, closes the channel', async () => {
    const o = await open();
    o.ch.receive(Buffer.alloc(40, 3));
    expect(o.closes).toEqual([CLOSE.malformed]);
    const p = await open();
    for (const f of p.phone.encode([1, 2])) p.ch.receive(f);
    expect(p.closes).toEqual([CLOSE.malformed]);
  });

  test('frames that arrive while admission is pending are kept and handled once admitted', async () => {
    let allow!: (a: Admission) => void;
    const s = setup({ admit: () => new Promise((r) => { allow = r; }) });
    const phone = new PhoneChannel({ kind: 'device', id: ROOM, key: generateKeyPair() });
    s.ch.receive(phone.start());
    s.ch.receive(phone.receive(s.sent.shift()!).reply!);
    expect(s.ch.state).toBe('admitting');
    for (const f of phone.encode({ t: 'detach', id: 't1' })) s.ch.receive(f);
    expect(s.received).toEqual([]);
    allow({ ok: true });
    await vi.waitFor(() => expect(s.received).toEqual([{ t: 'detach', id: 't1' }]));
  });

  test('limits: beyond 200 messages a second `busy`; sustained, the channel closes', async () => {
    let now = 0;
    const o = await open({ now: () => now, limits: { messagesPerSec: 5, strikes: 3 } });
    for (let i = 0; i < 6; i++) o.send({ t: 'detach', id: `t${i}` });
    expect(o.received).toHaveLength(5);
    expect(o.got.at(-1)).toMatchObject({ t: 'error', rid: 0, code: 'busy' });
    now += 1000;
    o.send({ t: 'detach', id: 'later' });
    expect(o.received).toHaveLength(6);
    for (let i = 0; i < 9; i++) o.send({ t: 'detach', id: 'flood' });
    expect(o.closes).toEqual([CLOSE.overloaded]);
  });

  test('limits: input bytes per second and sessions created per minute', async () => {
    let now = 0;
    const o = await open({ now: () => now, limits: { inputBytesPerSec: 10, createsPerMin: 2 } });
    o.send({ t: 'input', id: 't', data: '0123456789' });
    o.send({ t: 'input', id: 't', data: 'x' });
    o.send({ t: 'create', rid: 1, project: 'p', kind: 'claude' });
    o.send({ t: 'create', rid: 2, project: 'p', kind: 'claude' });
    o.send({ t: 'create', rid: 3, project: 'p', kind: 'claude' });
    expect(o.received.map((m) => m.t)).toEqual(['input', 'create', 'create']);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual([[0, 'busy'], [3, 'busy']]);
    now += 60_000;
    o.send({ t: 'create', rid: 4, project: 'p', kind: 'terminal' });
    expect(o.received).toHaveLength(4);
  });

  test('row actions (answer, rename, close, resume, dismiss) and create in a place as an account: strict shapes', async () => {
    const o = await open();
    const ok = [
      { t: 'answer', rid: 1, id: 't1', wait: 'AbC_-123', choice: 'allow' },
      { t: 'answer', rid: 2, id: 't1', wait: 'AbC_-123', choice: 'deny' },
      { t: 'rename', rid: 3, id: 't1', name: 'Fix the login' },
      { t: 'rename', rid: 4, id: 't1', name: '' },
      { t: 'close', rid: 5, id: 't1' },
      { t: 'resume', rid: 6, id: 'r1' },
      { t: 'dismiss', rid: 7, id: 'r1' },
      { t: 'create', rid: 8, project: 'p', kind: 'claude', place: 'w1abc', account: 'work' }
    ];
    for (const m of ok) o.send(m);
    expect(o.received).toEqual(ok);
    const bad = [
      { t: 'answer', rid: 11, id: 't1', wait: 'x', choice: 'always' },
      { t: 'answer', rid: 12, id: 't1', choice: 'allow' },
      { t: 'answer', rid: 13, id: 't1', wait: 'has space', choice: 'allow' },
      { t: 'rename', rid: 14, id: 't1', name: 'x'.repeat(61) },
      { t: 'close', rid: 15, id: 't1', force: true },
      { t: 'create', rid: 16, project: 'p', kind: 'claude', place: '../w' },
      { t: 'create', rid: 17, project: 'p', kind: 'claude', account: '/Users/x/.claude' },
      { t: 'create', rid: 18, project: 'p', kind: 'claude', command: 'rm -rf /' }
    ];
    for (const m of bad) o.send(m);
    expect(o.received).toHaveLength(ok.length);
    expect(o.got.filter((m) => m.t === 'error').map((m) => m.rid)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    // A name is counted in characters: 60 emoji are fine.
    o.send({ t: 'rename', rid: 19, id: 't1', name: '🚀'.repeat(60) });
    expect(o.received.at(-1)).toMatchObject({ rid: 19 });
  });

  test('limits: answer, rename, close, resume and dismiss together per minute', async () => {
    let now = 0;
    const o = await open({ now: () => now, limits: { actionsPerMin: 3 } });
    o.send({ t: 'answer', rid: 1, id: 't', wait: 'w', choice: 'allow' });
    o.send({ t: 'rename', rid: 2, id: 't', name: 'x' });
    o.send({ t: 'close', rid: 3, id: 't' });
    o.send({ t: 'dismiss', rid: 4, id: 'r' });
    o.send({ t: 'resume', rid: 5, id: 'r' });
    expect(o.received.map((m) => ('rid' in m ? m.rid : 0))).toEqual([1, 2, 3]);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual([[4, 'busy'], [5, 'busy']]);
    // Attaching and typing don't count.
    o.send({ t: 'detach', id: 't' });
    expect(o.received).toHaveLength(4);
    now += 60_000;
    o.send({ t: 'resume', rid: 6, id: 'r' });
    expect(o.received.at(-1)).toMatchObject({ rid: 6 });
  });

  test('workspaces and activities: workspace, activity, renamePlace and move; strict shapes, names bounded', async () => {
    const o = await open();
    const ok = [
      { t: 'workspace', rid: 1, project: 'p' },
      { t: 'workspace', rid: 2, project: 'p', name: 'Billing' },
      { t: 'activity', rid: 3, project: 'p', workspace: 'w1abc' },
      { t: 'activity', rid: 4, project: 'p', workspace: 'w1abc', name: 'SSO with Okta' },
      { t: 'renamePlace', rid: 5, project: 'p', place: 'w1abc', name: 'Auth' },
      { t: 'move', rid: 6, id: 't1', place: 'a-1_x' },
      // The name's own rule (1…60 characters on one line) is the hub's, with its own answer.
      { t: 'renamePlace', rid: 7, project: 'p', place: 'w1abc', name: '' }
    ];
    for (const m of ok) o.send(m);
    expect(o.received).toEqual(ok);
    const bad = [
      { t: 'workspace', rid: 11 },
      { t: 'workspace', rid: 12, project: 'p', color: 3 },
      { t: 'workspace', rid: 13, project: 'p', folder: '/work/app/wt' },
      { t: 'activity', rid: 14, project: 'p', name: 'x' },
      { t: 'activity', rid: 15, project: 'p', workspace: '../w1' },
      { t: 'renamePlace', rid: 16, project: 'p', place: 'w1' },
      { t: 'renamePlace', rid: 17, project: 'p', place: 'w1', name: 7 },
      { t: 'renamePlace', rid: 18, project: 'p', place: 'w1', name: 'x'.repeat(241) },
      { t: 'move', rid: 19, id: 't1' },
      { t: 'move', rid: 20, id: 't1', place: 'w1', project: 'p' }
    ];
    for (const m of bad) o.send(m);
    expect(o.received).toHaveLength(ok.length);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual(bad.map((m) => [m.rid, 'invalid']));
  });

  test('limits: workspace, activity, renamePlace and move share the row actions\' 30 a minute', async () => {
    let now = 0;
    const o = await open({ now: () => now, limits: { actionsPerMin: 4 } });
    o.send({ t: 'rename', rid: 1, id: 't', name: 'x' });
    o.send({ t: 'workspace', rid: 2, project: 'p' });
    o.send({ t: 'activity', rid: 3, project: 'p', workspace: 'w1' });
    o.send({ t: 'renamePlace', rid: 4, project: 'p', place: 'w1', name: 'A' });
    o.send({ t: 'move', rid: 5, id: 't', place: 'w1' });
    expect(o.received.map((m) => ('rid' in m ? m.rid : 0))).toEqual([1, 2, 3, 4]);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual([[5, 'busy']]);
    now += 60_000;
    o.send({ t: 'move', rid: 6, id: 't', place: 'w1' });
    expect(o.received.at(-1)).toMatchObject({ rid: 6 });
  });

  test('push: a registration with a token, its environment and a 32-byte key, or unregistering; strict shapes; 5 a minute', async () => {
    let now = 0;
    const o = await open({ now: () => now, limits: { pushesPerMin: 2 } });
    const key = Buffer.alloc(32, 1).toString('base64url');
    const reg = { t: 'push', rid: 1, token: 'ab'.repeat(32), env: 'sandbox', key };
    const off = { t: 'push', rid: 2, token: null };
    o.send(reg);
    o.send(off);
    expect(o.received).toEqual([reg, off]);
    const bad = [
      { ...reg, rid: 3, token: 'xyz' },
      { ...reg, rid: 4, token: 'ab'.repeat(101) },
      { ...reg, rid: 5, env: 'development' },
      { ...reg, rid: 6, key: Buffer.alloc(31, 1).toString('base64url') },
      { ...reg, rid: 7, key: undefined },
      { t: 'push', rid: 8, token: null, env: 'sandbox', key },
      { ...reg, rid: 9, extra: 1 }
    ];
    for (const m of bad) o.send(m);
    expect(o.received).toHaveLength(2);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual(bad.map((m) => [m.rid, 'invalid']));
    o.send({ ...reg, rid: 10 });
    expect(o.got.at(-1)).toMatchObject({ t: 'error', rid: 10, code: 'busy' });
    now += 60_000;
    o.send({ ...reg, rid: 11 });
    expect(o.received.at(-1)).toMatchObject({ rid: 11 });
  });

  test('bye: the message, then a normal close; the relay\'s own close is reported once', async () => {
    const o = await open();
    o.ch.bye('revoked');
    o.pump();
    expect(o.got.at(-1)).toEqual({ t: 'bye', reason: 'revoked' });
    expect(o.closes).toEqual([CLOSE.normal]);
    expect(o.ch.send({ t: 'exit', id: 'x' })).toBe(false);
    o.ch.relayClosed();
    expect(o.events.filter((e) => e === 'closed')).toHaveLength(1);
  });
});

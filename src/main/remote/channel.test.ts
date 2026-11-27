import { describe, expect, test, vi } from 'vitest';
import { PhoneChannel, type Msg } from '../../../tests/support/fake-phone';
import { SecureChannel, type Admission, type ChannelDeps, type PairCode } from './channel';
import { CLOSE, deviceMessageSchema, type DeviceMessage } from './messages';
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
    host, roomId: ROOM,
    pairCodes: () => o.codes ?? [],
    pairFailed: () => events.push('pair-failed'),
    admit: o.admit ?? (async () => ({ ok: true })),
    opened: (c) => { events.push('opened'); c.send({ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin', app: '0.3.0' } }); },
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
  test('device: the phone is admitted and learns the host by its key alone; the host learns the phone\'s key and hello', async () => {
    const s = setup();
    const phoneKey = generateKeyPair();
    const phone = new PhoneChannel({ kind: 'device', id: ROOM, key: phoneKey, hostKey: host.publicKey });
    const { got } = await handshake(s, phone);
    // Message 2 goes before the phone is known: it names nothing (`name` stays, empty, for the first iPhone builds).
    expect(phone.hostHello).toEqual({ v: 1, name: '' });
    expect(s.ch.deviceKey).toBe(b64url(phoneKey.publicKey));
    expect(s.ch.hello).toEqual({ v: 1, name: 'Test iPhone', model: 'iPhone17,1', app: '1.0.0' });
    expect(s.events).toEqual(['opened']);
    expect(got).toEqual([{ t: 'welcome', host: { name: 'Studio Mac', platform: 'darwin', app: '0.3.0' } }]);
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

  test('conversation messages: strict shapes', async () => {
    const o = await open();
    const ask = 'k'.repeat(22) + '.' + 'AbCd_-12';
    const ok = [
      { t: 'attach', rid: 1, id: 't1', cols: 80, rows: 24, fit: true },
      { t: 'follow', rid: 2, id: 't1' },
      { t: 'follow', rid: 3, id: 't1', before: 2 ** 31 - 1 },
      { t: 'unfollow', id: 't1' },
      { t: 'say', rid: 4, id: 't1', text: 'line one\n\tline two' },
      { t: 'say', rid: 5, id: 't1', text: 'é'.repeat(8192) },
      { t: 'stop', rid: 6, id: 't1' },
      { t: 'escape', rid: 7, id: 't1' },
      { t: 'dialog', rid: 8, id: 't1' },
      { t: 'choose', rid: 9, id: 't1', ask, n: 9, label: 'Yes' },
      { t: 'choose', rid: 10, id: 't1', ask, n: 1, label: 'x'.repeat(300), text: 'é'.repeat(2048) }
    ];
    for (const m of ok) o.send(m);
    expect(o.received).toEqual(ok);
    const bad = [
      { t: 'attach', rid: 11, id: 't1', cols: 80, rows: 24, fit: false },
      { t: 'follow', rid: 12, id: 't1', extra: 1 },
      { t: 'follow', rid: 13, id: 't1', before: 0 },
      { t: 'follow', rid: 14, id: 't1', before: 2 ** 31 },
      { t: 'say', rid: 15, id: 't1', text: 'a\x1bb' },
      { t: 'say', rid: 16, id: 't1', text: 'é'.repeat(8192) + 'x' },
      { t: 'say', rid: 17, id: 't1', text: '  \n ' },
      { t: 'say', rid: 18, id: 't1', text: 'a\rb' },
      { t: 'stop', rid: 19, id: 't1', force: true },
      { t: 'dialog', rid: 20, id: 't1', ask },
      { t: 'choose', rid: 21, id: 't1', ask, n: 10, label: 'Yes' },
      { t: 'choose', rid: 22, id: 't1', ask, n: 0, label: 'Yes' },
      { t: 'choose', rid: 23, id: 't1', ask, n: 1, label: 'Yes', text: 'a\nb' },
      { t: 'choose', rid: 24, id: 't1', ask, n: 1, label: 'Yes', text: 'é'.repeat(2048) + 'x' },
      { t: 'choose', rid: 25, id: 't1', ask, n: 1, label: 'Yes', text: ' ' },
      { t: 'choose', rid: 26, id: 't1', ask, n: 1, label: 'x'.repeat(301) },
      { t: 'choose', rid: 27, id: 't1', ask, n: 1, label: '' },
      { t: 'choose', rid: 28, id: 't1', ask: 'k'.repeat(22), n: 1, label: 'Yes' },
      { t: 'choose', rid: 29, id: 't1', ask: 'k'.repeat(22) + '.short', n: 1, label: 'Yes' }
    ];
    for (const m of bad) o.send(m);
    expect(o.received).toHaveLength(ok.length);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual(bad.map((m) => [m.rid, 'invalid']));
  });

  test('a choose\'s label far too long is refused before its characters are counted one by one', () => {
    const ask = 'k'.repeat(22) + '.AbCd_-12';
    const choose = (label: string) => deviceMessageSchema.safeParse({ t: 'choose', rid: 1, id: 't1', ask, n: 1, label });
    // 300 characters of two UTF-16 units each still go.
    expect(choose('😀'.repeat(300)).success).toBe(true);
    const counted = vi.spyOn(String.prototype as unknown as Record<symbol, () => Iterator<string>>, Symbol.iterator);
    try {
      expect(choose('x'.repeat(2 * 1024 * 1024)).success).toBe(false);
      expect(counted).not.toHaveBeenCalled();
    } finally {
      counted.mockRestore();
    }
  });

  test('images: image, paste and a say with images; strict shapes, the image\'s own rules left to the hub', async () => {
    const o = await open();
    const ref = 'r'.repeat(22);
    const ok = [
      { t: 'image', rid: 1, id: 't1', type: 'png', data: 'iVBORw0KGgo=' },
      // What isn't an image is the hub's to answer, in its own words.
      { t: 'image', rid: 2, id: 't1', type: 'gif', data: '' },
      { t: 'paste', rid: 3, id: 't1', image: ref },
      { t: 'paste', rid: 4, id: 't1', image: 'a-Z_9' },
      { t: 'say', rid: 5, id: 't1', text: '', images: [ref] },
      { t: 'say', rid: 6, id: 't1', text: 'What color is it?', images: [ref, 'b'.repeat(64), 'c', 'd', 'e'] }
    ];
    for (const m of ok) o.send(m);
    expect(o.received).toEqual(ok);
    const bad = [
      { t: 'image', rid: 11, id: 't1', type: 'png' },
      { t: 'image', rid: 12, id: 't1', data: 'iVBORw0KGgo=' },
      { t: 'image', rid: 13, id: 't1', type: 'png', data: 'iVBORw0KGgo=', name: 'shot.png' },
      { t: 'image', rid: 14, id: 't1', type: 'png', data: 7 },
      { t: 'image', id: 't1', type: 'png', data: 'iVBORw0KGgo=' },
      { t: 'paste', rid: 15, id: 't1' },
      { t: 'paste', rid: 16, id: 't1', image: '' },
      { t: 'paste', rid: 17, id: 't1', image: 'b'.repeat(65) },
      { t: 'paste', rid: 18, id: 't1', image: '/tmp/x.png' },
      { t: 'paste', rid: 19, id: 't1', image: ref, path: '/tmp/x.png' },
      // No text without images; no list with none or more than five; a blank text with them; a reference that isn't one.
      { t: 'say', rid: 20, id: 't1', text: '' },
      { t: 'say', rid: 21, id: 't1', text: '', images: [] },
      { t: 'say', rid: 22, id: 't1', text: '', images: [ref, ref, ref, ref, ref, ref] },
      { t: 'say', rid: 23, id: 't1', text: '  ', images: [ref] },
      { t: 'say', rid: 24, id: 't1', text: '', images: ['../x.png'] },
      { t: 'say', rid: 25, id: 't1', text: 'a\x1bb', images: [ref] }
    ];
    for (const m of bad) o.send(m);
    expect(o.received).toHaveLength(ok.length);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual(bad.map((m) => [m.rid ?? 0, 'invalid']));
  });

  test('limits: images 20 a minute and 12 MiB of them a minute; a paste, and a say with images, count with say', async () => {
    let now = 0;
    const o = await open({ now: () => now, limits: { imagesPerMin: 3, imageBytesPerMin: 300, typesPerMin: 1 } });
    /** An image of `n` bytes, as base64url. */
    const image = (rid: number, n: number) => ({ t: 'image', rid, id: 't', type: 'png', data: Buffer.alloc(n, 1).toString('base64url') });
    o.send(image(1, 100));
    o.send(image(2, 150));
    // Past the bytes, though one more would fit the count (nothing is taken of either); then past the count.
    o.send(image(3, 100));
    o.send(image(4, 10));
    o.send(image(5, 10));
    // The typing budget (one here): the paste takes it, the says after it are refused.
    o.send({ t: 'paste', rid: 6, id: 't', image: 'r' });
    o.send({ t: 'say', rid: 7, id: 't', text: 'x', images: ['r'] });
    o.send({ t: 'say', rid: 8, id: 't', text: 'y' });
    expect(o.received.map((m) => ('rid' in m ? m.rid : 0))).toEqual([1, 2, 4, 6]);
    const TOO_MANY = 'Too many images at once; try again in a minute.';
    const CHANGES = 'Too many changes at once; try again in a minute.';
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code, (m as { message?: string }).message])).toEqual([
      [3, 'busy', TOO_MANY],
      [5, 'busy', TOO_MANY],
      [7, 'busy', CHANGES],
      [8, 'busy', CHANGES]
    ]);
    now += 60_000;
    o.send(image(9, 300));
    o.send({ t: 'say', rid: 10, id: 't', text: 'x', images: ['r'] });
    expect(o.received.slice(-2).map((m) => ('rid' in m ? m.rid : 0))).toEqual([9, 10]);
  });

  test('limits: follow and dialog share 120 a minute; say, stop, escape and choose 30, apart from the row actions', async () => {
    let now = 0;
    const o = await open({ now: () => now, limits: { readsPerMin: 2, typesPerMin: 2, actionsPerMin: 1 } });
    const ask = 'k'.repeat(22) + '.AbCd_-12';
    o.send({ t: 'follow', rid: 1, id: 't' });
    o.send({ t: 'dialog', rid: 2, id: 't' });
    o.send({ t: 'follow', rid: 3, id: 't' });
    o.send({ t: 'unfollow', id: 't' });
    o.send({ t: 'say', rid: 4, id: 't', text: 'a' });
    o.send({ t: 'stop', rid: 5, id: 't' });
    o.send({ t: 'escape', rid: 6, id: 't' });
    o.send({ t: 'choose', rid: 7, id: 't', ask, n: 1, label: 'Yes' });
    // The row actions keep their own budget: one, whatever was spent above.
    o.send({ t: 'close', rid: 8, id: 't' });
    o.send({ t: 'close', rid: 9, id: 't' });
    expect(o.received.map((m) => ('rid' in m ? m.rid : 0))).toEqual([1, 2, 0, 4, 5, 8]);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code, (m as { message?: string }).message])).toEqual([
      [3, 'busy', 'Too many requests; try again in a minute.'],
      [6, 'busy', 'Too many changes at once; try again in a minute.'],
      [7, 'busy', 'Too many changes at once; try again in a minute.'],
      [9, 'busy', 'Too many changes at once; try again in a minute.']
    ]);
    now += 60_000;
    o.send({ t: 'dialog', rid: 10, id: 't' });
    o.send({ t: 'say', rid: 11, id: 't', text: 'b' });
    expect(o.received.slice(-2).map((m) => ('rid' in m ? m.rid : 0))).toEqual([10, 11]);
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

  test('windows and closing places: openWindow, closeWindow and closePlace; strict shapes, only the answers Atelier asks', async () => {
    const o = await open();
    const ok = [
      { t: 'openWindow', rid: 1, project: 'p' },
      { t: 'closeWindow', rid: 2, project: 'p' },
      { t: 'closeWindow', rid: 3, project: 'p', sessions: 'keep' },
      { t: 'closeWindow', rid: 4, project: 'p', sessions: 'stop' },
      { t: 'closePlace', rid: 5, project: 'p', place: 'w1abc' },
      { t: 'closePlace', rid: 6, project: 'p', place: 'a-1_x', sessions: 'move' },
      { t: 'closePlace', rid: 7, project: 'p', place: 'a-1_x', sessions: 'stop' }
    ];
    for (const m of ok) o.send(m);
    expect(o.received).toEqual(ok);
    const bad = [
      { t: 'openWindow', rid: 11 },
      { t: 'openWindow', rid: 12, project: 'p', root: '/work/app' },
      { t: 'closeWindow', rid: 13, project: 'p', sessions: 'move' },
      { t: 'closeWindow', rid: 14, project: 'p', sessions: 'ask' },
      { t: 'closeWindow', rid: 15, project: 'p', force: true },
      { t: 'closePlace', rid: 16, project: 'p' },
      { t: 'closePlace', rid: 17, project: 'p', place: '../w1' },
      { t: 'closePlace', rid: 18, project: 'p', place: 'w1', sessions: 'keep' },
      { t: 'closePlace', rid: 19, place: 'w1' }
    ];
    for (const m of bad) o.send(m);
    expect(o.received).toHaveLength(ok.length);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual(bad.map((m) => [m.rid, 'invalid']));
  });

  test('limits: openWindow, closeWindow and closePlace share the row actions\' 30 a minute', async () => {
    let now = 0;
    const o = await open({ now: () => now, limits: { actionsPerMin: 3 } });
    o.send({ t: 'openWindow', rid: 1, project: 'p' });
    o.send({ t: 'closeWindow', rid: 2, project: 'p' });
    o.send({ t: 'closePlace', rid: 3, project: 'p', place: 'w1' });
    o.send({ t: 'openWindow', rid: 4, project: 'p' });
    expect(o.received.map((m) => ('rid' in m ? m.rid : 0))).toEqual([1, 2, 3]);
    expect(o.got.filter((m) => m.t === 'error').map((m) => [m.rid, m.code])).toEqual([[4, 'busy']]);
    now += 60_000;
    o.send({ t: 'closeWindow', rid: 5, project: 'p' });
    expect(o.received.at(-1)).toMatchObject({ rid: 5 });
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

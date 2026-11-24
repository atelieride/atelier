// One phone's channel through the relay, on this computer's side: the Noise responder (XX for a paired phone, XXpsk3
// with a live pairing code's key while pairing), then app messages in fragments. Every message is decrypted,
// reassembled (8 MiB at most), parsed and checked against the strict schemas before the hub sees it; per-channel
// limits answer `busy` beyond them, and a channel that keeps getting refused, fails to decrypt or doesn't parse is
// closed. Whether a phone is let in at all (the allowlist, or the user's Allow) is the hub's call.
import { TokenBucket } from './bucket';
import { CLOSE, ROW_ACTIONS, deviceHelloSchema, deviceMessageSchema, type ByeReason, type DeniedReason, type DeviceHello, type DeviceMessage, type ErrorCode, type HostMessage } from './messages';
import { NOISE_MAX_MESSAGE, NoiseHandshake, type KeyPair, type NoiseTransport } from './noise';
import { MAX_APP_MESSAGE, Reassembler, b64url, fragments, prologue, protocolOf, type ChannelKind } from './wire';

export interface ChannelLink {
  send(ch: number, payload: Uint8Array): void;
  closeChannel(ch: number, code: number, o?: { drop?: boolean }): void;
  queued(ch: number): number;
}

/** A live pairing code: what the relay resolves (lookup) and the handshake's pre-shared key. */
export interface PairCode { lookup: string; psk: Buffer }

export type Admission = { ok: true } | { ok: false; reason: DeniedReason; code: number };

export interface ChannelLimits {
  messagesPerSec: number;
  inputBytesPerSec: number;
  createsPerMin: number;
  /** Answer, rename, close, resume and dismiss together. */
  actionsPerMin: number;
  /** Push registrations. */
  pushesPerMin: number;
  /** Refused messages (busy, invalid) tolerated within strikeWindowMs before the channel closes. */
  strikes: number;
  strikeWindowMs: number;
  /** The handshake must be over within this. */
  handshakeMs: number;
  /** Transport messages either way before the channel ends (the phone reconnects). */
  maxMessages: number;
}

const LIMITS: ChannelLimits = {
  messagesPerSec: 200, inputBytesPerSec: 1024 * 1024, createsPerMin: 10, actionsPerMin: 30, pushesPerMin: 5,
  strikes: 50, strikeWindowMs: 10_000, handshakeMs: 30_000, maxMessages: 2 ** 32
};

/** Frames kept while the hub decides whether the phone may in (a phone may send right after its last handshake message). */
const HELD_MAX = 64;

/**
 * Message 2's payload. It goes before the phone is known: anyone holding the room id (a removed phone) or a pairing
 * lookup (the relay routes it) can start a handshake and read it, so it says nothing of this computer; who it is comes
 * in `welcome`, once the phone is let in. `name` stays, empty, for the first iPhone builds, which refuse a message 2
 * without it.
 */
export const HOST_HELLO = { v: 1, name: '' } as const;

export interface ChannelDeps {
  link: ChannelLink;
  host: KeyPair;
  roomId: string;
  /** The codes live now (pairing channels). */
  pairCodes(): PairCode[];
  /** A pairing handshake failed: a wrong code, or garbage. */
  pairFailed(): void;
  /** The handshake is over: may this phone in? */
  admit(c: SecureChannel): Promise<Admission>;
  /** Admitted: the channel carries app messages now (the hub sends welcome first). */
  opened(c: SecureChannel): void;
  message(c: SecureChannel, m: DeviceMessage): void;
  /** Ended, by either side or the relay; called once. */
  closed(c: SecureChannel): void;
  limits?: Partial<ChannelLimits>;
  now?: () => number;
}

export type ChannelState = 'hello' | 'auth' | 'admitting' | 'open' | 'closed';

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class SecureChannel {
  state: ChannelState = 'hello';
  /** The phone's static public key (base64url), once its handshake message 3 is read. */
  deviceKey: string | null = null;
  hello: DeviceHello | null = null;
  /** The code a pairing channel matched. */
  code: PairCode | null = null;
  private hs: NoiseHandshake | null = null;
  private transport: NoiseTransport | null = null;
  private readonly reassembler = new Reassembler();
  private held: Buffer[] = [];
  private readonly limits: ChannelLimits;
  private readonly messages: TokenBucket;
  private readonly inputBytes: TokenBucket;
  private readonly creates: TokenBucket;
  private readonly actions: TokenBucket;
  private readonly pushes: TokenBucket;
  private strikesAt: number[] = [];
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly now: () => number;

  /** `lookup`: the offer a pairing channel was opened for, as the relay names it. */
  constructor(readonly ch: number, readonly kind: ChannelKind, private readonly d: ChannelDeps, private readonly lookup?: string) {
    this.limits = { ...LIMITS, ...d.limits };
    this.now = d.now ?? Date.now;
    this.messages = new TokenBucket(this.limits.messagesPerSec, this.limits.messagesPerSec, this.now);
    this.inputBytes = new TokenBucket(this.limits.inputBytesPerSec, this.limits.inputBytesPerSec, this.now);
    this.creates = new TokenBucket(this.limits.createsPerMin, this.limits.createsPerMin / 60, this.now);
    this.actions = new TokenBucket(this.limits.actionsPerMin, this.limits.actionsPerMin / 60, this.now);
    this.pushes = new TokenBucket(this.limits.pushesPerMin, this.limits.pushesPerMin / 60, this.now);
    this.timer = setTimeout(() => { if (this.state === 'hello' || this.state === 'auth') this.close(CLOSE.timeout); }, this.limits.handshakeMs);
    this.timer.unref?.();
  }

  /**
   * A frame from the relay for this channel. One larger than a Noise message (65535 bytes) is no frame a phone sends
   * (its fragments are at most that, and the relay refuses larger ones from it): refused unread, in every state.
   */
  receive(frame: Buffer): void {
    if (this.state === 'closed') return;
    if (frame.length > NOISE_MAX_MESSAGE) { this.close(CLOSE.tooLarge); return; }
    switch (this.state) {
      case 'hello': this.first(frame); return;
      case 'auth': this.third(frame); return;
      case 'admitting':
        if (this.held.length >= HELD_MAX) { this.close(CLOSE.overloaded); return; }
        this.held.push(frame);
        return;
      case 'open': this.transportFrame(frame); return;
    }
  }

  /** Message 1 (the phone's ephemeral key) in; message 2 (this computer's keys, and a hello that names nothing) out. */
  private first(frame: Buffer): void {
    const base = { protocol: protocolOf(this.kind), initiator: false, s: this.d.host } as const;
    if (this.kind === 'device') {
      this.hs = new NoiseHandshake({ ...base, prologue: prologue('device', this.d.roomId) });
      try { this.hs.readMessage(frame); } catch { this.close(CLOSE.malformed); return; }
    } else {
      // The code of the offer the relay names; without a name, any live code (message 1 of XXpsk3 authenticates its
      // empty payload under a hash that covers the prologue: only the code whose lookup the phone dialed reads it).
      const live = this.d.pairCodes();
      const codes = this.lookup === undefined ? live : live.filter((c) => c.lookup === this.lookup);
      if (codes.length === 0) { this.close(CLOSE.noCode); return; }
      for (const c of codes) {
        const hs = new NoiseHandshake({ ...base, prologue: prologue('pair', c.lookup), psk: c.psk });
        try { hs.readMessage(frame); this.hs = hs; this.code = c; break; } catch { /* not this code */ }
      }
      if (!this.hs) { this.d.pairFailed(); this.close(CLOSE.malformed); return; }
    }
    let m2: Buffer;
    try { m2 = this.hs.writeMessage(Buffer.from(JSON.stringify(HOST_HELLO))); } catch { this.close(CLOSE.malformed); return; }
    this.state = 'auth';
    this.d.link.send(this.ch, m2);
  }

  /** Message 3 (the phone's static key and hello) in: then the hub decides. */
  private third(frame: Buffer): void {
    const hs = this.hs!;
    // Message 2 may have gone up to the handshake's time ago: the code it matched must still be live now (not denied
    // and replaced, run out, or gone with the sheet). A phone that held on to message 3 is never asked about with it.
    const live = this.kind === 'device' || this.d.pairCodes().some((c) => c.lookup === this.code?.lookup);
    let payload: Buffer;
    try { payload = hs.readMessage(frame); } catch {
      // A wrong code fails here (the pre-shared key is mixed in with this message): an attempt at the live code only.
      if (this.kind === 'pair' && live) this.d.pairFailed();
      this.close(CLOSE.malformed);
      return;
    }
    let hello: DeviceHello;
    try { hello = deviceHelloSchema.parse(JSON.parse(utf8.decode(payload))); } catch { this.close(CLOSE.malformed); return; }
    this.hello = hello;
    this.deviceKey = b64url(hs.remoteStatic!);
    this.transport = hs.split();
    this.hs = null;
    this.state = 'admitting';
    clearTimeout(this.timer);
    if (!live) { this.deny('expired'); return; }
    this.d.admit(this).then((a) => {
      if (this.state !== 'admitting') return;
      if (!a.ok) { this.deny(a.reason, a.code); return; }
      this.state = 'open';
      this.d.opened(this);
      for (const f of this.held.splice(0)) { if (this.state !== 'open') break; this.transportFrame(f); }
    }, () => { if (this.state === 'admitting') this.close(CLOSE.malformed); });
  }

  private transportFrame(frame: Buffer): void {
    const t = this.transport!;
    let plain: Buffer;
    try { plain = t.decrypt(frame); } catch { this.close(CLOSE.malformed); return; }
    if (t.received >= this.limits.maxMessages) { this.close(CLOSE.normal); return; }
    let whole: Buffer | null;
    try { whole = this.reassembler.push(plain); } catch (e) {
      this.close(/large/.test((e as Error).message) ? CLOSE.tooLarge : CLOSE.malformed);
      return;
    }
    if (!whole) return;
    let raw: unknown;
    try { raw = JSON.parse(utf8.decode(whole)); } catch { this.close(CLOSE.malformed); return; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as { t?: unknown }).t !== 'string') { this.close(CLOSE.malformed); return; }
    const r = (raw as { rid?: unknown }).rid;
    const rid = typeof r === 'number' && Number.isInteger(r) && r > 0 && r < 2 ** 31 ? r : 0;
    if (!this.messages.tryTake(1)) { this.refuse(rid, 'busy', 'Too many messages; slow down.'); return; }
    const p = deviceMessageSchema.safeParse(raw);
    if (!p.success) { this.refuse(rid, 'invalid', 'This message is not one Atelier understands.'); return; }
    const m = p.data;
    if (m.t === 'input' && !this.inputBytes.tryTake(Buffer.byteLength(m.data, 'utf8'))) { this.refuse(0, 'busy', 'Too much input at once; some was not typed.'); return; }
    if (m.t === 'create' && !this.creates.tryTake(1)) { this.refuse(m.rid, 'busy', 'Too many new sessions; try again in a minute.'); return; }
    if (ROW_ACTIONS.has(m.t) && 'rid' in m && !this.actions.tryTake(1)) { this.refuse(m.rid, 'busy', 'Too many changes at once; try again in a minute.'); return; }
    if (m.t === 'push' && !this.pushes.tryTake(1)) { this.refuse(m.rid, 'busy', 'Too many registrations; try again in a minute.'); return; }
    this.d.message(this, m);
  }

  /** An error answer that also counts against the phone: past the tolerated number, the channel closes. */
  private refuse(rid: number, code: ErrorCode, message: string): void {
    const now = this.now();
    this.strikesAt = this.strikesAt.filter((at) => now - at < this.limits.strikeWindowMs);
    this.strikesAt.push(now);
    if (this.strikesAt.length > this.limits.strikes) { this.close(CLOSE.overloaded); return; }
    this.error(rid, code, message);
  }

  /** An app message to the phone; false when the channel can't carry it (not open, or gone). */
  send(msg: HostMessage): boolean {
    if (this.state !== 'open' && !(msg.t === 'denied' && this.state === 'admitting')) return false;
    const bytes = Buffer.from(JSON.stringify(msg), 'utf8');
    if (bytes.length > MAX_APP_MESSAGE) throw new Error('message too large');
    const parts = fragments(bytes);
    const t = this.transport!;
    if (t.sent + parts.length >= this.limits.maxMessages) { this.close(CLOSE.normal); return false; }
    for (const f of parts) this.d.link.send(this.ch, t.encrypt(f));
    return true;
  }

  error(rid: number, code: ErrorCode, message: string): void {
    this.send({ t: 'error', rid, code, message });
  }

  /** This computer ends the channel: the reason, then a normal close. */
  bye(reason: ByeReason): void {
    if (this.state === 'closed') return;
    if (this.state === 'open') this.send({ t: 'bye', reason });
    this.close(CLOSE.normal, { flush: true });
  }

  /** The phone is not let in: why, then the close. */
  deny(reason: DeniedReason, code: number = CLOSE.normal): void {
    if (this.state === 'closed') return;
    this.send({ t: 'denied', reason });
    this.close(code, { flush: true });
  }

  /** Bytes waiting at the relay link for this channel. */
  queuedBytes(): number { return this.d.link.queued(this.ch); }

  /**
   * Ends the channel. With `flush` what was queued for the phone goes first (a `bye` or `denied` just sent); otherwise
   * it is dropped and the close goes at once.
   */
  close(code: number, o: { flush?: boolean } = {}): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.timer);
    this.held = [];
    this.d.link.closeChannel(this.ch, code, { drop: !o.flush });
    this.d.closed(this);
  }

  /** The relay reported the channel over (or the connection dropped). */
  relayClosed(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.timer);
    this.held = [];
    this.d.closed(this);
  }
}

// A phone for tests: the iPhone app's side of iPhone access, in Node, on Atelier's own Noise and wire code. It pairs
// by code (or QR text) through a relay, connects again as a paired device, and speaks the app messages: attach,
// type, resize, create, with each terminal's screen kept as the text received. PhoneChannel is the device end of one
// Noise channel with no transport (the channel's unit tests feed it bytes directly); FakePhone runs it over the test
// relay with the `ws` package. Used from vitest and Playwright alike (no import.meta).
import WebSocket from 'ws';
import { deriveCode, normalizeCode, parsePairUrl } from '../../src/main/remote/code';
import { NoiseHandshake, generateKeyPair, type KeyPair, type NoiseTransport } from '../../src/main/remote/noise';
import { Reassembler, fragments, prologue, protocolOf, type ChannelKind } from '../../src/main/remote/wire';

export type Msg = Record<string, unknown> & { t: string };

export interface PhoneHello { name: string; model: string; app: string }
const HELLO: PhoneHello = { name: 'Test iPhone', model: 'iPhone17,1', app: '1.0.0' };

export interface PhoneChannelOptions {
  kind: ChannelKind;
  /** The code's lookup (pair) or the room id (device): what the phone dialed. */
  id: string;
  key: KeyPair;
  psk?: Buffer;
  hello?: Partial<PhoneHello> & Record<string, unknown>;
  /** The host's static key the phone pins: the handshake fails unless the host proves it. */
  hostKey?: Buffer | null;
}

/** The device end of one channel: the initiator's three handshake messages, then fragmented JSON messages. */
export class PhoneChannel {
  private hs: NoiseHandshake;
  private transport: NoiseTransport | null = null;
  private readonly reassembler = new Reassembler();
  hostHello: Msg | null = null;
  hostKey: Buffer | null = null;

  constructor(private readonly o: PhoneChannelOptions) {
    this.hs = new NoiseHandshake({ protocol: protocolOf(o.kind), initiator: true, prologue: prologue(o.kind, o.id), s: o.key, ...(o.psk ? { psk: o.psk } : {}) });
  }

  get open(): boolean { return this.transport !== null; }

  /** Message 1. */
  start(): Buffer { return this.hs.writeMessage(Buffer.alloc(0)); }

  /** A frame from the host: message 2 (answered with message 3 in `reply`), or transport frames once open. */
  receive(frame: Buffer): { reply?: Buffer; messages: Msg[] } {
    if (!this.transport) {
      const payload = this.hs.readMessage(frame);
      this.hostHello = JSON.parse(payload.toString('utf8')) as Msg;
      this.hostKey = this.hs.remoteStatic;
      if (this.o.hostKey && !this.o.hostKey.equals(this.hostKey!)) throw new Error('the host is not the one pinned');
      const reply = this.hs.writeMessage(Buffer.from(JSON.stringify({ v: 1, ...HELLO, ...this.o.hello })));
      this.transport = this.hs.split();
      return { reply, messages: [] };
    }
    const whole = this.reassembler.push(this.transport.decrypt(frame));
    return { messages: whole ? [JSON.parse(whole.toString('utf8')) as Msg] : [] };
  }

  /** An app message as the encrypted frames it travels in. */
  encode(msg: object): Buffer[] {
    if (!this.transport) throw new Error('the handshake is not over');
    return fragments(Buffer.from(JSON.stringify(msg))).map((f) => this.transport!.encrypt(f));
  }
}

export interface FakePhoneOptions {
  /** The relay's base URL (http://127.0.0.1:<port>). */
  relay: string;
  key?: KeyPair;
  hello?: Partial<PhoneHello>;
}

/** A phone over the relay. One connection at a time; `messages` holds what the current one received. */
export class FakePhone {
  readonly key: KeyPair;
  relay: string;
  room: string | null = null;
  hostKey: Buffer | null = null;
  messages: Msg[] = [];
  closeCode: number | null = null;
  /** The relay's last word on the host: online or offline. */
  hostStatus: string | null = null;
  private ws: WebSocket | null = null;
  private channel: PhoneChannel | null = null;
  private rid = 0;
  private waiters = new Set<() => void>();
  private readonly hello: Partial<PhoneHello>;

  constructor(o: FakePhoneOptions) {
    this.relay = o.relay;
    this.key = o.key ?? generateKeyPair();
    this.hello = o.hello ?? {};
  }

  /** Pairs by typed code; resolves with the host's first message: `welcome` (paired) or `denied`. */
  async pairByCode(code: string, o: { hostKey?: Buffer } = {}): Promise<Msg> {
    const normal = normalizeCode(code);
    if (!normal) throw new Error('not a code');
    const k = await deriveCode(normal);
    const first = await this.dial('pair', k.lookup, `/v1/pair/${k.lookup}`, { psk: k.psk, hostKey: o.hostKey ?? null });
    if (first.t === 'welcome') {
      this.room = first.room as string;
      this.hostKey = this.channel!.hostKey;
    }
    return first;
  }

  /** Pairs from the QR code's text: its relay, its code, and the host key pinned. */
  async pairByQr(text: string): Promise<Msg> {
    const t = parsePairUrl(text);
    if (!t) throw new Error('not a pairing QR code');
    this.relay = t.relay;
    return this.pairByCode(t.code, { hostKey: t.hostKey });
  }

  /** Connects again as a paired device; resolves with `welcome` (or `denied` when the host no longer knows it). */
  connect(): Promise<Msg> {
    if (!this.room) throw new Error('not paired');
    return this.dial('device', this.room, `/v1/device/${this.room}`, { hostKey: this.hostKey });
  }

  /** A pairing lookup the relay doesn't know: the HTTP status it answered with. */
  static async probe(relay: string, path: string): Promise<number | 'open'> {
    const ws = new WebSocket(relay.replace(/^http/, 'ws') + path);
    return new Promise((resolve) => {
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
      ws.on('open', () => { resolve('open'); ws.terminate(); });
      ws.on('error', () => resolve(0));
    });
  }

  private dial(kind: ChannelKind, id: string, path: string, o: { psk?: Buffer; hostKey: Buffer | null }): Promise<Msg> {
    this.drop();
    this.messages = [];
    this.closeCode = null;
    const ws = new WebSocket(this.relay.replace(/^http/, 'ws') + path);
    this.ws = ws;
    const fresh = () => {
      this.channel = new PhoneChannel({ kind, id, key: this.key, hello: this.hello, ...(o.psk ? { psk: o.psk } : {}), hostKey: o.hostKey });
      ws.send(this.channel.start());
    };
    return new Promise<Msg>((resolve, reject) => {
      let settled = false;
      const settle = (f: () => void) => { if (!settled) { settled = true; f(); } };
      ws.on('message', (data, binary) => {
        const buf = data as Buffer;
        if (!binary) {
          const f = JSON.parse(buf.toString('utf8')) as Msg;
          if (f.t === 'status') {
            this.hostStatus = f.host as string;
            // The host came (back): a new handshake on the same connection; gone, the session is lost with it.
            if (f.host === 'online') fresh();
            else this.channel = null;
          }
          return;
        }
        if (!this.channel) return;
        let r: { reply?: Buffer; messages: Msg[] };
        try { r = this.channel.receive(buf); } catch (e) { settle(() => reject(e)); ws.terminate(); return; }
        if (r.reply) ws.send(r.reply);
        for (const m of r.messages) {
          this.messages.push(m);
          if (m.t === 'welcome' || m.t === 'denied') settle(() => resolve(m));
        }
        if (r.messages.length) this.wake();
      });
      ws.on('close', (code) => {
        if (this.ws === ws) this.closeCode = code;
        settle(() => reject(new Error(`closed ${code}`)));
        this.wake();
      });
      ws.on('unexpected-response', (_req, res) => { settle(() => reject(new Error(`relay answered ${res.statusCode}`))); });
      ws.on('error', () => {});
    });
  }

  private wake(): void { for (const w of [...this.waiters]) w(); }

  /** What the host said of itself in handshake message 2, on the last channel. */
  get hostHello(): Msg | null { return this.channel?.hostHello ?? null; }

  get connected(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.channel?.open; }

  send(msg: object): void {
    if (!this.ws || !this.channel) throw new Error('not connected');
    for (const f of this.channel.encode(msg)) this.ws.send(f);
  }

  /** The first message (from index `since` on) that matches, waiting up to `ms` for it. */
  waitFor(pred: (m: Msg) => boolean, o: { since?: number; ms?: number } = {}): Promise<Msg> {
    const since = o.since ?? 0;
    return new Promise((resolve, reject) => {
      const check = () => {
        const m = this.messages.slice(since).find(pred);
        if (m) { this.waiters.delete(check); clearTimeout(timer); resolve(m); return; }
        if (this.closeCode !== null) { this.waiters.delete(check); clearTimeout(timer); reject(new Error(`closed ${this.closeCode} while waiting`)); }
      };
      const timer = setTimeout(() => { this.waiters.delete(check); reject(new Error(`timed out waiting; got ${this.messages.map((m) => m.t).join(',')}`)); }, o.ms ?? 5000);
      this.waiters.add(check);
      check();
    });
  }

  /** Waits for the connection to end; its close code. */
  async closed(ms = 5000): Promise<number> {
    const start = Date.now();
    while (this.closeCode === null) {
      if (Date.now() - start > ms) throw new Error('still open');
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.closeCode;
  }

  /** The latest `state`, waiting for one that matches. */
  state(pred: (s: Msg) => boolean = () => true, ms?: number): Promise<Msg> {
    const latest = [...this.messages].reverse().find((m) => m.t === 'state');
    if (latest && pred(latest)) return Promise.resolve(latest);
    return this.waitFor((m) => m.t === 'state' && pred(m), { since: this.messages.length, ...(ms ? { ms } : {}) });
  }

  /** Attaches at a size; resolves with the snapshot (its `ok` follows). */
  async attach(id: string, cols = 80, rows = 24): Promise<Msg> {
    const since = this.messages.length;
    const rid = ++this.rid;
    this.send({ t: 'attach', rid, id, cols, rows });
    return this.waitFor((m) => (m.t === 'snapshot' && m.id === id) || (m.t === 'error' && m.rid === rid), { since });
  }

  detach(id: string): void { this.send({ t: 'detach', id }); }
  input(id: string, data: string): void { this.send({ t: 'input', id, data }); }
  resize(id: string, cols: number, rows: number): void { this.send({ t: 'resize', id, cols, rows }); }

  /** Starts a session in a listed project (in a place, as an account); resolves with `created` or `error`. */
  create(project: string, kind: 'claude' | 'terminal', o: { place?: string; account?: string } = {}): Promise<Msg> {
    return this.request({ t: 'create', project, kind, ...o });
  }

  /** A request with the next rid; resolves with its answer: `ok`, `created` or `error`. */
  request(msg: Record<string, unknown> & { t: string }, ms?: number): Promise<Msg> {
    const since = this.messages.length;
    const rid = ++this.rid;
    this.send({ ...msg, rid });
    return this.waitFor((m) => (m.t === 'ok' || m.t === 'created' || m.t === 'error') && m.rid === rid, { since, ...(ms ? { ms } : {}) });
  }

  /** Allow or Deny on a session's permission request, naming the wait the state showed. */
  answer(id: string, wait: string, choice: 'allow' | 'deny'): Promise<Msg> { return this.request({ t: 'answer', id, wait, choice }); }
  rename(id: string, name: string): Promise<Msg> { return this.request({ t: 'rename', id, name }); }
  /** Registers for push notifications with an APNs token, its environment and the key notices are sealed with. */
  registerPush(token: string, env: 'sandbox' | 'production', key: Buffer): Promise<Msg> { return this.request({ t: 'push', token, env, key: key.toString('base64url') }); }
  unregisterPush(): Promise<Msg> { return this.request({ t: 'push', token: null }); }
  closeRow(id: string): Promise<Msg> { return this.request({ t: 'close', id }); }
  // Workspaces and activities, applied in the project's window (opened first when closed: up to 10 s).
  newWorkspace(project: string, name?: string): Promise<Msg> { return this.request({ t: 'workspace', project, ...(name !== undefined ? { name } : {}) }, 15000); }
  newActivity(project: string, workspace: string, name?: string): Promise<Msg> { return this.request({ t: 'activity', project, workspace, ...(name !== undefined ? { name } : {}) }, 15000); }
  renamePlace(project: string, place: string, name: string): Promise<Msg> { return this.request({ t: 'renamePlace', project, place, name }, 15000); }
  move(id: string, place: string): Promise<Msg> { return this.request({ t: 'move', id, place }, 15000); }
  closePlace(project: string, place: string, sessions?: 'move' | 'stop'): Promise<Msg> { return this.request({ t: 'closePlace', project, place, ...(sessions ? { sessions } : {}) }, 15000); }
  // A project's window, opened as a recent project opens or closed as its own close does (up to 10 s).
  openWindow(project: string): Promise<Msg> { return this.request({ t: 'openWindow', project }, 15000); }
  closeWindow(project: string, sessions?: 'keep' | 'stop'): Promise<Msg> { return this.request({ t: 'closeWindow', project, ...(sessions ? { sessions } : {}) }, 15000); }
  resume(id: string): Promise<Msg> { return this.request({ t: 'resume', id }); }
  dismiss(id: string): Promise<Msg> { return this.request({ t: 'dismiss', id }); }

  /** A terminal's screen as received: its last snapshot, then every `out` after it. */
  screen(id: string): string {
    let text = '';
    for (const m of this.messages) {
      if (m.t === 'snapshot' && m.id === id) text = m.data as string;
      else if (m.t === 'out' && m.id === id) text += m.data as string;
    }
    return text;
  }

  /** Waits until the terminal's screen holds `text`. */
  async sees(id: string, text: string, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!this.screen(id).includes(text)) {
      if (Date.now() - start > ms) throw new Error(`no ${JSON.stringify(text)} on screen; got ${JSON.stringify(this.screen(id).slice(-200))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** A clean goodbye from the phone's side. */
  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(1000); });
  }

  /** Gone without a word (out of coverage, killed). */
  drop(): void {
    const ws = this.ws;
    this.ws = null;
    this.channel = null;
    ws?.terminate();
  }
}

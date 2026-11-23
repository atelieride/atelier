// A pairing in progress (the pairing sheet is open): the live code, offered to the relay under its lookup for five
// minutes and replaced by a fresh one when it expires or after five failed attempts; then a phone that presented it
// asks to pair, and the user allows or denies it within a minute. A code is single use: once a phone completed the
// handshake with it, no other may, and after a Deny or no answer the sheet gets a fresh one.
import { randomBytes } from 'node:crypto';
import type { RemotePairing, RemotePairingEvent, RemotePairRequest } from '@shared/remote';
import type { PairCode } from './channel';
import { CODE_TTL_MS, deriveCode, formatCode, newCode, pairUrl } from './code';

export type Decision = 'allow' | 'declined' | 'expired' | 'disabled';

export interface PairingDeps {
  offer(lookup: string, ttlSec: number): void;
  withdraw(lookup: string): void;
  /** The QR code's other parts: the relay this computer dials, its static key, its name. */
  relay: string;
  hostKey: Buffer;
  hostName: string;
  emit(e: RemotePairingEvent): void;
  ttlMs?: number;
  decideMs?: number;
  maxFailures?: number;
  newCode?: () => string;
}

const DECIDE_MS = 60_000;
const MAX_FAILURES = 5;

interface LiveCode { text: string; keys: PairCode; expiresAt: number; failures: number }

export class Pairing {
  private code: LiveCode | null = null;
  private renewing: Promise<RemotePairing> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private request: { info: RemotePairRequest; resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private stopped = false;
  private readonly ttlMs: number;

  constructor(private readonly d: PairingDeps) {
    this.ttlMs = d.ttlMs ?? CODE_TTL_MS;
  }

  /** The code on screen; a fresh one when none is live yet. */
  current(): Promise<RemotePairing> {
    if (this.stopped) return Promise.reject(new Error('pairing stopped'));
    if (this.code && !this.renewing) return Promise.resolve(this.shown(this.code));
    return this.renew();
  }

  /** The codes a pairing handshake may present now: none while a phone that presented one waits for an answer. */
  codes(): PairCode[] {
    return this.code && !this.request && !this.stopped ? [this.code.keys] : [];
  }

  /** A handshake with a wrong code (or garbage): past five, the code is replaced. */
  failed(): void {
    if (!this.code || this.stopped) return;
    if (++this.code.failures >= (this.d.maxFailures ?? MAX_FAILURES)) void this.renew().catch(() => {});
  }

  /** A phone completed the handshake with the code: the windows ask the user, within a minute. */
  ask(o: { name: string; model: string }): Promise<Decision> {
    if (this.stopped || this.request) return Promise.resolve('expired');
    const decideMs = this.d.decideMs ?? DECIDE_MS;
    const info: RemotePairRequest = { id: randomBytes(8).toString('hex'), name: o.name, model: o.model, expiresAt: Date.now() + decideMs };
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.answer('expired'), decideMs);
      timer.unref?.();
      this.request = { info, resolve, timer };
      this.d.emit({ kind: 'request', request: info });
    });
  }

  /** The user's Allow or Deny for that request; false when it is no longer the one waiting. */
  decide(id: string, allow: boolean): boolean {
    if (this.request?.info.id !== id) return false;
    this.answer(allow ? 'allow' : 'declined');
    return true;
  }

  /** The phone that asked left before an answer. */
  cancel(): void {
    if (this.request) this.answer('expired');
  }

  /** Allowed, but the phone was gone by then: the sheet hears the request expired, and gets a fresh code. */
  lost(): void {
    if (this.stopped) return;
    this.d.emit({ kind: 'denied', reason: 'expired' });
    void this.renew().catch(() => {});
  }

  private answer(d: Decision): void {
    const r = this.request;
    if (!r) return;
    clearTimeout(r.timer);
    this.request = null;
    // Single use: Allow spends the code at once, whatever follows (the phone added, or found gone: lost()).
    if (d === 'allow') this.retire();
    r.resolve(d);
    if (d === 'declined' || d === 'expired') {
      this.d.emit({ kind: 'denied', reason: d });
      // Single use: the phone knew this code.
      void this.renew().catch(() => {});
    }
  }

  /** Paired: the code dies, the offer goes, nothing is renewed. */
  finish(): void {
    this.retire();
    this.stopped = true;
  }

  /** The sheet closed or remote access went off: the code goes; a phone still waiting is told so. */
  stop(): void {
    this.stopped = true;
    this.answer('disabled');
    this.retire();
  }

  private retire(): void {
    if (this.expiry) { clearTimeout(this.expiry); this.expiry = null; }
    if (this.code) { this.d.withdraw(this.code.keys.lookup); this.code = null; }
  }

  private shown(c: LiveCode): RemotePairing {
    return { code: formatCode(c.text), qr: pairUrl({ code: c.text, relay: this.d.relay, hostKey: this.d.hostKey, name: this.d.hostName }), expiresAt: c.expiresAt };
  }

  private renew(): Promise<RemotePairing> {
    if (this.renewing) return this.renewing;
    this.retire();
    const text = (this.d.newCode ?? newCode)();
    this.renewing = deriveCode(text).then((keys) => {
      this.renewing = null;
      if (this.stopped) throw new Error('pairing stopped');
      const c: LiveCode = { text, keys, expiresAt: Date.now() + this.ttlMs, failures: 0 };
      this.code = c;
      this.d.offer(keys.lookup, Math.ceil(this.ttlMs / 1000));
      this.expiry = setTimeout(() => {
        this.expiry = null;
        // In use by a phone waiting for an answer: every answer ends it (Allow spends it; Deny, no answer or the phone
        // leaving replace it; pairing off withdraws it), so it isn't replaced under that phone.
        if (this.request) return;
        void this.renew().catch(() => {});
      }, this.ttlMs);
      this.expiry.unref?.();
      const shown = this.shown(c);
      this.d.emit({ kind: 'code', pairing: shown });
      return shown;
    }, (err: unknown) => { this.renewing = null; throw err; });
    return this.renewing;
  }
}

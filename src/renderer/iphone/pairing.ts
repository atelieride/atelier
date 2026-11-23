// The pairing sheet's state: what startPairing answered, then the news main sends while it is open (a renewed code, a
// phone asking, the answer's outcome). Pure: the sheet renders it, its effects act on 'paired' and 'stopped'.
import type { RemotePairing, RemotePairingEvent, RemotePairingStart, RemotePairRequest } from '@shared/remote';

export type PairNotice = 'declined' | 'expired';

export type PairSheet =
  /** startPairing on its way. */
  | { phase: 'starting' }
  /** iPhone access is off: the sheet offers to turn it on. */
  | { phase: 'off' }
  | { phase: 'error'; message: string }
  /**
   * A code on screen. `notice`: why the code before it went (a Deny, no answer), shown with this fresh one; `waiting`:
   * that code is still the one on screen, its replacement on the way.
   */
  | { phase: 'code'; pairing: RemotePairing; notice: PairNotice | null; waiting: boolean }
  /** A phone presented the code: Allow or Deny. `answering`: Allow sent, the phone not paired yet. */
  | { phase: 'request'; request: RemotePairRequest; pairing: RemotePairing | null; answering: boolean }
  /** Paired: the sheet closes. */
  | { phase: 'paired'; name: string }
  /** Pairing ended elsewhere (another window's sheet closed, access turned off): the sheet asks for a code again. */
  | { phase: 'stopped' };

export type PairAction =
  | { kind: 'start' }
  | { kind: 'started'; result: RemotePairingStart }
  | { kind: 'allow' }
  | RemotePairingEvent;

export const PAIR_START: PairSheet = { phase: 'starting' };

const codeOf = (s: PairSheet): RemotePairing | null => (s.phase === 'code' || s.phase === 'request' ? s.pairing : null);

export function pairReducer(s: PairSheet, a: PairAction): PairSheet {
  switch (a.kind) {
    case 'start': return PAIR_START;
    case 'started':
      // A code event may have come first (startPairing waits for the code it brings): the newer one stays.
      if (s.phase === 'code' || s.phase === 'request') return s;
      if (a.result.ok) return { phase: 'code', pairing: a.result.pairing, notice: null, waiting: false };
      return a.result.reason === 'disabled' ? { phase: 'off' } : { phase: 'error', message: a.result.message };
    case 'code':
      // A fresh code after a Deny or no answer keeps saying why; one that renews by itself says nothing.
      if (s.phase === 'code') return { phase: 'code', pairing: a.pairing, notice: s.waiting ? s.notice : null, waiting: false };
      if (s.phase === 'request') return { ...s, pairing: a.pairing };
      if (s.phase === 'paired' || s.phase === 'off') return s;
      return { phase: 'code', pairing: a.pairing, notice: null, waiting: false };
    case 'request':
      if (s.phase === 'paired') return s;
      return { phase: 'request', request: a.request, pairing: codeOf(s), answering: false };
    case 'allow':
      return s.phase === 'request' ? { ...s, answering: true } : s;
    case 'paired':
      return { phase: 'paired', name: a.device.name };
    case 'denied': {
      if (s.phase === 'paired') return s;
      const pairing = codeOf(s);
      // The code the phone knew is spent: it stays on screen, dimmed, until its replacement comes.
      return pairing ? { phase: 'code', pairing, notice: a.reason, waiting: true } : { phase: 'starting' };
    }
    case 'stopped':
      return s.phase === 'paired' ? s : { phase: 'stopped' };
  }
}

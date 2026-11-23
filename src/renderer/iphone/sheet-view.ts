// iPhone access as Settings › iPhone and the pairing sheet show it: a phone by its name or model (device-name.ts), the
// relay's status line, when a phone was last seen, the countdowns, why a relay address can't be used. Loaded with them,
// out of the first paint. Pure.
import type { RemoteDeviceInfo, RemoteStatus } from '@shared/remote';
import { relayBase } from '@shared/remote';
import { agoLower } from '../connectors-view';
import { tiph } from '../i18n/iphone';

export { deviceSubtitle, deviceTitle, modelName } from './device-name';

export type Tone = 'ok' | 'busy' | 'warn' | 'err';

/** The relay's status line in Settings › iPhone; null while access is off and nothing is wrong. */
export function relayLine(s: RemoteStatus | null): { tone: Tone; text: string } | null {
  if (!s) return null;
  if (!s.available) return { tone: 'err', text: tiph.relay.unavailable };
  if (!s.enabled) return null;
  switch (s.relay.state) {
    case 'online': return { tone: 'ok', text: tiph.relay.online };
    case 'connecting': return { tone: 'busy', text: tiph.relay.connecting };
    case 'error': return { tone: 'err', text: s.relay.message ?? tiph.relay.failed };
    case 'offline': return { tone: 'warn', text: tiph.relay.offline };
  }
}

/** "Connected", or when it was last connected ("Last seen 2 min ago"). */
export function seenText(d: RemoteDeviceInfo, now: number): string {
  return d.connected ? tiph.connected : tiph.lastSeen(agoLower(d.lastSeenAt, now));
}

/** "4:59": what is left of a countdown, never negative, rounded up (a code shown for 300 s starts at 5:00). */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Why a relay address can't be used, in the words of the field's warning; null when Atelier can dial it. */
export function relayProblem(raw: string): string | null {
  const v = raw.trim();
  if (relayBase(v) !== null) return null;
  const bad = tiph.relayBad;
  if (!v) return bad.empty;
  let u: URL;
  try { u = new URL(v); } catch { return /^[a-z][a-z0-9+.-]*:/i.test(v) ? bad.invalid : bad.scheme; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad.scheme;
  if (u.username || u.password || u.search || u.hash || v.includes('?') || v.includes('#')) return bad.parts;
  if (!u.hostname) return bad.invalid;
  if (u.protocol === 'http:') return bad.http;
  return bad.invalid;
}


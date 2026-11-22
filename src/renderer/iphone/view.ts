// iPhone access as the windows show it: the relay's status line, a paired phone's name and model, when it was last
// seen, the countdowns of the pairing sheet, the relay field's feedback, and which terminals a phone has open. Pure.
import type { RemoteDeviceInfo, RemoteStatus } from '@shared/remote';
import { relayBase } from '@shared/remote';
import { agoLower } from '../connectors-view';
import { t } from '../i18n/en';

/** The marketing names of the iPhones Atelier's app runs on (iOS 18 and later), by hardware model. */
const MODELS: Record<string, string> = {
  'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max', 'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR',
  'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone12,8': 'iPhone SE',
  'iPhone13,1': 'iPhone 12 mini', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,6': 'iPhone SE', 'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus', 'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max', 'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus', 'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max', 'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus', 'iPhone17,1': 'iPhone 16 Pro',
  'iPhone17,2': 'iPhone 16 Pro Max', 'iPhone17,5': 'iPhone 16e', 'iPhone18,3': 'iPhone 17', 'iPhone18,4': 'iPhone Air',
  'iPhone18,1': 'iPhone 17 Pro', 'iPhone18,2': 'iPhone 17 Pro Max'
};

/** "iPhone 16 Pro" for iPhone17,1; an unknown model by its family (iPhone, iPad), else as reported. */
export function modelName(model: string): string {
  const known = MODELS[model];
  if (known) return known;
  const family = /^(iPhone|iPad|iPod)\d/.exec(model)?.[1];
  return family ?? (model.trim() || 'iPhone');
}

/** The names iOS gives every device unless the user's own name is allowed: they say less than the model. */
const GENERIC = /^(iphone|ipad|ipod touch)$/i;

/** What a phone is called on screen: the name it gave, or its model when that name is only "iPhone". */
export function deviceTitle(d: { name: string; model: string }): string {
  const name = d.name.trim();
  return name && !GENERIC.test(name) ? name : modelName(d.model);
}

/** The second line under a phone's title: its model, unless the title already is the model. */
export function deviceSubtitle(d: { name: string; model: string }): string | null {
  const model = modelName(d.model);
  return deviceTitle(d) === model ? null : model;
}

export type Tone = 'ok' | 'busy' | 'warn' | 'err';

/** The relay's status line in Settings › iPhone; null while access is off and nothing is wrong. */
export function relayLine(s: RemoteStatus | null): { tone: Tone; text: string } | null {
  if (!s) return null;
  if (!s.available) return { tone: 'err', text: t.iphone.relay.unavailable };
  if (!s.enabled) return null;
  switch (s.relay.state) {
    case 'online': return { tone: 'ok', text: t.iphone.relay.online };
    case 'connecting': return { tone: 'busy', text: t.iphone.relay.connecting };
    case 'error': return { tone: 'err', text: s.relay.message ?? t.iphone.relay.failed };
    case 'offline': return { tone: 'warn', text: t.iphone.relay.offline };
  }
}

/** "Connected", or when it was last connected ("Last seen 2 min ago"). */
export function seenText(d: RemoteDeviceInfo, now: number): string {
  return d.connected ? t.iphone.connected : t.iphone.lastSeen(agoLower(d.lastSeenAt, now));
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
  const bad = t.iphone.relayBad;
  if (!v) return bad.empty;
  let u: URL;
  try { u = new URL(v); } catch { return /^[a-z][a-z0-9+.-]*:/i.test(v) ? bad.invalid : bad.scheme; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad.scheme;
  if (u.username || u.password || u.search || u.hash || v.includes('?') || v.includes('#')) return bad.parts;
  if (!u.hostname) return bad.invalid;
  if (u.protocol === 'http:') return bad.http;
  return bad.invalid;
}

/** The phones connected now. */
export function connectedDevices(s: RemoteStatus | null): RemoteDeviceInfo[] {
  return s?.enabled ? s.devices.filter((d) => d.connected) : [];
}

/** The terminals a connected phone has open. */
export function phoneTerminals(s: RemoteStatus | null): string[] {
  return [...new Set(connectedDevices(s).flatMap((d) => d.attached))];
}

/** The footer pill: "iPhone" for one phone, "2 iPhones" for more, and its tooltip naming them. */
export function pillView(devices: RemoteDeviceInfo[]): { label: string; tip: string } | null {
  if (devices.length === 0) return null;
  return { label: t.iphone.pill(devices.length), tip: t.iphone.pillTip(devices.map(deviceTitle)) };
}

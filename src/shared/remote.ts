// iPhone access: the relay URL rule (Settings validates it, the main process dials only what passes it) and the types
// the renderer gets through `window.atelier.remote`. Pure: shared by main, preload and the renderer.

/** The relay a fresh install uses. */
export const DEFAULT_RELAY = 'https://relay.useatelier.dev';

/** The longest relay URL accepted. */
export const MAX_RELAY_URL = 512;

const privateV4 = (host: string): boolean => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

/** Loopback (::1) or a unique local address (fc00::/7), as the URL parser writes an IPv6 host: in brackets. */
const privateV6 = (host: string): boolean => {
  const m = /^\[([0-9a-f:.]+)\]$/.exec(host);
  if (!m) return false;
  const ip = m[1]!;
  return ip === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(ip);
};

/**
 * The relay's base URL as Atelier dials it (scheme, host, port, path, no trailing slash), or null when it is not one
 * Atelier may use: https to any host; http only to localhost, loopback and private (RFC 1918, unique local) addresses,
 * for a relay on this computer or the local network. No credentials, query or fragment.
 */
export function relayBase(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RELAY_URL || raw.trim() !== raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || raw.includes('?') || raw.includes('#') || !u.hostname) return null;
  if (u.protocol === 'http:') {
    if (u.hostname !== 'localhost' && !privateV4(u.hostname) && !privateV6(u.hostname)) return null;
  } else if (u.protocol !== 'https:') return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * The relay Atelier dials for the `remoteRelay` setting. A test relay (development only) stands in for the default
 * one, so no test or dev run reaches the real relay by default; a relay typed in Settings is dialed as it is, which is
 * how a developer points a dev Atelier, or a test, at a relay of their own.
 */
export function relayToDial(setting: string, testRelay: string | undefined): string {
  return testRelay && setting === DEFAULT_RELAY ? testRelay : setting;
}

/** How the relay connection stands: 'offline' also while remote access is off. */
export type RemoteRelayState = 'online' | 'connecting' | 'offline' | 'error';

/** A paired phone as Settings lists it. */
export interface RemoteDeviceInfo {
  id: string;
  name: string;
  /** The hardware model it reported (e.g. iPhone17,1). */
  model: string;
  pairedAt: number;
  lastSeenAt: number;
  /** Connected to this computer right now. */
  connected: boolean;
  /** The terminals it has open now (ids, as in TerminalInfo). */
  attached: string[];
}

/** A terminal a phone sized, and the size it has. */
export interface RemoteSized { id: string; cols: number; rows: number }

export interface RemoteStatus {
  /** Settings › iPhone › Allow access from iPhone. */
  enabled: boolean;
  /** This computer can keep the keys encrypted (safeStorage); without it remote access stays off. */
  available: boolean;
  relay: { state: RemoteRelayState; message?: string };
  devices: RemoteDeviceInfo[];
  /**
   * Terminals whose size a phone owns now, with that size: an Atelier window shows them at it until it takes it back
   * (what the program draws for that size then lands where it does on the phone).
   */
  sized: RemoteSized[];
}

/** A pairing code on screen: as shown (7K4Q-9MXD-2HTR), the QR code's text, and when it gives way to a fresh one. */
export interface RemotePairing { code: string; qr: string; expiresAt: number }

/** A phone presented the code: Allow or Deny before `expiresAt`. */
export interface RemotePairRequest { id: string; name: string; model: string; expiresAt: number }

export type RemotePairingStart = { ok: true; pairing: RemotePairing } | { ok: false; reason: 'disabled' | 'unavailable' | 'failed'; message: string };

/**
 * What happens to a pairing in progress: a fresh code (expiry, too many failed attempts, after a Deny), a phone asking
 * to pair, the phone paired (the sheet closes), a request declined or left unanswered, or pairing over (remote access
 * turned off).
 */
export type RemotePairingEvent =
  | { kind: 'code'; pairing: RemotePairing }
  | { kind: 'request'; request: RemotePairRequest }
  | { kind: 'paired'; device: RemoteDeviceInfo }
  | { kind: 'denied'; reason: 'declined' | 'expired' }
  | { kind: 'stopped' };

/** A place of a project's sidebar: a workspace, or an activity inside one (`parent`). `folder`: a name, never a path. */
export interface RemotePlace { id: string; name: string; color: number; folder?: string; parent?: string; open: boolean }

/**
 * How a project's sidebar is arranged, as its window shows it: grouping by state, the pins, the order rows were put
 * in by hand, and the workspaces with their activities and which place each row belongs to (absent with workspaces
 * off). The project's main window sends it to main whenever it changes while iPhone access is on; phones get it as is.
 */
export interface RemoteLayout {
  groupByState: boolean;
  pins: string[];
  order: { sessions: string[]; terminals: string[] };
  workspaces?: { active: string; activities: boolean; places: RemotePlace[]; members: Record<string, string> };
}

/**
 * What a paired phone did to a project's rows that its main window follows (only while it is open): a new row joins
 * the place the phone named; a resume keeps the old row alive meanwhile, then the new terminal takes its pin, its place
 * in the manual order and its workspace (`to` null: the resume failed).
 */
export type RemoteRowsEvent =
  | { kind: 'join'; id: string; place: string }
  | { kind: 'resuming'; id: string }
  | { kind: 'resumed'; from: string; to: string | null };

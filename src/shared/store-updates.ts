// Windows: the Microsoft Store's updates inside Atelier. What
// native/atelier-store.exe prints, parsed strictly, and what a check means for the app. Pure: no I/O.
import { compareSemver } from './update-feed';

/** Windows 11 24H2: `UpdateWhileInUse=defer` is honoured, so an install leaves the running Atelier alone. */
export const DEFER_BUILD = 26100;

/** atelier-store's `error` for a process without package identity: a dev run or an unpacked build. */
export const NO_IDENTITY = '80073d54';

export interface StoreCheck {
  family: string;
  /** The newest version of the package registered for this user (MSIX, four numbers); null when not found. */
  registered: string | null;
  updates: number;
  /** The Store allows a silent download: its automatic updates are on and the network isn't metered. */
  silent: boolean;
}

export type StoreDone = 'completed' | 'none' | 'canceled' | 'error' | 'low-battery' | 'wifi';
export type StoreUpdateLine = { kind: 'progress'; value: number } | { kind: 'done'; result: StoreDone };

const FAMILY = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}_[a-z0-9]{1,32}$/;
const MSIX = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;
const msixOk = (v: string) => { const m = MSIX.exec(v); return !!m && m.slice(1).every((n) => Number(n) <= 65535); };
const lines = (out: string) => out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');

/** `check`'s four lines (`registered` may be missing); null for anything else, never a guess. */
export function parseCheck(out: string): StoreCheck | null {
  const seen = new Map<string, string>();
  for (const l of lines(out)) {
    const m = /^(family|registered|updates|silent) (\S+)$/.exec(l);
    if (!m || seen.has(m[1]!)) return null;
    seen.set(m[1]!, m[2]!);
  }
  const family = seen.get('family'); const updates = seen.get('updates'); const silent = seen.get('silent');
  const registered = seen.get('registered') ?? null;
  if (!family || !FAMILY.test(family)) return null;
  if (!updates || !/^(0|[1-9]\d{0,3})$/.test(updates)) return null;
  if (silent !== '0' && silent !== '1') return null;
  if (registered !== null && !msixOk(registered)) return null;
  return { family, registered, updates: Number(updates), silent: silent === '1' };
}

/** The helper's `error <hresult> <message>` line, wherever it is in the output. */
export function parseHelperError(out: string): { hresult: string; message: string } | null {
  for (const l of lines(out)) {
    const m = /^error ([0-9a-f]{8}) ?(.*)$/.exec(l);
    if (m) return { hresult: m[1]!, message: m[2]!.trim() };
  }
  return null;
}

const DONE: readonly StoreDone[] = ['completed', 'none', 'canceled', 'error', 'low-battery', 'wifi'];

/** One line of `update`'s output; null for anything it doesn't print. */
export function parseUpdateLine(line: string): StoreUpdateLine | null {
  const l = line.replace(/\r$/, '');
  const p = /^progress ([01]\.\d{3})$/.exec(l);
  if (p) { const value = Number(p[1]); return value <= 1 ? { kind: 'progress', value } : null; }
  const d = /^done (\S+)$/.exec(l);
  if (d && (DONE as readonly string[]).includes(d[1]!)) return { kind: 'done', result: d[1] as StoreDone };
  return null;
}

/**
 * The release an MSIX version was packed from: the inverse of scripts/win/msix-version.mjs (X.Y.(Z·1000+N).0 for
 * X.Y.Z-beta.N, N = 999 for the stable X.Y.Z). Null for a version no release makes.
 */
export function semverOfMsix(v: string): string | null {
  if (!msixOk(v)) return null;
  const [major, minor, build, revision] = v.split('.').map(Number) as [number, number, number, number];
  if (revision !== 0) return null;
  const patch = Math.floor(build / 1000); const n = build % 1000;
  if (patch > 64) return null;
  return n === 999 ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}-beta.${n}`;
}

/** `os.release()` on Windows is `10.0.<build>`; null elsewhere. */
export function windowsBuild(release: string): number | null {
  const m = /^10\.0\.(\d+)/.exec(release);
  return m ? Number(m[1]) : null;
}

export type StoreDecision =
  | { kind: 'ready'; version: string }
  | { kind: 'download' }
  | { kind: 'store'; reason: 'no-silent' | 'windows' }
  | { kind: 'up-to-date' };

/**
 * What a check means: a newer version already registered is ready to restart into; a Store update is
 * installed in the background only where Windows leaves the running app alone and the Store allows it silently;
 * otherwise the user gets it from the Store.
 */
export function storeDecision(c: StoreCheck, o: { running: string; build: number | null }): StoreDecision {
  const registered = c.registered ? semverOfMsix(c.registered) : null;
  if (registered && compareSemver(registered, o.running) > 0) return { kind: 'ready', version: registered };
  if (c.updates === 0) return { kind: 'up-to-date' };
  if (o.build === null || o.build < DEFER_BUILD) return { kind: 'store', reason: 'windows' };
  return c.silent ? { kind: 'download' } : { kind: 'store', reason: 'no-silent' };
}

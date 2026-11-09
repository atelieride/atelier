// In-app updates: the per-release feed `latest-mac.yml` (electron-builder's
// shape plus our fields), semver, channel rules and the status the renderer shows. Pure: no I/O, no crypto (the
// signature lives in update-sign.node.ts), so the same rules are tested once and used by main and the renderer.

export type UpdateChannel = 'stable' | 'beta';
/** Settings › About: 'auto' follows the build's own channel (none for dev and stage-update builds). */
export type UpdateChannelSetting = 'auto' | 'off' | UpdateChannel;

/** Largest update ZIP we accept (Atelier's is ~150 MB): a bigger feed is malformed, not a download. */
export const MAX_UPDATE_ZIP = 1_000_000_000;
export const MAX_FEED_BYTES = 64 * 1024;
export const MAX_NOTES = 20_000;
/** The update payload's file name: a plain name next to the feed in the same release, never a path or a URL. */
export const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/;
/** Release tags of the releases repo: vX.Y.Z (stable) or vX.Y.Z-beta.N (beta). */
export const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/;

export interface SemVer { major: number; minor: number; patch: number; pre: (string | number)[] }

const NUM = '(0|[1-9]\\d{0,8})';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);

export function parseSemver(v: string): SemVer | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  // Numeric prerelease identifiers have no leading zeros.
  if (m[4] && m[4].split('.').some((p) => /^0\d+$/.test(p))) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** <0, 0, >0 as with sort; NaN if either side is not semver. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a); const y = parseSemver(b);
  if (!x || !y) return NaN;
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  // A version without prerelease is greater than the same version with one.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    // Numeric identifiers have lower precedence than alphanumeric ones.
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export interface UpdateFeed {
  version: string;
  /** The ZIP's file name in the same release, and its sha512 (base64) and size. */
  path: string;
  sha512: string;
  size: number;
  releaseDate: string;
  channel: UpdateChannel;
  minimumSystemVersion: string;
  /** atelierd protocol version of the build: a different one needs an atelierd restart (sessions close). */
  protocol: number;
  /** sha256 of node-pty's spawn-helper code (helper-hash.node.ts): atelierd runs it for every new terminal, so it must not change. */
  spawnHelper: string;
  notes: string;
}

type Item = Record<string, string>;
type Value = string | Item[];

// --- A strict subset of YAML: exactly what scripts/make-feed.mjs (and electron-builder) write -------------------
// Top-level `key: scalar`, `key: |` / `key: |-` block scalars indented by two spaces, and `files:` as a list of maps
// (`  - k: v` / `    k: v`). Anything else (tabs, anchors, flow collections, other indentation, duplicate keys) is
// rejected: the signature covers these bytes and they must mean exactly one thing.

const KEY = /^([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/;

function scalar(raw: string): string | null {
  const s = raw.replace(/ +$/, '');
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) return null;
    try { const v: unknown = JSON.parse(s); return typeof v === 'string' ? v : null; } catch { return null; }
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) return null;
    const inner = s.slice(1, -1);
    if (/'(?!')/.test(inner.replace(/''/g, ''))) return null;
    return inner.replace(/''/g, "'");
  }
  // Plain scalars: the characters of versions, names, base64, hex and ISO dates; no YAML indicators or comments.
  if (!/^[A-Za-z0-9._/+=-][A-Za-z0-9._/+=:-]*$/.test(s)) return null;
  return s;
}

function parseYamlSubset(text: string): Map<string, Value> | null {
  if (text.length === 0 || text.length > MAX_FEED_BYTES || text.includes('\t') || text.includes('\r')) return null;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = new Map<string, Value>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (line === '') continue;
    const m = KEY.exec(line);
    if (!m) return null;
    const key = m[1]!;
    const rest = m[2];
    if (out.has(key)) return null;
    if (rest === '|' || rest === '|-') {
      const body: string[] = [];
      while (i < lines.length && (lines[i] === '' || lines[i]!.startsWith('  '))) { body.push(lines[i]!.slice(2)); i++; }
      while (body.length > 0 && body.at(-1) === '') body.pop();
      out.set(key, body.join('\n') + (rest === '|' && body.length > 0 ? '\n' : ''));
      continue;
    }
    if (rest === undefined || rest === '') {
      const items: Item[] = [];
      while (i < lines.length && lines[i]!.startsWith('  ')) {
        const l = lines[i]!;
        i++;
        const start = /^ {2}- (.*)$/.exec(l);
        const cont = /^ {4}(\S.*)$/.exec(l);
        const kv = KEY.exec(start ? start[1]! : cont ? cont[1]! : '');
        if (!kv || kv[2] === undefined) return null;
        if (start) items.push({});
        const item = items.at(-1);
        const v = scalar(kv[2]);
        if (!item || v === null || kv[1]! in item) return null;
        item[kv[1]!] = v;
      }
      if (items.length === 0) return null;
      out.set(key, items);
      continue;
    }
    const v = scalar(rest);
    if (v === null) return null;
    out.set(key, v);
  }
  return out;
}

const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;
const str = (v: Value | undefined): string | null => (typeof v === 'string' ? v : null);

export function parseFeed(text: string): { ok: true; feed: UpdateFeed } | { ok: false; error: string } {
  const y = parseYamlSubset(text);
  if (!y) return { ok: false, error: 'not a feed in the expected format' };
  const fail = (error: string) => ({ ok: false as const, error });
  const version = str(y.get('version'));
  const v = version ? parseSemver(version) : null;
  if (!version || !v) return fail('version');
  const channel = str(y.get('channel'));
  if (channel !== 'stable' && channel !== 'beta') return fail('channel');
  if (channel === 'stable' && v.pre.length > 0) return fail('a stable feed with a prerelease version');
  const files = y.get('files');
  const first = Array.isArray(files) ? files[0] : undefined;
  const path = str(y.get('path'));
  const sha512 = str(y.get('sha512'));
  if (!first || !path || !ZIP_NAME.test(path) || first.url !== path) return fail('path');
  if (!sha512 || !SHA512_B64.test(sha512) || first.sha512 !== sha512) return fail('sha512');
  const size = /^\d{1,10}$/.test(first.size ?? '') ? Number(first.size) : 0;
  if (size < 1 || size > MAX_UPDATE_ZIP) return fail('size');
  const releaseDate = str(y.get('releaseDate'));
  if (!releaseDate || releaseDate.length > 40 || Number.isNaN(Date.parse(releaseDate))) return fail('releaseDate');
  const minimumSystemVersion = str(y.get('minimumSystemVersion'));
  if (!minimumSystemVersion || !/^\d{1,3}(\.\d{1,3}){0,2}$/.test(minimumSystemVersion)) return fail('minimumSystemVersion');
  const protocol = str(y.get('protocol'));
  if (!protocol || !/^[1-9]\d{0,5}$/.test(protocol)) return fail('protocol');
  const spawnHelper = str(y.get('spawnHelper'));
  if (!spawnHelper || !/^[0-9a-f]{64}$/.test(spawnHelper)) return fail('spawnHelper');
  const notes = str(y.get('notes'));
  if (notes === null || notes.length > MAX_NOTES) return fail('notes');
  return { ok: true, feed: { version, path, sha512, size, releaseDate, channel, minimumSystemVersion, protocol: Number(protocol), spawnHelper, notes } };
}

export interface ReleaseEntry { tag: string; version: string; prerelease: boolean }

/** The GitHub API's release list (`/repos/:owner/:repo/releases`): only our tags, never drafts; junk skipped. */
export function parseReleaseList(json: unknown): ReleaseEntry[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((r: unknown): ReleaseEntry[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    if (o.draft !== false || typeof o.tag_name !== 'string') return [];
    const m = RELEASE_TAG.exec(o.tag_name);
    if (!m || !parseSemver(m[1]!)) return [];
    return [{ tag: o.tag_name, version: m[1]!, prerelease: o.prerelease === true }];
  });
}

/** Stable: the newest full release (never a prerelease version). Beta: the newest of betas and full releases. */
export function pickRelease(list: readonly ReleaseEntry[], channel: UpdateChannel): ReleaseEntry | null {
  let best: ReleaseEntry | null = null;
  for (const r of list) {
    if (channel === 'stable' && (r.prerelease || (parseSemver(r.version)?.pre.length ?? 1) > 0)) continue;
    if (!best || compareSemver(r.version, best.version) > 0) best = r;
  }
  return best;
}

/** What to do with a verified feed: install only a newer version allowed on the channel (never a downgrade). */
export function feedVerdict(feed: Pick<UpdateFeed, 'version' | 'channel'>, o: { channel: UpdateChannel; current: string }): 'newer' | 'not-newer' | 'wrong-channel' {
  if (o.channel === 'stable' && (feed.channel !== 'stable' || (parseSemver(feed.version)?.pre.length ?? 1) > 0)) return 'wrong-channel';
  const c = compareSemver(feed.version, o.current);
  return c > 0 ? 'newer' : 'not-newer';
}

export function effectiveChannel(setting: UpdateChannelSetting, build: UpdateChannel | null): UpdateChannel | null {
  if (setting === 'off') return null;
  return setting === 'auto' ? build : setting;
}

/** macOS version (process.getSystemVersion(), "26.0.1") against the feed's minimum ("12.0"). */
export function systemVersionAtLeast(system: string, minimum: string): boolean {
  const p = (s: string) => (/^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null);
  const a = p(system); const b = p(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0; const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The "What's new" toast: the app now runs a newer version than at its last launch. */
export function whatsNewDue(lastRun: string | null, current: string): boolean {
  return lastRun !== null && compareSemver(current, lastRun) > 0;
}

// --- Status shown in Settings › About and the footer ------------------------------------------------------------

/** `incomplete`: a file of the release answered 404/5xx (deleted asset, half-published release, GitHub trouble). */
export type UpdateErrorKind = 'network' | 'rate-limited' | 'feed' | 'incomplete' | 'signature' | 'integrity' | 'identity' | 'unsigned-app' | 'system' | 'disk'
  /** Windows: the Store couldn't be asked, or its download/install didn't complete. */
  | 'store' | 'store-download';

/** Why the running app cannot be replaced by an update: running from a disk image, App Translocation, read-only folder. */
export type AppLocationProblem = 'disk-image' | 'translocated' | 'read-only';

export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'downloading'; version: string; received: number; total: number }
  | { kind: 'verifying'; version: string }
  /** Staged in ATELIER_HOME/updates/Atelier.app: the footer offers "Update ready · Restart". */
  | { kind: 'ready'; version: string; notes: string }
  /** A newer version that needs an atelierd restart (closes sessions): installed by hand from its release page. */
  | { kind: 'needs-restart'; version: string; notes: string }
  /** A newer version exists but this copy cannot replace itself where it runs: move it to Applications. */
  | { kind: 'location'; version: string; problem: AppLocationProblem }
  /** Windows: the Store has an update Atelier doesn't install itself (automatic updates off or metered, Windows before 24H2). */
  | { kind: 'store'; reason: 'no-silent' | 'windows' }
  | { kind: 'error'; error: UpdateErrorKind; message: string; version?: string };

export interface UpdateStatus {
  /** The updater can run here: a packaged build (or the tests' local feed). */
  available: boolean;
  /** The build's own channel (baked at release time); null for dev and stage-update builds. */
  buildChannel: UpdateChannel | null;
  /** The channel checked now (setting + build); null = updates off. */
  channel: UpdateChannel | null;
  version: string;
  lastCheck: number | null;
  phase: UpdatePhase;
  /** Release notes of the running version, when it came through the updater. */
  currentNotes: string | null;
}

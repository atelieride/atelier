// In-app updater. It ends exactly where
// `npm run stage-update` ends: a verified build in ATELIER_HOME/updates/Atelier.app, which UpdateWatcher (updates.ts)
// offers as "Update ready · Restart" and swaps on restart with the same gate (atelierd protocol, spawn-helper,
// signing identity).
//
// Flow: release list (useatelier.dev) → newest release of the channel → its latest-mac.yml + .sig → Ed25519 check with the
// embedded key → feed rules (version = tag, channel, newer, macOS, protocol, spawn-helper) → ZIP into updates/download
// with the signed size as cap → sha512 → `ditto -x -k` → `codesign --verify --deep --strict`, then the running app's
// designated requirement → the same gate as UpdateWatcher → staged with one rename.
// It writes only under ATELIER_HOME/updates; processes (ditto, codesign) come through deps.exec (updates-ipc.ts).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MAX_FEED_BYTES, MAX_NOTES, compareSemver, effectiveChannel, feedVerdict, parseFeed, parseReleaseList, parseSemver, pickRelease,
  systemVersionAtLeast, whatsNewDue, type AppLocationProblem, type ReleaseEntry, type UpdateChannel, type UpdateChannelSetting, type UpdateErrorKind,
  type UpdatePhase, type UpdateStatus
} from '@shared/update-feed';
import { verifyFeedSignature } from '@shared/update-sign.node';
import { ensureDir, writeFileAtomic } from '../daemon/fsutil';
import { activityParam, parseReported, periodKeys, withActivity, type PeriodKeys } from './update-activity';
import { DownloadError, httpGet, httpGetBuffer, updateAllow, type Opener } from './update-download';
import { ptyHelperHash, readStamp, updateUsable } from './updates';

/** Where releases are published, and how a file of a release is addressed. */
export interface FeedSource {
  releasesUrl: string;
  assetUrl(tag: string, name: string): string;
  pageUrl(tag: string): string;
  /** The list of releases, for a manual install (an update that failed or cannot install itself). */
  releasesPage: string;
  allow(u: URL): boolean;
}

/**
 * The endpoints of useatelier.dev (site/functions): the release list (the published
 * releases' tags, newest first), each file of a release (a redirect to where it is stored), the pages to install by
 * hand. Where the files live is the site's business: it can change without touching installed apps.
 */
function layout(root: string, allow: (u: URL) => boolean): FeedSource {
  return {
    releasesUrl: `${root}/updates/releases`,
    assetUrl: (tag, name) => `${root}/updates/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    pageUrl: (tag) => `${root}/releases/${encodeURIComponent(tag)}`,
    releasesPage: `${root}/releases`,
    allow
  };
}

export const SITE_SOURCE: FeedSource = layout('https://useatelier.dev', updateAllow);

/** Tests only (devEnv): the same layout served by a local server on 127.0.0.1. */
export function localSource(base: string): FeedSource | null {
  let b: URL;
  try { b = new URL(base); } catch { return null; }
  if (b.protocol !== 'http:' || b.hostname !== '127.0.0.1' || !b.port) return null;
  return layout(`http://127.0.0.1:${b.port}`, (u) => u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === b.port);
}

/** The channel CI baked into a release build's stamp (scripts/after-pack.cjs); null for dev and stage-update builds. */
export function buildChannelOf(appPath: string | null): UpdateChannel | null {
  if (!appPath) return null;
  const c = readJson(join(appPath, 'Contents/Resources/atelier-build.json'))?.channel;
  return c === 'stable' || c === 'beta' ? c : null;
}

const testUpdateSchema = z.object({
  feed: z.string().max(100).startsWith('http://127.0.0.1:'),
  app: z.string().max(4096).startsWith('/').endsWith('.app'),
  requirement: z.string().min(1).max(2000),
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  channel: z.enum(['stable', 'beta']).optional()
}).strict();
export type TestUpdate = z.infer<typeof testUpdateSchema>;

/**
 * ATELIER_TEST_UPDATE (devEnv, inert in the packaged app): the e2e points the updater at a local feed, with a fixture
 * app standing in for the running bundle, that fixture's ad-hoc identity as the requirement codesign checks against,
 * and the throwaway key the test signed the feed with.
 */
export function parseTestUpdate(raw: string | undefined): TestUpdate | null {
  if (!raw) return null;
  try { const r = testUpdateSchema.safeParse(JSON.parse(raw)); return r.success ? r.data : null; } catch { return null; }
}

export interface AutoUpdateDeps {
  /** ATELIER_HOME: the updater writes only in its `updates` folder. */
  home: string;
  /** Version of the running app. */
  version: string;
  /** atelierd protocol of the running app. */
  protocol: number;
  /** The running bundle (null outside a packaged app). */
  appPath: string | null;
  buildChannel: UpdateChannel | null;
  channelSetting(): UpdateChannelSetting;
  /** Packaged build (or the tests' local feed): otherwise the updater never checks. */
  available: boolean;
  source: FeedSource;
  /** Raw Ed25519 public keys (base64): the feed must be signed with one of them. */
  publicKeys: readonly string[];
  open: Opener;
  /** Runs a fixed command (ditto, codesign); rejects on a non-zero exit. */
  exec(cmd: string, args: string[]): Promise<string>;
  /** Designated requirement of the running app; null when ad-hoc or unsigned (no identity to compare with). */
  ownRequirement(): Promise<string | null>;
  /** macOS version, process.getSystemVersion(). */
  systemVersion: string;
  /** Why the running bundle could not be replaced (updates.ts appLocationProblem); null when it can. */
  appLocation(): AppLocationProblem | null;
  log(message: string): void;
  onStatus(s: UpdateStatus): void;
  now?(): number;
}

interface StagedMeta { version: string; notes: string; releaseDate: string; channel: UpdateChannel }

// 100 releases with their notes and asset lists stay well under this.
const LIST_CAP = 8 * 1024 * 1024;
const SIG_CAP = 1024;
const SMALL = { idleMs: 20_000, totalMs: 30_000 };
// The ZIP: no data for a minute means a dead connection; an hour covers slow lines.
const BIG = { idleMs: 60_000, totalMs: 60 * 60_000 };
/** Failures that are about the release itself: automatic checks keep the error instead of downloading it again. */
const STICKY = new Set<UpdateErrorKind>(['signature', 'integrity', 'identity', 'feed']);

class Failure extends Error {
  constructor(readonly kind: UpdateErrorKind, message: string) { super(message); }
}

/**
 * A file the release list promised that answers 404 or 5xx: the release is incomplete (asset deleted, half-published,
 * GitHub trouble), not "GitHub unreachable". Not sticky: the next check tries again.
 */
async function incomplete<T>(tag: string, name: string, p: Promise<T>): Promise<T> {
  try { return await p; } catch (err) {
    if (err instanceof DownloadError && err.kind === 'http' && err.status !== undefined && (err.status === 404 || err.status >= 500)) {
      throw new Failure('incomplete', `${name} of ${tag} answered HTTP ${err.status}`);
    }
    throw err;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bundleVersion(app: string): string | null {
  try {
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(app, 'Contents/Info.plist'), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

export class AutoUpdater {
  private phase: UpdatePhase = { kind: 'idle' };
  private lastCheck: number | null = null;
  private currentNotes: string | null = null;
  private whatsNew: { version: string; notes: string; since: string } | null = null;
  private running: Promise<UpdateStatus> | null = null;
  private failed = new Map<string, UpdatePhase>();
  private pageTag: string | null = null;
  private prevRun: string | null = null;
  /** The day, week and month the last successful check reported. */
  private reported: Partial<PeriodKeys> = {};
  private readonly dir: string;

  constructor(private readonly o: AutoUpdateDeps) {
    this.dir = join(o.home, 'updates');
  }

  private get staged(): string { return join(this.dir, 'Atelier.app'); }
  private get download(): string { return join(this.dir, 'download'); }
  private now(): number { return this.o.now ? this.o.now() : Date.now(); }

  status(): UpdateStatus {
    return {
      available: this.o.available, buildChannel: this.o.buildChannel, channel: effectiveChannel(this.o.channelSetting(), this.o.buildChannel),
      version: this.o.version, lastCheck: this.lastCheck, phase: this.phase, currentNotes: this.currentNotes
    };
  }

  /** The notes of the version this launch moved to, once (the first window shows the toast). */
  takeWhatsNew(): { version: string; notes: string; since: string } | null {
    const w = this.whatsNew;
    this.whatsNew = null;
    return w;
  }

  /**
   * Where to install by hand: the release of an update that needs an atelierd restart, otherwise the list of releases
   * (an update that failed, cannot replace this copy, or "Restart to Update" that could not apply).
   */
  releasePage(): string {
    return this.phase.kind === 'needs-restart' && this.pageTag ? this.o.source.pageUrl(this.pageTag) : this.o.source.releasesPage;
  }

  /** The version of the previous launch, as init() found it (null on the first launch with the updater). */
  lastRunVersion(): string | null { return this.prevRun; }

  /** Reads what the previous launches left: last run version ("What's new"), last check, a staged update. */
  init(): void {
    const state = readJson(join(this.dir, 'state.json'));
    const lastRun = typeof state?.lastRunVersion === 'string' ? state.lastRunVersion : null;
    this.prevRun = lastRun;
    if (typeof state?.lastCheck === 'number' && Number.isFinite(state.lastCheck)) this.lastCheck = state.lastCheck;
    this.reported = parseReported(state?.reported);
    const meta = this.readMeta();
    if (meta && meta.version === this.o.version) this.currentNotes = meta.notes;
    if (whatsNewDue(lastRun, this.o.version)) this.whatsNew = { version: this.o.version, notes: this.currentNotes ?? '', since: lastRun! };
    if (meta && compareSemver(meta.version, this.o.version) > 0 && this.stagedIs(meta.version)) this.phase = { kind: 'ready', version: meta.version, notes: meta.notes };
    this.saveState();
  }

  /** One check at a time; a second call gets the running one. */
  check(o: { manual: boolean }): Promise<UpdateStatus> {
    if (this.running) return this.running;
    this.running = this.run(o.manual).finally(() => { this.running = null; });
    return this.running;
  }

  private emit(): void { this.o.onStatus(this.status()); }
  private set(phase: UpdatePhase): void { this.phase = phase; this.emit(); }

  private readMeta(): StagedMeta | null {
    const m = readJson(join(this.dir, 'update.json'));
    if (!m || typeof m.version !== 'string' || !parseSemver(m.version) || typeof m.notes !== 'string' || m.notes.length > MAX_NOTES) return null;
    return { version: m.version, notes: m.notes, releaseDate: typeof m.releaseDate === 'string' ? m.releaseDate : '', channel: m.channel === 'beta' ? 'beta' : 'stable' };
  }

  private saveState(): void {
    try {
      ensureDir(this.dir, 0o700);
      writeFileAtomic(join(this.dir, 'state.json'), JSON.stringify({ lastRunVersion: this.o.version, lastCheck: this.lastCheck, reported: this.reported }) + '\n');
    } catch (err) {
      this.o.log(`could not save the update state: ${(err as Error).message}`);
    }
  }

  /** The staged build is that version and passes the gate UpdateWatcher applies before offering it. */
  private stagedIs(version: string): boolean {
    return existsSync(this.staged) && bundleVersion(this.staged) === version && this.gate(this.staged) === 'ok';
  }

  /** Same rules as UpdateWatcher.ready() and scripts/update-app.mjs: protocol, spawn-helper, newer build. */
  private gate(app: string): 'ok' | 'needs-restart' | 'not-newer' | 'no-stamp' {
    const stamp = readStamp(app);
    if (!stamp) return 'no-stamp';
    const own = this.o.appPath ? ptyHelperHash(this.o.appPath) : null;
    if (stamp.protocol !== this.o.protocol || own === null || ptyHelperHash(app) !== own) return 'needs-restart';
    return updateUsable({ own: this.o.appPath ? readStamp(this.o.appPath) : null, staged: stamp, protocol: this.o.protocol }) ? 'ok' : 'not-newer';
  }

  private async run(manual: boolean): Promise<UpdateStatus> {
    const channel = effectiveChannel(this.o.channelSetting(), this.o.buildChannel);
    if (!this.o.available || !channel) {
      if (this.phase.kind !== 'ready') this.set({ kind: 'idle' });
      return this.status();
    }
    this.set({ kind: 'checking' });
    this.lastCheck = this.now();
    this.saveState();
    let version: string | undefined;
    try {
      const keys = periodKeys(this.now());
      const list = await this.fetchList(withActivity(this.o.source.releasesUrl, activityParam(keys, this.reported)));
      // Reported once the list arrived: a failed check says it again next time.
      this.reported = keys;
      this.saveState();
      const rel = pickRelease(list, channel);
      if (!rel || compareSemver(rel.version, this.o.version) <= 0) {
        this.o.log(`update check (${channel}): up to date at ${this.o.version}`);
        this.set({ kind: 'up-to-date' });
        return this.status();
      }
      version = rel.version;
      const meta = this.readMeta();
      if (meta?.version === rel.version && this.stagedIs(rel.version)) {
        this.set({ kind: 'ready', version: meta.version, notes: meta.notes });
        return this.status();
      }
      const sticky = this.failed.get(rel.version);
      if (!manual && sticky) {
        this.set(sticky);
        return this.status();
      }
      await this.install(rel, channel);
    } catch (err) {
      const f = err instanceof Failure ? err
        : err instanceof DownloadError ? new Failure(err.kind === 'rate-limited' ? 'rate-limited' : 'network', err.message)
          : new Failure('disk', err instanceof Error ? err.message : String(err));
      this.o.log(`update check (${channel})${version ? ` for ${version}` : ''} failed [${f.kind}]: ${f.message}`);
      const phase: UpdatePhase = { kind: 'error', error: f.kind, message: f.message, ...(version ? { version } : {}) };
      if (version && STICKY.has(f.kind)) this.failed.set(version, phase);
      this.set(phase);
    } finally {
      try { rmSync(this.download, { recursive: true, force: true }); } catch { /* next run cleans it */ }
    }
    return this.status();
  }

  private async fetchList(url: string): Promise<ReleaseEntry[]> {
    const buf = await httpGetBuffer(this.o.open, url, { allow: (u) => this.o.source.allow(u), maxBytes: LIST_CAP, ...SMALL });
    let json: unknown;
    try { json = JSON.parse(buf.toString('utf8')); } catch { throw new Failure('network', 'the release list is not JSON'); }
    return parseReleaseList(json);
  }

  private async install(rel: ReleaseEntry, channel: UpdateChannel): Promise<void> {
    const get = (name: string, maxBytes: number) => incomplete(rel.tag, name, httpGetBuffer(this.o.open, this.o.source.assetUrl(rel.tag, name), { allow: (u) => this.o.source.allow(u), maxBytes, ...SMALL }));
    const yml = await get('latest-mac.yml', MAX_FEED_BYTES);
    const sig = await get('latest-mac.yml.sig', SIG_CAP);
    if (!verifyFeedSignature(yml, sig.toString('utf8'), this.o.publicKeys)) throw new Failure('signature', `the feed of ${rel.tag} is not signed with the Atelier release key`);
    const parsed = parseFeed(yml.toString('utf8'));
    if (!parsed.ok) throw new Failure('feed', `the feed of ${rel.tag} is malformed (${parsed.error})`);
    const feed = parsed.feed;
    if (feed.version !== rel.version) throw new Failure('feed', `the feed of ${rel.tag} names version ${feed.version}`);
    const verdict = feedVerdict(feed, { channel, current: this.o.version });
    if (verdict === 'wrong-channel') throw new Failure('feed', `${feed.version} is a ${feed.channel} release, not for the ${channel} channel`);
    if (verdict === 'not-newer') { this.set({ kind: 'up-to-date' }); return; }
    if (!systemVersionAtLeast(this.o.systemVersion, feed.minimumSystemVersion)) throw new Failure('system', `${feed.version} needs macOS ${feed.minimumSystemVersion} or later`);
    const ownHelper = this.o.appPath ? ptyHelperHash(this.o.appPath) : null;
    if (feed.protocol !== this.o.protocol || ownHelper === null || feed.spawnHelper !== ownHelper) {
      this.needsRestart(rel.tag, feed.version, feed.notes, feed.protocol !== this.o.protocol ? `atelierd protocol ${feed.protocol}` : 'a different spawn-helper');
      return;
    }
    const req = await this.o.ownRequirement();
    if (!req) throw new Failure('unsigned-app', 'this copy of Atelier has no certificate signature to compare the update with');
    // Downloading is pointless if "Restart to Update" could never swap this bundle.
    const where = this.o.appLocation();
    if (where) {
      this.o.log(`update ${feed.version} not downloaded: this copy cannot be replaced where it runs (${where})`);
      this.set({ kind: 'location', version: feed.version, problem: where });
      return;
    }

    // Download, with the signed size as the cap and the signed sha512 as the check.
    ensureDir(this.dir, 0o700);
    rmSync(this.download, { recursive: true, force: true });
    ensureDir(this.download, 0o700);
    const zip = join(this.download, feed.path);
    const hash = createHash('sha512');
    const fd = openSync(zip, 'w', 0o600);
    let last = 0;
    this.set({ kind: 'downloading', version: feed.version, received: 0, total: feed.size });
    let bytes = 0;
    try {
      ({ bytes } = await incomplete(rel.tag, feed.path, httpGet(this.o.open, this.o.source.assetUrl(rel.tag, feed.path), {
        allow: (u) => this.o.source.allow(u), maxBytes: feed.size, ...BIG,
        onData: (c) => { hash.update(c); writeAll(fd, c); },
        onProgress: (received) => {
          const t = performance.now();
          if (received < feed.size && t - last < 200) return;
          last = t;
          this.set({ kind: 'downloading', version: feed.version, received, total: feed.size });
        }
      })));
    } catch (err) {
      if (err instanceof DownloadError && err.kind === 'too-large') throw new Failure('integrity', `the download of ${feed.version} is larger than its signed size`);
      throw err;
    } finally {
      closeSync(fd);
    }
    if (bytes !== feed.size) throw new Failure('integrity', `the download of ${feed.version} has ${bytes} bytes, the feed says ${feed.size}`);
    if (hash.digest('base64') !== feed.sha512) throw new Failure('integrity', `the download of ${feed.version} does not match its signed sha512`);

    // Extract and verify the bundle.
    this.set({ kind: 'verifying', version: feed.version });
    const out = mkdtempSync(join(this.download, 'x-'));
    try { await this.o.exec('/usr/bin/ditto', ['-x', '-k', zip, out]); } catch (err) { throw new Failure('integrity', `the download of ${feed.version} could not be extracted: ${(err as Error).message}`); }
    const entries = readdirSync(out);
    const app = join(out, 'Atelier.app');
    if (entries.length !== 1 || entries[0] !== 'Atelier.app' || !lstatSync(app).isDirectory()) throw new Failure('integrity', `the download of ${feed.version} does not contain just Atelier.app`);
    if (bundleVersion(app) !== feed.version) throw new Failure('integrity', `the downloaded app is not version ${feed.version}`);
    try { await this.o.exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]); } catch (err) { throw new Failure('integrity', `the code signature of ${feed.version} is broken: ${(err as Error).message}`); }
    try { await this.o.exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${req}`, app]); } catch {
      throw new Failure('identity', `${feed.version} is not signed with the same identity as this app`);
    }
    const gate = this.gate(app);
    if (gate === 'needs-restart') { this.needsRestart(rel.tag, feed.version, feed.notes, 'its bundle'); return; }
    if (gate === 'no-stamp') throw new Failure('integrity', `the downloaded app has no build stamp`);
    if (gate === 'not-newer') throw new Failure('feed', `the build of ${feed.version} is not newer than this one`);

    // Stage: notes first, then the one rename UpdateWatcher reacts to.
    writeFileAtomic(join(this.dir, 'update.json'), JSON.stringify({ version: feed.version, notes: feed.notes, releaseDate: feed.releaseDate, channel: feed.channel } satisfies StagedMeta) + '\n');
    rmSync(this.staged, { recursive: true, force: true });
    renameSync(app, this.staged);
    this.failed.delete(feed.version);
    this.o.log(`update ${feed.version} (${channel}) verified and staged`);
    this.set({ kind: 'ready', version: feed.version, notes: feed.notes });
  }

  private needsRestart(tag: string, version: string, notes: string, why: string): void {
    this.pageTag = tag;
    this.o.log(`update ${version} needs an atelierd restart (${why}): offered by hand`);
    this.set({ kind: 'needs-restart', version, notes });
  }
}

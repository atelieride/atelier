import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, toOut } from '../cpath';
import { isBelow, isInside, isRepoRel } from '@shared/paths';
import type { RepoStatus } from '@shared/git';
import { DIFF_GUARDS as GUARDS, SHOW_GUARDS, runGit } from './exec';
import { parseNumstat, parseStatusV2 } from './parse';
import { gitReadLimiter, type ReadLimiter } from './read-limiter';
const MAX_COUNT_BYTES = 5 * 1024 * 1024;

/** Line count of an untracked file (null if binary or too large). Async: does not block the main process. */
async function countLines(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > MAX_COUNT_BYTES) return null;
    const fh = await open(path, 'r');
    try {
      const buf = await fh.readFile();
      if (buf.subarray(0, 8192).includes(0)) return null;
      if (buf.length === 0) return 0;
      // Newlines counted on the bytes (UTF-8 never has 0x0a inside a character): no string of up to 5 MB per file,
      // per status, in the main process.
      let n = 0;
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
      return buf[buf.length - 1] === 10 ? n : n + 1;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

// Beyond these limits the list is truncated: a not-yet-ignored node_modules would produce tens of thousands of lines.
const MAX_CHANGES = 2000;
const MAX_COUNTED_UNTRACKED = 300;

async function hasHead(repo: string): Promise<boolean> {
  try { await runGit(repo, ['rev-parse', '--verify', '-q', 'HEAD']); return true; } catch { return false; }
}

export async function readRepoStatus(repo: string): Promise<RepoStatus> {
  const name = basename(repo);
  const checkedAt = Date.now();
  try {
    // A large repository under load (fsmonitor is off) can pass the 10 s default: its changes would vanish meanwhile.
    const out = await runGit(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { timeoutMs: 30_000 });
    const st = parseStatusV2(out, repo);
    const numArgs = (await hasHead(repo)) ? ['diff', ...GUARDS, '--numstat', '-z', 'HEAD'] : ['diff', ...GUARDS, '--numstat', '-z', '--cached'];
    // Line counts are extra: a numstat that fails or times out (a huge generated file, an object missing) leaves them
    // unknown, never the repository's changes gone with them.
    const counts = parseNumstat(await runGit(repo, numArgs).catch(() => ''));
    // Tracked files first, then untracked; truncate beyond the limit.
    const ordered = [...st.changes.filter((c) => c.kind !== '?'), ...st.changes.filter((c) => c.kind === '?')];
    const kept = ordered.slice(0, MAX_CHANGES);
    let counted = 0;
    for (const c of kept) {
      if (c.kind === '?') {
        c.removed = 0;
        if (counted++ < MAX_COUNTED_UNTRACKED) c.added = await countLines(join(repo, c.rel));
        continue;
      }
      const n = counts.get(c.rel);
      if (n) { c.added = n.added; c.removed = n.removed; }
    }
    return { root: repo, name, ...st, changes: kept, checkedAt, truncated: ordered.length - kept.length };
  } catch (err) {
    return { root: repo, name, branch: null, detached: false, ahead: 0, behind: 0, oid: null, changes: [], checkedAt, truncated: 0, error: (err as Error).message };
  }
}

export async function readHeadContent(repo: string, rel: string): Promise<string | null> {
  if (!isRepoRel(rel)) return null;
  try {
    return await runGit(repo, ['show', ...SHOW_GUARDS, `HEAD:${rel}`]);
  } catch {
    return null;
  }
}

/**
 * One refresh at a time per repo; requests made while one is running collapse into a single follow-up. Reads wait for
 * a slot of the limiter shared by every repository: `bulk` ones (a whole project refreshed) after the others. `soon`
 * (after an Atelier git write, the user waiting on a click) skips the spacing between reads and the limiter's queue,
 * never the one-at-a-time.
 */
export class StatusScheduler {
  /** A read asked for: waiting for a slot ('queued', with its level) or under way ('started'). */
  private running = new Map<string, 'live' | 'bulk' | 'started'>();
  /** A follow-up asked during a read: true while every request for it was bulk (then it reads as bulk). */
  private queued = new Map<string, boolean>();
  private queuedSoon = new Set<string>();
  private lastStart = new Map<string, number>();
  private waiting = new Map<string, { timer: NodeJS.Timeout; bulk: boolean }>();
  private listeners: ((s: RepoStatus) => void)[] = [];

  /** minIntervalMs: minimum time between the starts of two reads of the same repo (no bursts of git status). */
  constructor(private readonly read: (repo: string) => Promise<RepoStatus> = readRepoStatus, private readonly minIntervalMs = 1000,
    private readonly limiter: ReadLimiter = gitReadLimiter) {}

  onResult(cb: (s: RepoStatus) => void): void { this.listeners.push(cb); }

  request(repo: string, o: { soon?: boolean; bulk?: boolean } = {}): void {
    const state = this.running.get(repo);
    if (state === 'started') {
      this.queued.set(repo, (this.queued.get(repo) ?? true) && !!o.bulk);
      if (o.soon) this.queuedSoon.add(repo);
      return;
    }
    // Still waiting for a slot: it reads after this request anyway, only sooner if asked.
    if (state) {
      if (o.soon) this.limiter.promote(repo, 'now');
      else if (!o.bulk && state === 'bulk') { this.running.set(repo, 'live'); this.limiter.promote(repo, 'live'); }
      return;
    }
    const spaced = this.waiting.get(repo);
    if (spaced) {
      // A live request keeps the spacing but no longer waits behind bulk reads once it is over.
      if (!o.soon) { if (!o.bulk) spaced.bulk = false; return; }
      clearTimeout(spaced.timer);
      this.waiting.delete(repo);
    }
    const bulk = !o.soon && !!o.bulk;
    const wait = o.soon ? 0 : (this.lastStart.get(repo) ?? -Infinity) + this.minIntervalMs - Date.now();
    if (wait > 0) {
      const entry = { timer: setTimeout(() => { this.waiting.delete(repo); this.request(repo, { bulk: entry.bulk }); }, wait), bulk };
      this.waiting.set(repo, entry);
      return;
    }
    const start = () => {
      this.running.set(repo, 'started');
      this.lastStart.set(repo, Date.now());
      return this.read(repo);
    };
    this.running.set(repo, bulk ? 'bulk' : 'live');
    const reading = o.soon ? start() : this.limiter.run(bulk ? 'bulk' : 'live', start, repo);
    void reading.then((s) => {
      for (const l of this.listeners) l(s);
    }, () => { /* a failed read: the next request reads again */ }).finally(() => {
      this.running.delete(repo);
      const soon = this.queuedSoon.delete(repo);
      const followUp = this.queued.get(repo);
      if (followUp === undefined) return;
      this.queued.delete(repo);
      this.request(repo, { soon, bulk: followUp });
    });
  }

  /** A repository gone from every project: its spacing goes (back later, it is read at once). */
  forget(repo: string): void {
    this.lastStart.delete(repo);
    const spaced = this.waiting.get(repo);
    if (spaced) { clearTimeout(spaced.timer); this.waiting.delete(repo); }
  }
}

const MAX_INDEX = 50000;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.next', 'coverage', '.turbo', '.cache']);

/** Files of a repo for ⌘K: tracked plus untracked non-ignored; null when git won't read it (safe.directory, a broken .git). */
export async function listRepoFiles(repo: string): Promise<string[] | null> {
  try {
    return (await runGit(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean).slice(0, MAX_INDEX);
  } catch {
    return null;
  }
}

/** Index of all project files: repos via ls-files, the rest via a bounded walk (no hidden files or build folders). */
export async function buildFileIndex(root: string, repos: string[]): Promise<{ path: string; rel: string }[]> {
  const out: { path: string; rel: string }[] = [];
  const relOf = (p: string) => p.slice(root.length + 1);
  // Repos git won't read: walked like folders below, so their files can still be found.
  const unread: string[] = [];
  for (const r of repos) {
    // A repo reached through a symlink to outside the project: its files cannot be opened (insideProject).
    if (!isInside(root, r)) continue;
    const listed = await listRepoFiles(r);
    if (!listed) { unread.push(r); continue; }
    // A nested repo lists its own files: the outer repo's files that sit inside a nested one are skipped. Only the
    // repos inside this one are looked at (with hundreds of repos found, checking every one per file adds up).
    const inner = repos.filter((o) => o !== r && isBelow(r, o));
    for (const f of listed) {
      const p = join(r, f);
      if (inner.length && inner.some((o) => isBelow(o, p))) continue;
      out.push({ path: p, rel: relOf(p) });
      if (out.length >= MAX_INDEX) return out;
    }
  }
  const repoSet = new Set(repos);
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || out.length >= 20000) return;
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const n of names.sort()) {
      if (n.startsWith('.') || SKIP_DIRS.has(n)) continue;
      const p = join(dir, n);
      let st;
      try { st = await stat(p); } catch { continue; }
      // Repos have their own listing; a symlink to a repo is compared by its real path.
      if (st.isDirectory()) { if (!repoSet.has(p) && !repoSet.has(await realpath(p).then(toOut, () => p))) await walk(p, depth + 1); }
      else if (st.isFile()) out.push({ path: p, rel: relOf(p) });
    }
  };
  if (!repoSet.has(root)) await walk(root, 0);
  for (const r of unread) await walk(r, r === root ? 0 : 1);
  return out;
}

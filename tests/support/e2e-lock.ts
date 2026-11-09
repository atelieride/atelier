// One e2e run at a time on this Mac: several sessions, each in its own worktree, used to start
// the suite together and fight for the CPU (slower runs, load flakes). The lock is a file in the git common dir, shared
// by the checkout and every worktree, inside the repo: never in the system temp, never outside the repo.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export interface LockInfo { pid: number; startedAt: number; cwd: string; what: string }

export interface LockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  isAlive?: (pid: number) => boolean;
  /** Age in ms of the lock file (an unreadable one may still be being written). */
  fileAge?: (path: string) => number;
  /** The main checkout, to name where the holder runs. */
  root?: string;
  /** Tests: runs under the guard, before the lock is read again. */
  beforeStaleRemoval?: () => void;
}

const POLL_MS = 1000;
const SAY_EVERY_MS = 30_000;
/** writeFileSync writes the whole JSON at once: a lock still unreadable after this is a leftover. */
const UNREADABLE_MS = 5000;
/** A removal guard this old belongs to a waiter that died inside it (the removal itself takes microseconds). */
const GUARD_MS = 10_000;

/** `<git common dir>/atelier-e2e.lock`, or null when `cwd` isn't in a git checkout. */
export function lockFile(cwd: string): string | null {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return resolve(cwd, dir, 'atelier-e2e.lock');
  } catch {
    return null;
  }
}

/** The main checkout of `cwd` (the common dir's parent), to name places relative to it. */
export function checkoutRoot(lock: string): string {
  return resolve(lock, '../..');
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function read(path: string): LockInfo | 'missing' | 'unreadable' {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return 'missing'; }
  try {
    const v = JSON.parse(text) as LockInfo;
    return Number.isInteger(v.pid) ? v : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function place(cwd: string, root: string | undefined): string {
  const rel = root ? relative(root, cwd).split(sep).join('/') : cwd;
  return rel === '' ? 'the main checkout' : rel.startsWith('..') ? cwd : rel;
}

function age(ms: number): string {
  const min = Math.floor(ms / 60_000);
  return min < 1 ? 'less than a minute ago' : `${min} min ago`;
}

/** Waits until the lock is free, then takes it for `info.pid`. A lock whose pid is gone is removed (stale). */
export async function takeLock(path: string, info: LockInfo, o: LockOptions = {}): Promise<void> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? ((l: string) => console.log(l));
  const isAlive = o.isAlive ?? pidAlive;
  const fileAge = o.fileAge ?? ((p: string) => { try { return Date.now() - statSync(p).mtimeMs; } catch { return 0; } });
  let lastSaid = -Infinity;
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify(info), { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const held = read(path);
    if (held === 'missing') continue; // released meanwhile
    // A dead lock is removed under an exclusive guard and read again inside it: two waiters that saw the same stale
    // lock must not both remove "it" (the second would remove the first one's fresh lock).
    const removeIf = (still: (again: ReturnType<typeof read>) => boolean, line: string): 'done' | 'busy' => {
      const guard = `${path}.stale`;
      try {
        writeFileSync(guard, String(info.pid), { flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (fileAge(guard) > GUARD_MS) rmSync(guard, { force: true });
        return 'busy';
      }
      try {
        o.beforeStaleRemoval?.();
        if (still(read(path))) {
          rmSync(path, { force: true });
          log(line);
        }
      } finally {
        rmSync(guard, { force: true });
      }
      return 'done';
    };
    if (held === 'unreadable') {
      const stillLeftover = (a: ReturnType<typeof read>) => a === 'unreadable' && fileAge(path) > UNREADABLE_MS;
      if (fileAge(path) > UNREADABLE_MS && removeIf(stillLeftover, 'Removed an unreadable e2e lock.') === 'done') continue;
    } else if (held.pid === info.pid) {
      return; // ours already
    } else if (!isAlive(held.pid)) {
      const same = (a: ReturnType<typeof read>) => JSON.stringify(a) === JSON.stringify(held);
      if (removeIf(same, `Removed a stale e2e lock: pid ${held.pid} (started in ${place(held.cwd, o.root)}) is gone.`) === 'done') continue;
    } else if (now() - lastSaid >= SAY_EVERY_MS) {
      log(`Waiting for the e2e run started ${age(now() - held.startedAt)} in ${place(held.cwd, o.root)} (pid ${held.pid})…`);
      lastSaid = now();
    }
    await sleep(POLL_MS);
  }
}

/** Releases the lock if `pid` holds it; true when it did. */
export function releaseLock(path: string, pid: number): boolean {
  const held = read(path);
  if (held === 'missing' || held === 'unreadable' || held.pid !== pid) return false;
  rmSync(path, { force: true });
  return true;
}

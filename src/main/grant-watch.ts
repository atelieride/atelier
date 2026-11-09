import { lstatSync, watch } from 'node:fs';

// Files outside a project open in its tabs: changes on disk reload them like project files.
// One watcher per file, never its folder: watching `~/Downloads` reads as access to all of it, and macOS asks for
// permission although the user gave only one file. An atomic save by another editor replaces the inode, which a file
// watcher sees as `rename`: the watcher is armed again on the same path.

export type WatchEvent = 'change' | 'rename';

export interface GrantWatchDeps {
  /** Throws when the file can't be watched (missing, unreadable). onError: the watcher died. */
  watch(file: string, onEvent: (ev: WatchEvent) => void, onError?: () => void): () => void;
  /** The changed files of a project (sent to its windows as ev:fs-changed). */
  send(root: string, paths: string[]): void;
  debounceMs?: number;
  /** A file replaced or gone: how often and how many times to try watching its path again. */
  retryMs?: number;
  retries?: number;
}

/** lost: replaced, gone or never watched; the next successful arm means content to report. */
interface Entry { stop: (() => void) | null; retry: ReturnType<typeof setTimeout> | null; tries: number; lost: boolean }
interface Root { files: Map<string, Entry>; pending: Set<string>; timer: ReturnType<typeof setTimeout> | null }

export const nodeWatch: GrantWatchDeps['watch'] = (file, onEvent, onError) => {
  // A regular file only: never a folder (all of it), never a link swapped in after the grant (what it points to).
  if (!lstatSync(file).isFile()) throw new Error(`not a file: ${file}`);
  const w = watch(file, { persistent: false }, (ev) => onEvent(ev === 'rename' ? 'rename' : 'change'));
  w.on('error', () => { w.close(); onError?.(); });
  return () => w.close();
};

export class GrantWatch {
  private readonly roots = new Map<string, Root>();

  constructor(private readonly deps: GrantWatchDeps) {}

  /** The outside files open in a project's tabs now (real paths). */
  update(root: string, files: string[]): void {
    const want = new Set(files);
    const r = this.roots.get(root) ?? { files: new Map<string, Entry>(), pending: new Set<string>(), timer: null };
    for (const [f, e] of r.files) {
      if (!want.has(f)) { this.stop(e); r.files.delete(f); r.pending.delete(f); }
    }
    for (const f of want) {
      const e = r.files.get(f) ?? { stop: null, retry: null, tries: 0, lost: false };
      r.files.set(f, e);
      // Not watched (new, or gone for good after its retries): try now; one that came back is reported.
      if (!e.stop && !e.retry) this.arm(root, r, f, e, true);
    }
    if (r.files.size) this.roots.set(root, r);
    else { if (r.timer) clearTimeout(r.timer); this.roots.delete(root); }
  }

  close(root: string): void {
    const r = this.roots.get(root);
    if (!r) return;
    for (const e of r.files.values()) this.stop(e);
    if (r.timer) clearTimeout(r.timer);
    this.roots.delete(root);
  }

  dispose(): void {
    for (const root of [...this.roots.keys()]) this.close(root);
  }

  private stop(e: Entry): void {
    e.stop?.();
    e.stop = null;
    if (e.retry) clearTimeout(e.retry);
    e.retry = null;
  }

  /** Watches the file; `announce`: a file that was lost is reported (its content changed meanwhile). */
  private arm(root: string, r: Root, f: string, e: Entry, announce: boolean): boolean {
    let mine: (() => void) | null = null;
    // Only this arm's watcher counts: a late event from one already replaced is ignored.
    const current = () => r.files.get(f) === e && e.stop !== null && e.stop === mine;
    const lost = () => {
      if (!current()) return;
      this.stop(e);
      e.tries = 0;
      e.lost = true;
      this.report(root, r, f);
    };
    try {
      mine = this.deps.watch(f, (ev) => { if (ev === 'rename') lost(); else if (current()) this.report(root, r, f); }, lost);
    } catch {
      e.lost = true;
      return false;
    }
    e.stop = mine;
    e.tries = 0;
    const was = e.lost;
    e.lost = false;
    if (announce && was) this.report(root, r, f);
    return true;
  }

  private report(root: string, r: Root, f: string): void {
    r.pending.add(f);
    if (r.timer) return;
    r.timer = setTimeout(() => this.flush(root, r), this.deps.debounceMs ?? 150);
  }

  private flush(root: string, r: Root): void {
    r.timer = null;
    const paths = [...r.pending];
    r.pending.clear();
    if (this.roots.get(root) !== r) return;
    // Files lost since the last report: watched again on the same path (the new inode of an atomic save).
    for (const f of paths) {
      const e = r.files.get(f);
      // Already in this report: not announced again.
      if (e && !e.stop && !e.retry && !this.arm(root, r, f, e, false)) this.retry(root, r, f, e);
    }
    if (paths.length) this.deps.send(root, paths);
  }

  private retry(root: string, r: Root, f: string, e: Entry): void {
    if (e.tries >= (this.deps.retries ?? 5)) return;
    e.tries++;
    e.retry = setTimeout(() => {
      e.retry = null;
      if (r.files.get(f) !== e || e.stop) return;
      if (!this.arm(root, r, f, e, true)) this.retry(root, r, f, e);
    }, this.deps.retryMs ?? 200);
  }
}

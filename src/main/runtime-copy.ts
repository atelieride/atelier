import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renameWithRetry } from '../daemon/fsutil';

// atelierd's runtime copy on Windows: a running atelierd and its
// terminals hold the files they run from (Atelier.exe, its DLLs, node-pty's ConPTY binaries). Run from the Store
// package, they would block every update or be closed by it; run from a copy outside the package, one per daemon
// fingerprint, they survive updates and Task Manager's "End task" on the app.

const COMPLETE = '.complete';
/** A temporary copy older than this belongs to an app that died while copying. */
const STALE_TMP_MS = 3600_000;

/**
 * `root/<fp>`, copied from `src` the first time (to `<fp>.tmp-<pid>`, marked complete, then renamed into place: a
 * daemon never starts from half a copy). An existing complete copy is used as it is, as long as it still has every
 * `keyFiles` (relative paths) the package has: an antivirus may have quarantined one since (the bridge), and a copy
 * without it is rebuilt. It is moved aside first, never deleted in place: one a process still runs from can't be moved
 * on Windows, and the error is thrown (the caller starts atelierd from the package).
 */
export function ensureRuntime(
  src: string, root: string, fp: string, fs: { rename: (from: string, to: string) => void } = { rename: renameSync },
  keyFiles: readonly string[] = []
): string {
  const dst = join(root, fp);
  if (existsSync(join(dst, COMPLETE))) {
    const lost = keyFiles.filter((f) => existsSync(join(src, f)) && !existsSync(join(dst, f)));
    if (lost.length === 0) return dst;
    const aside = `${dst}.del-${process.pid}`;
    fs.rename(dst, aside);
    // What can't be removed now goes at a later prune (a .del- folder).
    try { rmSync(aside, { recursive: true, force: true }); } catch { /* left for pruneRuntimes */ }
  }
  const tmp = `${dst}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(src, tmp, { recursive: true });
  writeFileSync(join(tmp, COMPLETE), fp);
  // A half copy from a crash midway goes.
  rmSync(dst, { recursive: true, force: true });
  try {
    // An antivirus or the indexer may hold a file just written for a moment: retried before giving up the copy.
    renameWithRetry(tmp, dst, fs.rename);
  } catch (e) {
    // Another Atelier window finished the same copy first: use it.
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(join(dst, COMPLETE))) throw e;
  }
  return dst;
}

/**
 * Removes the copies in `root` that no one keeps (the live daemon's, this app's), and temporary copies left by an
 * app that died while copying. Each copy is first moved aside: Windows refuses to move a folder whose files a process
 * holds, so a copy still in use (an older atelierd of this home) is left whole, never half deleted.
 */
export function pruneRuntimes(root: string, keep: readonly string[], fs: { rename: (from: string, to: string) => void } = { rename: renameSync }): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (keep.includes(name)) continue;
    const dir = join(root, name);
    try {
      // Moved aside by an earlier prune whose removal was cut short.
      if (name.includes('.del-')) { rmSync(dir, { recursive: true, force: true }); continue; }
      if (name.includes('.tmp-')) {
        if (Date.now() - statSync(dir).mtimeMs > STALE_TMP_MS) rmSync(dir, { recursive: true, force: true });
        continue;
      }
      const aside = `${dir}.del-${process.pid}`;
      fs.rename(dir, aside);
      rmSync(aside, { recursive: true, force: true });
    } catch { /* in use, or gone meanwhile: left for a later start */ }
  }
}

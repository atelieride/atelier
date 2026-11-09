import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A private temp root per test run (vitest and Playwright global setup): every mkdtemp under os.tmpdir() in the run
 * (tests, forks workers, Electron, atelierd, shells: all started afterwards, all inheriting TMPDIR) lands in
 * `<system temp>/atl-run-XXXXXX/`, which the global teardown removes. No test has to clean up after itself, and two
 * concurrent runs (another session may run the suite at the same time) never touch each other's files.
 */

const RUN_PREFIX = 'atl-run-';
const RUN_NAME = /^atl-run-[A-Za-z0-9]{6}$/;
/** An interrupted run (Ctrl-C, crash) leaves its root behind: swept by a later run once surely not live any more. */
const STALE_MS = 24 * 3600_000;

/**
 * The variables os.tmpdir() reads, at every call: TMPDIR on macOS and Linux; TEMP and TMP on Windows (TMPDIR is
 * ignored there, so the run root would silently not apply).
 */
export const TEMP_VARS: readonly string[] = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR'];

/**
 * The base as the run uses it. Windows: the system temp can be an 8.3 short name (GitHub's runner:
 * `C:\Users\RUNNER~1\…`) while real paths (realpath, git) use the long one, so the root takes the long form.
 */
function baseOf(base: string): string {
  if (process.platform !== 'win32') return resolve(base);
  try { return realpathSync.native(base); } catch { return resolve(base); }
}

/** Creates `<base>/atl-run-XXXXXX`, points os.tmpdir() at it (TEMP_VARS) and returns it. */
export function createRunTemp(base: string = tmpdir()): string {
  const root = baseOf(base);
  sweepStale(root);
  const dir = mkdtempSync(join(root, RUN_PREFIX));
  for (const v of TEMP_VARS) process.env[v] = dir;
  return dir;
}

/**
 * Removes a run root made by createRunTemp(base). Refuses (throws) anything else: a path that is not a direct child of
 * `base`, not named atl-run-XXXXXX, or a symlink. Symlinks inside are removed, never followed. Gone already: no-op.
 */
export function removeRunTemp(dir: string, base: string): void {
  const abs = resolve(dir);
  if (dirname(abs) !== baseOf(base) || !RUN_NAME.test(basename(abs))) {
    throw new Error(`removeRunTemp refuses ${abs}: not an atl-run-XXXXXX dir directly under ${baseOf(base)}`);
  }
  let st;
  try { st = lstatSync(abs); } catch { return; }
  if (!st.isDirectory()) throw new Error(`removeRunTemp refuses ${abs}: not a real directory (symlink or file)`);
  rmSync(abs, { recursive: true, force: true });
}

function sweepStale(base: string): void {
  let names: string[];
  try { names = readdirSync(base); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const dir = join(base, name);
    try {
      const st = lstatSync(dir);
      if (st.isDirectory() && now - st.mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true });
    } catch { /* gone meanwhile (a concurrent run swept it) or unreadable: leave it */ }
  }
}

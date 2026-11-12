import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, toOut } from '../cpath';
import { isBelow, isInside, samePath } from '@shared/paths';
import { pathStyle } from '@shared/platform';
import { DEFAULT_HIDDEN } from '../fs/files';
import { GitTooLarge, runGit } from '../git/exec';

/** One file a search covers. `ignored` files are listed only when the search asks for them, after all the others. */
export interface ListedFile { path: string; rel: string; ignored: boolean }

/** Tracked plus untracked files that are not ignored. */
export const LS_ARGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
/** Every ignored file, one by one (not folded into folders). */
export const LS_IGNORED_FILES_ARGS = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'];

/** Largest listing git may print for one repository (a repository with hundreds of thousands of files). */
const LS_MAX_BYTES = 128 * 1024 * 1024;

const byRel = (a: ListedFile, b: ListedFile): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/** The key two spellings of one path share: Windows paths compare without case. */
const keyOf = (p: string): string => (pathStyle() === 'win32' ? p.toLowerCase() : p);

function real(p: string): string | null {
  try { return toOut(realpathSync(p)); } catch { return null; }
}

type Listing = { ok: true; paths: string[] } | { ok: false; tooLarge: boolean };

async function lsFiles(repo: string, args: string[], maxBytes: number): Promise<Listing> {
  try {
    return { ok: true, paths: (await runGit(repo, args, { maxBytes })).split('\0').filter(Boolean) };
  } catch (e) {
    return { ok: false, tooLarge: e instanceof GitTooLarge };
  }
}

/**
 * The files a search covers, in order: the non-ignored ones sorted by relative path, then the ignored ones the same
 * way. Files of a git repository come from git (a nested repository lists its own files, once); folders outside any
 * repository, and repositories git will not read, are walked. The filter applies before the cap, and the cap never
 * cuts a non-ignored file while an ignored one is listed: ignored files are only collected while they can still fit.
 *
 * Which ignored files survive a cap is the listing order (git's, repository by repository). A capped walk of a folder
 * outside any repository stops in its own depth-first order (names sorted at each level), not in global path order.
 * An ignored listing git cannot print in full (past `ignoredMaxBytes`) is left out and the result reports `capped`:
 * it never turns the repository into a walked one, which would swap git's ignore rules for the walk's.
 */
export async function listSearchFiles(
  root: string,
  repos: string[],
  o: { includeIgnored: boolean; cap: number; filter: (rel: string) => boolean; ignoredMaxBytes?: number },
): Promise<{ files: ListedFile[]; capped: boolean }> {
  const relOf = (p: string): string => p.slice(root.length + 1);
  const plain: ListedFile[] = [];
  const ignoredFiles: ListedFile[] = [];
  const seen = new Set<string>();
  let incomplete = false;
  // Ignored files come after every other one: more than `cap` of them can never be shown.
  const ignoredFull = (): boolean => ignoredFiles.length > o.cap;
  const add = (p: string, ignored: boolean): void => {
    if (ignored && ignoredFull()) return;
    const rel = relOf(p);
    if (!o.filter(rel)) return;
    const key = keyOf(rel);
    if (seen.has(key)) return;
    seen.add(key);
    (ignored ? ignoredFiles : plain).push({ path: p, rel, ignored });
  };

  const rootReal = real(root);
  const unread: string[] = [];
  for (const r of repos) {
    // A repository reached through a symlink to outside the project: its files cannot be opened.
    if (!isInside(root, r)) continue;
    const listed = await lsFiles(r, LS_ARGS, LS_MAX_BYTES);
    if (!listed.ok) { unread.push(r); continue; }
    const inner = repos.filter((x) => !samePath(x, r) && isBelow(r, x));
    const keep = (f: string): string | null => {
      // A nested repository shows up as a folder entry (a gitlink or an untracked repo): its files are its own.
      if (f.endsWith('/')) return null;
      const p = join(r, f);
      return inner.some((x) => isInside(x, p)) ? null : p;
    };
    for (const f of listed.paths) { const p = keep(f); if (p) add(p, false); }
    if (!o.includeIgnored) continue;
    const ignored = await lsFiles(r, LS_IGNORED_FILES_ARGS, o.ignoredMaxBytes ?? LS_MAX_BYTES);
    if (!ignored.ok) { incomplete = true; continue; }
    for (const f of ignored.paths) {
      if (ignoredFull()) break;
      const p = keep(f);
      if (p) add(p, true);
    }
  }

  const repoKeys = new Set(repos.map(keyOf));
  // Symlinked folders are never followed (their files are listed under the folder's own name, once, and a link
  // cannot loop or lead out of the project); a symlinked file counts when it resolves inside the project.
  const walk = async (dir: string, ignoredDir: boolean): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (plain.length > o.cap) return;
      if (e.name === '.git') continue;
      const hidden = DEFAULT_HIDDEN.has(e.name);
      if (hidden && !o.includeIgnored) continue;
      const ignored = ignoredDir || hidden;
      if (ignored && ignoredFull()) continue;
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        let isFile = false;
        try { isFile = (await stat(p)).isFile(); } catch { continue; }
        const rp = isFile ? real(p) : null;
        if (rp && rootReal && isInside(rootReal, rp)) add(p, ignored);
      } else if (e.isDirectory()) {
        // A repository has its own listing.
        if (!repoKeys.has(keyOf(p))) await walk(p, ignored);
      } else if (e.isFile()) {
        add(p, ignored);
      }
    }
  };
  if (!repoKeys.has(keyOf(root))) await walk(root, false);
  for (const r of unread) {
    const rr = real(r);
    if (rr && rootReal && isInside(rootReal, rr)) await walk(r, false);
  }

  plain.sort(byRel);
  ignoredFiles.sort(byRel);
  const files = [...plain, ...(o.includeIgnored ? ignoredFiles : [])];
  const capped = files.length > o.cap || incomplete;
  return { files: files.length > o.cap ? files.slice(0, o.cap) : files, capped };
}

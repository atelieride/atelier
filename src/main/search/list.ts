import { readdir, stat } from 'node:fs/promises';
import { join } from '../cpath';
import { isBelow, isInside } from '@shared/paths';
import { DEFAULT_HIDDEN, insideProject } from '../fs/files';
import { runGit } from '../git/exec';

/** One file a search covers. `ignored` files are listed only when the search asks for them, after all the others. */
export interface ListedFile { path: string; rel: string; ignored: boolean }

/** Tracked plus untracked files that are not ignored. */
export const LS_ARGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
/** Every ignored file, one by one (not folded into folders). */
export const LS_IGNORED_FILES_ARGS = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'];

const byRel = (a: ListedFile, b: ListedFile): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

async function lsFiles(repo: string, args: string[]): Promise<string[] | null> {
  try {
    return (await runGit(repo, args)).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The files a search covers, in order: the non-ignored ones sorted by relative path, then the ignored ones the same
 * way. Files of a git repository come from git (a nested repository lists its own files, once); folders outside any
 * repository, and repositories git will not read, are walked. The filter applies before the cap, and the cap never
 * cuts a non-ignored file while an ignored one is listed.
 */
export async function listSearchFiles(
  root: string,
  repos: string[],
  o: { includeIgnored: boolean; cap: number; filter: (rel: string) => boolean },
): Promise<{ files: ListedFile[]; capped: boolean }> {
  const relOf = (p: string): string => p.slice(root.length + 1);
  const plain: ListedFile[] = [];
  const ignoredFiles: ListedFile[] = [];
  const seen = new Set<string>();
  const add = (p: string, ignored: boolean): void => {
    const rel = relOf(p);
    if (!o.filter(rel)) return;
    const key = rel;
    if (seen.has(key)) return;
    seen.add(key);
    (ignored ? ignoredFiles : plain).push({ path: p, rel, ignored });
  };

  const unread: string[] = [];
  for (const r of repos) {
    // A repository reached through a symlink to outside the project: its files cannot be opened.
    if (!isInside(root, r)) continue;
    const listed = await lsFiles(r, LS_ARGS);
    if (!listed) { unread.push(r); continue; }
    const inner = repos.filter((x) => x !== r && isBelow(r, x));
    const keep = (f: string): string | null => {
      // A nested repository shows up as a folder entry (a gitlink or an untracked repo): its files are its own.
      if (f.endsWith('/')) return null;
      const p = join(r, f);
      if (inner.some((x) => p === x || isBelow(x, p))) return null;
      return p;
    };
    for (const f of listed) { const p = keep(f); if (p) add(p, false); }
    if (o.includeIgnored) {
      for (const f of (await lsFiles(r, LS_IGNORED_FILES_ARGS)) ?? []) { const p = keep(f); if (p) add(p, true); }
    }
  }

  const repoSet = new Set(repos);
  const visited = new Set<string>();
  const full = (): boolean => plain.length > o.cap || (o.includeIgnored && plain.length + ignoredFiles.length > o.cap);
  const walk = async (dir: string, ignoredDir: boolean): Promise<void> => {
    if (full()) return;
    const real = insideProject(root, dir);
    if (!real || visited.has(real)) return;
    visited.add(real);
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const n of names.sort()) {
      if (full()) return;
      if (n === '.git') continue;
      const hidden = DEFAULT_HIDDEN.has(n);
      if (hidden && !o.includeIgnored) continue;
      const ignored = ignoredDir || hidden;
      const p = join(dir, n);
      let st;
      try { st = await stat(p); } catch { continue; }
      if (st.isDirectory()) {
        // A repository has its own listing; a symlink to one is compared by its real path.
        if (repoSet.has(p)) continue;
        const rp = insideProject(root, p);
        if (!rp || repoSet.has(rp)) continue;
        await walk(p, ignored);
      } else if (st.isFile()) {
        if (!insideProject(root, p)) continue;
        add(p, ignored);
      }
    }
  };
  if (!repoSet.has(root)) await walk(root, false);
  for (const r of unread) await walk(r, false);

  plain.sort(byRel);
  ignoredFiles.sort(byRel);
  const files = [...plain, ...(o.includeIgnored ? ignoredFiles : [])];
  const capped = files.length > o.cap;
  return { files: capped ? files.slice(0, o.cap) : files, capped };
}

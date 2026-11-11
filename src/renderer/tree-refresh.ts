// Files follows the disk. A folder is listed when it opens; main reports every path changed in the project (a clone,
// a rename, a file a terminal wrote), and the nearest folder shown open around each one is listed again. The root
// itself reported means the OS dropped events: every open folder is listed again.
import type { DirEntry } from '@shared/files';
import { isBelow } from '@shared/paths';
import { useApp } from './store';

/** The folders open in Files, per project root: kept while the tree is hidden, and inside closed folders. */
export const expandedByProject = new Map<string, Set<string>>();

/** How long changes gather before the folders are listed again: one listing per burst (a clone writes thousands). */
const GATHER_MS = 150;

/**
 * The folders to list again for these changed paths: for each path inside `root`, the deepest folder around it shown
 * open (the root, or an open folder whose own folders are all open). `'all'` when the root itself is reported.
 */
export function foldersToRelist(paths: readonly string[], root: string, open: ReadonlySet<string>): Set<string> | 'all' {
  const out = new Set<string>();
  for (const p of paths) {
    if (p === root) return 'all';
    if (!isBelow(root, p)) continue;
    const parts = p.slice(root.length + 1).split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      const next = `${at}/${part}`;
      if (!open.has(next)) break;
      at = next;
    }
    out.add(at);
  }
  return out;
}

/** Whether a folder's new listing shows the same rows: then the tree keeps the old one and renders nothing. */
export function sameEntries(a: readonly DirEntry[] | null, b: readonly DirEntry[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x.path === b[i]!.path && x.dir === b[i]!.dir && x.hidden === b[i]!.hidden && x.name === b[i]!.name);
}

let gathered: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Paths changed on disk (main's file events): the folders showing them are listed again after a short gathering. */
export function treeChanged(paths: readonly string[]): void {
  // One by one: a big checkout's burst would overflow push's arguments.
  for (const p of paths) gathered.push(p);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = gathered;
    gathered = [];
    const st = useApp.getState();
    if (!st.project) return;
    const folders = foldersToRelist(batch, st.project.realRoot ?? st.project.root, expandedByProject.get(st.project.root) ?? new Set());
    if (folders === 'all' || folders.size > 0) st.relistFolders(folders);
  }, GATHER_MS);
}

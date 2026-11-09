// The Shelf: files kept at hand in the Sessions sidebar (the project's and outside ones),
// per project root, saved in localStorage like the pins (main keeps the outside ones' grants with the saved tabs). Items have the recents' shape, so renames and the Trash reuse recent.ts.
import { isAbsPath, isBelow, isCleanAbsPath, samePath } from '@shared/paths';
import type { RecentFile } from './recent';
import { isUntitled } from './untitled';
import { isExternal } from './external';

export type ShelfItem = RecentFile;
export type ShelvesByProject = Record<string, ShelfItem[]>;

/** Files per project, and projects remembered (the least recently changed forgotten). */
export const MAX_SHELF = 50;
export const MAX_SHELF_PROJECTS = 50;
export const KEY = 'atelier.shelf';
export const COLLAPSED_KEY = 'atelier.shelfCollapsed';

const isItem = (x: unknown): x is ShelfItem => {
  const o = x as Partial<ShelfItem> | null;
  return !!o && typeof o === 'object' && isCleanAbsPath(o.path) && typeof o.rel === 'string' && o.rel.length > 0;
};

/** From the saved value (whatever it contains) to valid shelves. */
export function parseShelf(raw: string | null): ShelvesByProject {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: empty */ }
  const out: ShelvesByProject = {};
  for (const [root, items] of Object.entries(o)) {
    if (!Array.isArray(items)) continue;
    const seen = new Set<string>();
    const valid = items.filter(isItem).filter((x) => !seen.has(x.path) && !!seen.add(x.path)).map((x) => ({ path: x.path, rel: x.rel })).slice(0, MAX_SHELF);
    if (valid.length) out[root] = valid;
  }
  return out;
}

/** The shelf of `root` replaced by `items` (none: the project is removed); the project becomes the most recent one. */
export function withProjectShelf(all: ShelvesByProject, root: string, items: ShelfItem[]): ShelvesByProject {
  const rest = Object.entries(all).filter(([r]) => r !== root);
  if (items.length) rest.push([root, items]);
  return Object.fromEntries(rest.slice(-MAX_SHELF_PROJECTS));
}

export function loadShelf(root: string): ShelfItem[] {
  try { return parseShelf(localStorage.getItem(KEY))[root] ?? []; } catch { return []; }
}

export function saveShelf(root: string, items: ShelfItem[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(withProjectShelf(parseShelf(localStorage.getItem(KEY)), root, items))); } catch { /* not saved: stays for this session */ }
}

export function loadShelfCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}

export function saveShelfCollapsed(collapsed: boolean): void {
  try { if (collapsed) localStorage.setItem(COLLAPSED_KEY, '1'); else localStorage.removeItem(COLLAPSED_KEY); } catch { /* not saved */ }
}

/**
 * A file put on the shelf before `before` (null, or a path no longer there: last). One already there moves; past the
 * limit the first file other than this one gives way.
 */
export function placeInShelf(items: ShelfItem[], item: ShelfItem, before: string | null): ShelfItem[] {
  if (before === item.path) return items.map((x) => (x.path === item.path ? { ...item } : x));
  const rest = items.filter((x) => x.path !== item.path);
  const i = before === null ? -1 : rest.findIndex((x) => x.path === before);
  const next = i < 0 ? [...rest, { ...item }] : [...rest.slice(0, i), { ...item }, ...rest.slice(i)];
  let over = next.length - MAX_SHELF;
  return over > 0 ? next.filter((x) => x.path === item.path || over-- <= 0) : next;
}

/** A file moved one place up (-1) or down (1); the same list when it can't move. */
export function nudgeInShelf(items: ShelfItem[], path: string, by: -1 | 1): ShelfItem[] {
  const i = items.findIndex((x) => x.path === path);
  const j = i + by;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = [...items];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Changed paths (main's watcher) that may change what the shelf finds on disk: a shelved file, or a folder above one. */
export function touchesShelf(items: ShelfItem[], paths: string[]): boolean {
  return paths.some((p) => items.some((x) => x.path === p || isBelow(p, x.path)));
}

export function removeFromShelf(items: ShelfItem[], path: string): ShelfItem[] {
  return items.filter((x) => x.path !== path);
}

/**
 * A file that can go on the shelf: any real file of an open project, inside it or outside it; not an
 * untitled tab, not the project folder itself.
 */
export function shelvable(path: string, realRoot: string | null): boolean {
  if (!realRoot || isUntitled(path) || !isAbsPath(path)) return false;
  return !samePath(realRoot.replace(/\/$/, ''), path.replace(/\/$/, ''));
}

/** Outside the project, as an outside tab is: its row says so, and main keeps it granted across launches. */
export const isOutside = (path: string, realRoot: string | null): boolean => isExternal(path, realRoot);

/** The shelf's outside files, for main to keep granted. */
export function outsideOf(items: ShelfItem[], realRoot: string | null): string[] {
  return realRoot ? items.filter((x) => isOutside(x.path, realRoot)).map((x) => x.path) : [];
}

/** The outside files main did not grant again after a launch (`granted`: null when it restored none). */
export function ungranted(items: ShelfItem[], realRoot: string | null, granted: string[] | null): Set<string> {
  const ok = new Set(granted ?? []);
  return new Set(outsideOf(items, realRoot).filter((p) => !ok.has(p)));
}

/** Where a drop at height `y` lands among the rows: before the first row whose middle is below it, else last (null). */
export function shelfIndexAt(rows: { path: string; top: number; height: number }[], y: number): string | null {
  return rows.find((r) => y < r.top + r.height / 2)?.path ?? null;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** The folders whose listing tells whether the shelf's project files are still there (an outside one is never listed). */
export function shelfDirs(items: ShelfItem[], realRoot: string | null): string[] {
  return [...new Set(items.filter((x) => !isOutside(x.path, realRoot)).map((x) => dirOf(x.path)))];
}

/** The shelf's files missing from their folder's listing (names; null: not read, so unknown). */
export function missingIn(items: ShelfItem[], listings: Map<string, string[] | null>): Set<string> {
  const out = new Set<string>();
  for (const x of items) {
    const names = listings.get(dirOf(x.path));
    if (names && !names.includes(nameOf(x.path))) out.add(x.path);
  }
  return out;
}

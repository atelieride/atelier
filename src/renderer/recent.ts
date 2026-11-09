import { isBelow } from '@shared/paths';
export interface RecentFile { path: string; rel: string }

/** Recently opened files in this window: newest on top, no duplicates. */
export function pushRecent(list: RecentFile[], f: RecentFile, max = 12): RecentFile[] {
  return [f, ...list.filter((x) => x.path !== f.path)].slice(0, max);
}

/** Recents to show in the palette on an empty search: all except the active one. */
export function recentForPalette(list: RecentFile[], active: string | null, max = 6): RecentFile[] {
  return list.filter((x) => x.path !== active).slice(0, max);
}

/** A renamed file or folder: recents follow the new path. */
export function renameRecent(list: RecentFile[], from: string, to: string, root: string): RecentFile[] {
  return list.map((x) => {
    const n = x.path === from ? to : isBelow(from, x.path) ? to + x.path.slice(from.length) : null;
    return n ? { path: n, rel: isBelow(root, n) ? n.slice(root.length + 1) : n } : x;
  });
}

/** File or folder moved to the Trash (or gone from disk): removed from recents. */
export function dropRecent(list: RecentFile[], path: string): RecentFile[] {
  return list.filter((x) => x.path !== path && !isBelow(path, x.path));
}

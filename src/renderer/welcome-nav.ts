// The welcome window's keyboard: "Open Folder", then the recent folders. Pure.

/** The item an arrow, Home or End moves to; null for any other key. Nothing focused yet: the first recent folder. */
export function welcomeNext(current: number | null, key: string, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case 'ArrowDown': return current === null ? Math.min(1, last) : Math.min(current + 1, last);
    case 'ArrowUp': return current === null ? Math.min(1, last) : Math.max(current - 1, 0);
    case 'Home': return 0;
    case 'End': return last;
    default: return null;
  }
}

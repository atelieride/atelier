import { currentPlatform, type Platform } from '@shared/platform';

/** Color of the limits bar: the brand while there is headroom, then yellow and red. */
export function usageTone(pct: number): 'brand' | 'warn' | 'danger' {
  if (!(pct >= 80)) return 'brand';
  return pct >= 95 ? 'danger' : 'warn';
}

/**
 * The usage ring's arc as a `stroke-dasharray` over a `pathLength` of 100: its share of the
 * circle, clamped; null at 0% or below, where the round cap would still draw a dot.
 */
export function ringArc(pct: number): string | null {
  if (!(pct > 0)) return null;
  return `${Math.min(100, pct)} 100`;
}

/** Project path to display: ~ for home, and only the last two folders if it is long. */
export function shortPath(root: string, platform: Platform = currentPlatform()): string {
  // Windows (canonical C:/…): the user's folder is ~, any other path keeps its drive.
  const win = platform === 'win32';
  const m = (win ? /^[A-Za-z]:\/Users\/[^/]+/ : /^\/Users\/[^/]+/).exec(root);
  const prefix = m ? '~' : win ? root.slice(0, 2) : '';
  const rest = m ? root.slice(m[0].length) : win ? root.slice(2) : root;
  const parts = rest.split('/').filter(Boolean);
  // Shown, never parsed: Windows' own separator there.
  const sep = win ? '\\' : '/';
  if (parts.length <= 2) return `${prefix}${sep}${parts.join(sep)}`;
  return `${prefix}${sep}…${sep}${parts.slice(-2).join(sep)}`;
}

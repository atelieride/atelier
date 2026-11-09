// The filter bar's layout math: how many chips two lines hold, and where a popover
// sits in its tab. Pure; the bar measures, these decide. Lazy, with the table's chunk.
import type { Box } from '../popover-place';

/**
 * How many chips show: the row wraps to `lines` lines (two) at most; past them, as many as leave room for "+N more" and
 * "+ Filter" after them. `widths`: each chip's natural width (a chip wider than the row takes the row and ellipsizes);
 * `room` 0 (not measured yet): all of them.
 */
export function fitChips(widths: readonly number[], room: number, o: { gap: number; more: (n: number) => number; add: number; lines?: number }): number {
  const n = widths.length;
  if (room <= 0) return n;
  const lines = o.lines ?? 2;
  const fits = (items: readonly number[]): boolean => {
    let line = 1;
    let x = 0;
    for (const w0 of items) {
      const w = Math.min(w0, room);
      if (x > 0 && x + o.gap + w > room) {
        line++;
        x = w;
      } else x += (x > 0 ? o.gap : 0) + w;
      if (line > lines) return false;
    }
    return true;
  };
  for (let k = n; k > 0; k--) if (fits([...widths.slice(0, k), ...(k < n ? [o.more(n - k)] : []), o.add])) return k;
  return 0;
}

/** A popover's margin inside its tab, and its gap under the anchor (as popover-place.ts's). */
const MARGIN = 8;
const GAP = 6;

/**
 * Where a popover goes inside its tab (`box`), in the tab's coordinates: under its anchor (always in the bar at the
 * tab's top: there is room below), slid to stay inside, at most the tab's width less its margins, its height what is
 * left under the anchor (it scrolls inside) — within the window. Its own few lines, not popover-place.ts's: importing
 * that from this lazy chunk would make the first paint export it.
 */
export function placeInBox(anchor: Box, box: Box, size: { width: number }): { left: number; top: number; width: number; maxHeight: number } {
  const w = box.right - box.left;
  const width = Math.max(0, Math.min(size.width, w - 2 * MARGIN));
  const left = Math.max(MARGIN, Math.min(anchor.left - box.left, w - width - MARGIN));
  const top = anchor.bottom - box.top + GAP;
  return { left, top, width, maxHeight: Math.max(0, box.bottom - box.top - top - MARGIN) };
}

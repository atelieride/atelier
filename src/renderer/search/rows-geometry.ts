// Find in Files, the result list's geometry: rows of two heights (a file, a match), where each one starts, which of them
// a viewport needs drawn, and the scroll that shows one whole. Pure: the list keeps only those rows in the page.

export const FILE_ROW_H = 26;
export const MATCH_ROW_H = 22;

/** Where each row starts, in order; one more entry at the end: the list's whole height. */
export function rowTops(kinds: readonly ('file' | 'match')[]): number[] {
  const tops = new Array<number>(kinds.length + 1);
  let y = 0;
  for (let i = 0; i < kinds.length; i++) {
    tops[i] = y;
    y += kinds[i] === 'file' ? FILE_ROW_H : MATCH_ROW_H;
  }
  tops[kinds.length] = y;
  return tops;
}

/** The last row starting at or above `y` (the row `y` falls in); 0 for an empty list. */
function rowAt(tops: readonly number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The rows `[start, end)` a viewport touches, plus `overscan` rows on each side; a scroll past the end keeps the last row. */
export function visibleRange(tops: readonly number[], scrollTop: number, height: number, overscan = 12): { start: number; end: number } {
  const n = tops.length - 1;
  if (n <= 0 || height <= 0) return { start: 0, end: 0 };
  const first = rowAt(tops, Math.max(0, scrollTop));
  let last = first;
  const bottom = scrollTop + height;
  while (last + 1 < n && tops[last + 1]! < bottom) last++;
  return { start: Math.max(0, first - overscan), end: Math.min(n, last + 1 + overscan) };
}

// A match row (search.css): the list's 6 px sides, the row's 42 px indent and 8 px right padding, a 6 px gap, room for a
// five-digit line number in 10.5 px mono; its text is 11.5 px mono, whose characters are 0.6 em wide.
const MATCH_ROW_CHROME = 6 + 6 + 42 + 8 + 6 + 32;
const MATCH_CHAR_W = 11.5 * 0.6;

/** How many characters of a line a match row shows in a list `listWidth` px wide (at least 4). */
export function textChars(listWidth: number): number {
  return Math.max(4, Math.floor((listWidth - MATCH_ROW_CHROME) / MATCH_CHAR_W));
}

/**
 * How many characters before its match a row starts when the match is further along the line: as many as fit with
 * "…" and the match itself in the row's `room`, so the match is never cut by the row's end; between 4 and 20.
 */
export function leadFor(room: number, matchLen: number): number {
  return Math.max(4, Math.min(20, room - matchLen - 3));
}

/** The scroll position that puts row `i` in the middle of a viewport `height` px tall, within the list's bounds. */
export function centerOn(tops: readonly number[], i: number, height: number): number {
  if (i < 0 || i >= tops.length - 1) return 0;
  const total = tops[tops.length - 1]!;
  const rowH = tops[i + 1]! - tops[i]!;
  return Math.max(0, Math.min(total - height, tops[i]! - (height - rowH) / 2));
}

/** The scroll position that shows row `i` whole: unchanged when it already is (or when there is no such row). */
export function scrollToShow(tops: readonly number[], i: number, scrollTop: number, height: number): number {
  if (i < 0 || i >= tops.length - 1) return scrollTop;
  const top = tops[i]!;
  const bottom = tops[i + 1]!;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + height) return bottom - height;
  return scrollTop;
}

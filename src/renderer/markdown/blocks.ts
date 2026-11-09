// The preview's blocks and their source lines: every block element carries
// `data-src="start-end"`; these pure helpers turn that into selections, change bars and scroll positions.
import type { LineRange } from '../mention';

/** `data-src` → 1-based line range (null when absent or broken). */
export function parseSrc(attr: string | null | undefined): LineRange | null {
  const m = /^(\d+)-(\d+)$/.exec(attr ?? '');
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return start >= 1 && end >= start ? { start, end } : null;
}

/** The lines behind several blocks (a selection's ends): from the first to the last. */
export function spanOf(ranges: readonly (LineRange | null)[]): LineRange | null {
  const ok = ranges.filter((r): r is LineRange => !!r);
  if (!ok.length) return null;
  return { start: Math.min(...ok.map((r) => r.start)), end: Math.max(...ok.map((r) => r.end)) };
}

export type GutterMark = 'add' | 'mod' | 'del';
export interface BlockMark { bar: 'add' | 'mod' | null; removedBefore: boolean }

/** Change bars from the margin marks: a block is modified when any line is (or lines vanished from inside it), added
 * when all its marks are additions; lines removed right before it show as a wedge. */
export function blockMarks(blocks: readonly LineRange[], marks: ReadonlyMap<number, GutterMark> | null): BlockMark[] {
  return blocks.map(({ start, end }) => {
    let add = false; let mod = false; let removedBefore = false;
    if (marks) for (let l = start; l <= end; l++) {
      const m = marks.get(l);
      if (m === 'add') add = true;
      else if (m === 'mod') mod = true;
      else if (m === 'del') { if (l === start) removedBefore = true; else mod = true; }
    }
    return { bar: mod ? 'mod' : add ? 'add' : null, removedBefore };
  });
}

/** A rendered block's lines and its box in the page (top and height in px, page coordinates). */
export interface BlockGeo { start: number; end: number; top: number; height: number }

/** Page offset of a (fractional) source line: interpolated inside its block, and across the gap between blocks. */
export function offsetOfLine(blocks: readonly BlockGeo[], line: number): number {
  if (!blocks.length) return 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (line < b.start) {
      const prev = blocks[i - 1];
      if (!prev) return b.top;
      const from = prev.end + 1; const fromY = prev.top + prev.height;
      return fromY + ((line - from) / Math.max(1, b.start - from)) * (b.top - fromY);
    }
    if (line < b.end + 1) return b.top + ((line - b.start) / (b.end + 1 - b.start)) * b.height;
  }
  return blocks.at(-1)!.top;
}

/** The (fractional) source line at a page offset: the inverse of `offsetOfLine`. */
export function lineAtOffset(blocks: readonly BlockGeo[], y: number): number {
  if (!blocks.length) return 1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (y < b.top) {
      const prev = blocks[i - 1];
      if (!prev) return b.start;
      const fromY = prev.top + prev.height; const from = prev.end + 1;
      return from + ((y - fromY) / Math.max(1, b.top - fromY)) * (b.start - from);
    }
    if (y < b.top + b.height) return b.start + ((y - b.top) / Math.max(1, b.height)) * (b.end + 1 - b.start);
  }
  return blocks.at(-1)!.start;
}

/** The outline's current heading: the last one whose top is above the reading line (scrollTop + offset); the first
 * one before any. -1 without headings. */
export function currentHeading(tops: readonly number[], scrollTop: number, offset: number): number {
  if (!tops.length) return -1;
  let at = 0;
  tops.forEach((t, i) => { if (t <= scrollTop + offset) at = i; });
  return at;
}

// The editor's overview ruler: the geometry and words, pure. ruler.ts draws it.
import { t } from '../i18n/en';

export type ChangeKind = 'add' | 'mod' | 'del';
/** A changed line of the editor's document (1-based). */
export interface LineChange { line: number; kind: ChangeKind }
/** Consecutive lines of one kind. */
export interface ChangeBlock { kind: ChangeKind; first: number; last: number }
/** A block on the track: its top and height in px, the lines it stands for (merged neighbours included). */
export interface RulerMark extends ChangeBlock { y: number; h: number; n: number }

/** Marks are at least this tall; neighbours of one kind closer than MERGE_PX merge. */
const MIN_MARK = 3;
const MERGE_PX = 3;
/** The thumb is at least this tall, however long the file. */
const MIN_THUMB = 18;

/** Changed lines as blocks of one kind, in line order. */
export function changeBlocks(changes: LineChange[]): ChangeBlock[] {
  const out: ChangeBlock[] = [];
  for (const c of [...changes].sort((a, b) => a.line - b.line)) {
    const last = out.at(-1);
    if (last && last.kind === c.kind && c.line === last.last + 1) last.last = c.line;
    else out.push({ kind: c.kind, first: c.line, last: c.line });
  }
  return out;
}

/**
 * Blocks mapped from the content (a line's `top` and `bottom`, wrapped lines whole, and `contentHeight`, in px) onto a
 * track `track` px tall: at least 3 px each, never past the track's end; neighbours of one kind closer than 3 px become
 * one mark.
 */
export function placeMarks(blocks: ChangeBlock[], top: (line: number) => number, bottom: (line: number) => number, contentHeight: number, track: number): RulerMark[] {
  if (contentHeight <= 0 || track <= 0) return [];
  const out: RulerMark[] = [];
  for (const b of blocks) {
    const from = (top(b.first) * track) / contentHeight;
    const to = (bottom(b.last) * track) / contentHeight;
    // Whole pixels (the page snaps boxes to them: fractional neighbours would overlap where the pointer lands).
    const h = Math.max(MIN_MARK, Math.round(to - from));
    const prev = out.at(-1);
    // Never over the previous mark: on a dense track a removed row's mark and the added one under it both stay whole.
    const y = Math.max(0, Math.min(Math.floor(track) - h, Math.max(Math.round(from), prev && prev.kind !== b.kind ? prev.y + prev.h : 0)));
    const n = b.last - b.first + 1;
    if (prev && prev.kind === b.kind && y - (prev.y + prev.h) < MERGE_PX) {
      prev.h = Math.max(prev.y + prev.h, y + h) - prev.y;
      prev.last = Math.max(prev.last, b.last);
      prev.n += n;
      continue;
    }
    out.push({ kind: b.kind, first: b.first, last: b.last, y, h, n });
  }
  return out;
}

/** The visible part on the track, or null when everything fits. */
export function thumbOf(scrollTop: number, clientHeight: number, scrollHeight: number, track: number): { y: number; h: number } | null {
  if (scrollHeight <= clientHeight + 1 || track <= 0) return null;
  const h = Math.min(track, Math.max(MIN_THUMB, (clientHeight / scrollHeight) * track));
  const room = scrollHeight - clientHeight;
  return { y: (Math.min(room, Math.max(0, scrollTop)) / room) * (track - h), h };
}

const clampScroll = (v: number, clientHeight: number, scrollHeight: number) => Math.max(0, Math.min(scrollHeight - clientHeight, v));

/** The scroll position that centers the point `y` of the track. */
export function scrollFor(y: number, track: number, clientHeight: number, scrollHeight: number): number {
  return clampScroll((y / track) * scrollHeight - clientHeight / 2, clientHeight, scrollHeight);
}

/** Dragging the thumb `dy` px from where it was at scroll `start`: the content follows at the thumb's scale. */
export function dragScroll(start: number, dy: number, track: number, clientHeight: number, scrollHeight: number): number {
  const thumb = thumbOf(start, clientHeight, scrollHeight, track);
  if (!thumb || track <= thumb.h) return clampScroll(start, clientHeight, scrollHeight);
  return clampScroll(start + (dy * (scrollHeight - clientHeight)) / (track - thumb.h), clientHeight, scrollHeight);
}

/** A press on a change becomes a drag once the pointer has moved this far (px); released before, it goes to the change. */
const MARK_SLOP = 3;

/** A press on a change, moved `dy` px since: far enough to be a drag of the thumb. */
export function pressMoved(dy: number): boolean {
  return Math.abs(dy) >= MARK_SLOP;
}

/**
 * A move during a drag with the primary button up: its release never came (Electron can swallow it over the window's
 * drag region). Only over the window: out of it macOS may report a move with no button while one is held.
 */
export function releaseMissed(buttons: number, p: { x: number; y: number }, view: { width: number; height: number }): boolean {
  return !(buttons & 1) && p.x >= 0 && p.y >= 0 && p.x < view.width && p.y < view.height;
}

/**
 * What a mark says under the pointer. `lines`: the file's line numbers it covers, or null (the Diff view's removed rows,
 * which have none); a removal in the margin sits above the line it is marked on.
 */
export function markTip(kind: ChangeKind, n: number, lines: [number, number] | null): string {
  const w = t.ruler.words[kind];
  if (!lines) return t.ruler.count(n, w);
  if (kind === 'del') return t.ruler.removedAbove(lines[0]);
  return n === 1 && lines[0] === lines[1] ? t.ruler.line(lines[0], w) : t.ruler.lines(lines[0], lines[1], n, w);
}

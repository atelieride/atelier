const ANCHOR = 20;
/** Marker for lines the pane produced faster than they were captured. */
export const SKIPPED = '\x1b[2m… earlier lines skipped (output faster than capture)\x1b[0m';

const startsWith = (hay: string[], prefix: string[]) => prefix.length <= hay.length && prefix.every((l, i) => hay[i] === l);

/**
 * Complete lines that appeared between two captures of the same pane. The last line of a capture is "live"
 * (prompt, progress bar, last line of a log) and is handled separately.
 * 1. As long as the history doesn't exceed the capture window the lines don't move: the new ones are those after the
 *    already seen ones (works with repeated identical lines too).
 * 2. If the lines scrolled away, look for the anchor (the last lines seen) from its first occurrence: better a duplicate
 *    than a loss.
 * 3. Without an anchor: if the capture hasn't shrunk the pane produced more than fits in the window
 *    → append everything with a marker; if it shrank the screen was cleared → reset.
 */
export function newLines(prev: string[], next: string[]): { appended: string[]; reset: boolean } {
  const done = next.slice(0, -1);
  const prevDone = prev.slice(0, -1);
  if (prevDone.length === 0) return { appended: done, reset: false };
  if (startsWith(done, prevDone)) return { appended: done.slice(prevDone.length), reset: false };
  const k = Math.min(ANCHOR, prevDone.length);
  const anchor = prevDone.slice(-k);
  for (let at = 0; at + k <= done.length; at++) {
    let match = true;
    for (let i = 0; i < k; i++) if (done[at + i] !== anchor[i]) { match = false; break; }
    if (match) return { appended: done.slice(at + k), reset: false };
  }
  if (done.length >= prevDone.length) return { appended: [SKIPPED, ...done], reset: false };
  return { appended: done, reset: true };
}

export class LineBuffer {
  private buf: string[] = [];
  /** Lines received since the last reset: whoever receives the updates can tell if it missed any. */
  seq = 0;
  /** Last line of the capture, not final yet. */
  live = '';
  constructor(private readonly max = 5000) {}
  push(lines: string[]): void {
    if (!lines.length) return;
    this.seq += lines.length;
    this.buf.push(...lines);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  }
  reset(lines: string[]): void { this.buf = []; this.seq = 0; this.push(lines); }
  lines(): string[] { return [...this.buf]; }
}

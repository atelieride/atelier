// Next / previous change in a file tab (the Diff view's added and removed rows, or the margin's marks), on
// ⌥F5 / ⌥⇧F5: in a long file the changes are found without scrolling through it.
import type { DiffDoc } from './linediff';

/** 1-based rows of the Diff view that are added or removed. */
export function diffChangedLines(lines: DiffDoc['lines']): number[] {
  return lines.flatMap((l, i) => (l.kind === 'ctx' ? [] : [i + 1]));
}

/** First line of each run of consecutive changed lines: one stop per change, not per line. */
export function runStarts(changed: number[]): number[] {
  const sorted = [...new Set(changed)].sort((a, b) => a - b);
  return sorted.filter((n, i) => i === 0 || sorted[i - 1] !== n - 1);
}

/** The change after (dir 1) or before (dir -1) the cursor line, wrapping around; null without changes. */
export function stepChange(starts: number[], line: number, dir: 1 | -1): number | null {
  if (starts.length === 0) return null;
  if (dir === 1) return starts.find((n) => n > line) ?? starts[0]!;
  return [...starts].reverse().find((n) => n < line) ?? starts.at(-1)!;
}

/** How many changes start at or before the cursor line: the "2" of "2 / 5", 0 before the first. */
export function changePosition(starts: number[], line: number): number {
  return starts.filter((n) => n <= line).length;
}

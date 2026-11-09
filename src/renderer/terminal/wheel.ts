// Wheel with the mouse captured by a program (full-screen Claude Code, vim, less…): xterm.js sends a single
// event per movement, scaled down to 30% on trackpads, and Claude scrolls one line per event. Here the movement becomes
// as many lines as its pixels are worth, and each line an event.

const MAX_LINES = 60;

/** Whole lines for a wheel event (deltaMode 0 pixels, 1 lines, 2 pages), with the remainder to add to the next one. */
export function wheelLines(rest: number, deltaY: number, deltaMode: number, cellHeight: number, rows: number): { lines: number; rest: number } {
  // Direction change: the remainder from the other direction doesn't count.
  const carry = Math.sign(rest) !== 0 && Math.sign(rest) !== Math.sign(deltaY) ? 0 : rest;
  let total: number;
  if (deltaMode === 1) total = carry + deltaY;
  else if (deltaMode === 2) total = carry + deltaY * rows;
  else if (cellHeight > 0) total = carry + deltaY / cellHeight;
  else return { lines: 0, rest: carry };
  const lines = Math.trunc(total);
  return { lines: Math.max(-MAX_LINES, Math.min(MAX_LINES, lines)), rest: total - lines };
}

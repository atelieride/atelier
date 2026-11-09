// Click to move the cursor at the shell prompt: the arrows that bring zsh's
// cursor to a clicked cell of the command being typed. Pure: xterm's buffer is behind CellBuffer.

/** The parts of xterm's IBuffer read here. */
export interface CellBuffer {
  getLine(y: number): {
    isWrapped: boolean;
    getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
    translateToString(trimRight?: boolean): string;
  } | undefined;
}

export interface Cell { line: number; col: number }

/**
 * The ← or → keys (one per character) that move the cursor from `cursor` to `target`, or null when the click is not
 * in the input region: from `start` (the last B mark) to the end of that logical line. The cursor must be inside it
 * too, and nothing may be drawn below it (a completion menu, Ctrl+R's search line: arrows would drive those). A click
 * past the typed text goes to its end. '' when already there.
 *
 * The rows of a long command: those that soft-wrap from the one above, and those below a full row down to `visited`
 * (the lowest line the cursor reached at this prompt): zsh moves the cursor down with a line feed, which clears the
 * wrap flag of the row it lands on.
 */
export function clickToMove(buf: CellBuffer, cols: number, start: Cell, cursor: Cell, target: Cell, appCursor: boolean, visited = cursor.line): string | null {
  const reached = Math.max(visited, cursor.line);
  const full = (y: number) => { const c = buf.getLine(y)?.getCell(cols - 1); return !!c && (c.getWidth() === 0 || c.getChars() !== ''); };
  let last = start.line;
  for (let next = buf.getLine(last + 1); next && (next.isWrapped || (full(last) && last + 1 <= reached)); next = buf.getLine(last + 1)) last++;
  for (let y = last + 1, line = buf.getLine(y); line; line = buf.getLine(++y)) if (line.translateToString(true) !== '') return null;
  // Positions as offsets from the start of the region's first row.
  const pos = (c: Cell) => (c.line - start.line) * cols + c.col;
  const from = pos(start);
  const limit = (last - start.line + 1) * cols;
  const inside = (c: Cell) => c.line >= start.line && c.line <= last && pos(c) >= from;
  if (!inside(cursor) || !inside(target)) return null;
  const cell = (p: number) => buf.getLine(start.line + Math.floor(p / cols))?.getCell(p % cols);
  // A character: a written cell that is not the second half of a wide one (a cell never written, e.g. the one a wide
  // character that did not fit left at a row's end, is not part of the text).
  const isChar = (p: number) => { const c = cell(p); return !!c && c.getWidth() > 0 && c.getChars() !== ''; };

  let end = from;
  for (let p = limit - 1; p >= from; p--) {
    if (isChar(p)) { end = p + (cell(p)!.getWidth() || 1); break; }
  }
  let to = Math.min(pos(target), Math.max(end, pos(cursor)));
  // The second half of a wide character: the character itself.
  if (to > from && to < limit && cell(to)?.getWidth() === 0) to--;
  const here = pos(cursor);
  let n = 0;
  for (let p = Math.min(here, to); p < Math.max(here, to); p++) if (isChar(p)) n++;
  const key = `\x1b${appCursor ? 'O' : '['}${to < here ? 'D' : 'C'}`;
  return key.repeat(n);
}

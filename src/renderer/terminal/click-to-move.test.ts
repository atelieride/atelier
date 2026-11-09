import { describe, expect, test } from 'vitest';
import { clickToMove, type CellBuffer } from './click-to-move';

const WIDE = new Set(['世', '界']);
const L = '\x1b[D';
const R = '\x1b[C';

/** A screen of `cols` columns: one string per row (a leading `+` marks a row wrapped from the one above). */
function screen(cols: number, rows: string[]): CellBuffer {
  const lines = rows.map((r) => {
    const isWrapped = r.startsWith('+');
    const cells: { getChars(): string; getWidth(): number }[] = [];
    for (const c of isWrapped ? r.slice(1) : r) {
      if (WIDE.has(c)) { cells.push({ getChars: () => c, getWidth: () => 2 }, { getChars: () => '', getWidth: () => 0 }); }
      else cells.push({ getChars: () => c, getWidth: () => 1 });
    }
    while (cells.length < cols) cells.push({ getChars: () => '', getWidth: () => 1 });
    return { isWrapped, getCell: (x: number) => cells[x], translateToString: (trim?: boolean) => { const t = cells.map((c) => c.getChars() || ' ').join(''); return trim ? t.trimEnd() : t; } };
  });
  return { getLine: (y) => lines[y] };
}

const at = (line: number, col: number) => ({ line, col });

describe('click to move the cursor', () => {
  // "~ › " is the prompt: the command starts at column 4.
  const one = screen(40, ['~ › echo hello world', '']);

  test('a click left of the cursor: one ← per character', () => {
    expect(clickToMove(one, 40, at(0, 4), at(0, 20), at(0, 15), false)).toBe(L.repeat(5));
  });

  test('a click right of the cursor: one → per character', () => {
    expect(clickToMove(one, 40, at(0, 4), at(0, 4), at(0, 9), false)).toBe(R.repeat(5));
  });

  test('a click on the cursor: nothing to send', () => {
    expect(clickToMove(one, 40, at(0, 4), at(0, 10), at(0, 10), false)).toBe('');
  });

  test('application cursor keys: ESC O', () => {
    expect(clickToMove(one, 40, at(0, 4), at(0, 20), at(0, 18), true)).toBe('\x1bOD\x1bOD');
  });

  test('past the end of the text: clamped to the end', () => {
    expect(clickToMove(one, 40, at(0, 4), at(0, 4), at(0, 35), false)).toBe(R.repeat(16));
  });

  test('typed trailing spaces count as text', () => {
    const s = screen(40, ['~ › ls   ']);
    expect(clickToMove(s, 40, at(0, 4), at(0, 4), at(0, 30), false)).toBe(R.repeat(5));
  });

  test('on the prompt, before the command, or on a line below: not a move (null)', () => {
    expect(clickToMove(one, 40, at(0, 4), at(0, 20), at(0, 2), false)).toBeNull();
    expect(clickToMove(one, 40, at(0, 4), at(0, 20), at(1, 3), false)).toBeNull();
  });

  test('the cursor outside the input: not a move', () => {
    const s = screen(40, ['~ › echo hi', '']);
    expect(clickToMove(s, 40, at(0, 4), at(1, 0), at(0, 6), false)).toBeNull();
  });

  test('something drawn under the input (a completion menu, Ctrl+R\'s search line): not a move (arrows would drive it)', () => {
    const menu = screen(40, ['~ › ls src/renderer/', 'renderer/  repo/', '']);
    expect(clickToMove(menu, 40, at(0, 4), at(0, 20), at(0, 5), false)).toBeNull();
    const search = screen(40, ['~ › echo hi', 'bck-i-search: ec_']);
    expect(clickToMove(search, 40, at(0, 4), at(0, 7), at(0, 5), false)).toBeNull();
  });

  test('wrapped rows that lost their wrap flag (zsh moves down with a line feed): still the input once the cursor went there', () => {
    const s = screen(10, ['~ › abcdef', 'ghijklmnop', 'qr']);
    // The cursor on the last row now.
    expect(clickToMove(s, 10, at(0, 4), at(2, 2), at(0, 6), false)).toBe(L.repeat(16));
    // The cursor back on the first row, after having been on the last one.
    expect(clickToMove(s, 10, at(0, 4), at(0, 6), at(2, 1), false, 2)).toBe(R.repeat(15));
    // Never been there: the rows below are something else.
    expect(clickToMove(s, 10, at(0, 4), at(0, 6), at(2, 1), false, 0)).toBeNull();
  });

  test('a full row followed by a line the cursor never reached is not the input', () => {
    const s = screen(10, ['~ › abcdef', 'list  more']);
    expect(clickToMove(s, 10, at(0, 4), at(0, 10), at(0, 5), false)).toBeNull();
  });

  test('a command wrapped over rows: counted across the wrap', () => {
    const s = screen(10, ['~ › abcdef', '+ghijklmnop', '+qr']);
    // From the end (row 2, col 2) to "c" (row 0, col 6): c–f, g–p, q r → 16 characters.
    expect(clickToMove(s, 10, at(0, 4), at(2, 2), at(0, 6), false)).toBe(L.repeat(16));
    expect(clickToMove(s, 10, at(0, 4), at(0, 6), at(2, 1), false)).toBe(R.repeat(15));
  });

  test('a row that is not a wrap (a newline in the buffer) ends the input', () => {
    const s = screen(10, ['~ › abc', 'def']);
    expect(clickToMove(s, 10, at(0, 4), at(0, 7), at(1, 1), false)).toBeNull();
  });

  test('wide characters: one arrow each; a click on the second half lands on the character', () => {
    const s = screen(40, ['~ › echo 世界!']);
    // Cells: e c h o _ 世 . 界 . ! → cursor after "!" (col 14).
    expect(clickToMove(s, 40, at(0, 4), at(0, 14), at(0, 9), false)).toBe(L.repeat(3));
    expect(clickToMove(s, 40, at(0, 4), at(0, 14), at(0, 12), false)).toBe(L.repeat(2));
  });

  test('a wrapped row that starts after a wide character left a blank cell: the blank is not a character', () => {
    const s = screen(6, ['› abc', '+世d']);
    // Row 0: "› abc" + an empty cell at col 5 (the wide character did not fit).
    expect(clickToMove(s, 6, at(0, 2), at(1, 3), at(0, 2), false)).toBe(L.repeat(5));
  });
});

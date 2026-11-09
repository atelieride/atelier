// CSV viewer: the table's selection. It is kept in data coordinates (a data row, a column) so it
// survives sorting, filtering and hiding; the table draws it as a rectangle of display positions. Pure.
import type { CellRange } from './types';

export interface Cell { row: number; col: number }
/** a: the anchor (where the range started), f: the focus (the cell the keyboard moves). */
export interface Sel { a: Cell; f: Cell }

/** The selection as display positions; an anchor no longer shown shrinks it to the focus; null if the focus isn't shown. */
export function rangeOf(sel: Sel | null, rows: readonly number[], cols: readonly number[]): CellRange | null {
  if (!sel) return null;
  const fr = rows.indexOf(sel.f.row);
  const fc = cols.indexOf(sel.f.col);
  if (fr < 0 || fc < 0) return null;
  const ar = rows.indexOf(sel.a.row);
  const ac = cols.indexOf(sel.a.col);
  if (ar < 0 || ac < 0) return { r0: fr, c0: fc, r1: fr, c1: fc };
  return { r0: Math.min(ar, fr), c0: Math.min(ac, fc), r1: Math.max(ar, fr), c1: Math.max(ac, fc) };
}

/** A key's move: arrows, Home/End (the row's ends), ⌘↑/⌘↓ (first/last row), PageUp/PageDown; shift extends. */
export function moveSelection(sel: Sel | null, key: string, o: { shift: boolean; mod: boolean; page: number }, rows: readonly number[], cols: readonly number[]): Sel | null {
  if (!rows.length || !cols.length) return null;
  const moves = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageDown', 'PageUp'];
  if (!moves.includes(key)) return null;
  const first = { row: rows[0]!, col: cols[0]! };
  const at = sel ? { r: Math.max(0, rows.indexOf(sel.f.row)), c: Math.max(0, cols.indexOf(sel.f.col)) } : null;
  if (!at || !sel) return { a: first, f: first };
  let { r, c } = at;
  const last = rows.length - 1;
  if (key === 'ArrowDown') r = o.mod ? last : r + 1;
  else if (key === 'ArrowUp') r = o.mod ? 0 : r - 1;
  else if (key === 'ArrowRight') c = o.mod ? cols.length - 1 : c + 1;
  else if (key === 'ArrowLeft') c = o.mod ? 0 : c - 1;
  else if (key === 'Home') c = 0;
  else if (key === 'End') c = cols.length - 1;
  else if (key === 'PageDown') r += o.page;
  else if (key === 'PageUp') r -= o.page;
  const f = { row: rows[Math.max(0, Math.min(last, r))]!, col: cols[Math.max(0, Math.min(cols.length - 1, c))]! };
  return { a: o.shift ? sel.a : f, f };
}

/** The lowest and highest data rows of a range (one pass: a range can hold every row of a 5 MB file). */
export function rowBounds(rows: readonly number[], r: CellRange): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let k = r.r0; k <= r.r1; k++) { const x = rows[k]!; if (x < min) min = x; if (x > max) max = x; }
  return { min, max };
}

/** The rows a virtualized table renders: what the scroll box shows plus some; a filter that left fewer rows than the
 * scroll position reaches shows the last ones (the box scrolls back to them). */
export function rowWindow(o: { top: number; height: number; head: number; row: number; count: number; overscan: number }): { first: number; last: number } {
  const page = Math.ceil(o.height / o.row);
  let first = Math.max(0, Math.floor((o.top - o.head) / o.row) - o.overscan);
  if (first >= o.count) first = Math.max(0, o.count - page - o.overscan);
  const last = Math.min(o.count, Math.max(first + page, Math.ceil((o.top + o.height) / o.row)) + o.overscan);
  return { first, last };
}

/** A click on a row number: that row whole; with shift, from the anchor's row to it. */
export function rowSelection(sel: Sel | null, row: number, shift: boolean, cols: readonly number[]): Sel {
  const c0 = cols[0] ?? 0;
  const c1 = cols.at(-1) ?? 0;
  return { a: { row: shift && sel ? sel.a.row : row, col: c0 }, f: { row, col: c1 } };
}

// Where the split view's pieces go in the workspace body. The body is a CSS grid whose lines are every pane's edges and
// bands, named after the pane (`p0l`, `p0r` its left and right; `p0t` its top, `p0s` under its tab strip, `p0h` under
// a session's bar, `p0b` its bottom), with tracks in exact px from the layout. A view in pane i is placed between pane
// i's lines — the same placement however the layout changes, so views never re-render for a divider drag or a window
// resize: only the template on the body changes. Being grid areas, the bands are also the containing blocks of the
// absolutely placed views in them (their insets and percentages are the pane's, as with one pane and the whole body).
import type { CSSProperties } from 'react';
import type { Rect } from './split-tree';

/** A pane's tab strip, on top of it. */
export const STRIP_PX = 38;
/** A Claude session's bar, under the strip. */
export const HEAD_PX = 36;

/** strip: the tab strip; head: a session's bar; body: the content under the bar; full: bar and content together (a pane without a bar). */
export type Band = 'strip' | 'head' | 'body' | 'full';

const ROWS: Record<Band, [string, string]> = { strip: ['t', 's'], head: ['s', 'h'], body: ['h', 'b'], full: ['s', 'b'] };
const boxes = new Map<string, CSSProperties>();

/** The grid placement of pane `i`'s band (one object per pane and band). */
export function paneBox(i: number, band: Band): CSSProperties {
  const id = `${i}:${band}`;
  let box = boxes.get(id);
  if (!box) {
    const [a, b] = ROWS[band];
    box = { gridColumn: `p${i}l / p${i}r`, gridRow: `p${i}${a} / p${i}${b}` };
    boxes.set(id, box);
  }
  return box;
}

/** A grid template from named positions: `[names] Npx [names] …`, the tracks between consecutive positions. */
function template(lines: Map<number, string[]>): string {
  const at = [...lines.keys()].sort((a, b) => a - b);
  return at.map((p, i) => {
    const names = lines.get(p)!;
    const label = names.length ? `[${names.join(' ')}]` : '';
    return i < at.length - 1 ? `${label} ${at[i + 1]! - p}px`.trim() : label;
  }).filter(Boolean).join(' ');
}

function name(lines: Map<number, string[]>, at: number, n: string): void {
  const list = lines.get(at);
  if (list) list.push(n);
  else lines.set(at, [n]);
}

/**
 * The body's grid for panes laid out at `panes` (px, from layoutPanes) in a body of `width` × `height`: columns and rows
 * with every pane's named lines. `strip`: the height of the tab strips in the body (0 while they sit above it). A pane
 * shorter than its bands keeps them inside it: the band lines stop at its bottom.
 */
export function gridTemplate(panes: Rect[], width: number, height: number, strip: number): { columns: string; rows: string } {
  const w = Math.max(0, Math.round(width));
  const h = Math.max(0, Math.round(height));
  const cols = new Map<number, string[]>([[0, []], [w, []]]);
  const rows = new Map<number, string[]>([[0, []], [h, []]]);
  panes.forEach((r, i) => {
    name(cols, r.x, `p${i}l`);
    name(cols, r.x + r.w, `p${i}r`);
    const bottom = r.y + r.h;
    name(rows, r.y, `p${i}t`);
    name(rows, Math.min(r.y + strip, bottom), `p${i}s`);
    name(rows, Math.min(r.y + strip + HEAD_PX, bottom), `p${i}h`);
    name(rows, bottom, `p${i}b`);
  });
  return { columns: template(cols), rows: template(rows) };
}

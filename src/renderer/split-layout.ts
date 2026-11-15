// The split view in pixels: the layout tree laid out over the workspace body. Every pane and every gap between panes
// gets an integer rectangle, and together they cover the body exactly — no gap, no overlap, nothing outside — at any
// size. Panes keep their minimums while the body has room for them; with less room every pane shrinks in proportion,
// and the shares in the tree never change because of it, so a window grown back shows the same layout again.
import { insertBeside, panePaths, withSizes, type Dir, type LayoutNode, type Rect, type Side } from './split-tree';

/** A pane is never narrower than this while the body has room for every pane's minimum. */
export const MIN_PANE_PX = 240;
/** Nor shorter than this: its tab strip, a session bar and a few terminal rows. */
export const MIN_PANE_H_PX = 180;
/** The line between two panes. */
export const PANE_GAP_PX = 1;
/** A new split is refused when a pane would end up narrower than this at the current size: one tab and its pane's ×. */
export const SPLIT_FLOOR_W = 160;
/** Or shorter than this. */
export const SPLIT_FLOOR_H = 140;
/** Arrow keys on a focused divider move it by this much. */
export const DIVIDER_STEP_PX = 24;

/** The gap after child `index` of the group at `path`: where its divider sits. */
export interface DividerBox { path: number[]; index: number; dir: Dir; rect: Rect }

type Axis = 'w' | 'h';
const axisOf = (dir: Dir): Axis => (dir === 'row' ? 'w' : 'h');

/** The smallest size `node` keeps along `axis` while there is room: a pane's minimum; a group, its children's. */
export function minSize(node: LayoutNode, axis: Axis): number {
  if (node.kind === 'pane') return axis === 'w' ? MIN_PANE_PX : MIN_PANE_H_PX;
  const mins = node.children.map((c) => minSize(c, axis));
  return axisOf(node.dir) === axis ? mins.reduce((a, b) => a + b, 0) + PANE_GAP_PX * (mins.length - 1) : Math.max(...mins);
}

/**
 * How much of `available` px each child gets: its share, children under their minimum raised to it and the difference
 * taken from the others in proportion to what they have above theirs; with less room than every minimum, plain shares.
 */
function allocate(sizes: readonly number[], mins: readonly number[], available: number): number[] {
  const target = sizes.map((s) => s * available);
  if (mins.reduce((a, b) => a + b, 0) >= available) return target;
  const deficit = target.reduce((a, t, i) => a + Math.max(0, mins[i]! - t), 0);
  if (deficit <= 0) return target;
  const excess = target.map((t, i) => Math.max(0, t - mins[i]!));
  const spare = excess.reduce((a, b) => a + b, 0);
  return target.map((t, i) => (t < mins[i]! ? mins[i]! : t - (deficit * excess[i]!) / spare));
}

interface Placed { panes: Rect[]; dividers: DividerBox[]; groups: Map<string, { rect: Rect; alloc: number[]; available: number; gap: number }> }

function place(node: LayoutNode, r: Rect, path: number[], out: Placed): void {
  if (node.kind === 'pane') { out.panes.push(r); return; }
  const n = node.children.length;
  const along = node.dir === 'row' ? r.w : r.h;
  // A body too small for every gap: the gaps go first, the panes keep what is left.
  const gap = n > 1 ? Math.min(PANE_GAP_PX, Math.floor(along / (n - 1))) : 0;
  const available = Math.max(0, along - gap * (n - 1));
  const alloc = allocate(node.sizes, node.children.map((c) => minSize(c, axisOf(node.dir))), available);
  out.groups.set(path.join('/'), { rect: r, alloc, available, gap });
  let cum = 0;
  node.children.forEach((c, i) => {
    const start = Math.round(cum) + i * gap;
    cum += alloc[i]!;
    const end = i === n - 1 ? available + i * gap : Math.round(cum) + i * gap;
    const child = node.dir === 'row' ? { x: r.x + start, y: r.y, w: end - start, h: r.h } : { x: r.x, y: r.y + start, w: r.w, h: end - start };
    place(c, child, [...path, i], out);
    if (i < n - 1) {
      const rect = node.dir === 'row' ? { x: r.x + end, y: r.y, w: gap, h: r.h } : { x: r.x, y: r.y + end, w: r.w, h: gap };
      out.dividers.push({ path, index: i, dir: node.dir, rect });
    }
  });
}

function placed(tree: LayoutNode, width: number, height: number): Placed {
  const out: Placed = { panes: [], dividers: [], groups: new Map() };
  place(tree, { x: 0, y: 0, w: Math.max(0, Math.round(width)), h: Math.max(0, Math.round(height)) }, [], out);
  return out;
}

/** Each pane's rectangle and each divider's, in px from the body's top left, for a body of `width` × `height`. */
export function layoutPanes(tree: LayoutNode, width: number, height: number): { panes: Rect[]; dividers: DividerBox[] } {
  const { panes, dividers } = placed(tree, width, height);
  return { panes, dividers };
}

/**
 * Divider `index` of the group at `path` dragged by `deltaPx`: only its two neighbours change, neither below its minimum;
 * the other children keep the size they are shown at. The same tree when the group has no room for every minimum, or
 * nothing moves.
 */
export function dragDivider(tree: LayoutNode, path: number[], index: number, deltaPx: number, width: number, height: number): LayoutNode {
  const g = placed(tree, width, height).groups.get(path.join('/'));
  let node: LayoutNode | undefined = tree;
  for (const i of path) node = node?.kind === 'group' ? node.children[i] : undefined;
  if (!g || !node || node.kind !== 'group' || index < 0 || index >= node.children.length - 1 || deltaPx === 0) return tree;
  const axis = axisOf(node.dir);
  const mins = node.children.map((c) => minSize(c, axis));
  if (g.available < mins.reduce((a, b) => a + b, 0)) return tree;
  const pair = g.alloc[index]! + g.alloc[index + 1]!;
  const left = Math.min(Math.max(g.alloc[index]! + deltaPx, mins[index]!), pair - mins[index + 1]!);
  const sizes = g.alloc.map((a, i) => (i === index ? left : i === index + 1 ? pair - left : a));
  return withSizes(tree, path, sizes);
}

/**
 * Whether a new pane fits on `side` of pane `pane` at the body size `area`: after the split (the insertion rule, equal
 * shares in the group it joins), every pane of that group is at least the floor along the split's direction. Without a
 * measured size (nothing laid out yet), yes.
 */
export function roomToSplit(tree: LayoutNode, pane: number, side: Side, area: { width: number; height: number } | null): boolean {
  if (!area) return true;
  const { tree: next, index } = insertBeside(tree, pane, side);
  if (index < 0) return false;
  const paths = panePaths(next);
  const group = paths[index]!.slice(0, -1);
  const rects = layoutPanes(next, area.width, area.height).panes;
  const row = side === 'left' || side === 'right';
  return paths.every((p, i) => !group.every((x, k) => p[k] === x) || (row ? rects[i]!.w >= SPLIT_FLOOR_W : rects[i]!.h >= SPLIT_FLOOR_H));
}

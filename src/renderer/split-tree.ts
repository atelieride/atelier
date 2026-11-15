// The split view's layout tree: how the workspace is cut into panes. A group cuts its space into a row (children side
// by side, left to right) or a column (stacked, top to bottom), each child with its share; a leaf is a pane. Pane `i`
// is the i-th leaf in depth-first order — the reading order — so the panes themselves can stay a flat list. Pure
// functions; every one that reshapes the tree returns it in normal form: no group with a single child, no group directly
// inside a group of the same direction, shares positive and summing to 1.

export type Dir = 'row' | 'column';
/** A side of a pane: where a new pane goes, where a neighbour is, where tabs move. */
export type Side = 'left' | 'right' | 'top' | 'bottom';
export interface Group { kind: 'group'; dir: Dir; children: LayoutNode[]; sizes: number[] }
export type LayoutNode = { kind: 'pane' } | Group;
/** A rectangle: position and size (fractions of the workspace, or pixels, depending on who made it). */
export interface Rect { x: number; y: number; w: number; h: number }

const EPS = 1e-6;
const equal = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

/** Shares scaled to sum 1; anything unusable (wrong length, not positive, not finite) becomes equal shares. */
function shares(sizes: readonly number[] | undefined, n: number): number[] {
  if (!sizes || sizes.length !== n || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return equal(n);
  const sum = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => s / sum);
}

const group = (dir: Dir, children: LayoutNode[], sizes?: readonly number[]): Group => ({ kind: 'group', dir, children, sizes: shares(sizes, children.length) });
const dirOf = (side: Side): Dir => (side === 'left' || side === 'right' ? 'row' : 'column');

export function leaf(): LayoutNode {
  return { kind: 'pane' };
}

/** `n` panes side by side (one: a leaf), with the given widths when they are usable, else equal ones. */
export function row(n: number, sizes?: readonly number[]): LayoutNode {
  if (n <= 1) return leaf();
  return group('row', Array.from({ length: n }, leaf), sizes);
}

export function leafCount(n: LayoutNode): number {
  return n.kind === 'pane' ? 1 : n.children.reduce((a, c) => a + leafCount(c), 0);
}

export function normalize(n: LayoutNode): LayoutNode {
  if (n.kind === 'pane') return n;
  const own = shares(n.sizes, n.children.length);
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c0, i) => {
    const c = normalize(c0);
    if (c.kind === 'group' && c.dir === n.dir) {
      c.children.forEach((cc, j) => { children.push(cc); sizes.push(own[i]! * c.sizes[j]!); });
    } else {
      children.push(c);
      sizes.push(own[i]!);
    }
  });
  if (children.length === 0) return leaf();
  if (children.length === 1) return children[0]!;
  return group(n.dir, children, sizes);
}

/** Every leaf's path (child indices from the root), in reading order. */
function leafPaths(n: LayoutNode, at: number[] = []): number[][] {
  return n.kind === 'pane' ? [at] : n.children.flatMap((c, i) => leafPaths(c, [...at, i]));
}

function nodeAt(n: LayoutNode, path: readonly number[]): LayoutNode | null {
  let cur: LayoutNode | undefined = n;
  for (const i of path) {
    if (!cur || cur.kind !== 'group') return null;
    cur = cur.children[i];
  }
  return cur ?? null;
}

/** The tree with the node at `path` replaced by `fn` of it (ancestors rebuilt, nothing normalized). */
function replaceAt(n: LayoutNode, path: readonly number[], fn: (old: LayoutNode) => LayoutNode): LayoutNode {
  if (path.length === 0) return fn(n);
  if (n.kind !== 'group') return n;
  const [i, ...rest] = path as [number, ...number[]];
  const child = n.children[i];
  if (!child) return n;
  const children = n.children.map((c, j) => (j === i ? replaceAt(child, rest, fn) : c));
  return { ...n, children };
}

/**
 * A new pane on `side` of pane `pane`. If the pane's group already runs in that direction, the new pane joins it next to
 * the pane; otherwise the pane is replaced by a new group of the two (which takes its place and share). The group the
 * new pane joins gets equal shares. `index`: the new pane's place in reading order (-1, tree unchanged: no such pane).
 */
export function insertBeside(tree: LayoutNode, pane: number, side: Side): { tree: LayoutNode; index: number } {
  const path = leafPaths(tree)[pane];
  if (!path) return { tree, index: -1 };
  const dir = dirOf(side);
  const after = side === 'right' || side === 'bottom';
  const parentPath = path.slice(0, -1);
  const parent = path.length > 0 ? nodeAt(tree, parentPath) : null;
  let next: LayoutNode;
  if (parent && parent.kind === 'group' && parent.dir === dir) {
    const at = path.at(-1)! + (after ? 1 : 0);
    next = replaceAt(tree, parentPath, () => {
      const children = [...parent.children.slice(0, at), leaf(), ...parent.children.slice(at)];
      return group(dir, children);
    });
  } else {
    next = replaceAt(tree, path, (old) => group(dir, after ? [old, leaf()] : [leaf(), old]));
  }
  return { tree: normalize(next), index: pane + (after ? 1 : 0) };
}

function rectsOf(n: LayoutNode, r: Rect, out: Rect[]): Rect[] {
  if (n.kind === 'pane') { out.push(r); return out; }
  let at = 0;
  n.children.forEach((c, i) => {
    const s = n.sizes[i]!;
    rectsOf(c, n.dir === 'row' ? { x: r.x + at * r.w, y: r.y, w: s * r.w, h: r.h } : { x: r.x, y: r.y + at * r.h, w: r.w, h: s * r.h }, out);
    at += s;
  });
  return out;
}

/** Each pane's rectangle in the unit square (no gaps, no minimums): the geometry neighbours are found on. */
export function fractionalRects(tree: LayoutNode): Rect[] {
  return rectsOf(tree, { x: 0, y: 0, w: 1, h: 1 }, []);
}

/** How much `b` lies along `a`'s `side` (touching it): the length of their shared edge, 0 when they don't touch. */
function sharedEdge(a: Rect, b: Rect, side: Side): number {
  const touches = side === 'right' ? Math.abs(b.x - (a.x + a.w)) < EPS
    : side === 'left' ? Math.abs(b.x + b.w - a.x) < EPS
      : side === 'bottom' ? Math.abs(b.y - (a.y + a.h)) < EPS
        : Math.abs(b.y + b.h - a.y) < EPS;
  return touches ? spanOverlap(a, b, side) : 0;
}

/** The overlap of two rectangles across `side`'s axis: vertical spans for left/right, horizontal ones for top/bottom. */
function spanOverlap(a: Rect, b: Rect, side: Side): number {
  return dirOf(side) === 'row'
    ? Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
    : Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
}

/** The best of `candidates` by `score` (higher wins), ties to the top-most, then the left-most; null for none. */
function best(candidates: number[], rects: Rect[], score: (i: number) => number): number | null {
  let pick: number | null = null;
  for (const i of candidates) {
    if (pick === null) { pick = i; continue; }
    const d = score(i) - score(pick);
    const a = rects[i]!;
    const b = rects[pick]!;
    if (d > EPS || (Math.abs(d) <= EPS && (a.y < b.y - EPS || (Math.abs(a.y - b.y) <= EPS && a.x < b.x - EPS)))) pick = i;
  }
  return pick;
}

/**
 * The pane that takes pane `pane`'s tabs and space when it closes (old indices): its sibling before it in its group
 * (left or above), else the one after; a sibling that is a group gives its pane sharing the longest edge with the closing
 * one (ties: top-most, then left-most). `to`: where that pane is, seen from the closing one. Null for the only pane.
 */
export function receiverOf(tree: LayoutNode, pane: number): { pane: number; to: Side } | null {
  const paths = leafPaths(tree);
  const path = paths[pane];
  if (!path || path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(tree, parentPath) as Group;
  const idx = path.at(-1)!;
  const sib = idx > 0 ? idx - 1 : idx + 1;
  const to: Side = parent.dir === 'row' ? (sib < idx ? 'left' : 'right') : (sib < idx ? 'top' : 'bottom');
  const sibPath = [...parentPath, sib];
  const inSibling = paths.map((p, i) => (sibPath.every((x, k) => p[k] === x) ? i : -1)).filter((i) => i >= 0);
  if (inSibling.length === 1) return { pane: inSibling[0]!, to };
  const rects = fractionalRects(tree);
  const touching = inSibling.filter((i) => sharedEdge(rects[pane]!, rects[i]!, to) > EPS);
  const pick = best(touching.length ? touching : inSibling, rects, (i) => sharedEdge(rects[pane]!, rects[i]!, to));
  return { pane: pick!, to };
}

/**
 * Pane `pane` removed: its share goes to the sibling `receiverOf` names, groups left with one child collapse.
 * `receiver`: the receiving pane's index in the new tree (null when it was the only pane, which stays).
 */
export function removeLeaf(tree: LayoutNode, pane: number): { tree: LayoutNode; receiver: number | null } {
  const r = receiverOf(tree, pane);
  const path = leafPaths(tree)[pane];
  if (!r || !path) return { tree, receiver: null };
  const parentPath = path.slice(0, -1);
  const idx = path.at(-1)!;
  const sib = idx > 0 ? idx - 1 : idx + 1;
  const next = replaceAt(tree, parentPath, (p) => {
    const g = p as Group;
    const sizes = g.sizes.map((s, i) => (i === sib ? s + g.sizes[idx]! : s)).filter((_, i) => i !== idx);
    return { ...g, children: g.children.filter((_, i) => i !== idx), sizes };
  });
  return { tree: normalize(next), receiver: r.pane > pane ? r.pane - 1 : r.pane };
}

/**
 * The pane next to `pane` on `side`: of those touching that side, the one sharing the most of its span (ties: top-most,
 * then left-most). None there: with `wrap`, the farthest pane on the opposite side among those overlapping its span
 * (with columns only, right of the last pane is the first); else null.
 */
export function neighbour(tree: LayoutNode, pane: number, side: Side, wrap: boolean): number | null {
  const rects = fractionalRects(tree);
  const p = rects[pane];
  if (!p) return null;
  const others = rects.map((_, i) => i).filter((i) => i !== pane);
  const touching = others.filter((i) => sharedEdge(p, rects[i]!, side) > EPS);
  if (touching.length) return best(touching, rects, (i) => sharedEdge(p, rects[i]!, side));
  if (!wrap) return null;
  const across = others.filter((i) => spanOverlap(p, rects[i]!, side) > EPS);
  const far = (i: number) => {
    const r = rects[i]!;
    return side === 'right' ? -r.x : side === 'left' ? r.x + r.w : side === 'bottom' ? -r.y : r.y + r.h;
  };
  // Farthest first; among equally far, the most overlap.
  return best(across, rects, (i) => far(i) * 1e3 + spanOverlap(p, rects[i]!, side));
}

/** The pane touching the top-right corner. */
export function topRight(tree: LayoutNode): number {
  const rects = fractionalRects(tree);
  const i = rects.findIndex((r) => r.y < EPS && Math.abs(r.x + r.w - 1) < EPS);
  return Math.max(0, i);
}

/** The shares of the group at `path`; null when there is no group there. */
export function sizesAt(tree: LayoutNode, path: readonly number[]): number[] | null {
  const n = nodeAt(tree, path);
  return n && n.kind === 'group' ? n.sizes : null;
}

const sameSizes = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < 1e-12);

/** The group at `path` with new shares (scaled to sum 1); the same tree when they are unusable or unchanged. */
export function withSizes(tree: LayoutNode, path: readonly number[], sizes: readonly number[]): LayoutNode {
  const n = nodeAt(tree, path);
  if (!n || n.kind !== 'group' || sizes.length !== n.children.length || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return tree;
  const next = shares(sizes, sizes.length);
  if (sameSizes(next, n.sizes)) return tree;
  return replaceAt(tree, path, (g) => ({ ...(g as Group), sizes: next }));
}

/** Equal shares in the group at `path`, or in every group when no path is given; the same tree when nothing changes. */
export function equalized(tree: LayoutNode, path?: readonly number[]): LayoutNode {
  if (path) {
    const n = nodeAt(tree, path);
    return n && n.kind === 'group' ? withSizes(tree, path, equal(n.children.length)) : tree;
  }
  if (tree.kind === 'pane') return tree;
  const children = tree.children.map((c) => equalized(c));
  const sizes = equal(children.length);
  if (children.every((c, i) => c === tree.children[i]) && sameSizes(sizes, tree.sizes)) return tree;
  return { ...tree, children, sizes };
}

/**
 * Whether `raw` (whatever storage returned) is a usable tree of at most `maxLeaves` panes: known kinds and directions,
 * groups of two or more children with positive shares summing to 1.
 */
export function isLayoutNode(raw: unknown, maxLeaves: number): raw is LayoutNode {
  let leaves = 0;
  const ok = (n: unknown): boolean => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return false;
    const o = n as Record<string, unknown>;
    if (o.kind === 'pane') { leaves++; return leaves <= maxLeaves; }
    if (o.kind !== 'group' || (o.dir !== 'row' && o.dir !== 'column')) return false;
    if (!Array.isArray(o.children) || !Array.isArray(o.sizes) || o.children.length < 2 || o.sizes.length !== o.children.length) return false;
    const sizes = o.sizes as unknown[];
    if (sizes.some((s) => typeof s !== 'number' || !Number.isFinite(s) || s <= 0)) return false;
    if (Math.abs((sizes as number[]).reduce((a, b) => a + b, 0) - 1) > 0.01) return false;
    return o.children.every(ok);
  };
  return ok(raw);
}

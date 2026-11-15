import { describe, expect, test } from 'vitest';
import {
  equalized, fractionalRects, insertBeside, isLayoutNode, leaf, leafCount, neighbour, normalize, receiverOf, removeLeaf, row, sizesAt, topRight, withSizes,
  type LayoutNode, type Rect
} from './split-tree';

// The layout tree of the split view: groups cut their space in rows or columns; pane i is the i-th leaf, depth first.

const L: LayoutNode = { kind: 'pane' };
const R = (children: LayoutNode[], sizes = children.map(() => 1 / children.length)): LayoutNode => ({ kind: 'group', dir: 'row', children, sizes });
const C = (children: LayoutNode[], sizes = children.map(() => 1 / children.length)): LayoutNode => ({ kind: 'group', dir: 'column', children, sizes });
const near = (xs: number[] | null, ys: number[]) => { expect(xs).not.toBeNull(); expect(xs!.length).toBe(ys.length); xs!.forEach((x, i) => expect(x).toBeCloseTo(ys[i]!, 6)); };
const rect = (r: Rect | undefined, x: number, y: number, w: number, h: number) => { near(r ? [r.x, r.y, r.w, r.h] : null, [x, y, w, h]); };
const grid = () => R([C([L, L]), C([L, L])]);

describe('building', () => {
  test('a leaf is one pane; row(n) is n panes side by side with equal or given widths', () => {
    expect(leaf()).toEqual(L);
    expect(leafCount(leaf())).toBe(1);
    expect(row(1)).toEqual(L);
    expect(row(3)).toEqual(R([L, L, L]));
    near(sizesAt(row(2, [3, 1]), []), [0.75, 0.25]);
    near(sizesAt(row(2, [0, 1]), []), [0.5, 0.5]);
    expect(leafCount(grid())).toBe(4);
  });
});

describe('normal form', () => {
  test('a one-child group becomes its child; a row inside a row is spliced with scaled sizes', () => {
    expect(normalize(R([L]))).toEqual(L);
    const t = normalize(R([L, R([L, L], [0.5, 0.5])], [0.5, 0.5]));
    expect(t).toMatchObject({ kind: 'group', dir: 'row' });
    expect(leafCount(t)).toBe(3);
    near(sizesAt(t, []), [0.5, 0.25, 0.25]);
  });
  test('sizes are scaled to sum 1; unusable ones become equal shares', () => {
    near(sizesAt(normalize(R([L, L], [2, 6])), []), [0.25, 0.75]);
    near(sizesAt(normalize(C([L, L], [Number.NaN, 1])), []), [0.5, 0.5]);
  });
});

describe('insertBeside', () => {
  test('right of the only pane makes a row of two halves', () => {
    const r = insertBeside(L, 0, 'right');
    expect(r.tree).toEqual(R([L, L]));
    expect(r.index).toBe(1);
  });
  test('left and top put the new pane first', () => {
    expect(insertBeside(L, 0, 'left').index).toBe(0);
    const r = insertBeside(L, 0, 'top');
    expect(r.tree).toEqual(C([L, L]));
    expect(r.index).toBe(0);
  });
  test('bottom of pane 1 in a row of two wraps that pane in a column', () => {
    const r = insertBeside(R([L, L]), 1, 'bottom');
    expect(r.tree).toEqual(R([L, C([L, L])]));
    expect(r.index).toBe(2);
  });
  test('into a same-direction group: equal shares in that group', () => {
    const r = insertBeside(R([L, L], [0.7, 0.3]), 0, 'right');
    expect(leafCount(r.tree)).toBe(3);
    near(sizesAt(r.tree, []), [1 / 3, 1 / 3, 1 / 3]);
    expect(r.index).toBe(1);
  });
  test('the wrapping group takes the place and size of the pane it wraps', () => {
    const r = insertBeside(R([L, L], [0.7, 0.3]), 0, 'bottom');
    expect(r.tree).toMatchObject({ kind: 'group', dir: 'row' });
    near(sizesAt(r.tree, []), [0.7, 0.3]);
    near(sizesAt(r.tree, [0]), [0.5, 0.5]);
    expect(r.index).toBe(1);
  });
});

describe('receiver and removal', () => {
  test('left sibling first, then right; a group sibling gives its pane with the longest shared edge', () => {
    const t = R([L, C([L, L], [0.6, 0.4])]);
    expect(receiverOf(t, 0)).toEqual({ pane: 1, to: 'right' });
    expect(receiverOf(t, 1)).toEqual({ pane: 2, to: 'bottom' });
    expect(receiverOf(t, 2)).toEqual({ pane: 1, to: 'top' });
    expect(receiverOf(R([L, L, L]), 1)).toEqual({ pane: 0, to: 'left' });
    expect(receiverOf(L, 0)).toBeNull();
  });
  test('a tie on the shared edge goes to the top-most pane', () => {
    expect(receiverOf(R([L, C([L, L])]), 0)).toEqual({ pane: 1, to: 'right' });
    expect(receiverOf(C([R([L, L]), L]), 2)).toEqual({ pane: 0, to: 'top' });
  });
  test('removeLeaf collapses groups and keeps normal form; the size goes to the receiving sibling', () => {
    const r = removeLeaf(R([L, C([L, L])]), 1);
    expect(r.tree).toEqual(R([L, L]));
    expect(r.receiver).toBe(1);
    const s = removeLeaf(R([L, L, L], [0.2, 0.3, 0.5]), 1);
    near(sizesAt(s.tree, []), [0.5, 0.5]);
    expect(s.receiver).toBe(0);
    const u = removeLeaf(R([C([L, L]), L], [0.5, 0.5]), 2);
    expect(u.tree).toEqual(C([L, L]));
    expect(u.receiver).toBe(0);
  });
  test('removing the only pane leaves a leaf and no receiver', () => {
    expect(removeLeaf(L, 0)).toEqual({ tree: L, receiver: null });
  });
  test('removing a pane next to a nested group splices the group into the parent', () => {
    // row[A, column[B, row[C, D]]] minus B: column has one child left (row), which joins the outer row.
    const r = removeLeaf(R([L, C([L, R([L, L])])]), 1);
    expect(r.tree).toEqual(R([L, L, L], [0.5, 0.25, 0.25]));
    expect(r.receiver).toBe(1);
  });
});

describe('geometry', () => {
  test('fractionalRects tile the unit square', () => {
    const rs = fractionalRects(R([L, C([L, L], [0.25, 0.75])], [0.4, 0.6]));
    expect(rs).toHaveLength(3);
    rect(rs[0], 0, 0, 0.4, 1);
    rect(rs[1], 0.4, 0, 0.6, 0.25);
    rect(rs[2], 0.4, 0.25, 0.6, 0.75);
  });
  test('neighbour: overlap wins, ties go top-most; wrap returns the farthest pane in the span', () => {
    const g = grid();
    expect(neighbour(g, 0, 'right', false)).toBe(2);
    expect(neighbour(g, 0, 'bottom', false)).toBe(1);
    expect(neighbour(g, 3, 'left', false)).toBe(1);
    expect(neighbour(g, 0, 'top', true)).toBe(1);
    expect(neighbour(g, 0, 'top', false)).toBeNull();
    const three = R([L, L, L]);
    expect(neighbour(three, 2, 'right', true)).toBe(0);
    expect(neighbour(three, 2, 'right', false)).toBeNull();
    expect(neighbour(three, 0, 'left', true)).toBe(2);
    expect(neighbour(R([L, C([L, L])]), 0, 'right', false)).toBe(1);
    expect(neighbour(R([L, C([L, L], [0.3, 0.7])]), 0, 'right', false)).toBe(2);
    expect(neighbour(L, 0, 'right', true)).toBeNull();
  });
  test('topRight is the pane touching the top-right corner', () => {
    expect(topRight(R([L, C([L, L])]))).toBe(1);
    expect(topRight(C([R([L, L]), L]))).toBe(1);
    expect(topRight(L)).toBe(0);
    expect(topRight(grid())).toBe(2);
  });
});

describe('sizes', () => {
  test('sizesAt and withSizes address a group by its path; invalid sizes change nothing', () => {
    const t = R([L, C([L, L])]);
    near(sizesAt(t, [1]), [0.5, 0.5]);
    expect(sizesAt(t, [0])).toBeNull();
    expect(sizesAt(t, [5])).toBeNull();
    const u = withSizes(t, [1], [0.2, 0.8]);
    near(sizesAt(u, [1]), [0.2, 0.8]);
    near(sizesAt(u, []), [0.5, 0.5]);
    expect(withSizes(t, [1], [1, 0])).toBe(t);
    expect(withSizes(t, [1], [0.5])).toBe(t);
    expect(withSizes(t, [0], [0.5, 0.5])).toBe(t);
  });
  test('equalized: one group by path, or every group', () => {
    const t = R([L, C([L, L], [0.2, 0.8])], [0.7, 0.3]);
    const one = equalized(t, [1]);
    near(sizesAt(one, []), [0.7, 0.3]);
    near(sizesAt(one, [1]), [0.5, 0.5]);
    const all = equalized(t);
    near(sizesAt(all, []), [0.5, 0.5]);
    near(sizesAt(all, [1]), [0.5, 0.5]);
    const even = R([L, L]);
    expect(equalized(even)).toBe(even);
  });
});

describe('isLayoutNode', () => {
  test('accepts a normal tree within the limit', () => {
    expect(isLayoutNode(R([L, C([L, L])]), 4)).toBe(true);
    expect(isLayoutNode(L, 4)).toBe(true);
  });
  test('rejects too many leaves, bad sizes, one-child groups, unknown kinds', () => {
    expect(isLayoutNode(R([L, L, L, L, L]), 4)).toBe(false);
    expect(isLayoutNode({ kind: 'group', dir: 'row', children: [L, L], sizes: [0.5] }, 4)).toBe(false);
    expect(isLayoutNode({ kind: 'group', dir: 'row', children: [L, L], sizes: [0.5, -0.5] }, 4)).toBe(false);
    expect(isLayoutNode({ kind: 'group', dir: 'row', children: [L, L], sizes: [0.2, 0.2] }, 4)).toBe(false);
    expect(isLayoutNode({ kind: 'group', dir: 'row', children: [L], sizes: [1] }, 4)).toBe(false);
    expect(isLayoutNode({ kind: 'group', dir: 'diagonal', children: [L, L], sizes: [0.5, 0.5] }, 4)).toBe(false);
    expect(isLayoutNode({ kind: 'box' }, 4)).toBe(false);
    expect(isLayoutNode(null, 4)).toBe(false);
    expect(isLayoutNode('pane', 4)).toBe(false);
  });
});

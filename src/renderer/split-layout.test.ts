import { describe, expect, test } from 'vitest';
import {
  dragDivider, layoutPanes, minSize, roomToSplit, MIN_PANE_H_PX, MIN_PANE_PX, PANE_GAP_PX, SPLIT_FLOOR_H, SPLIT_FLOOR_W, DIVIDER_STEP_PX
} from './split-layout';
import { insertBeside, leaf, leafCount, sizesAt, type LayoutNode, type Rect, type Side } from './split-tree';

// The split view in pixels: the layout tree laid out over the workspace body.

const L: LayoutNode = { kind: 'pane' };
const R = (children: LayoutNode[], sizes = children.map(() => 1 / children.length)): LayoutNode => ({ kind: 'group', dir: 'row', children, sizes });
const C = (children: LayoutNode[], sizes = children.map(() => 1 / children.length)): LayoutNode => ({ kind: 'group', dir: 'column', children, sizes });

/** A small seeded generator, so a failing case can be replayed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const SIDES: Side[] = ['left', 'right', 'top', 'bottom'];
function randomTree(rand: () => number): LayoutNode {
  let t: LayoutNode = leaf();
  const n = 1 + Math.floor(rand() * 4);
  for (let k = 1; k < n; k++) t = insertBeside(t, Math.floor(rand() * leafCount(t)), SIDES[Math.floor(rand() * 4)]!).tree;
  const shuffle = (node: LayoutNode): LayoutNode => (node.kind === 'pane' ? node : {
    ...node, children: node.children.map(shuffle), sizes: (() => { const xs = node.children.map(() => 0.05 + rand()); const s = xs.reduce((a, b) => a + b, 0); return xs.map((x) => x / s); })()
  });
  return shuffle(t);
}
const area = (r: Rect) => r.w * r.h;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

describe('constants', () => {
  test('minimums, floor, gap and keyboard step', () => {
    expect([MIN_PANE_PX, MIN_PANE_H_PX, PANE_GAP_PX, SPLIT_FLOOR_W, SPLIT_FLOOR_H, DIVIDER_STEP_PX]).toEqual([240, 180, 1, 160, 140, 24]);
  });
});

describe('layoutPanes', () => {
  test('tiles exactly: no gap, no overlap, nothing outside, at any size', () => {
    const rand = prng(20261115);
    const sizes: [number, number][] = [[1, 1], [59, 37], [342, 554], [1180, 840], [6000, 4000]];
    for (let k = 0; k < 300; k++) {
      const t = randomTree(rand);
      for (const [w, h] of sizes) {
        const { panes, dividers } = layoutPanes(t, w, h);
        expect(panes).toHaveLength(leafCount(t));
        const all = [...panes, ...dividers.map((d) => d.rect)];
        for (const r of all) {
          for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
          expect(r.w).toBeGreaterThanOrEqual(0);
          expect(r.h).toBeGreaterThanOrEqual(0);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(w);
          expect(r.y + r.h).toBeLessThanOrEqual(h);
        }
        for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!)).toBe(0);
        expect(all.reduce((a, r) => a + area(r), 0)).toBe(w * h);
      }
    }
  });
  test('fractional sizes from the body are rounded first', () => {
    const { panes } = layoutPanes(R([L, L]), 800.6, 600.4);
    expect(panes[1]!.x + panes[1]!.w).toBe(801);
    expect(panes[0]!.h).toBe(600);
  });
  test('honours minimums when there is room; with less, the minimums shrink together, so no pane is starved', () => {
    expect(layoutPanes(R([L, L], [0.1, 0.9]), 1000, 600).panes.map((r) => r.w)).toEqual([240, 759]);
    expect(layoutPanes(C([L, L], [0.1, 0.9]), 800, 1000).panes.map((r) => r.h)).toEqual([180, 819]);
    // 299 px for two 240 px minimums: each pane gets half, whatever its share.
    expect(layoutPanes(R([L, L], [0.1, 0.9]), 300, 600).panes.map((r) => r.w)).toEqual([150, 149]);
    expect(layoutPanes(R([L, L], [2 / 3, 1 / 3]), 343, 600).panes.map((r) => r.w)).toEqual([171, 171]);
    // A three-pane column at 299 px of room (minimums 3 × 180): each pane gets a third, the gaps their pixel.
    expect(layoutPanes(C([L, L, L], [0.6, 0.2, 0.2]), 800, 301).panes.map((r) => r.h)).toEqual([100, 99, 100]);
  });
  test('a nested column\'s minimum height is the sum of its children\'s; across, the largest child\'s', () => {
    expect(minSize(C([L, L]), 'h')).toBe(2 * 180 + 1);
    expect(minSize(C([L, L]), 'w')).toBe(240);
    expect(minSize(R([L, C([L, L])]), 'w')).toBe(2 * 240 + 1);
    expect(minSize(R([L, C([L, L])]), 'h')).toBe(361);
    expect(minSize(L, 'w')).toBe(240);
  });
  test('dividers: one per gap, spanning the group\'s cross extent', () => {
    const { panes, dividers } = layoutPanes(R([L, C([L, L])]), 1001, 601);
    expect(panes).toEqual([{ x: 0, y: 0, w: 500, h: 601 }, { x: 501, y: 0, w: 500, h: 300 }, { x: 501, y: 301, w: 500, h: 300 }]);
    expect(dividers).toEqual([
      { path: [], index: 0, dir: 'row', rect: { x: 500, y: 0, w: 1, h: 601 } },
      { path: [1], index: 0, dir: 'column', rect: { x: 501, y: 300, w: 500, h: 1 } }
    ]);
  });
  test('one pane takes the whole body, without dividers', () => {
    expect(layoutPanes(L, 640, 480)).toEqual({ panes: [{ x: 0, y: 0, w: 640, h: 480 }], dividers: [] });
  });
});

describe('dragDivider', () => {
  test('moves the two neighbours, clamped to their minimums, and leaves the other children alone', () => {
    const t = R([L, L, L]);
    const d = dragDivider(t, [], 0, 2000, 1200, 800);
    const shown = layoutPanes(d, 1200, 800).panes.map((r) => r.w);
    expect(shown[1]).toBe(240);
    expect(sizesAt(d, [])![2]).toBeCloseTo(1 / 3, 6);
    const back = dragDivider(t, [], 1, -100, 1200, 800);
    expect(layoutPanes(back, 1200, 800).panes.map((r) => r.w)).toEqual([399, 300, 499]);
  });
  test('a horizontal divider resizes the stacked panes of its group only', () => {
    const t = R([L, C([L, L])]);
    const d = dragDivider(t, [1], 0, 100, 1001, 801);
    expect(sizesAt(d, [])).toEqual(sizesAt(t, []));
    const [, top, bottom] = layoutPanes(d, 1001, 801).panes;
    expect(top!.h).toBe(500);
    expect(bottom!.h).toBe(300);
  });
  test('in a group squeezed below its minimums it returns the same tree', () => {
    const t = R([L, L, L]);
    expect(dragDivider(t, [], 0, 50, 500, 600)).toBe(t);
  });
  test('an unknown path or index returns the same tree; no movement returns the same tree', () => {
    const t = R([L, L]);
    expect(dragDivider(t, [3], 0, 50, 1000, 600)).toBe(t);
    expect(dragDivider(t, [], 1, 50, 1000, 600)).toBe(t);
    expect(dragDivider(t, [], 0, 0, 1000, 600)).toBe(t);
  });
});

describe('roomToSplit', () => {
  test('uses the floor at the current size', () => {
    const a = { width: 342, height: 554 };
    expect(roomToSplit(L, 0, 'right', a)).toBe(true);
    expect(roomToSplit(R([L, L]), 0, 'right', a)).toBe(false);
    expect(roomToSplit(R([L, L]), 0, 'bottom', a)).toBe(true);
    expect(roomToSplit(C([L, L, L]), 2, 'bottom', a)).toBe(false);
    expect(roomToSplit(C([L, L]), 1, 'bottom', a)).toBe(true);
  });
  test('only the group the new pane joins is checked', () => {
    // Three stacked on the left (about 184 px each), one on the right: the right one can still be stacked in two.
    const t = R([C([L, L, L]), L]);
    const a = { width: 342, height: 554 };
    expect(roomToSplit(t, 3, 'bottom', a)).toBe(true);
    expect(roomToSplit(t, 0, 'bottom', a)).toBe(false);
    expect(roomToSplit(t, 3, 'right', a)).toBe(false);
  });
  test('without a measured size, a split is allowed', () => {
    expect(roomToSplit(C([L, L, L]), 2, 'bottom', null)).toBe(true);
  });
});

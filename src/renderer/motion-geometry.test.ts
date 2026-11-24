import { expect, test } from 'vitest';
import { arc, bezierAt, clippedShift, crownKeyframes, markPlates, plateTargets, revealOrigin, type Box } from './motion-geometry';

const col = (x: number): Box => ({ x, y: 0, w: 100, h: 200 });

test('markPlates lays the three plates out like the mark, back first, scaled to the box', () => {
  expect(markPlates({ x: 0, y: 0, w: 72, h: 72 })).toEqual([
    { x: 4, y: 22, w: 40, h: 40 },
    { x: 16, y: 16, w: 40, h: 40 },
    { x: 28, y: 10, w: 40, h: 40 }
  ]);
  expect(markPlates({ x: 10, y: 20, w: 36, h: 36 })[0]).toEqual({ x: 12, y: 31, w: 20, h: 20 });
});

test('plateTargets maps plates to columns in x order, folding extra plates onto the first columns', () => {
  const plates = markPlates({ x: 0, y: 0, w: 72, h: 72 });
  const [a, b, c] = [col(0), col(100), col(200)];
  expect(plateTargets([c, a, b], plates, null)).toEqual([a, b, c]);
  expect(plateTargets([b, a], plates, null)).toEqual([a, a, b]);
  expect(plateTargets([a], plates, null)).toEqual([a, a, a]);
});

test('plateTargets with a welcome box sends every plate to that box\'s mark', () => {
  const plates = markPlates({ x: 0, y: 0, w: 72, h: 72 });
  const welcome = { x: 100, y: 50, w: 144, h: 144 };
  expect(plateTargets([col(0)], plates, welcome)).toEqual(markPlates(welcome));
});

test('crownKeyframes stretches over both spans in the middle, either direction', () => {
  const right = crownKeyframes({ left: 0, width: 80 }, { left: 120, width: 60 });
  expect(right).toHaveLength(3);
  expect(right[0]).toMatchObject({ left: '0px', width: '80px' });
  expect(right[1]).toEqual({ left: '0px', width: '180px', offset: 0.45 });
  expect(right[2]).toMatchObject({ left: '120px', width: '60px' });
  expect(crownKeyframes({ left: 120, width: 60 }, { left: 0, width: 80 })[1]).toEqual({ left: '0px', width: '180px', offset: 0.45 });
});

test('arc returns n + 1 points from p0 to p2', () => {
  const pts = arc([0, 0], [100, 50], 4);
  expect(pts).toHaveLength(5);
  expect(pts[0]).toEqual([0, 0]);
  expect(pts[4]).toEqual([100, 50]);
  // midpoint of the quadratic with control [70, 80]
  expect(pts[2]).toEqual([0.25 * 0 + 0.5 * 70 + 0.25 * 100, 0.5 * 80 + 0.25 * 50]);
});

test('revealOrigin sits at the row\'s middle on the slot\'s left edge, clamped to the slot', () => {
  const slot = { x: 0, y: 100, w: 300, h: 200 };
  expect(revealOrigin(slot, { x: 0, y: 150, w: 10, h: 20 })).toEqual([0, 60]);
  expect(revealOrigin(slot, { x: 0, y: 0, w: 10, h: 20 })).toEqual([0, 0]);
  expect(revealOrigin(slot, { x: 0, y: 900, w: 10, h: 20 })).toEqual([0, 200]);
});

test('bezierAt reads a CSS cubic-bezier curve at a point in time', () => {
  // The linear curve is its own time; every curve starts at 0 and ends at 1.
  for (const x of [0, 0.25, 0.5, 0.9, 1]) expect(bezierAt([0, 0, 1, 1], x)).toBeCloseTo(x, 6);
  expect(bezierAt([0.3, 1.7, 0.45, 1], 0)).toBeCloseTo(0, 6);
  expect(bezierAt([0.3, 1.7, 0.45, 1], 1)).toBeCloseTo(1, 6);
  // An elastic curve goes past its end before it settles.
  expect(Math.max(...Array.from({ length: 50 }, (_, i) => bezierAt([0.3, 1.7, 0.45, 1], i / 49)))).toBeGreaterThan(1.05);
});

test('clippedShift: from its shift back to rest along the curve, every step clipped to the element\'s own box', () => {
  const kf = clippedShift('x', 48, [0.3, 1.7, 0.45, 1]);
  expect(kf[0]).toEqual({ offset: 0, transform: 'translateX(48px)', clipPath: 'inset(0px 48px 0px 0px)' });
  expect(kf.at(-1)).toEqual({ offset: 1, transform: 'translateX(0px)', clipPath: 'inset(0px 0px 0px 0px)' });
  // Past its place (the overshoot, towards the line it was split off on): what passes the near edge is cut.
  const past = kf.find((k) => parseFloat(/translateX\((-?[\d.]+)px\)/.exec(k.transform as string)![1]!) < -3);
  expect(past).toBeDefined();
  // At every step the clip takes off exactly what the move puts outside the box, on that side.
  for (const k of kf) {
    const d = parseFloat(/translateX\((-?[\d.]+)px\)/.exec(k.transform as string)![1]!);
    const [, right, , left] = /inset\(([^)]*)\)/.exec(k.clipPath as string)![1]!.split(' ').map(parseFloat);
    expect(right).toBeCloseTo(Math.max(d, 0), 2);
    expect(left).toBeCloseTo(Math.max(-d, 0), 2);
  }
  // Up and down alike: shifted down, its bottom is cut; past its place upwards, its top.
  const down = clippedShift('y', 48, [0.3, 1.7, 0.45, 1]);
  expect(down[0]).toEqual({ offset: 0, transform: 'translateY(48px)', clipPath: 'inset(0px 0px 48px 0px)' });
  expect(down.some((k) => /^inset\([1-9][\d.]*px 0px 0px 0px\)$/.test(k.clipPath as string))).toBe(true);
  // From the other side (a pane put before its neighbour): its left is cut first.
  expect(clippedShift('x', -48, [0.3, 1.7, 0.45, 1])[0]).toEqual({ offset: 0, transform: 'translateX(-48px)', clipPath: 'inset(0px 0px 0px 48px)' });
});

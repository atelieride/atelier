// Pure geometry for the launch animation and the in-app transitions. No DOM: callers
// measure elements and pass plain boxes in, and get plain numbers or keyframes back.

export type Box = { x: number; y: number; w: number; h: number };
export type Pt = [number, number];

// The three plates of the logo mark, back to front, as [x, y] in its 72-unit square
// (each plate is 40 units square).
const PLATE_ORIGINS: Pt[] = [[4, 22], [16, 16], [28, 10]];
const PLATE_SIZE = 40;
const MARK_SIZE = 72;

/** The mark's three plates inside `mark`, back first, scaled to its width. */
export function markPlates(mark: Box): Box[] {
  const s = mark.w / MARK_SIZE;
  return PLATE_ORIGINS.map(([x, y]) => ({ x: mark.x + x * s, y: mark.y + y * s, w: PLATE_SIZE * s, h: PLATE_SIZE * s }));
}

/**
 * Where each plate lands. With a welcome mark on screen they all land on it; otherwise
 * they land on the columns, left to right, the front plate on the last column. With
 * fewer columns than plates the back plates share the first column.
 */
export function plateTargets(columns: Box[], plates: Box[], welcome: Box | null): Box[] {
  if (welcome) return markPlates(welcome).slice(0, plates.length);
  const sorted = [...columns].sort((a, b) => a.x - b.x);
  const extra = plates.length - sorted.length;
  return plates.map((_, i) => sorted[Math.max(0, i - extra)]!);
}

/** The tab crown's move: it stretches over both tabs midway, then settles on the new one. */
export function crownKeyframes(from: { left: number; width: number }, to: { left: number; width: number }): Keyframe[] {
  const left = Math.min(from.left, to.left);
  const right = Math.max(from.left + from.width, to.left + to.width);
  return [
    { left: `${from.left}px`, width: `${from.width}px` },
    { left: `${left}px`, width: `${right - left}px`, offset: 0.45 },
    { left: `${to.left}px`, width: `${to.width}px` }
  ];
}

/** `n + 1` points of a quadratic curve from p0 to p2 that bows below both ends by `lift`. */
export function arc(p0: Pt, p2: Pt, n: number, lift = 30): Pt[] {
  const c: Pt = [p0[0] + 70, Math.max(p0[1], p2[1]) + lift];
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const d = t * t;
    return [a * p0[0] + b * c[0] + d * p2[0], a * p0[1] + b * c[1] + d * p2[1]] as Pt;
  });
}

/** Where a circular reveal starts inside `slot`: its left edge, level with `row`'s middle, kept within the slot. */
export function revealOrigin(slot: Box, row: Box): Pt {
  const y = row.y + row.h / 2 - slot.y;
  return [0, Math.min(Math.max(y, 0), slot.h)];
}

/** A CSS cubic-bezier(x1, y1, x2, y2) timing function's value at time `x` (0…1). */
export function bezierAt([x1, y1, x2, y2]: readonly [number, number, number, number], x: number): number {
  const at = (a: number, b: number, t: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  // x(t) only climbs for a timing function (x1, x2 within 0…1): halve towards the t whose x is `x`.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) / 2;
    if (at(x1, x2, t) < x) lo = t; else hi = t;
  }
  return at(y1, y2, (lo + hi) / 2);
}

/**
 * A move from `shift` px along `axis` back to rest on `curve`, in `steps` linear steps, each with the clip that keeps
 * what moves inside its own box. A clip moves with its element, so each step cuts what the move puts past the box:
 * shifted right (down), its right (bottom) side; past its place the other way (a curve that overshoots), the other.
 */
export function clippedShift(axis: 'x' | 'y', shift: number, curve: readonly [number, number, number, number], steps = 32): Keyframe[] {
  const px = (v: number) => `${Math.abs(v) < 0.005 ? 0 : +v.toFixed(2)}px`;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const offset = i / steps;
    const d = shift * (1 - bezierAt(curve, offset));
    const far = Math.max(d, 0);
    const near = Math.max(-d, 0);
    return axis === 'x'
      ? { offset, transform: `translateX(${px(d)})`, clipPath: `inset(0px ${px(far)} 0px ${px(near)})` }
      : { offset, transform: `translateY(${px(d)})`, clipPath: `inset(${px(near)} 0px ${px(far)} 0px)` };
  });
}

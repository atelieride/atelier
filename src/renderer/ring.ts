/** Dash of an SVG ring of radius r filled to pct (0..100): out-of-range or non-numeric values are clamped. */
export function ringDash(pct: number, r: number): { dasharray: string; dashoffset: number } {
  const c = 2 * Math.PI * r;
  const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  return { dasharray: `${c.toFixed(2)} ${c.toFixed(2)}`, dashoffset: c * (1 - p / 100) };
}

/** Used context is shown at any value once the status line sent one: the ring lives only in the session bar, where every value is useful. */
export function showContext(pct: number | null): pct is number {
  return pct !== null;
}

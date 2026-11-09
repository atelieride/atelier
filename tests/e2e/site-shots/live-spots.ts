// "Live" spots of a website screenshot: where the app animates something the site can replay exactly on top of the
// still image. Since the quiet finish the only one is the waiting pane's bright
// hairline breathing over its calm one; the dots and rings that breathe dim themselves, which a layer over an image
// cannot do, so they stay still in the shots.

export type SpotKind = 'glow';

/** A spot as measured in the app window, in CSS px; `r` is its border radius (px, or CSS text like "50%"/"8px"). */
export interface MeasuredSpot { kind: SpotKind; x: number; y: number; w: number; h: number; r: number | string }

/** A spot in the captured area's coordinates, radius in px. */
export interface LiveSpot { kind: SpotKind; x: number; y: number; w: number; h: number; r: number }

export interface LiveSpots { width: number; height: number; spots: LiveSpot[] }

function radiusPx(r: number | string, w: number, h: number): number {
  if (typeof r === 'number') return r;
  const n = parseFloat(r) || 0;
  return r.trim().endsWith('%') ? (n / 100) * Math.min(w, h) : n;
}

/** The app's selectors for each kind of animation (src/renderer/layout.css). */
export const LIVE_SELECTORS: Record<SpotKind, string> = {
  glow: '.workspace-body.is-waiting, .pane-frame.is-waiting'
};

const tenth = (n: number) => Math.round(n * 10) / 10;

/** The spots fully inside the captured area, in its own coordinates (CSS px, rounded to tenths). */
export function liveSpots(measured: MeasuredSpot[], area: { x: number; y: number; width: number; height: number }): LiveSpots {
  const spots = measured
    .filter((s) => s.w > 0 && s.h > 0 && s.x >= area.x && s.y >= area.y && s.x + s.w <= area.x + area.width && s.y + s.h <= area.y + area.height)
    .map((s) => ({ kind: s.kind, x: tenth(s.x - area.x), y: tenth(s.y - area.y), w: tenth(s.w), h: tenth(s.h), r: tenth(radiusPx(s.r, s.w, s.h)) }));
  return { width: area.width, height: area.height, spots };
}

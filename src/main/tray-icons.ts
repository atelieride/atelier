import type { AttentionKind } from './dock-menu';

// The tray's pixels, drawn in code like the taskbar badge (win-shell.ts): no
// image files to keep in step with the tokens. Premultiplied BGRA bitmaps, as nativeImage.createFromBitmap wants them.

export type Rgb = [number, number, number];

/** Aurora's state colours (theme.css `--waiting`, `--error`, `--done`; a test checks them). */
export const TRAY_COLOURS: Record<AttentionKind, Rgb> = { waiting: [0xFB, 0xBF, 0x24], error: [0xFB, 0x71, 0x85], done: [0x34, 0xD3, 0x99] };

const clamp = (a: number) => Math.max(0, Math.min(1, a));
// One pixel of anti-aliasing at an edge `d` away from a shape of radius `r`.
const cover = (r: number, d: number) => clamp(r - d + 0.5);

function paint(size: number, pixel: (x: number, y: number) => { rgb: Rgb; a: number } | null): Buffer {
  const b = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = pixel(x + 0.5, y + 0.5);
      if (!p || p.a <= 0) continue;
      const i = (y * size + x) * 4;
      // Premultiplied, as Skia reads a bitmap: a straight colour at partial alpha would draw a bright fringe.
      b[i] = Math.round(p.rgb[2] * p.a); b[i + 1] = Math.round(p.rgb[1] * p.a); b[i + 2] = Math.round(p.rgb[0] * p.a); b[i + 3] = Math.round(p.a * 255);
    }
  }
  return b;
}

const segment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Aurora's --bg-0: the Λ on macOS's disc.
const INK: Rgb = [0x08, 0x08, 0x0F];

// The Λ's coverage at (x, y): apex, feet and half stroke in a 32-unit square scaled by `u`.
type Lambda = { apex: readonly [number, number]; left: readonly [number, number]; right: readonly [number, number]; half: number };
const lambda = (x: number, y: number, u: number, g: Lambda) => cover(g.half * u, Math.min(
  segment(x, y, g.apex[0] * u, g.apex[1] * u, g.left[0] * u, g.left[1] * u),
  segment(x, y, g.apex[0] * u, g.apex[1] * u, g.right[0] * u, g.right[1] * u)));
const FULL: Lambda = { apex: [16, 5], left: [6, 27], right: [26, 27], half: 2.2 };
// macOS's disc, one unit below the middle of its square: the menu bar's glyphs sit a little low, and centred it read
// as raised next to them. The Λ inside it, smaller.
const DISC = { x: 16, y: 17, r: 15 };
const INNER: Lambda = { apex: [16, 9], left: [9.6, 23], right: [22.4, 23], half: 1.9 };

const mix = (under: Rgb, over: Rgb, a: number): Rgb => [0, 1, 2].map((i) => under[i]! + (over[i]! - under[i]!) * a) as Rgb;

/**
 * Atelier's Λ (no crossbar) in `ink`, as Windows' notification area shows it: neutral, with `dot` a state-coloured dot
 * in the bottom-right corner, the Λ cut away around it (Teams' and Slack's pattern).
 */
export function markBitmap(size: number, o: { ink: Rgb; dot?: Rgb }): Buffer {
  const u = size / 32;
  const dot = { x: 26 * u, y: 26 * u, r: 5.5 * u, gap: 2.5 * u };
  return paint(size, (x, y) => {
    let a = lambda(x, y, u, FULL);
    if (!o.dot) return { rgb: o.ink, a };
    const d = Math.hypot(x - dot.x, y - dot.y);
    const inDot = cover(dot.r, d);
    if (inDot > 0) return { rgb: o.dot, a: inDot };
    a *= clamp(d - (dot.r + dot.gap) + 0.5);
    return { rgb: o.ink, a };
  });
}

/**
 * macOS's menu bar mark: a disc in the state's colour with Atelier's dark Λ inside. The menu bar is transparent over the
 * wallpaper, so a coloured Λ alone vanishes on a wallpaper of its own hue; the dark Λ reads on any, and a dark rim keeps
 * the disc's edge.
 */
export function discBitmap(size: number, colour: Rgb): Buffer {
  const u = size / 32;
  return paint(size, (x, y) => {
    const d = Math.hypot(x - DISC.x * u, y - DISC.y * u);
    const a = cover(DISC.r * u, d);
    if (a <= 0) return null;
    const rim = a - cover((DISC.r - 1) * u, d);
    return { rgb: mix(mix(colour, INK, rim * 0.45), INK, lambda(x, y, u, INNER)), a };
  });
}

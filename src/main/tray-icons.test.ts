import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { TRAY_COLOURS, discBitmap, markBitmap, type Rgb } from './tray-icons';

// The tray's pixels: BGRA bitmaps, as nativeImage.createFromBitmap wants them.

const at = (b: Buffer, size: number, x: number, y: number) => [...b.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
const bgra = ([r, g, b]: Rgb) => [b, g, r, 255];

test('the state colours are Aurora\'s tokens', () => {
  const css = readFileSync(resolve(__dirname, '../renderer/theme.css'), 'utf8');
  const token = (name: string) => { const m = new RegExp(`--${name}:\\s*#([0-9A-Fa-f]{6})`).exec(css)!; return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)); };
  expect(TRAY_COLOURS.waiting).toEqual(token('waiting'));
  expect(TRAY_COLOURS.error).toEqual(token('error'));
  expect(TRAY_COLOURS.done).toEqual(token('done'));
});

test('the Windows mark: a Λ with no crossbar, in the ink colour', () => {
  const ink: Rgb = [255, 255, 255];
  const b = markBitmap(32, { ink });
  // Apex and both feet are drawn; the middle of the base is empty (no crossbar), and so are the top corners.
  expect(at(b, 32, 16, 6)).toEqual(bgra(ink));
  expect(at(b, 32, 7, 26)[3]).toBe(255);
  expect(at(b, 32, 25, 26)[3]).toBe(255);
  expect(at(b, 32, 16, 24)[3]).toBe(0);
  expect(at(b, 32, 0, 0)[3]).toBe(0);
  expect(at(b, 32, 31, 0)[3]).toBe(0);
});

test('the Windows mark with a dot: the dot in the bottom-right corner, a clear gap between it and the Λ', () => {
  const b = markBitmap(32, { ink: [255, 255, 255], dot: TRAY_COLOURS.error });
  expect(at(b, 32, 25, 25)).toEqual(bgra(TRAY_COLOURS.error));
  // Where the right foot ran, just outside the dot: cut away.
  const gap = at(b, 32, 22, 20);
  expect(gap[3]).toBe(0);
  // Without the dot that pixel is the Λ.
  expect(at(markBitmap(32, { ink: [255, 255, 255] }), 32, 22, 20)[3]).toBe(255);
});

test('the macOS mark: a disc in the state colour, Atelier\'s dark Λ inside, a dark rim against a same-coloured wallpaper', () => {
  const amber = TRAY_COLOURS.waiting;
  const b = discBitmap(32, amber);
  // Inside the disc, below the Λ's open base: the state colour, opaque.
  expect(at(b, 32, 15, 26)).toEqual(bgra(amber));
  // The Λ's apex: Aurora's --bg-0, not the state colour.
  expect(at(b, 32, 15, 9)).toEqual(bgra([0x08, 0x08, 0x0F]));
  // The middle of the base: no crossbar.
  expect(at(b, 32, 15, 21)).toEqual(bgra(amber));
  // The rim: the state colour darkened (premultiplied, at the disc's anti-aliased edge).
  const [rb, rg, rr, ra] = at(b, 32, 15, 2);
  expect(ra).toBeGreaterThan(240);
  expect(rr!).toBeLessThan(amber[0] - 60);
  expect(rr! > rg! && rg! > rb!).toBe(true);
  // Outside the disc: empty.
  expect(at(b, 32, 0, 0)[3]).toBe(0);
  expect(at(b, 32, 31, 31)[3]).toBe(0);
});

test('the macOS mark sits one unit below the middle, where the menu bar\'s glyphs sit: its top row empty, its bottom row drawn', () => {
  const b = discBitmap(32, TRAY_COLOURS.done);
  expect(at(b, 32, 15, 0)[3]).toBe(0);
  expect(at(b, 32, 15, 1)[3]).toBeLessThan(128);
  expect(at(b, 32, 15, 31)[3]).toBeGreaterThan(128);
});

test('pixels are premultiplied by their alpha, as Skia reads a bitmap: no bright fringe on anti-aliased edges', () => {
  for (const b of [markBitmap(32, { ink: TRAY_COLOURS.done }), markBitmap(32, { ink: [255, 255, 255], dot: TRAY_COLOURS.waiting }), discBitmap(32, TRAY_COLOURS.error)]) {
    let edges = 0;
    for (let i = 0; i < b.length; i += 4) {
      const a = b[i + 3]!;
      if (a === 0 || a === 255) continue;
      edges++;
      expect(Math.max(b[i]!, b[i + 1]!, b[i + 2]!)).toBeLessThanOrEqual(a);
    }
    expect(edges).toBeGreaterThan(0);
  }
});

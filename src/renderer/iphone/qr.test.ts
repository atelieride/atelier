import { expect, test } from 'vitest';
import { correction, generate } from 'lean-qr/nano';
import { qrPath } from './qr';

const URL_TEXT = 'atelier://pair?v=1&c=7K4Q9MXD2HTR&r=https%3A%2F%2Frelay.useatelier.dev&k=' + 'A'.repeat(43) + '&n=Studio';

/** The modules the path paints, read back from its rectangles. */
function painted(d: string, n: number): boolean[][] {
  const grid = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, w, back] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    expect(back).toBe(w);
    for (let i = 0; i < w; i++) grid[y]![x + i] = true;
  }
  return grid;
}

test('the path paints exactly the dark modules of the code, nothing else', () => {
  const { size, d } = qrPath(URL_TEXT);
  const code = generate(URL_TEXT, { minCorrectionLevel: correction.M });
  expect(size).toBe(code.size);
  const grid = painted(d, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) expect(grid[y]![x], `${x},${y}`).toBe(code.get(x, y));
  // A pairing URL of this length fits a code a phone camera reads at arm's length.
  expect(size).toBeLessThanOrEqual(73);
});

test('the three finder patterns are where a reader looks for them', () => {
  const { size, d } = qrPath(URL_TEXT);
  const grid = painted(d, size);
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
    // A 7×7 dark ring, a light ring, a 3×3 dark core.
    for (let i = 0; i < 7; i++) {
      expect(grid[oy]![ox + i]).toBe(true);
      expect(grid[oy + 6]![ox + i]).toBe(true);
      expect(grid[oy + i]![ox]).toBe(true);
      expect(grid[oy + i]![ox + 6]).toBe(true);
    }
    expect(grid[oy + 1]![ox + 1]).toBe(false);
    expect(grid[oy + 3]![ox + 3]).toBe(true);
  }
});

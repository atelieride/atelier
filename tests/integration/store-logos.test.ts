import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Committed PNGs rendered from assets/brand/app-icon.svg
// (scripts/render-store-logos.cjs), with the qualifiers makepri indexes: scale-100/200/400 for every logo, and
// targetsize-16…256 plain and altform-unplated for Square44x44Logo (taskbar, Start, File Explorer without a plate).
const root = join(__dirname, '../..');
const manifest = readFileSync(join(root, 'build/appx/AppxManifest.xml'), 'utf8');
const assets = join(root, 'build/appx/assets');

/** Base size (scale-100) of each logo the manifest may name. */
const BASE: Record<string, number> = { StoreLogo: 50, Square44x44Logo: 44, Square150x150Logo: 150 };
const SCALES = [100, 200, 400];
const TARGET_SIZES = [16, 24, 32, 48, 256];

function named(): string[] {
  const store = /<Logo>assets\\(\w+)\.png<\/Logo>/.exec(manifest)?.[1];
  const visual = [...manifest.matchAll(/\b(Square\d+x\d+Logo)="assets\\(\w+)\.png"/g)].map((m) => { expect(m[2]).toBe(m[1]); return m[2]!; });
  return [store!, ...visual];
}

function expected(): Map<string, number> {
  const files = new Map<string, number>();
  for (const name of named()) {
    for (const s of SCALES) files.set(`${name}.scale-${s}.png`, (BASE[name]! * s) / 100);
    if (name === 'Square44x44Logo') for (const t of TARGET_SIZES) {
      files.set(`${name}.targetsize-${t}.png`, t);
      files.set(`${name}.targetsize-${t}_altform-unplated.png`, t);
    }
  }
  return files;
}

test('the manifest names the Store logo, the 44×44 and the 150×150 logos (no wide tile)', () => {
  expect(named().sort()).toEqual(['Square150x150Logo', 'Square44x44Logo', 'StoreLogo']);
  expect(manifest).not.toContain('Wide310x150Logo');
});

test('every logo the manifest names exists at every scale and target size, a PNG of the right size with alpha', () => {
  const files = expected();
  expect(files.size).toBe(3 * 3 + 10);
  for (const [file, size] of files) {
    const png = readFileSync(join(assets, file));
    expect(png.subarray(0, 8).toString('hex'), file).toBe('89504e470d0a1a0a');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], file).toEqual([size, size]);
    // Colour type 6: RGBA (transparent around the tile).
    expect(png[25], file).toBe(6);
  }
});

test('nothing else in build/appx/assets (an unqualified copy would clash with scale-100 in makepri)', () => {
  expect(readdirSync(assets).sort()).toEqual([...expected().keys()].sort());
});

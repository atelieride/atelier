import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const root = join(__dirname, '../..');

test('app icon: 1024×1024 PNG (the dev Dock icon and the source of the icns)', () => {
  const png = readFileSync(join(root, 'build/icon.png'));
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.readUInt32BE(16)).toBe(1024);
  expect(png.readUInt32BE(20)).toBe(1024);
});

// macOS 26 draws an icon that is not an Icon Composer one shrunk inside a gray tile. electron-builder compiles the
// .icon with actool (Xcode 26) into Assets.car, plus the icns for older macOS (actool's, not electron-builder's own
// png → icns, whose PNG-in-icp4/icp5 small sizes Finder draws garbled).
test('app icon: an Icon Composer package, brand gradient behind a glass Λ, used by electron-builder', () => {
  const pkg = join(root, 'build/AppIcon.icon');
  const manifest = JSON.parse(readFileSync(join(pkg, 'icon.json'), 'utf8')) as {
    fill: { 'linear-gradient': string[]; orientation: { start: object; stop: object } };
    groups: { layers: { 'image-name': string; glass?: boolean }[] }[];
    'supported-platforms': { squares: unknown };
  };
  // Violet #8B5CF6 → pink #EC4899, as --brand.
  expect(manifest.fill['linear-gradient']).toEqual(['srgb:0.54510,0.36078,0.96471,1.00000', 'srgb:0.92549,0.28235,0.60000,1.00000']);
  expect(manifest.fill.orientation.start).toBeDefined();
  const layers = manifest.groups.flatMap((g) => g.layers);
  expect(layers.length).toBeGreaterThan(0);
  for (const l of layers) expect(readFileSync(join(pkg, 'Assets', l['image-name']), 'utf8'), l['image-name']).toMatch(/^<svg[^>]+viewBox="0 0 1024 1024"/);
  expect(layers.some((l) => l.glass)).toBe(true);
  expect(manifest['supported-platforms'].squares).toBeDefined();
  expect(readFileSync(join(root, 'electron-builder.yml'), 'utf8')).toMatch(/icon: build\/AppIcon\.icon/);
  // A single source: no stale hand-made icns next to it.
  expect(existsSync(join(root, 'build/icon.icns'))).toBe(false);
});

test('font and icon licenses ship with the app', () => {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  expect(yml).toMatch(/extraResources:\n\s+- from: assets\/licenses/);
  for (const f of ['OFL-InstrumentSans.txt', 'OFL-JetBrainsMono.txt', 'OFL-Poppins.txt', 'MIT-seti-icons.txt']) expect(readFileSync(join(root, 'assets/licenses', f), 'utf8').length).toBeGreaterThan(100);
});

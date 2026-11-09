import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseThemeCss } from '../../src/shared/theme-resolve';
// @ts-expect-error: .mjs script without types
import { APP_ICONS as APP_ICONS_UNTYPED, iconSourcePrint as iconSourcePrintUntyped } from '../../scripts/render-app-icon-sources.mjs';

const APP_ICONS = APP_ICONS_UNTYPED as [string, string][];
const iconSourcePrint = iconSourcePrintUntyped as (dir: string) => string;

// The Docsy app icon: its Icon Composer source wears the light Docsy theme's mark
// colors, and the PNG the app ships is a full 1024×1024 RGBA icon.
const root = join(__dirname, '..', '..');
const docsy = parseThemeCss(readFileSync(join(root, 'src/renderer/themes-docsy.css'), 'utf8')).docsy!;

/** `srgb:0.18824,0.35686,0.67059,1.00000` → `#305BAB`. */
const hex = (srgb: string) => '#' + srgb.replace(/^srgb:/, '').split(',').slice(0, 3)
  .map((c) => Math.round(Number(c) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

test('AppIcon-Docsy.icon: the fill runs from the theme\'s --violet to --pink, the Λ in --mark-lambda, the rest as AppIcon.icon', () => {
  const icon = JSON.parse(readFileSync(join(root, 'build/AppIcon-Docsy.icon/icon.json'), 'utf8')) as { fill: { 'linear-gradient': string[] } };
  expect(icon.fill['linear-gradient'].map(hex)).toEqual([docsy['--violet'], docsy['--pink']]);
  const lambda = readFileSync(join(root, 'build/AppIcon-Docsy.icon/Assets/lambda.svg'), 'utf8');
  expect([...lambda.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]!.toUpperCase())).toEqual([docsy['--mark-lambda'], docsy['--mark-lambda']]);
  // Same glass, shadow, translucency and shape: only the colors differ from Aurora's icon.
  const aurora = JSON.parse(readFileSync(join(root, 'build/AppIcon.icon/icon.json'), 'utf8')) as Record<string, unknown>;
  expect({ ...icon, fill: null }).toEqual({ ...aurora, fill: null });
  expect(lambda.replace(/#[0-9A-Fa-f]{6}/g, '')).toBe(readFileSync(join(root, 'build/AppIcon.icon/Assets/lambda.svg'), 'utf8').replace(/#[0-9A-Fa-f]{6}/g, ''));
});

// Aurora's image is the bundle's own icon drawn the same way: the Dock gets it back from Docsy while Atelier runs, since
// macOS answers a reset (null) with a stale copy of the custom icon just removed.
for (const name of ['app-icon-docsy.png', 'app-icon-aurora.png']) {
  test(`${name}: 1024×1024, 8-bit RGBA, under 2 MB`, () => {
    const file = join(root, 'assets/brand', name);
    const png = readFileSync(file);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([1024, 1024, 8, 6]);
    expect(statSync(file).size).toBeLessThan(2 * 1024 * 1024);
  });

  test(`the packaged app carries ${name} in Contents/Resources`, () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    expect(yml).toContain(`- from: assets/brand/${name}\n    to: ${name}`);
  });
}

test('each image was rendered from its Icon Composer source as it is now (rerun scripts/render-app-icons.mjs after an .icon change)', () => {
  expect(APP_ICONS).toEqual([['AppIcon.icon', 'app-icon-aurora.png'], ['AppIcon-Docsy.icon', 'app-icon-docsy.png']]);
  const prints = JSON.parse(readFileSync(join(root, 'assets/brand/app-icon-sources.json'), 'utf8')) as Record<string, string>;
  expect(prints).toEqual(Object.fromEntries(APP_ICONS.map(([source, png]) => [png, iconSourcePrint(join(root, 'build', source))])));
});

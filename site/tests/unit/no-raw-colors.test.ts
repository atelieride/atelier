import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const src = new URL('../../src/', import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name)) : /\.(astro|ts|css)$/.test(e.name) ? [join(dir, e.name)] : []);

// Aurora, the design system: raw values live in src/renderer/theme.css and, for the site, only in site.css's token
// block and config.ts's theme colour (a meta tag cannot read CSS).
test('components and scripts use tokens, never raw colours', () => {
  const offenders = files(src)
    .filter((f) => !f.endsWith('styles/site.css') && !f.endsWith('src/config.ts'))
    .flatMap((f) => (readFileSync(f, 'utf8').match(/#[0-9a-fA-F]{3,8}\b(?![-\w])|rgba?\(\s*\d/g) ?? []).map((m) => `${f.slice(src.length)}: ${m}`));
  expect(offenders).toEqual([]);
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

// The app only knows useatelier.dev. Where the releases live (today GitHub Releases in atelieride/atelier) is the
// endpoint's business, so it can move without touching installed apps.
const root = join(__dirname, '../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

test('no GitHub releases address is baked into the app', () => {
  const found = sources(join(root, 'src')).flatMap((f) => {
    const text = readFileSync(f, 'utf8');
    return [/api\.github\.com/, /github\.com\/[\w.-]+\/[\w.-]+\/releases/, /atelier-releases/].filter((re) => re.test(text)).map((re) => `${relative(root, f)}: ${re.source}`);
  });
  expect(found).toEqual([]);
});

test('the update errors name the update server, not GitHub: the app no longer talks to GitHub first', async () => {
  const { t } = await import('../../src/renderer/i18n/en');
  for (const [kind, text] of Object.entries(t.upd.errors)) expect(text, kind).not.toMatch(/GitHub/);
  const download = readFileSync(join(root, 'src/main/update-download.ts'), 'utf8');
  expect(download).not.toMatch(/'GitHub rate limit/);
});

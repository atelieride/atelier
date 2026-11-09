import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parseChangelog } from '../../src/lib/changelog';

const releases = parseChangelog(readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8'));

test('changelog: one card per published version, newest first, betas marked, markdown rendered', async ({ page }) => {
  await page.goto('/changelog');
  const cards = page.locator('.release');
  await expect(cards).toHaveCount(releases.length);
  await expect(cards.first().locator('h2')).toHaveText(releases[0]!.version);
  if (releases[0]!.beta) await expect(cards.first().locator('.beta')).toBeVisible();
  await expect(cards.first().locator('strong').first()).toBeVisible(); // **bold** became <strong>
  await expect(page.locator('body')).not.toContainText('Not published');
});

test('a long code block or a wide table in the changelog scrolls inside its card on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/changelog');
  await page.locator('.release .body').first().evaluate((body) => {
    body.insertAdjacentHTML('beforeend', `<pre><code>${'npm run something-very-long --with --many --flags '.repeat(4)}</code></pre><table><tr>${'<td>a wide table cell with words</td>'.repeat(6)}</tr></table>`);
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('unknown paths get the 404 page in the same style', async ({ page }) => {
  const res = await page.goto('/nope');
  expect(res!.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lost the session?');
  await expect(page.getByRole('link', { name: 'Back home' })).toHaveAttribute('href', '/');
});

test('share and icon metadata', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://useatelier.dev/og.png');
  // What chat apps need to draw a large card right away: size, type, alt text, site name; X reads its own tags.
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
  await expect(page.locator('meta[property="og:image:type"]')).toHaveAttribute('content', 'image/png');
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', /Atelier/);
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content', 'Atelier');
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', 'https://useatelier.dev/og.png');
  await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', /Atelier/);
  for (const p of ['/og.png', '/apple-touch-icon.png']) expect((await page.request.get(p)).status(), p).toBe(200);
});

test('visual check: changelog and 404', async ({ page }) => {
  for (const [w, h, name] of [[1440, 900, 'desktop'], [375, 812, 'phone']] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [path, file] of [['/changelog', 'changelog'], ['/nope', '404']] as const) {
      await page.goto(path);
      await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((e) => e.classList.add('is-in')));
      await page.waitForTimeout(700);
      await page.screenshot({ path: `test-results/${file}-${name}.png`, fullPage: true });
    }
  }
});

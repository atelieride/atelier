import { expect, test } from '@playwright/test';

test('at launch: indexable, the macOS button links the DMG with its version and the Apple mark, Windows is one quiet line to /download', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  const hero = page.locator('.hero');
  const mac = hero.locator('a[data-download]');
  await expect(mac).toHaveAttribute('href', /^\/download\/mac(\/beta)?$/);
  await expect(mac).toContainText('Download for macOS');
  await expect(mac.locator('.ver')).toHaveText(/^v\d+\.\d+\.\d+(-beta\.\d+)?$/);
  await expect(mac.locator('svg[data-icon="apple"]')).toHaveCount(1);
  // One button, the Mac's: Windows is a quiet line under it, to its card on /download (the Store button is there).
  for (const where of ['.hero', '.final']) {
    await expect(page.locator(`${where} a.also`), where).toHaveAttribute('href', '/download#windows');
    await expect(page.locator(`${where} a.also`), where).toHaveText('Also on Windows→');
  }
  await expect(page.locator('[data-platform="windows"]')).toHaveCount(0);
  await expect(hero.locator('.lead')).not.toContainText('macOS');
  // No requirements line under the downloads: Your Mac, /download and the FAQ say them.
  await expect(hero.locator('.fine')).toHaveCount(0);
  await expect(hero).not.toContainText('Apple Silicon');
  await expect(page.locator('footer')).toContainText('Made by Francesco Musso');
  await expect(page.locator('footer')).toContainText('not affiliated with Anthropic');
  // On /download the Windows card links the Microsoft Store; its mark is four filled tiles (outlines do not read as Windows).
  await page.goto('/download');
  const win = page.locator('[data-platform="windows"]').first();
  await expect(win).toHaveAttribute('href', '/download/windows');
  const fills = await win.locator('svg rect').evaluateAll((rs) => rs.map((r) => [getComputedStyle(r).fill, getComputedStyle(r).stroke]));
  expect(fills).toHaveLength(4);
  for (const [fill, stroke] of fills) { expect(fill).not.toBe('none'); expect(stroke).toBe('none'); }
  expect(errors).toEqual([]);
});

test('robots.txt and the sitemap are served', async ({ request }) => {
  expect(await (await request.get('/robots.txt')).text()).toContain('Sitemap: https://useatelier.dev/sitemap.xml');
  expect(await (await request.get('/sitemap.xml')).text()).toContain('<loc>https://useatelier.dev/download</loc>');
});

// WCAG AA for small text: 4.5:1 against the page background (--bg-0 #08080F; the cards are darker or equal).
test('small print (requirements, file name, legal line) meets AA contrast', async ({ page }) => {
  const lum = ([r, g, b]: number[]) => {
    const c = [r!, g!, b!].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const bg = lum([8, 8, 15]);
  for (const path of ['/', '/download']) {
    await page.goto(path);
    const colors = await page.locator('.fine, .legal').evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
    expect(colors.length, path).toBeGreaterThan(0);
    for (const color of colors) {
      const fg = lum(color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number));
      expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), `${path} ${color}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('no page logs an error', async ({ page }) => {
  for (const path of ['/', '/download', '/changelog', '/nope']) {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');
    // The 404 page's own status is reported by Chromium as a failed resource: that one is expected.
    expect(errors.filter((e) => !(path === '/nope' && /status of 404/.test(e))), path).toEqual([]);
  }
});

test('the 404 page is never indexed and names no canonical URL', async ({ page }) => {
  await page.goto('/nope');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});

test('the code on GitHub: the header and the footer link it on every page, the hero says it with a wink', async ({ page }) => {
  const repo = 'https://github.com/atelieride/atelier';
  await page.goto('/');
  const pill = page.locator('.hero a.oss');
  await expect(pill).toHaveAttribute('href', repo);
  await expect(pill).toHaveText('Open source·Peek behind the panes→');
  await expect(pill.locator('svg')).toHaveCount(1);
  for (const path of ['/', '/features', '/privacy']) {
    await page.goto(path);
    const ext = page.locator('header nav a.ext');
    await expect(ext, path).toHaveAttribute('href', repo);
    await expect(ext, path).toHaveText('github↗');
    const footer = page.locator('footer');
    await expect(footer.locator('a.github'), path).toHaveAttribute('href', 'https://github.com/atelieride/atelier');
    await expect(footer.locator('a.github'), path).toHaveText('GitHub');
    await expect(footer.locator('.fine a'), path).toHaveText('MIT license');
    await expect(footer.locator('.fine a'), path).toHaveAttribute('href', 'https://github.com/atelieride/atelier/blob/main/LICENSE');
  }
});

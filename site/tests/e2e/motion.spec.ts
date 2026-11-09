import { expect, test } from '@playwright/test';

// The last block of each page with scroll reveals (the home's questions; /features' last article).
const LAST = [['/', 'Questions'], ['/features', 'Close the app. Your sessions keep going.']] as const;

test('with reduced motion every section is visible without scrolling into it', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  for (const [path, heading] of LAST) {
    await page.goto(path);
    const opacity = await page.getByRole('heading', { name: heading }).evaluate((h) => getComputedStyle(h.closest('[data-reveal]')!).opacity);
    expect(opacity, path).toBe('1');
  }
  await ctx.close();
});

test('with reduced motion the hero window is flat and whole (nothing cut by the hero edge)', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/');
  const frame = (await page.locator('.hero .frame').boundingBox())!;
  const hero = (await page.locator('.hero').boundingBox())!;
  expect(frame.y + frame.height).toBeLessThanOrEqual(hero.y + hero.height);
  expect(await page.locator('.hero .frame').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
  await ctx.close();
});

test('the hero screenshot is flat (sharp) at the top of the page, motion on', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000); // the entrance has run
  expect(await page.locator('.hero .frame').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
});

test('without JavaScript nothing is hidden', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  for (const [path, heading] of LAST) {
    await page.goto(path);
    const opacity = await page.getByRole('heading', { name: heading }).evaluate((h) => getComputedStyle(h.closest('[data-reveal]')!).opacity);
    expect(opacity, path).toBe('1');
  }
  await ctx.close();
});

test('with motion, sections reveal as they scroll in', async ({ page }) => {
  for (const [path, heading] of LAST) {
    await page.goto(path);
    const block = page.getByRole('heading', { name: heading }).locator('xpath=ancestor::*[@data-reveal][1]');
    await expect(block, path).not.toHaveClass(/is-in/);
    await block.scrollIntoViewIfNeeded();
    await expect(block, path).toHaveClass(/is-in/);
  }
});

test('on a phone, content keeps a 16 px gutter from the screen edges', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const [path, selector] of [['/', '.split .copy'], ['/', '.tile'], ['/features', 'article.feature .text'], ['/features', 'nav.toc'], ['/download', '.card']] as const) {
    await page.goto(path);
    const box = (await page.locator(selector).first().boundingBox())!;
    expect(box.x, `${path} ${selector}`).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width, `${path} ${selector}`).toBeLessThanOrEqual(375 - 16);
  }
});

test('a revealed tile keeps its own quick hover transition (the reveal never overrides it)', async ({ page }) => {
  await page.goto('/');
  const tile = page.locator('.tile').first();
  await tile.scrollIntoViewIfNeeded();
  await expect(tile).toHaveClass(/is-in/);
  const t = await tile.evaluate((e) => { const s = getComputedStyle(e); return { prop: s.transitionProperty, dur: s.transitionDuration }; });
  expect(t.prop).toContain('border-color');
  expect(t.dur.split(',').map((d) => parseFloat(d))).not.toContain(0.6);
});

test('no horizontal scroll on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ['/', '/features', '/download', '/changelog']) {
    const res = await page.goto(path);
    expect(res!.status(), path).toBe(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(375);
  }
});

import { expect, test } from '@playwright/test';

test('a macOS card with requirements and the DMG, a Windows card with requirements and the Store, three steps, updates', async ({ page }) => {
  await page.goto('/download');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Download Atelier');
  const mac = page.locator('.platform.mac');
  await expect(mac).toContainText('Apple Silicon');
  await expect(mac).toContainText('macOS 13 Ventura');
  await expect(mac).toContainText('Claude Code');
  await expect(mac).toContainText('Notarized');
  await expect(mac.locator('.file')).toContainText(/Atelier-\d+\.\d+\.\d+(-beta\.\d+)?-arm64\.dmg/);
  await expect(mac.locator('a[data-download]')).toHaveAttribute('href', /^\/download\/mac(\/beta)?$/);
  const win = page.locator('.platform.windows');
  await expect(win.getByRole('heading')).toContainText('Windows');
  await expect(win).toHaveAttribute('id', 'windows'); // the home's "Also on Windows" lands here
  await expect(win.locator('[data-platform="windows"]')).toHaveAttribute('href', '/download/windows');
  await expect(win).toContainText('Windows 10 (2004)');
  await expect(win).toContainText('PowerShell');
  await expect(win).toContainText('Git for Windows');
  await expect(win).toContainText('Microsoft Store');
  await expect(page.getByRole('link', { name: /What’s new in/ })).toHaveAttribute('href', '/changelog');
  await expect(page.locator('.steps li')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'If macOS blocks Atelier' })).toHaveCount(0);
  await expect(page.locator('.updates')).toContainText('without closing your sessions');
});

test('a shortcut\'s keycaps stay on one line on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/download');
  const tops = await page.locator('.steps kbd').evaluateAll((ks) => ks.map((k) => Math.round(k.getBoundingClientRect().top)));
  expect(tops.length).toBe(2);
  expect(tops[0]).toBe(tops[1]);
});

test('visual check: download page', async ({ page }) => {
  for (const [w, h, name] of [[1440, 900, 'desktop'], [375, 812, 'phone']] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/download');
    await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((e) => e.classList.add('is-in')));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/download-${name}.png`, fullPage: true });
  }
});

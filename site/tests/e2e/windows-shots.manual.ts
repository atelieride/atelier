import { test } from '@playwright/test';

// Manual (not in npm run e2e): shots of the pages the Windows launch changes, to look at before a deploy.
const OUT = process.env.SHOTS_DIR ?? 'test-results/windows-shots';

test('hero, download and support with the Windows app in the Store', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [name, path, sel] of [['hero', '/', '.hero'], ['download', '/download', '.grid'], ['support', '/support', '.costs']] as const) {
    await page.goto(path);
    await page.locator(sel).scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.locator(sel).screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/download');
  await page.locator('.platform.windows').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.locator('.platform.windows').screenshot({ path: `${OUT}/download-phone.png`, animations: 'disabled' });
});

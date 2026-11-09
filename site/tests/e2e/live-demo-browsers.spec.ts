import { expect, test, type Page } from '@playwright/test';

// The real live demo where browsers differ: run in Chromium by
// default and in WebKit and Firefox with `npm run e2e:browsers`. What the browser itself provides: the terminals draw
// (WebGL, or xterm's fallback), the green light's full screen, the menu bar, focus rings, the blur behind floating
// surfaces. Screenshots land in test-results/ (live-demo-browser-<browser>-*.png) to be looked at.

const app = (page: Page) => page.frameLocator('.demo-stage iframe');
const demoFrame = (page: Page) => page.frame({ url: /\/demo-app\// })!;

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90000 });

test('the demo in this browser: open, menus, palette, a terminal drawn, full screen', async ({ page, browserName }) => {
  const shot = (name: string) => page.screenshot({ path: `test-results/live-demo-browser-${browserName}-${name}.png` });
  await page.goto('/');
  await expect(page.locator('.hero [data-live-demo][data-armed]')).toBeAttached();
  await page.locator('.hero .demo-hit').click();
  // The launch: the pressed window and its "Opening Atelier…" pill while the demo loads, then the app (the next shot).
  await expect(page.locator('.demo-launch')).toBeVisible();
  if (await page.locator('.demo-stage.is-loading').count()) await shot('a0-launch');
  await expect(page.locator('.demo-stage')).toHaveClass(/is-ready/, { timeout: 15000 });
  await expect(app(page).locator('.dm-coach')).toBeVisible();
  await page.waitForTimeout(1200);
  await shot('a-open');

  // The terminal in front is drawn: xterm's canvas (WebGL, or its fallback) has pixels that are not the background. The
  // screen's canvas: the overview ruler over the scrollbar (Find's ticks) is a canvas too, empty without a search.
  const drawn = await demoFrame(page).evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>('.xterm')].find((x) => x.getClientRects().length);
    const canvas = host?.querySelector<HTMLCanvasElement>('.xterm-screen canvas');
    if (!canvas) return { kind: host?.querySelector('.xterm-rows')?.textContent ? 'dom' : 'none', lit: (host?.querySelector('.xterm-rows')?.textContent ?? '').trim().length };
    const probe = document.createElement('canvas');
    probe.width = canvas.width; probe.height = canvas.height;
    const g = probe.getContext('2d')!;
    g.drawImage(canvas, 0, 0);
    const d = g.getImageData(0, 0, probe.width, probe.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 16) if (d[i]! + d[i + 1]! + d[i + 2]! > 200) lit++;
    return { kind: canvas.getContext('webgl2') === null ? 'canvas' : 'webgl', lit };
  });
  expect(drawn.lit, JSON.stringify(drawn)).toBeGreaterThan(50);

  // ⌘J, then the menu bar open (View), then the palette.
  await page.keyboard.press('Meta+j');
  await expect(app(page).locator('.session-row.is-selected')).toContainText('db-migration');
  await app(page).getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await expect(app(page).getByRole('menu').first()).toBeVisible();
  await page.waitForTimeout(300);
  await shot('b-menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  await expect(app(page).locator('.palette')).toBeVisible();
  await page.waitForTimeout(300);
  await shot('c-palette');
  // Floating surfaces blur what is behind them (the browser supports the property; headless WebKit does not paint
  // it in screenshots).
  const blur = await app(page).locator('.palette').evaluate((e) => { const c = getComputedStyle(e) as CSSStyleDeclaration & { webkitBackdropFilter?: string }; return c.backdropFilter || c.webkitBackdropFilter || 'none'; });
  expect(blur).toMatch(/blur\(/);
  await page.keyboard.press('Escape');

  // The green light: the page puts the demo's frame in full screen (when the browser allows it headless).
  await app(page).locator('.dm-light.is-max').click();
  const full = await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? null), { timeout: 3000 }).toBe('IFRAME').then(() => true, () => false);
  test.info().annotations.push({ type: 'fullscreen', description: full ? 'entered' : 'not entered (headless browser refused)' });
  if (full) {
    await page.waitForTimeout(500);
    await shot('d-fullscreen');
    await expect(app(page).locator('.dm-light.is-max')).toHaveAttribute('aria-label', 'Exit full screen');
    await app(page).locator('.dm-light.is-max').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  }
  await expect(page.locator('html')).toHaveAttribute('data-demo', 'open');
});

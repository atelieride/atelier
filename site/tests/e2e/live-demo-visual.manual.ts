import { expect, test, type Page } from '@playwright/test';

// Visual check of the live demo's site side, with the same stub as
// live-demo.spec.ts: the shots land in test-results/ to be looked at, nothing is compared. Manual (npm run shots:demo,
// playwright.manual.config.ts): never part of npm run e2e.
const stubHtml = (ready: boolean) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Demo stub</title>
<style>
  html, body { margin: 0; height: 100%; background: Canvas; color-scheme: dark; font: 13px system-ui; overflow: hidden; }
  .bar { height: 28px; display: flex; align-items: center; gap: 18px; padding: 0 14px; background: rgb(20 20 34 / .92); color: rgb(238 237 255); }
  .bar b { font-weight: 700; } .bar span { opacity: .7; } .bar i { margin-left: auto; font-style: normal; opacity: .55; }
  .app { position: absolute; inset: 28px 0 0; overflow: hidden; } .app img { width: 100%; }
</style>
<div class="bar"><b>Atelier</b><span>File</span><span>Edit</span><span>View</span><span>Session</span><span>Window</span><span>Help</span><i>Live demo · scripted sessions (stub)</i></div>
<div class="app"><img alt=""></div>
<script>
  const shot = parent.document.querySelector('[data-live-demo] img');
  if (shot) document.querySelector('.app img').src = shot.currentSrc;
  ${ready ? "requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage({ source: 'atelier-demo', type: 'ready' }, location.origin)));" : ''}
</script></html>`;
const stub = (page: Page, ready = true) => page.route('**/demo-app/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: stubHtml(ready) }));
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/live-demo-${name}.png` });
const armed = async (page: Page, path = '/') => {
  await page.goto(path);
  await expect(page.locator('[data-live-demo][data-armed]').first()).toBeAttached();
  await expect.poll(() => page.evaluate(() => [...document.images].slice(0, 2).every((i) => i.complete))).toBe(true);
  await page.waitForTimeout(900); // the hero's entrance has run
};

test.use({ viewport: { width: 1440, height: 900 } });

test('visual check: the live demo on the site', async ({ page }) => {
  test.setTimeout(60000);
  await stub(page);
  await armed(page);
  await page.evaluate(() => window.scrollTo({ top: 260, behavior: 'instant' }));
  // (a) The hero window under the pointer: lifted, lit from below, the pill.
  await page.mouse.move(720, 700);
  await page.waitForTimeout(500);
  await shot(page, 'a-hover');
  // The keyboard way: the text link, then the window's focus ring.
  await page.mouse.move(4, 400);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.locator('.hero .demo-pill').hover();
  await page.waitForTimeout(300);
  await shot(page, 'a2-link-hover');
  await page.mouse.move(4, 400);
  await page.evaluate(() => window.scrollTo({ top: 260, behavior: 'instant' }));
  await page.keyboard.press('Tab'); // focus-visible needs a keyboard origin
  await page.locator('.hero .demo-hit').focus();
  await page.waitForTimeout(400);
  await shot(page, 'a3-focus');

  // (b) Mid-zoom: the script's animations held a third of the way (live-demo-transition.manual.ts has every frame).
  await page.mouse.click(720, 640);
  await expect(page.locator('.demo-stage')).toHaveClass(/is-ready/);
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (!(a instanceof CSSAnimation) && !(a instanceof CSSTransition)) { a.pause(); a.currentTime = 100; } }));
  await shot(page, 'b-zoom');
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));

  // (c) Open, live (the stub).
  await expect(page.locator('.demo-stage')).toHaveClass(/is-ready/);
  await page.waitForTimeout(400);
  await shot(page, 'c-open');
  await page.goBack();
  await expect(page.locator('html')).not.toHaveAttribute('data-demo');
});

test('visual check: a feature row\'s "Try it", at rest, hovered, and its window hovered', async ({ page }) => {
  await armed(page, '/features');
  for (const id of ['docker', 'redis']) {
    const row = page.locator(`#${id}`);
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator('.media')).toHaveClass(/is-in/);
    await page.mouse.move(4, 4);
    await page.waitForTimeout(800);
    await row.screenshot({ path: `test-results/live-demo-f-row-${id}.png` });
    await row.locator('.try-live').hover();
    await page.waitForTimeout(400);
    await row.screenshot({ path: `test-results/live-demo-f-row-${id}-try-hover.png` });
    await row.locator('.demo-hit').hover();
    await page.waitForTimeout(500);
    await row.screenshot({ path: `test-results/live-demo-f-row-${id}-window-hover.png` });
  }
  await page.mouse.move(4, 4);
  await page.keyboard.press('Tab');
  await page.locator('#docker .try-live').focus();
  await page.waitForTimeout(300);
  await page.locator('#docker .text').screenshot({ path: 'test-results/live-demo-f-row-try-focus.png' });
});

test('visual check: loading and failure', async ({ page }) => {
  await stub(page, false);
  await armed(page);
  await page.locator('[data-live-demo]').first().evaluate((e) => e.setAttribute('data-demo-timeout', '1500'));
  await page.mouse.click(720, 700);
  await expect(page.locator('.demo-stage')).toHaveClass(/is-loading/);
  await page.waitForTimeout(700);
  await shot(page, 'c0-loading');
  // The "Opening Atelier…" pill, enlarged.
  const pill = (await page.locator('.demo-launch').boundingBox())!;
  await page.screenshot({ path: 'test-results/live-demo-c0-pill.png', clip: { x: pill.x - 20, y: pill.y - 20, width: pill.width + 40, height: pill.height + 40 }, scale: 'device' });
  // (d) The failure toast, back in the hero.
  await expect(page.locator('.demo-toast')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(400);
  await shot(page, 'd-failure');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test('visual check: /demo on a phone, and the hero without the demo controls', async ({ page }) => {
    await page.goto('/demo');
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'test-results/live-demo-e-phone.png', fullPage: true });
    await page.goto('/');
    await page.waitForTimeout(900);
    await page.screenshot({ path: 'test-results/live-demo-e2-phone-home.png' });
  });
});

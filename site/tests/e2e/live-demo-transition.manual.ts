import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The launch of the REAL live demo, frame by frame, to be looked at: the
// script's animations held at fixed times, phase by phase (the press from the click, the zoom from `ready`, the close
// from the exit). Manual (npm run shots:demo): it asserts nothing of its own. SHOTS_TAG names the set (e.g. before/after
// a change), so two sets compare frame by frame.
const DIR = fileURLToPath(new URL(`../../../e2e-shots/live-demo/launch/${process.env.SHOTS_TAG ?? 'current'}`, import.meta.url));

/** Holds the stage's script animations still under way (the phase that just started; finished ones keep their end)
 *  at `ms` into them. */
const hold = (page: Page, ms: number) => page.evaluate((t) => {
  for (const a of document.getAnimations()) {
    if (a instanceof CSSAnimation || a instanceof CSSTransition) continue;
    if (a.playState === 'finished' && !(a as Animation & { __held?: boolean }).__held) continue;
    (a as Animation & { __held?: boolean }).__held = true;
    a.pause();
    a.currentTime = t;
  }
}, ms);
const release = (page: Page) => page.evaluate(() => {
  // One held past its end finishes there (play() would rewind it).
  for (const a of document.getAnimations()) {
    if (!(a as Animation & { __held?: boolean }).__held) continue;
    delete (a as Animation & { __held?: boolean }).__held;
    if (Number(a.currentTime) < Number(a.effect?.getComputedTiming().endTime)) a.play(); else a.finish();
  }
});
const settled = async (page: Page) => {
  await expect(page.locator('[data-live-demo][data-armed]').first()).toBeAttached();
  await expect.poll(() => page.evaluate(() => [...document.images].slice(0, 2).every((i) => i.complete))).toBe(true);
  await page.waitForTimeout(900); // the hero's entrance has run
};
/** The zoom has begun (the demo is ready): held at its start before it moves. */
const zoomStarted = (page: Page) => page.waitForFunction(() => {
  if (!document.querySelector('.demo-stage.is-ready')) return false;
  for (const a of document.getAnimations()) if (!(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.playState === 'running') a.pause();
  return true;
}, null, { timeout: 15000, polling: 'raf' });

for (const [w, h] of [[1440, 900], [1920, 1080]] as const) {
  test.describe(`${w}x${h}@2x`, () => {
    test.use({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    test.describe.configure({ timeout: 90000 });
    const shot = async (page: Page, name: string) => { await mkdir(DIR, { recursive: true }); await page.screenshot({ path: `${DIR}/${w}-${name}.png` }); };
    /** The press (from the click), the zoom (from ready), held; then at rest. */
    const opening = async (page: Page, prefix: string, click: () => Promise<void>) => {
      // The demo's entry held back a little, so the press is all there is while it is captured (the zoom waits for ready).
      await page.route('**/demo-app/assets/index-*.js', async (r) => { await new Promise((d) => setTimeout(d, 1500)); await r.continue(); });
      await click();
      await expect(page.locator('.demo-launch, .demo-stage.is-ready').first()).toBeVisible();
      for (const t of [0, 80, 160, 240]) { await hold(page, t); await page.waitForTimeout(60); await shot(page, `${prefix}-${String(t).padStart(3, '0')}`); }
      await release(page);
      await zoomStarted(page);
      for (const [t, name] of [[0, 'ready'], [50, 'ready-050'], [100, 'ready-100'], [150, 'ready-150']] as const) { await hold(page, t); await page.waitForTimeout(60); await shot(page, `${prefix}-${name}`); }
      await release(page);
      await expect.poll(() => page.locator('.demo-stage .demo-win').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
      await page.waitForTimeout(600);
      await shot(page, `${prefix}-settled`);
    };

    test('the launch from the hero, held frame by frame, then the closing', async ({ page }) => {
      await page.goto('/');
      await settled(page);
      await page.locator('.hero .demo-hit').hover();
      await page.waitForTimeout(400); // intent: the stage is loaded, the demo prefetched
      await opening(page, 'open', async () => { await page.mouse.down(); await page.mouse.up(); });
      await page.goBack();
      await expect(page.locator('html')).toHaveAttribute('data-demo', 'closing');
      for (const t of [0, 60, 110, 160, 200, 300]) { await hold(page, t); await page.waitForTimeout(60); await shot(page, `close-${String(t).padStart(3, '0')}`); }
      await release(page);
      await expect(page.locator('html')).not.toHaveAttribute('data-demo');
      await page.waitForTimeout(400);
      await shot(page, 'close-settled');
    });

    test('a slow start (the demo\'s entry held back 3.5 s): the pill beats, then says it takes a moment', async ({ page }) => {
      await page.route('**/demo-app/assets/index-*.js', async (r) => { await new Promise((d) => setTimeout(d, 3500)); await r.continue(); });
      await page.goto('/');
      await settled(page);
      await page.locator('.hero .demo-hit').hover();
      await page.waitForTimeout(400);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(1100);
      await shot(page, 'slow-1100');
      await expect(page.locator('.demo-launch.is-slow')).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(400);
      await shot(page, 'slow-moment');
      await expect(page.locator('.demo-stage')).toHaveClass(/is-ready/, { timeout: 15000 });
      await page.waitForTimeout(90);
      await shot(page, 'slow-ready-90');
    });

    test('a feature row: Docker, from its window, on its view', async ({ page }) => {
      await page.goto('/features');
      await settled(page);
      const row = page.locator('#docker');
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator('.media')).toHaveClass(/is-in/);
      await page.waitForTimeout(800);
      await row.locator('.try-live').hover();
      await page.waitForTimeout(400);
      await opening(page, 'row', () => row.locator('.try-live').click());
    });

    test('/demo, the direct link: from the screen\'s centre, over the aurora', async ({ page }) => {
      await opening(page, 'direct', () => page.goto('/demo').then(() => undefined));
    });
  });
}

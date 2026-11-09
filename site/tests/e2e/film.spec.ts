import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

// The film on the site: A, the desktop sheet; C, the film in the hero on phones
// and tablets. Chromium plays the WebM files (it has no H.264): the media requests below are the WebM ones.
const MEDIA = /\/_astro\/film-[^/]*\.(webm|mp4)$|\/_astro\/film[^/]*\.vtt$/;
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const TABLET: BrowserContextOptions = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** Every film file the page asks for, from the start. */
const watchMedia = (page: Page) => {
  const loads: string[] = [];
  page.on('request', (r) => { if (MEDIA.test(new URL(r.url()).pathname)) loads.push(new URL(r.url()).pathname); });
  return loads;
};
const settled = async (page: Page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
const video = (page: Page, scope: string) => page.locator(`${scope} video`);
const prop = <T>(page: Page, scope: string, fn: (v: HTMLVideoElement) => T) => video(page, scope).evaluate(fn);

test.describe('desktop: the sheet (A)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const button = (page: Page) => page.locator('.hero [data-film-open]');
  const sheet = (page: Page) => page.locator('dialog.film-sheet');

  test('"Watch the film" sits on the window beside "Try it live", on screen without hover; nothing of the film loads with the page', async ({ page }) => {
    const loads = watchMedia(page);
    await page.goto('/');
    await expect(button(page)).toBeVisible();
    await expect(button(page)).toContainText('Watch the film');
    await expect(button(page)).toContainText('0:38');
    await expect(page.locator('.hero .film-pill')).toBeHidden();
    // Seeing the app is the window's business; the copy keeps the downloads only.
    await expect(page.locator('.hero .cta [data-film-open], .hero .cta [data-live-demo-for]')).toHaveCount(0);
    const bar = page.locator('.hero .see');
    await expect(bar.locator('[data-film-open]')).toBeVisible();
    await expect(bar.getByRole('link', { name: /Try it live/ })).toBeVisible();
    const b = (await bar.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(900 - 20);
    // Inside the window (its rail spans the frame; the frame itself may still be rising into place).
    expect(b.y).toBeGreaterThan((await page.locator('.hero .see-rail').boundingBox())!.y);
    await settled(page);
    expect(loads).toEqual([]);
    await expect(sheet(page)).toHaveCount(0);
  });

  test('a click opens the sheet playing with sound and captions; a chapter seeks; Esc closes, pauses and gives the focus back', async ({ page }) => {
    const loads = watchMedia(page);
    await page.goto('/');
    await button(page).click();
    await expect(sheet(page)).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Atelier in 38 seconds' })).toBeVisible();
    await expect.poll(() => prop(page, 'dialog.film-sheet', (v) => v.currentTime)).toBeGreaterThan(0.3);
    expect(await prop(page, 'dialog.film-sheet', (v) => ({ paused: v.paused, muted: v.muted, src: v.currentSrc, track: v.textTracks[0]?.mode })))
      .toMatchObject({ paused: false, muted: false, src: expect.stringMatching(/film-1080[^/]*\.webm$/), track: 'showing' });
    expect(loads.some((l) => /film-1080/.test(l))).toBe(true);
    expect(loads.some((l) => /film-720/.test(l))).toBe(false);

    await sheet(page).getByRole('button', { name: /Files/ }).click();
    await expect.poll(() => prop(page, 'dialog.film-sheet', (v) => v.currentTime)).toBeGreaterThanOrEqual(16.5);
    expect(await prop(page, 'dialog.film-sheet', (v) => v.currentTime)).toBeLessThan(18.5);
    await expect(sheet(page).locator('[aria-current="true"]')).toContainText('Files');

    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
    // The dialog's close event is a queued task: the film pauses just after the sheet hides.
    await expect.poll(() => prop(page, 'dialog.film-sheet', (v) => v.paused)).toBe(true);
    await expect(button(page)).toBeFocused();
  });

  test('the close button closes it; opening again resumes where it was', async ({ page }) => {
    await page.goto('/');
    await button(page).click();
    await sheet(page).getByRole('button', { name: /Automations/ }).click();
    await expect.poll(() => prop(page, 'dialog.film-sheet', (v) => v.currentTime)).toBeGreaterThanOrEqual(20);
    await sheet(page).getByRole('button', { name: 'Close' }).click();
    await expect(sheet(page)).toBeHidden();
    await button(page).click();
    await expect(sheet(page)).toBeVisible();
    expect(await prop(page, 'dialog.film-sheet', (v) => v.currentTime)).toBeGreaterThanOrEqual(20);
    await expect.poll(() => prop(page, 'dialog.film-sheet', (v) => v.paused)).toBe(false);
  });

  test('a click on the dimmed page closes it; a drag on the player released over it does not', async ({ page }) => {
    await page.goto('/');
    await button(page).click();
    await expect(sheet(page)).toBeVisible();
    const box = (await sheet(page).locator('video').boundingBox())!;
    // A press on the player let go outside the sheet (a drag that overshoots): the click lands on their common ancestor,
    // the dialog.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.mouse.move(6, 450, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    await expect(sheet(page)).toBeVisible();
    await page.mouse.click(6, 450);
    await expect(sheet(page)).toBeHidden();
  });

  test('keyboard: the player and the playing chapter show the focus ring', async ({ page }) => {
    const ring = (sel: string) => page.locator(sel).evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle} ${s.boxShadow}`;
    });
    await page.goto('/');
    await button(page).focus();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sheet(page).locator('video')).toBeFocused();
    // The video sits in a clipped, rounded box: the ring is the box's.
    expect(await ring('dialog.film-sheet .fs-player')).toMatch(/rgb\(139, 92, 246\)/);
    // The player's own controls come next in the tab order (they differ by browser), then the chapters.
    const current = sheet(page).locator('.fs-chapters [aria-current="true"]');
    for (let i = 0; i < 12 && !(await current.evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(current).toBeFocused();
    expect(await ring('dialog.film-sheet .fs-chapters [aria-current="true"]')).toMatch(/rgb\(139, 92, 246\)/);
  });

  test('"Try it live" closes the sheet and opens the live demo', async ({ page }) => {
    await page.route('**/demo-app/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>stub</title><script>requestAnimationFrame(() => parent.postMessage({ source: "atelier-demo", type: "ready" }, location.origin));</script>' }));
    await page.goto('/');
    await expect(page.locator('[data-live-demo][data-armed]').first()).toBeAttached();
    await button(page).click();
    await sheet(page).getByRole('link', { name: /Try it live/ }).click();
    await expect(sheet(page)).toBeHidden();
    await expect.poll(() => prop(page, 'dialog.film-sheet', (v) => v.paused)).toBe(true);
    await expect(page).toHaveURL(/\/demo$/);
    await expect(page.locator('html')).toHaveAttribute('data-demo', 'open');
  });
});

// The gate is the screen's, at the time of the click: a window narrowed or widened after the page loaded (or DevTools'
// device mode turned on) still gets a film that plays.
test.describe('the gate changes after the page loaded', () => {
  // No autoplay here: the scroll that brings the pill into view would start the film muted, and the pill gives way.
  test.use({ reducedMotion: 'reduce' });
  test('wide, then narrow: the pill on the window plays the film', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.setViewportSize({ width: 600, height: 900 });
    await page.locator('.hero .film-pill').scrollIntoViewIfNeeded();
    await page.locator('.hero .film-pill').click();
    await expect.poll(() => prop(page, '.hero [data-film-inline]', (v) => v.currentTime)).toBeGreaterThan(0.3);
    expect(await prop(page, '.hero [data-film-inline]', (v) => v.muted)).toBe(false);
    // Wide again: the frame shows the live demo; the film (hidden with its box) stops, and stays stopped.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => prop(page, '.hero [data-film-inline]', (v) => v.paused)).toBe(true);
    await page.waitForTimeout(400);
    expect(await prop(page, '.hero [data-film-inline]', (v) => v.paused)).toBe(true);
  });

  test('narrow, then wide: "Watch the film" on the bar opens the sheet', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.hero [data-film-open]').click();
    await expect(page.locator('dialog.film-sheet')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });
});

// A link to the film (the releases README, a shared URL): useatelier.dev/#film.
test.describe('the #film link', () => {
  test('desktop: the page opens with the film\'s sheet', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#film');
    await expect(page.locator('dialog.film-sheet')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Atelier in 38 seconds' })).toBeVisible();
  });

  test('phone: the hero\'s frame and its pill come into view; nothing plays until the visitor taps', async ({ browser }) => {
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    const loads = watchMedia(page);
    await page.goto('/#film');
    await expect(page.locator('.hero .film-pill')).toBeInViewport();
    await settled(page);
    await expect(page.locator('video')).toHaveCount(0);
    expect(loads).toEqual([]);
    await context.close();
  });

  test('tablet: the hero\'s frame is brought into view and the film starts there, muted', async ({ browser }) => {
    const context = await browser.newContext(TABLET);
    const page = await context.newPage();
    await page.goto('/#film');
    await expect.poll(() => prop(page, '.hero [data-film-inline]', (v) => v.currentTime)).toBeGreaterThan(0.3);
    expect(await prop(page, '.hero [data-film-inline]', (v) => v.muted)).toBe(true);
    await expect(page.locator('.hero .frame')).toBeInViewport({ ratio: 0.5 });
    await context.close();
  });
});

test.describe('the desktop with motion allowed', () => {
  test('on the desktop a scroll never starts the hero film (nothing fetched)', async ({ page }) => {
    const loads = watchMedia(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(1200);
    expect(loads).toEqual([]);
    await expect(page.locator('.hero [data-film-inline] video')).toHaveCount(0);
  });
});

const pill = (page: Page) => page.locator('.hero .film-pill');
const inline = '.hero [data-film-inline]';
const open = async (browser: Browser, options: BrowserContextOptions) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const loads = watchMedia(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __shifts: number; __locks: string[] };
    w.__shifts = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__shifts += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
    // What the page asks of the screen's orientation (headless Chromium refuses the lock itself).
    w.__locks = [];
    const o = screen.orientation as ScreenOrientation & { lock?: (x: string) => Promise<void> };
    if (o) o.lock = (x: string) => { w.__locks.push(x); return Promise.reject(new Error('not in a test')); };
  });
  await page.goto('/');
  return { page, loads, context };
};
const scrollABit = (page: Page) => page.evaluate(() => window.scrollBy(0, 160));
const fullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement ? `${document.fullscreenElement.tagName.toLowerCase()}.${document.fullscreenElement.className}` : null);

test.describe('phones: the film opens full screen, in landscape, only when asked (C)', () => {
  const pv = <T>(page: Page, fn: (v: HTMLVideoElement) => T) => page.locator('video.film-phone').evaluate(fn);

  test('the screenshot and the pill on load; a scroll never starts anything, nothing is fetched', async ({ browser }) => {
    const { page, loads, context } = await open(browser, PHONE);
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toContainText('Watch the film');
    await expect(pill(page)).toHaveAccessibleName('Watch the film, 38 seconds, with sound');
    await expect(page.locator('.hero [data-film-open]')).toBeHidden();
    await scrollABit(page);
    await settled(page);
    expect(loads).toEqual([]);
    await expect(page.locator('video')).toHaveCount(0);
    await context.close();
  });

  test('a tap opens it full screen with sound and captions, asking for landscape; leaving pauses it, the screenshot is back; a second tap goes on', async ({ browser }) => {
    const { page, context } = await open(browser, PHONE);
    await pill(page).scrollIntoViewIfNeeded();
    await pill(page).tap();
    await expect.poll(() => fullscreen(page)).toBe('video.film-phone');
    await expect.poll(() => pv(page, (v) => v.currentTime)).toBeGreaterThan(0.6);
    expect(await pv(page, (v) => ({ muted: v.muted, paused: v.paused, controls: v.controls, src: v.currentSrc, kind: v.textTracks[0]?.kind, mode: v.textTracks[0]?.mode })))
      .toMatchObject({ muted: false, paused: false, controls: true, src: expect.stringMatching(/film-720[^/]*\.webm$/), kind: 'captions', mode: 'showing' });
    expect(await page.evaluate(() => (window as unknown as { __locks: string[] }).__locks)).toEqual(['landscape']);
    // Nothing plays in the hero's frame: the screenshot stays.
    await expect(page.locator(`${inline} video`)).toHaveCount(0);

    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => fullscreen(page)).toBeNull();
    await expect.poll(() => pv(page, (v) => v.paused)).toBe(true);
    await expect(pill(page)).toBeVisible();
    const at = await pv(page, (v) => v.currentTime);

    await pill(page).tap();
    await expect.poll(() => fullscreen(page)).toBe('video.film-phone');
    await expect.poll(() => pv(page, (v) => v.paused)).toBe(false);
    expect(await pv(page, (v) => v.currentTime)).toBeGreaterThanOrEqual(at);
    await context.close();
  });

  test('the very first tap opens it full screen, with a slow network and a browser that allows full screen only inside the tap (iOS)', async ({ browser }) => {
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    // As iOS Safari: full screen only while the tap's event is being handled, never after an await.
    await page.addInitScript(() => {
      let inTap = false;
      addEventListener('click', () => { inTap = true; }, true);
      addEventListener('click', () => { inTap = false; });
      const real = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function (this: Element, o?: FullscreenOptions) {
        return inTap ? real.call(this, o) : Promise.reject(new TypeError('Full screen is allowed only inside a tap'));
      };
    });
    // The player's module arrives late (a phone's network): the tap lands long before it.
    await page.route(/\/_astro\/film-inline[^/]*\.js$/, async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
    await page.goto('/');
    await pill(page).scrollIntoViewIfNeeded();
    await pill(page).tap();
    await expect.poll(() => fullscreen(page)).toBe('video.film-phone');
    await expect.poll(() => pv(page, (v) => v.currentTime)).toBeGreaterThan(0.3);
    expect(await pv(page, (v) => v.muted)).toBe(false);
    // Once the module is there, leaving full screen still pauses it (its listeners took the video over).
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => pv(page, (v) => v.paused)).toBe(true);
    await context.close();
  });

  test('iPhone: the first tap opens iOS\'s own full screen player (no Fullscreen API; webkitEnterFullscreen refuses a video with no metadata yet)', async ({ browser }) => {
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    // iOS Safari on an iPhone, as far as the page can tell: no standard full screen for a video; webkitEnterFullscreen
    // throws until the video has its metadata; a video without playsinline that plays in a tap opens full screen.
    await page.addInitScript(() => {
      const w = window as unknown as { __presented: string[]; __errors: string[] };
      w.__presented = [];
      w.__errors = [];
      addEventListener('error', (e) => w.__errors.push(String(e.message)));
      addEventListener('unhandledrejection', (e) => w.__errors.push(String(e.reason)));
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true });
      Object.defineProperty(HTMLVideoElement.prototype, 'requestFullscreen', { value: undefined, configurable: true });
      Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { configurable: true, value(this: HTMLVideoElement) {
        if (this.readyState < 1) throw new DOMException('The object is in an invalid state.', 'InvalidStateError');
        w.__presented.push('webkitEnterFullscreen');
      } });
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        if (this instanceof HTMLVideoElement && !this.hasAttribute('playsinline')) w.__presented.push('play');
        return play.call(this);
      };
    });
    await page.goto('/');
    await pill(page).scrollIntoViewIfNeeded();
    await pill(page).tap();
    // iOS presents it full screen on the first tap, with sound.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __presented: string[] }).__presented.length)).toBeGreaterThan(0);
    await expect.poll(() => pv(page, (v) => v.currentTime)).toBeGreaterThan(0.3);
    expect(await pv(page, (v) => v.muted)).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { __errors: string[] }).__errors)).toEqual([]);
    // Leaving iOS's player pauses it.
    await page.locator('video.film-phone').evaluate((v) => v.dispatchEvent(new Event('webkitendfullscreen')));
    await expect.poll(() => pv(page, (v) => v.paused)).toBe(true);
    await context.close();
  });

  test('a phone held in landscape is still a phone: full screen too', async ({ browser }) => {
    const { page, context } = await open(browser, { ...PHONE, viewport: { width: 844, height: 390 } });
    await pill(page).scrollIntoViewIfNeeded();
    await pill(page).tap();
    await expect.poll(() => fullscreen(page)).toBe('video.film-phone');
    await context.close();
  });
});

test.describe('tablets: the film in the hero (C)', () => {
  test('the screenshot and a pill on load, no film file; after a scroll it plays muted with captions, in place', async ({ browser }) => {
    const { page, loads, context } = await open(browser, TABLET);
    await expect(pill(page)).toBeVisible();
    await expect(page.locator('.hero [data-film-open]')).toBeHidden();
    await settled(page);
    expect(loads).toEqual([]);
    await expect(video(page, inline)).toHaveCount(0);
    await page.locator('.hero .frame').scrollIntoViewIfNeeded();
    const before = await page.locator('.hero .frame').boundingBox();

    await scrollABit(page);
    await expect.poll(() => video(page, inline).count()).toBe(1);
    await expect.poll(() => prop(page, inline, (v) => v.currentTime)).toBeGreaterThan(0.6);
    expect(await prop(page, inline, (v) => ({ muted: v.muted, paused: v.paused, src: v.currentSrc })))
      .toMatchObject({ muted: true, paused: false, src: expect.stringMatching(/film-720[^/]*\.webm$/) });
    await expect(page.locator('.hero .film-caption')).toHaveText(/\S/);
    // The page draws the captions: readable by assistive tech too; that track is metadata, so no browser draws its own.
    await expect(page.locator('.hero .film-caption')).not.toHaveAttribute('aria-hidden', /.*/);
    expect(await prop(page, inline, (v) => ({ kind: v.textTracks[0]?.kind, mode: v.textTracks[0]?.mode }))).toEqual({ kind: 'metadata', mode: 'hidden' });
    const after = await page.locator('.hero .frame').boundingBox();
    expect(after!.height).toBeCloseTo(before!.height, 0);
    expect(await page.evaluate(() => (window as unknown as { __shifts: number }).__shifts)).toBeLessThan(0.001);
    await context.close();
  });

  test('tap for sound restarts it unmuted; pause and play; muting a paused film keeps it paused', async ({ browser }) => {
    const { page, context } = await open(browser, TABLET);
    await page.locator('.hero .frame').scrollIntoViewIfNeeded();
    await scrollABit(page);
    await expect.poll(() => prop(page, inline, (v) => v.currentTime)).toBeGreaterThan(1.5);
    await page.locator('.hero .film-sound').tap();
    await expect.poll(() => prop(page, inline, (v) => v.muted)).toBe(false);
    expect(await prop(page, inline, (v) => v.currentTime)).toBeLessThan(1.5);
    await expect(page.locator('.hero .film-sound')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('.hero .film-pause').tap();
    await expect.poll(() => prop(page, inline, (v) => v.paused)).toBe(true);
    await expect(page.locator('.hero .film-pause')).toHaveAccessibleName('Play the film');
    await page.locator('.hero .film-pause').tap();
    await expect.poll(() => prop(page, inline, (v) => v.paused)).toBe(false);

    await page.locator('.hero .film-pause').tap();
    await expect.poll(() => prop(page, inline, (v) => v.paused)).toBe(true);
    await page.locator('.hero .film-sound').tap();
    await expect.poll(() => prop(page, inline, (v) => v.muted)).toBe(true);
    await page.waitForTimeout(300);
    expect(await prop(page, inline, (v) => v.paused)).toBe(true);
    await context.close();
  });

  test('the full screen button: the film full screen with sound, native controls and captions; leaving it, back in the frame', async ({ browser }) => {
    const { page, context } = await open(browser, TABLET);
    await page.locator('.hero .frame').scrollIntoViewIfNeeded();
    await scrollABit(page);
    await expect.poll(() => prop(page, inline, (v) => v.currentTime)).toBeGreaterThan(0.6);
    const full = page.locator('.hero .film-full');
    await expect(full).toHaveAccessibleName('Full screen');
    await full.tap();
    await expect.poll(() => fullscreen(page)).toMatch(/^video/);
    await expect.poll(() => prop(page, inline, (v) => v.paused)).toBe(false);
    expect(await prop(page, inline, (v) => ({ muted: v.muted, controls: v.controls, captions: [...v.textTracks].find((t) => t.kind === 'captions')?.mode })))
      .toEqual({ muted: false, controls: true, captions: 'showing' });
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => fullscreen(page)).toBeNull();
    // fullscreenchange is a queued event: the frame's own look comes back just after.
    await expect.poll(() => prop(page, inline, (v) => ({ controls: v.controls, captions: [...v.textTracks].find((t) => t.kind === 'captions')?.mode })))
      .toEqual({ controls: false, captions: 'disabled' });
    await expect.poll(() => prop(page, inline, (v) => v.paused)).toBe(false);
    await context.close();
  });

  test('off screen it rests, back on screen it goes on; one the visitor paused stays paused', async ({ browser }) => {
    const { page, context } = await open(browser, TABLET);
    await page.locator('.hero .frame').scrollIntoViewIfNeeded();
    await scrollABit(page);
    await expect.poll(() => prop(page, inline, (v) => v.currentTime)).toBeGreaterThan(0.6);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => prop(page, inline, (v) => v.paused)).toBe(true);
    await page.locator('.hero .frame').scrollIntoViewIfNeeded();
    await expect.poll(() => prop(page, inline, (v) => v.paused)).toBe(false);
    await page.locator('.hero .film-pause').tap();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator('.hero .frame').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    expect(await prop(page, inline, (v) => v.paused)).toBe(true);
    await context.close();
  });

  test('keyboard: Enter on the pill plays it, the focus moves to the sound button', async ({ browser }) => {
    const { page, context } = await open(browser, { ...TABLET, reducedMotion: 'reduce' });
    await pill(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => prop(page, inline, (v) => v.currentTime)).toBeGreaterThan(0.3);
    await expect(pill(page)).toBeHidden();
    await expect(page.locator('.hero .film-sound')).toBeFocused();
    await context.close();
  });

  test('reduced motion: no autoplay; the pill plays it with sound', async ({ browser }) => {
    const { page, loads, context } = await open(browser, { ...TABLET, reducedMotion: 'reduce' });
    await page.locator('.hero .frame').scrollIntoViewIfNeeded();
    await scrollABit(page);
    await page.waitForTimeout(1200);
    await expect(video(page, inline)).toHaveCount(0);
    expect(loads).toEqual([]);
    await pill(page).tap();
    await expect.poll(() => prop(page, inline, (v) => v.currentTime)).toBeGreaterThan(0.3);
    expect(await prop(page, inline, (v) => v.muted)).toBe(false);
    await context.close();
  });
});

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv, writePrefs } from './env';
import { look } from './shots';

// The launch animation: the first window of an app start plays it (ATELIER_TEST_INTRO lets it play although e2e
// windows are hidden). The mark's plates open into the columns on screen, or gather on the Welcome mark; it ends on its
// own with nothing left moving, a click skips it, and the setting, Reduce motion and a reload play none.

async function launch(o: { project?: boolean; prefs?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const { env, home } = e2eEnv({ ATELIER_TEST_INTRO: '1', ...o.env });
  if (o.prefs) writePrefs(home, o.prefs);
  const args = ['out/main/index.js', ...(o.project === false ? [] : [`--project=${mkdtempSync(join(tmpdir(), 'atl-prj-'))}`])];
  const app = await electron.launch({ args, env });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, home, win };
}
async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** Waits until the page's entry module ran `ms` ago (the launch animation starts as it runs). */
const pageAt = (win: Page, ms: number) => win.waitForFunction((t) =>
  performance.now() - (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventStart >= t, ms);

/**
 * Whether the launch overlay shows at any frame until the page is `ms` old. Its whole run outlasts that, so a page
 * that plays it is caught (a waiting assertion for its absence would pass once it ended).
 */
const introShown = (win: Page, ms: number) => win.evaluate((t) => new Promise<boolean>((done) => {
  const age = () => performance.now() - (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventStart;
  const tick = () => {
    if (document.querySelector('.intro')) done(true);
    else if (age() >= t) done(false);
    else requestAnimationFrame(tick);
  };
  tick();
}), ms);

/** The animations running now (xterm's own cursor blink aside), by what they animate. */
const running = (win: Page) => win.evaluate(() => document.getAnimations()
  .filter((a) => a.playState === 'running' && !/^blink_(bar|block|underline)_/.test((a as CSSAnimation).animationName ?? ''))
  .map((a) => `${(a as CSSAnimation).animationName ?? 'script'} on ${((a.effect as KeyframeEffect | null)?.target as Element | null)?.getAttribute('class') ?? ''}`));

/**
 * Waits for the plates' morph, then freezes every running animation 260 ms into it (the plates halfway, the seams
 * about to draw). Returns each plate's landing box (its own style) and the boxes it should be: the columns shown, or
 * the Welcome mark's plates.
 */
const freezeMidMorph = (win: Page) => win.evaluate(() => new Promise<{ plates: number[][]; columns: number[][]; logo: number[] | null }>((done) => {
  const box = (r: DOMRect) => [r.x, r.y, r.width, r.height];
  const tick = () => {
    const anims = document.getAnimations().filter((a) => a.playState === 'running');
    const morphing = anims.some((a) => {
      const e = a.effect as KeyframeEffect | null;
      return (e?.target as Element | null)?.classList.contains('intro-plate') && e!.getKeyframes().some((k) => 'width' in k);
    });
    if (!morphing) { requestAnimationFrame(tick); return; }
    for (const a of anims) { a.pause(); a.currentTime = 260; }
    (window as unknown as { frozen: Animation[] }).frozen = anims;
    const plates = [...document.querySelectorAll<HTMLElement>('.intro-plate')].map((p) => [p.style.left, p.style.top, p.style.width, p.style.height].map(parseFloat));
    const columns = ['aside.sidebar', 'main.workspace', 'aside.changes'].map((s) => document.querySelector(s)).filter((e): e is Element => !!e).map((e) => box(e.getBoundingClientRect()));
    const logo = document.querySelector('.welcome-card .logo');
    done({ plates, columns, logo: logo ? box(logo.getBoundingClientRect()) : null });
  };
  tick();
}));
/** Whether two lists of boxes agree within a pixel. */
const near = (a: number[][], b: number[][]) => a.length === b.length && a.every((r, i) => r.every((v, j) => Math.abs(v - b[i]![j]!) <= 1));
const playOn = (win: Page) => win.evaluate(() => { for (const a of (window as unknown as { frozen: Animation[] }).frozen) a.play(); });

test('the first window plays the launch, then leaves nothing moving', async () => {
  const { app, home, win } = await launch();
  try {
    await expect(win.locator('.intro')).toBeVisible();
    await expect(win.locator('.intro-plate')).toHaveCount(3);
    const at = await freezeMidMorph(win);
    // Sidebar, terminal area and Changes: one plate each, back to front, left to right; a seam at each inner edge.
    expect(at.columns).toHaveLength(3);
    expect(near(at.plates, at.columns), JSON.stringify(at)).toBe(true);
    await expect(win.locator('.intro-seam')).toHaveCount(2);
    await look(win, 'test-results/intro-morph.png');
    await playOn(win);

    await expect(win.locator('.intro')).toHaveCount(0, { timeout: 4000 });
    await expect(win.locator('html')).not.toHaveAttribute('data-intro');
    await expect(win.locator('.intro-seam')).toHaveCount(0);
    await expect.poll(() => running(win), { timeout: 3000 }).toEqual([]);
    await look(win, 'test-results/intro-rest.png');
  } finally {
    await stop(app, home);
  }
});

test('a click skips it and the next key reaches the terminal', async () => {
  const { app, home, win } = await launch();
  try {
    await expect(win.locator('.intro')).toBeAttached();
    await pageAt(win, 200);
    await win.mouse.click(400, 300);
    await expect(win.locator('.intro')).toHaveCount(0, { timeout: 300 });
    // Skipped: no landing either, and none of its animations left (the app's own entrances may still be running).
    expect(await win.locator('html').getAttribute('data-intro')).toBeNull();
    expect((await running(win)).filter((a) => a.startsWith('script'))).toEqual([]);

    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 10000 });
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type('echo intro-$((40+2))\n');
    await expect(win.locator('.xterm-rows')).toContainText('intro-42', { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

test('a key skips it too: that key goes no further, the next one does', async () => {
  const { app, home, win } = await launch();
  try {
    await expect(win.locator('.intro')).toBeAttached();
    await pageAt(win, 200);
    // A window listener of the page's own, added after the launch's: it hears what the launch lets through.
    await win.evaluate(() => {
      const w = window as unknown as { heard: string[] };
      w.heard = [];
      window.addEventListener('keydown', (e) => { w.heard.push(e.key); }, true);
    });
    await win.keyboard.press('a');
    await expect(win.locator('.intro')).toHaveCount(0, { timeout: 300 });
    await win.keyboard.press('b');
    expect(await win.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual(['b']);
  } finally {
    await stop(app, home);
  }
});

for (const [name, prefs] of [['Launch animation off', { launchAnimation: false }], ['Reduce motion', { motion: 'reduced' }]] as const) {
  test(`${name}: none`, async () => {
    const { app, home, win } = await launch({ prefs });
    try {
      expect(await introShown(win, 800)).toBe(false);
      await expect(win.locator('main.workspace')).toBeVisible();
    } finally {
      await stop(app, home);
    }
  });
}

test('no project: the plates gather on the Welcome mark', async () => {
  const { app, home, win } = await launch({ project: false });
  try {
    await expect(win.locator('.intro')).toBeVisible();
    const at = await freezeMidMorph(win);
    // Each plate lands on the same plate of the Welcome card's mark (72 px: plates of 40 at 4,22 / 16,16 / 28,10).
    expect(at.logo).not.toBeNull();
    const [x = 0, y = 0] = at.logo!;
    expect(near(at.plates, [[x + 4, y + 22, 40, 40], [x + 16, y + 16, 40, 40], [x + 28, y + 10, 40, 40]]), JSON.stringify(at)).toBe(true);
    expect(await win.locator('.intro-seam').count()).toBe(0);
    await look(win, 'test-results/intro-welcome-gather.png');
    await playOn(win);

    await expect(win.locator('.intro')).toHaveCount(0, { timeout: 4000 });
    await expect(win.locator('.welcome-card .logo')).toBeVisible();
    await expect.poll(() => running(win), { timeout: 3000 }).toEqual([]);
    await look(win, 'test-results/intro-welcome.png');
  } finally {
    await stop(app, home);
  }
});

test('a reload plays nothing', async () => {
  const { app, home, win } = await launch();
  try {
    await expect(win.locator('.intro')).toBeVisible();
    await expect(win.locator('.intro')).toHaveCount(0, { timeout: 4000 });
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    expect(await introShown(win, 800)).toBe(false);
    await expect(win.locator('main.workspace')).toBeVisible();
  } finally {
    await stop(app, home);
  }
});

test('a slow layout: the mark holds, then leaves', async () => {
  const { app, home, win } = await launch({ env: { ATELIER_TEST_INTRO_HOLD_MS: '1500' } });
  try {
    await expect(win.locator('.intro')).toBeAttached();
    await pageAt(win, 1200);
    // Leafed out and drawn, the mark waits still: nothing runs meanwhile (no loop).
    expect(await win.locator('.intro').count()).toBe(1);
    expect(await running(win)).toEqual([]);
    await win.waitForFunction(() => !document.querySelector('.intro')
      || performance.now() - (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventStart >= 2500);
    expect(await win.locator('.intro').count()).toBe(0);
  } finally {
    await stop(app, home);
  }
});

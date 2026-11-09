import { expect, test, type Browser, type Page } from '@playwright/test';

// The live demo on the site (plan "Performance and SEO contract"). The
// demo itself is a STUB here, served by route interception in place of /demo-app/: it says `ready` (or nothing, or
// `failed`), records what the page sends it in window.received, and window.send() posts a message to the page. The real
// demo's own e2e come with it.
type Mode = 'ready' | 'slow' | 'silent' | 'failed';
const stubHtml = (mode: Mode) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Demo stub</title>
<style>
  html, body { margin: 0; height: 100%; background: Canvas; color-scheme: dark; font: 13px system-ui; overflow: hidden; }
  .bar { height: 28px; display: flex; align-items: center; gap: 18px; padding: 0 14px; background: rgb(20 20 34 / .92); color: rgb(238 237 255); }
  .bar b { font-weight: 700; } .bar span { opacity: .7; } .bar i { margin-left: auto; font-style: normal; opacity: .55; }
  .app { position: absolute; inset: 28px 0 0; display: grid; place-items: start; overflow: hidden; }
  .app img { width: 100%; }
</style>
<div class="bar"><b>Atelier</b><span>File</span><span>Edit</span><span>View</span><span>Session</span><span>Window</span><span>Help</span><i>Live demo · scripted sessions (stub)</i></div>
<div class="app"><img alt=""></div>
<script>
  window.received = [];
  // Keys that reach the demo natively (its iframe has the focus), next to the ones the page re-dispatches.
  addEventListener('keydown', (e) => received.push({ type: 'native-key', key: e.key, metaKey: e.metaKey }));
  addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.source === 'atelier-demo') received.push(Object.assign({ at: parent.performance.now() }, e.data)); });
  window.send = (m) => parent.postMessage(Object.assign({ source: 'atelier-demo' }, m), location.origin);
  const shot = parent.document.querySelector('[data-live-demo] img');
  if (shot) document.querySelector('.app img').src = shot.currentSrc;
  ${mode === 'ready' ? "requestAnimationFrame(() => requestAnimationFrame(() => send({ type: 'ready' })));" : ''}
  ${mode === 'slow' ? "setTimeout(() => send({ type: 'ready' }), 1500);" : ''}
  ${mode === 'failed' ? "send({ type: 'failed', reason: 'the bridge threw at startup' });" : ''}
</script></html>`;

const stub = async (page: Page, mode: Mode = 'ready') => {
  const loads: string[] = [];
  await page.route('**/demo-app/**', (route) => {
    loads.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: stubHtml(mode) });
  });
  return loads;
};
const demoFrame = (page: Page) => page.frame({ url: /\/demo-app\// })!;
const received = (page: Page) => demoFrame(page).evaluate(() => (window as unknown as { received: { type: string }[] }).received);
const send = (page: Page, m: Record<string, unknown>) => demoFrame(page).evaluate((msg) => (window as unknown as { send: (m: unknown) => void }).send(msg), m);
const hit = (page: Page) => page.locator('.hero .demo-hit');
const stage = (page: Page) => page.locator('.demo-stage');
const iframe = (page: Page) => stage(page).locator('iframe');
// The script arms the controls once the page has loaded and gone idle.
const armed = async (page: Page, path = '/') => { await page.goto(path); await expect(page.locator('[data-live-demo][data-armed]').first()).toBeAttached(); };
const isOpen = async (page: Page) => {
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.locator('html')).toHaveAttribute('data-demo', 'open');
  await expect(stage(page)).toHaveClass(/is-ready/);
  // The live app in full, at its size: no transform at rest.
  await expect.poll(() => stage(page).locator('.demo-win').evaluate((w) => `${getComputedStyle(w).opacity} ${getComputedStyle(w).transform}`)).toBe('1 none');
};
const isClosed = async (page: Page) => {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo');
  await expect(stage(page)).toBeHidden();
  await expect(page.locator('header.appbar')).toBeVisible();
  await expect(page.locator('.hero .frame')).toBeVisible();
  // Nothing of the launch is left for the next opening: no pill, no pressed copy, nothing busy.
  await expect(page.locator('.demo-launch')).toHaveAttribute('hidden', '');
  await expect(page.locator('.demo-launch')).toHaveText('');
  await expect(page.locator('.demo-press')).toHaveAttribute('hidden', '');
  await expect(stage(page)).not.toHaveAttribute('aria-busy');
};

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('before any interaction (the performance contract)', () => {
  test('desktop: nothing from /demo-app/, no long task after load, no layout shift, the hero image is the LCP', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await page.addInitScript(() => {
      const w = window as unknown as { perf: { long: number[]; cls: number; lcp: string } };
      w.perf = { long: [], cls: 0, lcp: '' };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.perf.long.push(e.startTime); }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => { const e = l.getEntries().at(-1) as unknown as { element: Element | null }; w.perf.lcp = e.element ? `${e.element.nodeName} ${e.element.closest('.hero') ? 'hero' : ''}` : ''; }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    await page.mouse.move(4, 600); // the pointer rests away from the hero window
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('[data-live-demo][data-armed]').first()).toBeAttached();
    await page.waitForTimeout(2000);
    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const w = window as unknown as { perf: { long: number[]; cls: number; lcp: string } };
      return { ...w.perf, long: w.perf.long.filter((t) => t >= nav.loadEventStart) };
    });
    expect(requests.filter((p) => p.startsWith('/demo-app/'))).toEqual([]);
    // Nor the stage's script and styles: they load on intent.
    expect(requests.filter((p) => /live-demo-stage/i.test(p))).toEqual([]);
    expect(perf.long).toEqual([]);
    expect(perf.cls).toBe(0);
    expect(perf.lcp).toBe('IMG hero');
  });

  test('desktop: the window is a control with a name; "Try it live" sits on it, shown without hover, lit when the window is', async ({ page }) => {
    await armed(page);
    await expect(page.getByRole('link', { name: 'Try Atelier live in your browser' })).toHaveAttribute('href', '/demo');
    const pill = page.locator('.hero .demo-pill');
    await expect(pill).toHaveText(/Try it live\s*·\s*in your browser/);
    await expect(pill).toHaveAttribute('data-live-demo-for', 'hero');
    expect(await pill.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    // At the top of the page the window runs past the fold: the pill still shows, on screen, over the window.
    const p = (await pill.boundingBox())!;
    expect(p.y + p.height).toBeLessThanOrEqual(900 - 20);
    await page.mouse.move(720, 700);
    await expect(pill).toHaveAttribute('data-hot', '');
    const f = (await page.locator('.hero .frame').boundingBox())!;
    expect(p.y).toBeGreaterThan(f.y);
    // Its bar (with the film beside it) is centred on the window.
    const bar = (await page.locator('.hero .see').boundingBox())!;
    expect(Math.abs(bar.x + bar.width / 2 - (f.x + f.width / 2))).toBeLessThan(1);
    expect(await hit(page).evaluate((e) => getComputedStyle(e).cursor)).toBe('pointer');
    // The frame stays put (the quiet finish: nothing lifts under the pointer); its edge lights instead.
    const edge = () => page.locator('.hero .frame').evaluate((e) => getComputedStyle(e).boxShadow);
    // (Polled: the frame's entrance, a short rise, may still be running.)
    await expect.poll(() => page.locator('.hero .frame').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
    const lit = await edge();
    await page.mouse.move(4, 600);
    await expect.poll(edge).not.toBe(lit);
    expect(await page.locator('.hero .frame').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
  });

  test('intent: 150 ms of hover loads the stage (and the demo prefetch); a pointer just passing by loads nothing', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await armed(page);
    // How long the pointer really stayed, as the page saw it (a loaded machine can stretch a short pass).
    await hit(page).evaluate((e) => {
      const w = window as unknown as { dwell: number[] };
      w.dwell = [];
      let t = 0;
      e.addEventListener('pointerenter', () => { t = performance.now(); });
      e.addEventListener('pointerleave', () => w.dwell.push(performance.now() - t));
    });
    const box = (await hit(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.move(4, 600);
    await page.waitForTimeout(400);
    const dwell = await page.evaluate(() => (window as unknown as { dwell: number[] }).dwell[0]!);
    expect(requests.filter((p) => /live-demo-stage/i.test(p)).length > 0, `pointer stayed ${Math.round(dwell)} ms`).toBe(dwell >= 150);
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await expect.poll(() => requests.filter((p) => /live-demo-stage/i.test(p)).length).toBeGreaterThan(0);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  test('no pill, no link, no listeners, no demo bytes; tapping the window does nothing', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(new URL(r.url()).pathname));
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await expect(page.locator('.hero .demo-hit')).toBeHidden();
    await expect(page.locator('.hero .demo-pill')).toBeHidden();
    await expect(page.locator('[data-live-demo][data-armed]')).toHaveCount(0);
    await page.locator('.hero .frame').tap();
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('html')).not.toHaveAttribute('data-demo');
    expect(requests.filter((p) => p.startsWith('/demo-app/') || /live-demo-stage/i.test(p))).toEqual([]);
    expect(await listeners(page, '.hero .demo-hit')).toBe(0);
  });
});

// Event listeners on an element, as DevTools counts them: the phone has none, the desktop some (the check works).
async function listeners(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
  const { listeners: l } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId! });
  return l.length;
}
test('desktop: the controls do have listeners (the phone check above is meaningful)', async ({ page }) => {
  await armed(page);
  expect(await listeners(page, '.hero .demo-hit')).toBeGreaterThan(0);
});

test.describe('the immersive demo (stub)', () => {
  test('click: the window becomes the demo at /demo, the header leaves, keys belong to the demo; exit comes back where it was', async ({ page }) => {
    const loads = await stub(page);
    await armed(page);
    // 'manual' (kept by the entry it is set on): a browser that does not restore the scroll on Back by itself, as
    // Chromium does; the stage restores it then.
    await page.evaluate(() => { history.scrollRestoration = 'manual'; window.scrollTo({ top: 160, behavior: 'instant' }); });
    // A click where the window is on screen (locator.click() would first scroll it into view).
    await page.mouse.click(720, 640);
    await isOpen(page);
    await expect(page.locator('header.appbar')).toBeHidden();
    await expect(stage(page)).toHaveAttribute('role', 'dialog');
    await expect(iframe(page)).toHaveAttribute('title', 'Atelier live demo');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    await expect.poll(async () => (await received(page)).map((m) => m.type)).toContain('focus');
    // The window fills the viewport, 12 px in.
    const win = (await stage(page).locator('.demo-win').boundingBox())!;
    expect([win.x, win.y, win.width, win.height].map(Math.round)).toEqual([12, 12, 1440 - 24, 900 - 24]);

    // Focus forced onto the page (a click on the dimmed edge would do it): ⌘K and / go to the demo, not the site search.
    // The first key the page sees is re-dispatched and puts the focus back in the demo, so the rest of a chord arrives
    // there natively: ⌘K is Meta re-dispatched, then K, with ⌘ held, in the demo itself.
    type Got = { type: string; key: string | { key: string; metaKey: boolean }; metaKey?: boolean };
    const keys = async () => ((await received(page)) as unknown as Got[]).flatMap((m) =>
      m.type === 'key' ? [`sent ${(m.key as { key: string; metaKey: boolean }).metaKey ? '⌘' : ''}${(m.key as { key: string }).key}`]
      : m.type === 'native-key' ? [`native ${m.metaKey ? '⌘' : ''}${m.key as string}`] : []);
    for (const [press, expected] of [['Meta+k', ['sent ⌘Meta', 'native ⌘k']], ['/', ['sent /']]] as const) {
      await iframe(page).evaluate((f) => (f as HTMLIFrameElement).blur());
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
      const before = (await keys()).length;
      await page.keyboard.press(press);
      await expect.poll(async () => (await keys()).slice(before), press).toEqual(expect.arrayContaining([...expected]));
      await expect(page.locator('dialog.search-sheet')).toBeHidden();
      expect(await page.evaluate(() => document.activeElement?.tagName), press).toBe('IFRAME');
    }
    // A re-dispatched key carries exactly what the app's handlers read.
    const sent = (await received(page)).find((m) => m.type === 'key') as unknown as { key: Record<string, unknown> };
    expect(sent.key).toEqual({ key: 'Meta', code: 'MetaLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false });

    // Something scrolls the page under the open demo (a browser resetting a locked page, a focus): exit restores it.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await send(page, { type: 'exit' });
    await isClosed(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(160);
    await expect(hit(page)).toBeFocused();

    // Again: the same demo resumes where it was (no second load), and Back leaves it too.
    await page.mouse.click(720, 640);
    await isOpen(page);
    // The demo's directory itself, once: /demo-app/index.html would cost a redirect (Cloudflare Pages serves it at
    // /demo-app/). Its assets may have been prefetched on intent (the focus back on the window).
    expect(loads.filter((p) => !p.startsWith('/demo-app/assets/'))).toEqual(['/demo-app/']);
    await expect.poll(async () => (await received(page)).map((m) => m.type)).toEqual(expect.arrayContaining(['pause', 'resume']));
    await page.goBack();
    await isClosed(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(160);
    // Forward opens it once more.
    await page.goForward();
    await isOpen(page);
  });

  test('Forward pressed while the demo is still closing opens it again: the page follows the URL', async ({ page }) => {
    await stub(page);
    await armed(page);
    await hit(page).click();
    await isOpen(page);
    // Back starts the 200 ms close; Forward lands mid-animation (no await on the close).
    await page.evaluate(() => { history.back(); setTimeout(() => history.forward(), 60); });
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/demo');
    await isOpen(page);
  });

  test('Enter and Space open it from the keyboard; the text link opens it too', async ({ page }) => {
    await stub(page);
    await armed(page);
    for (const key of ['Enter', ' ']) {
      await hit(page).focus();
      await page.keyboard.press(key === ' ' ? 'Space' : key);
      await isOpen(page);
      await send(page, { type: 'exit' });
      await isClosed(page);
    }
    await page.locator('.hero .demo-pill').click();
    await isOpen(page);
  });

  test('a modified click (new tab) is the browser\'s: the page does not open the demo in place', async ({ page }) => {
    await stub(page);
    await armed(page);
    const popup = page.context().waitForEvent('page');
    await hit(page).click({ modifiers: ['Meta'] });
    expect(new URL((await popup).url()).pathname).toBe('/demo');
    await expect(page.locator('html')).not.toHaveAttribute('data-demo');
    await expect(page).toHaveURL(/\/$/);
  });

  test('the green light asks for full screen: the page puts the demo\'s iframe in full screen', async ({ page }) => {
    await stub(page);
    await armed(page);
    await hit(page).click();
    await isOpen(page);
    await send(page, { type: 'fullscreen' });
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? null)).toBe('IFRAME');
    await send(page, { type: 'exit' });
    await isClosed(page);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  });

  test('messages from anywhere else are ignored', async ({ page }) => {
    await stub(page);
    await armed(page);
    await hit(page).click();
    await isOpen(page);
    // The page posting to itself (another script, an extension): right shape, wrong source window.
    await page.evaluate(() => window.postMessage({ source: 'atelier-demo', type: 'exit' }, location.origin));
    await page.waitForTimeout(400);
    await expect(page.locator('html')).toHaveAttribute('data-demo', 'open');
    // The demo itself, but a malformed message.
    await send(page, { type: 'exit', now: true });
    await page.waitForTimeout(400);
    await expect(page.locator('html')).toHaveAttribute('data-demo', 'open');
  });
});

// The opening and the closing (Leaving): the launch. The click presses the window (a copy of it, over
// the dimming page) and an "Opening Atelier…" pill beats where "Try it live" was; the demo boots hidden, at its final
// size; once it is ready, and never sooner than 240 ms after the click, the live app itself zooms open from the
// window's place, downscaled (crisp) all the way to exactly its size. Nothing is ever drawn above its own size.
interface Sample {
  /** ms since the click (or since the recording started, for a closing). */
  t: number;
  demo: string | undefined;
  stage: string;
  busy: string | null;
  /** The demo has said `ready` (as the page heard it). */
  ready: boolean;
  /** The pressed copy of the window: its scale and box, whether a press (a scale animation) is under way on it (null: none shown). */
  press: { scale: number; pressing: boolean; opacity: number; x: number; y: number; w: number; h: number } | null;
  pill: { text: string; opacity: number; x: number; y: number } | null;
  /** The open window (the live app in it): computed, so mid-animation. */
  win: { opacity: number; scale: number; transform: string; origin: string };
  backdrop: number;
  iframe: { src: string | null; x: number; y: number; w: number; h: number } | null;
  /** The largest scale any screenshot (or the live app) is drawn at: its ancestors' transforms, multiplied. */
  drawn: number;
  /** A script animation of the stage moves something (transform keyframes). */
  moving: boolean;
}
/** Records what the stage looks like at every frame, for `ms` from the next click (or from now: `fromClick` false). */
const record = (page: Page, ms: number, fromClick = true) => page.evaluate(([ms, fromClick]) => {
  const w = window as unknown as { __frames: Sample[]; __recording: Promise<void>; __ready?: boolean; __t0?: number };
  w.__frames = [];
  w.__t0 = fromClick ? undefined : performance.now();
  if (fromClick) addEventListener('click', () => { w.__t0 = performance.now(); }, { capture: true, once: true });
  addEventListener('message', (e) => { if ((e.data as { type?: string } | null)?.type === 'ready') w.__ready = true; });
  const scaleOf = (e: Element | null) => {
    let s = 1;
    for (; e && e !== document.documentElement; e = e.parentElement) {
      const t = getComputedStyle(e).transform;
      if (t !== 'none') s *= new DOMMatrix(t).a;
    }
    return s;
  };
  const shown = (e: HTMLElement | null) => e && !e.hidden && e.closest('[hidden]') === null ? e : null;
  w.__recording = new Promise<void>((done) => {
    const tick = () => {
      const now = performance.now();
      if (w.__t0 !== undefined) {
        const stage = document.querySelector<HTMLElement>('.demo-stage');
        const press = shown(document.querySelector<HTMLElement>('.demo-press'));
        const clone = press?.firstElementChild ?? null;
        const pill = shown(document.querySelector<HTMLElement>('.demo-launch'));
        const win = document.querySelector<HTMLElement>('.demo-win');
        const f = document.querySelector<HTMLIFrameElement>('.demo-stage iframe');
        const pr = clone?.getBoundingClientRect(), pl = pill?.getBoundingClientRect(), fr = f?.getBoundingClientRect();
        const ws = win ? getComputedStyle(win) : null;
        const shots = [...document.querySelectorAll('.demo-stage img, [data-live-demo] img'), ...(f ? [f] : [])];
        w.__frames.push({
          t: now - w.__t0, demo: document.documentElement.dataset.demo, stage: stage?.className ?? '', busy: stage?.getAttribute('aria-busy') ?? null,
          ready: w.__ready === true,
          press: clone && pr ? { scale: scaleOf(clone), pressing: clone.getAnimations().some((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => 'transform' in k)), opacity: Number(getComputedStyle(press!).opacity), x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null,
          pill: pill && pl ? { text: pill.textContent!.trim().replace(/\s+/g, ' '), opacity: Number(getComputedStyle(pill).opacity), x: pl.x + pl.width / 2, y: pl.y + pl.height / 2 } : null,
          win: { opacity: Number(ws?.opacity ?? 0), scale: win ? scaleOf(win) : 1, transform: ws?.transform ?? '', origin: ws?.transformOrigin ?? '' },
          backdrop: Number(getComputedStyle(document.querySelector('.demo-backdrop') ?? document.body).opacity),
          iframe: f && fr ? { src: f.getAttribute('src'), x: fr.x, y: fr.y, w: fr.width, h: fr.height } : null,
          drawn: Math.max(0, ...shots.map(scaleOf)),
          moving: document.getAnimations().some((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.playState === 'running'
            && (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => 'transform' in k) === true
            && ((a.effect as KeyframeEffect).target as Element | null)?.closest('.demo-stage') !== null)
        });
        if (now - w.__t0 >= ms) { done(); return; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}, [ms, fromClick] as const);
const recorded = (page: Page) => page.evaluate(async () => {
  const w = window as unknown as { __frames: Sample[]; __recording: Promise<void> };
  await w.__recording;
  return w.__frames;
});
/** Hover first (intent): the stage is loaded, so the click opens it in the same task, as for a visitor who aims. */
const aim = async (page: Page) => {
  await page.mouse.move(720, 780);
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some((r) => /live-demo-stage/.test(r.name)))).toBe(true);
  await page.waitForTimeout(150);
};
const at = (s: Sample) => `${Math.round(s.t)} ms`;
/** Nothing drawn above its own size: the live app, the pressed window, any screenshot. */
const neverUpscaled = (frames: Sample[]) => {
  for (const s of frames) {
    expect(s.drawn, at(s)).toBeLessThanOrEqual(1 + 1e-9);
    expect(s.win.scale, at(s)).toBeLessThanOrEqual(1 + 1e-9);
    if (s.press) expect(s.press.scale, at(s)).toBeLessThanOrEqual(1 + 1e-9);
  }
};

test.describe('the opening and the closing (the launch)', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the click: the window is pressed at once, "Opening Atelier…" beats, the demo loads hidden at its final size', async ({ page }) => {
    await stub(page, 'silent');
    await armed(page);
    await aim(page);
    await page.waitForTimeout(300); // the hover's lift and pill have settled
    const frame = (await page.locator('.hero .frame').boundingBox())!;
    const hover = await page.locator('.hero .demo-pill').evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await record(page, 800);
    await page.mouse.click(720, 780);
    const frames = await recorded(page);
    const [f0, f1] = frames;
    // The first frame after the click: the window's copy where the window was (the page's own has left), the pill
    // where "Try it live" was, the demo's frame at the open window's rect (12 px in), invisible.
    expect(f0!.demo).toBe('opening');
    expect(f0!.press, 'pressed copy').not.toBeNull();
    expect([f0!.press!.x, f0!.press!.y, f0!.press!.w].map(Math.round)).toEqual([frame.x, frame.y, frame.width].map(Math.round));
    expect(f0!.pill?.text).toBe('Opening Atelier…');
    expect(Math.abs(f0!.pill!.x - hover.x)).toBeLessThan(1);
    expect(Math.abs(f0!.pill!.y - hover.y)).toBeLessThan(1);
    expect(f0!.iframe).toMatchObject({ x: 12, y: 12, w: 1416, h: 876 });
    expect(f0!.win.opacity).toBe(0);
    await expect(page.locator('.hero .window')).toHaveCSS('visibility', 'hidden');
    // In that same first frame the press is under way (on the compositor: it moves from the frame its animation
    // is committed in); by the next one the demo is loading its directory (no redirect hop).
    expect(f0!.press!.pressing).toBe(true);
    expect(frames.some((s) => s.press!.scale < 1 && s.press!.scale > 0.985 + 1e-6), 'a press, not a jump').toBe(true);
    expect(f1!.iframe!.src).toBe('/demo-app/');
    // It settles pressed (.985) and darkened; the page dims to about 70 %, steadily; the app stays hidden (no ready).
    const last = frames.at(-1)!;
    expect(last.press!.scale).toBeCloseTo(0.985, 3);
    expect(last.backdrop).toBeCloseTo(0.7, 2);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.backdrop, at(frames[i]!)).toBeGreaterThanOrEqual(frames[i - 1]!.backdrop);
    for (const s of frames) expect(s.win.opacity, at(s)).toBe(0);
    neverUpscaled(frames);
    // Booting: the stage says so.
    expect(last.busy).toBe('true');
    await expect(page.locator('html')).toHaveAttribute('data-demo', 'opening');
    await expect(page.locator('header.appbar')).toBeVisible();
  });

  test('ready: the live app zooms open from the window, never before 240 ms; downscaled all the way, exactly itself at rest', async ({ page }) => {
    await stub(page);
    await armed(page);
    await aim(page);
    await record(page, 900);
    await page.mouse.click(720, 780);
    const frames = await recorded(page);
    const shown = frames.findIndex((s) => s.win.opacity > 0);
    expect(shown, 'the app shows').toBeGreaterThan(0);
    // Only once the demo is ready, and a beat after the click: a launch, not a glitch.
    expect(frames[shown]!.ready).toBe(true);
    expect(frames[shown]!.t).toBeGreaterThanOrEqual(240);
    const live = frames.find((s) => /is-ready/.test(s.stage))!;
    expect(live.ready).toBe(true);
    expect(live.t).toBeGreaterThanOrEqual(240);
    // The zoom: from about .93 to 1, never above; a fade-in over its first part, not a cut.
    const zoom = frames.slice(shown);
    expect(Math.min(...zoom.map((s) => s.win.scale))).toBeLessThan(0.97);
    expect(zoom.some((s) => s.win.opacity > 0 && s.win.opacity < 1), 'a fade, not a cut').toBe(true);
    neverUpscaled(frames);
    // Around the window's visible centre (the hero runs past the fold): 12 px in, the open window's own coordinates.
    const f = await page.locator('.hero .frame').evaluate((e) => { const r = e.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2 }; });
    const [ox, oy] = frames[shown]!.win.origin.split(' ').map(parseFloat);
    expect(Math.abs(ox! - (f.x - 12))).toBeLessThan(2);
    expect(Math.abs(oy! - (f.y - 12))).toBeLessThan(6);
    // The page goes fully dim, never flashing; the header leaves with the zoom.
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.backdrop, at(frames[i]!)).toBeGreaterThanOrEqual(frames[i - 1]!.backdrop - 1e-6);
    expect(frames[shown]!.demo).toBe('open');
    await isOpen(page);
    // At rest: no transform at all, nothing animating, the copy and the pill gone.
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.playState === 'running').length)).toBe(0);
    expect(await stage(page).locator('.demo-win').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
    expect(await stage(page).locator('.demo-backdrop').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    await expect(stage(page).locator('.demo-press')).toBeHidden();
    await expect(stage(page).locator('.demo-launch')).toBeHidden();
  });

  test('a slow start: the pill keeps beating, says it takes a moment after a while; the stage is busy until ready', async ({ page }) => {
    await stub(page, 'silent');
    await armed(page);
    await aim(page);
    await page.mouse.click(720, 780);
    const pill = stage(page).locator('.demo-launch');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('role', 'status');
    await expect(stage(page)).toHaveAttribute('aria-busy', 'true');
    // The beat: a CSS animation on the mark, running.
    expect(await pill.locator('.demo-launch-mark').evaluate((e) => e.getAnimations().some((a) => a.playState === 'running'))).toBe(true);
    await page.waitForTimeout(1500);
    await expect(pill).toHaveText('Opening Atelier…');
    await expect(pill).toHaveText('Opening Atelier… First start takes a moment', { timeout: 2500 });
    await expect(pill.locator('.demo-launch-more')).toBeVisible();
    expect(await stage(page).locator('.demo-win').evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
    await send(page, { type: 'ready' });
    await isOpen(page);
    await expect(pill).toBeHidden();
    await expect(stage(page)).not.toHaveAttribute('aria-busy');
    // The next slow start begins with one line again.
    await expect(pill).toHaveText('');
  });

  test('closing: the app shrinks a little toward the window and fades; the window and the page come back', async ({ page }) => {
    await stub(page);
    await armed(page);
    await aim(page);
    await page.mouse.click(720, 780);
    await isOpen(page);
    await record(page, 600, false);
    await send(page, { type: 'exit' });
    const frames = (await recorded(page)).filter((s) => s.demo === 'closing');
    expect(frames.length, 'frames of the closing').toBeGreaterThan(5);
    neverUpscaled(frames);
    expect(Math.min(...frames.map((s) => s.win.scale))).toBeLessThan(0.98);
    for (const s of frames) expect(s.win.scale, at(s)).toBeGreaterThanOrEqual(0.95 - 1e-6);
    // Gone well before the end: about 110 ms in.
    for (const s of frames.filter((s) => s.t > 170)) expect(s.win.opacity, at(s)).toBe(0);
    // The window's copy comes back at its place, unpressed; the page undims, never flashing.
    const back = frames.filter((s) => s.press);
    expect(back.length).toBeGreaterThan(0);
    for (const s of back) expect(s.press!.scale, at(s)).toBe(1);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.backdrop, at(frames[i]!)).toBeLessThanOrEqual(frames[i - 1]!.backdrop + 1e-6);
    await isClosed(page);
  });

  test('opening again: the kept-alive demo zooms open at once (it is ready), with no pill', async ({ page }) => {
    await stub(page);
    await armed(page);
    await aim(page);
    await page.mouse.click(720, 780);
    await isOpen(page);
    await send(page, { type: 'exit' });
    await isClosed(page);
    await aim(page);
    await record(page, 700);
    await page.mouse.click(720, 780);
    await isOpen(page);
    const frames = await recorded(page);
    const shown = frames.findIndex((s) => s.win.opacity > 0);
    expect(frames[shown]!.t).toBeLessThan(120);
    expect(Math.min(...frames.slice(shown).map((s) => s.win.scale))).toBeLessThan(0.97);
    expect(frames.some((s) => s.pill)).toBe(false);
    expect(frames.every((s) => s.busy === null)).toBe(true);
    neverUpscaled(frames);
  });

  test('the motion runs on the compositor: the app keeps zooming while the page\'s main thread is busy', async ({ page }) => {
    await stub(page);
    await armed(page);
    await aim(page);
    // The open window in white over a black backdrop, nothing else drawn: a row of pixels measures its width.
    await page.addStyleTag({ content: '.demo-stage .demo-backdrop { background: rgb(0 0 0) !important } .demo-stage .demo-win { background: rgb(255 255 255) !important } .demo-stage .demo-win > *, .demo-stage .demo-shade, .demo-stage .demo-press, .demo-stage .demo-launch { visibility: hidden !important }' });
    const cdp = await page.context().newCDPSession(page);
    const frames: { t: number; data: string }[] = [];
    cdp.on('Page.screencastFrame', (f) => {
      frames.push({ t: f.metadata.timestamp! * 1000, data: f.data });
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => { /* closed */ });
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    // Two frames into the zoom (it is on the compositor by then), the page blocks its main thread for 250 ms, as the
    // demo booting in its iframe may.
    await page.evaluate(() => {
      const w = window as unknown as { __busy: [number, number] };
      new MutationObserver((_, o) => {
        if (!document.querySelector('.demo-stage.is-ready')) return;
        o.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const start = Date.now();
          while (Date.now() - start < 250) { /* busy */ }
          w.__busy = [start, Date.now()];
        }));
      }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    });
    await page.mouse.click(720, 780);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __busy?: number[] }).__busy)).toBeDefined();
    await page.waitForTimeout(300);
    await cdp.send('Page.stopScreencast');
    const [from, to] = await page.evaluate(() => (window as unknown as { __busy: [number, number] }).__busy);
    const widths: number[] = [];
    for (const f of frames.filter((f) => f.t > from + 20 && f.t < to - 20)) {
      // Row 450 of the frame (in CSS px), its white pixels counted.
      widths.push(await page.evaluate(async (data) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const y = Math.round(450 * bmp.height / innerHeight);
        const row = g.getImageData(0, y, bmp.width, 1).data;
        let white = 0;
        for (let i = 0; i < row.length; i += 4) if (row[i]! > 200 && row[i + 1]! > 200 && row[i + 2]! > 200) white++;
        return Math.round(white * innerWidth / bmp.width);
      }, f.data));
    }
    // While the main thread was blocked, the app kept growing, frame after frame, up to its size.
    expect(new Set(widths).size, `widths while blocked: ${widths.join(', ')}`).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]!);
    expect(Math.max(...widths)).toBeLessThanOrEqual(1416);
  });
});

test.describe('when the demo cannot start', () => {
  for (const [mode, what] of [['silent', 'no ready in time'], ['failed', 'it says failed']] as const) {
    test(`${what}: back to the hero, with a toast pointing to the download`, async ({ page }) => {
      await stub(page, mode);
      await armed(page);
      // Silent: the timeout, shortened. Failed: the default 10 s, so only the message itself can be what fails it.
      if (mode === 'silent') await page.locator('.hero [data-live-demo]').evaluate((e) => { e.setAttribute('data-demo-timeout', '800'); });
      await hit(page).click();
      const toast = page.locator('.demo-toast');
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast).toHaveText(/The live demo couldn't start\. Download Atelier to try it for real\./);
      await expect(toast.getByRole('link', { name: 'Download Atelier' })).toHaveAttribute('href', '/download');
      await isClosed(page);
      await expect(hit(page)).toBeFocused();
      await expect(stage(page).locator('iframe')).toHaveCount(0);
      await toast.getByRole('button', { name: 'Close' }).click();
      await expect(toast).toBeHidden();
    });
  }

  // A background tab stalls the demo's frames: the wait for `ready` counts only the time the page is seen.
  test('no ready while the page is hidden: the wait counts visible time only', async ({ page }) => {
    await stub(page, 'silent');
    await armed(page);
    await page.locator('.hero [data-live-demo]').evaluate((e) => { e.setAttribute('data-demo-timeout', '1200'); });
    const setHidden = (hidden: boolean) => page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await hit(page).click();
    await setHidden(true);
    await page.waitForTimeout(3000);
    await expect(page.locator('.demo-toast')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-demo', 'opening');
    await expect(iframe(page)).toHaveCount(1);
    await setHidden(false);
    await expect(page.locator('.demo-toast')).toBeVisible({ timeout: 5000 });
    await isClosed(page);
  });
});

// Feature rows the demo can show (features.ts › demo): "Try it" opens the same demo, from that row's window,
// on that row's view. One iframe per page: every control reuses it. The rows live on /features: leaving the demo comes
// back there, at the row.
const ROW_VIEWS = { sessions: 'view-sessions', ask: 'demo:ask', workspace: 'split-right', background: 'show-background', docker: 'view-docker', redis: 'view-redis', databases: 'view-databases', changes: 'review-all', editor: 'demo:editor', accounts: 'new-session-account:work' } as const;
const opens = async (page: Page) => (await received(page)).flatMap((m) => (m.type === 'open' ? [(m as unknown as { view: string }).view] : []));
const indexLoads = (loads: string[]) => loads.filter((p) => p === '/demo-app/').length;
const closedOn = async (page: Page, url: RegExp) => {
  await expect(page).toHaveURL(url);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo');
  await expect(stage(page)).toBeHidden();
  await expect(page.locator('header.appbar')).toBeVisible();
};

test.describe('feature rows: "Try it"', () => {
  test('rows the demo can show carry a "Try it" control and a live window on their view; the others none', async ({ page }) => {
    await armed(page, '/features');
    for (const [id, view] of Object.entries(ROW_VIEWS)) {
      const row = page.locator(`#${id}`);
      await expect(row.locator('[data-live-demo]'), id).toHaveAttribute('data-demo-view', view);
      await expect(row.locator('[data-live-demo]'), id).toHaveAttribute('data-armed', '');
      const tryIt = row.locator('.try-live');
      await expect(tryIt, id).toBeVisible();
      await expect(tryIt, id).toHaveAttribute('href', '/demo');
      await expect(tryIt, id).toHaveAttribute('data-live-demo-for', id);
      await expect(tryIt, id).toHaveText(/Try it live/);
    }
    // Their names say what opens (the button's starts with its visible text). The button is the keyboard's way in: the
    // window is not a second tab stop on every row.
    await expect(page.getByRole('link', { name: 'Try it live: Docker, in your browser', exact: true })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Try Docker live in your browser', exact: true })).toHaveCount(1);
    await expect(page.locator('#docker .demo-hit')).toHaveAttribute('tabindex', '-1');
    for (const id of ['dictation', 'alive']) {
      await expect(page.locator(`#${id} [data-live-demo]`), id).toHaveCount(0);
      await expect(page.locator(`#${id} .try-live`), id).toHaveCount(0);
    }
  });

  test('hovering a row\'s window lights the row\'s Try it and leaves the window in place; no pill covers the shot', async ({ page }) => {
    await armed(page, '/features');
    const row = page.locator('#docker');
    await row.locator('.window').scrollIntoViewIfNeeded();
    const tryIt = row.locator('.try-live');
    const glow = () => tryIt.evaluate((e) => getComputedStyle(e).backgroundColor);
    const rest = await glow();
    await row.locator('.demo-hit').hover();
    // The shot's own bottom bar (Docker: "2 lines · Send to auth-refactor") stays readable: the rows have no pill over
    // the screenshot; the row's own "Try it live" lights up instead (the hero keeps its pill).
    await expect(row.locator('.demo-pill')).toHaveCount(0);
    await expect(tryIt).toHaveAttribute('data-hot', '');
    await expect.poll(glow).not.toBe(rest);
    await page.mouse.move(4, 4);
    await expect(tryIt).not.toHaveAttribute('data-hot');
    await row.locator('.demo-hit').hover();
    // Nothing rises (the quiet finish): neither the window nor the frame inside it.
    await expect(tryIt).toHaveAttribute('data-hot', '');
    expect(await row.locator('.window').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
    expect(await row.locator('.frame').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
  });

  test('Try it opens the demo from that row\'s window, on its view; another row reuses the same iframe; leaving comes back to the row', async ({ page }) => {
    const loads = await stub(page);
    await armed(page, '/features');
    const row = page.locator('#docker');
    // In view, its scroll reveal over (the frame is where it stays).
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator('.media')).toHaveClass(/is-in/);
    await expect.poll(() => row.locator('.media').evaluate((m) => m.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
    const frame = (await row.locator('.frame').boundingBox())!;
    await record(page, 1200);
    await row.locator('.try-live').click();
    await isOpen(page);
    const frames = await recorded(page);
    // The press is this row's window: its copy over the row's frame, with the row's screenshot.
    const pressed = frames.find((s) => s.press)!;
    expect([pressed.press!.x, pressed.press!.y, pressed.press!.w, pressed.press!.h].map(Math.round)).toEqual([frame.x, frame.y, frame.width, frame.height].map(Math.round));
    // The pill, then the app's zoom, at the centre of the row window's part on screen.
    const c = { x: frame.x + frame.width / 2, y: (Math.max(0, frame.y) + Math.min(900, frame.y + frame.height)) / 2 };
    expect(Math.abs(pressed.pill!.x - c.x)).toBeLessThan(1);
    expect(Math.abs(pressed.pill!.y - c.y)).toBeLessThan(1);
    const shown = frames.find((s) => s.win.opacity > 0)!;
    const [ox, oy] = shown.win.origin.split(' ').map(parseFloat);
    expect(Math.abs(ox! - (c.x - 12))).toBeLessThan(1);
    expect(Math.abs(oy! - (c.y - 12))).toBeLessThan(1);
    neverUpscaled(frames);
    // The row's view reached the demo before the app showed: it opens on it, never on the default view first.
    const t0 = await page.evaluate(() => (window as unknown as { __t0: number }).__t0);
    const open = (await received(page)).find((m) => m.type === 'open') as unknown as { at: number };
    expect(open.at).toBeLessThan(t0 + shown.t);
    await expect.poll(() => opens(page)).toEqual(['view-docker']);
    // The demo's own way out: back on /features, at the row, its "Try it" focused.
    await send(page, { type: 'exit' });
    await closedOn(page, /\/features$/);
    await expect(row.locator('.try-live')).toBeFocused();
    await expect(row.locator('.frame')).toBeVisible();
    await expect(row.locator('.frame')).toBeInViewport();

    // From another row, through its window this time: still one iframe, now on Redis. Back leaves it, at that row.
    await page.locator('#redis .window').scrollIntoViewIfNeeded();
    await page.locator('#redis .demo-hit').click();
    await isOpen(page);
    expect(indexLoads(loads)).toBe(1);
    await expect.poll(() => opens(page)).toEqual(['view-docker', 'view-redis']);
    await page.goBack();
    await closedOn(page, /\/features$/);
    await expect(page.locator('#redis .frame')).toBeInViewport();
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    test('no Try it controls on the rows, no listeners, no demo bytes', async ({ page }) => {
      const requests: string[] = [];
      page.on('request', (r) => requests.push(new URL(r.url()).pathname));
      await page.goto('/features', { waitUntil: 'networkidle' });
      for (const id of Object.keys(ROW_VIEWS)) {
        await expect(page.locator(`#${id} .try-live`), id).toBeHidden();
        await expect(page.locator(`#${id} .demo-hit`), id).toBeHidden();
      }
      await expect(page.locator('[data-live-demo][data-armed]')).toHaveCount(0);
      await page.locator('#docker .frame').tap();
      await page.waitForTimeout(400);
      await expect(page.locator('html')).not.toHaveAttribute('data-demo');
      expect(requests.filter((p) => p.startsWith('/demo-app/') || /live-demo-stage/i.test(p))).toEqual([]);
      expect(await listeners(page, '#docker .try-live')).toBe(0);
    });
  });
});

// The home's two windows: each opens the demo on its view, with a name of
// its own and its own tab stop; the hero and both reuse one iframe.
test.describe('the home\'s windows', () => {
  test('who needs you and Ask open the demo on their view; the hero reuses the same iframe', async ({ page }) => {
    const loads = await stub(page);
    await armed(page);
    const sessions = page.locator('[data-live-demo="home-sessions"]');
    const ask = page.locator('[data-live-demo="home-ask"]');
    await expect(sessions).toHaveAttribute('data-demo-view', 'view-sessions');
    await expect(ask).toHaveAttribute('data-demo-view', 'demo:ask');
    for (const name of ['Try Sessions live in your browser', 'Try Ask live in your browser']) {
      const link = page.getByRole('link', { name, exact: true });
      await expect(link, name).toHaveCount(1);
      await expect(link, name).not.toHaveAttribute('tabindex'); // nothing else in the block opens it
    }
    await expect(sessions.locator('.demo-pill')).toHaveCount(0);

    await sessions.scrollIntoViewIfNeeded();
    await sessions.locator('.demo-hit').click();
    await isOpen(page);
    await expect.poll(() => opens(page)).toEqual(['view-sessions']);
    await send(page, { type: 'exit' });
    await closedOn(page, /\/$/);
    await expect(sessions.locator('.demo-hit')).toBeFocused();

    await ask.scrollIntoViewIfNeeded();
    await ask.locator('.demo-hit').click();
    await isOpen(page);
    expect(indexLoads(loads)).toBe(1);
    await expect.poll(() => opens(page)).toEqual(['view-sessions', 'demo:ask']);
    await send(page, { type: 'exit' });
    await closedOn(page, /\/$/);

    // From the hero: the same iframe, resumed where it was (no view of its own: nothing to open). Every reopening
    // resumes it: Ask's, then the hero's.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await hit(page).click();
    await isOpen(page);
    expect(indexLoads(loads)).toBe(1);
    await expect.poll(async () => (await received(page)).filter((m) => m.type === 'resume').length).toBe(2);
    expect(await opens(page)).toEqual(['view-sessions', 'demo:ask']);
    await send(page, { type: 'exit' });
    await isClosed(page);
  });
});

test.describe('/demo, the direct link', () => {
  test('opens straight into the demo; exiting goes home', async ({ page }) => {
    await stub(page);
    await page.goto('/demo');
    await expect(page).toHaveTitle(/live/i);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://useatelier.dev/demo');
    await isOpen(page);
    await send(page, { type: 'exit' });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Run many Claude Code sessions/);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    test('a friendly note, the screenshot and the download; no demo', async ({ page }) => {
      const requests: string[] = [];
      page.on('request', (r) => requests.push(new URL(r.url()).pathname));
      await page.goto('/demo', { waitUntil: 'networkidle' });
      await expect(page.getByText('The live demo needs a desktop browser.')).toBeVisible();
      await expect(page.locator('main [data-download]').first()).toBeVisible();
      await expect(page.locator('main .window .frame img')).toBeVisible();
      await expect(page.locator('.demo-stage')).toHaveCount(0);
      expect(requests.filter((p) => p.startsWith('/demo-app/'))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });
  });
});

test('reduced motion: no scale anywhere, plain fades (opening and closing)', async ({ browser }) => {
  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    const ctx = await (browser as Browser).newContext({ reducedMotion, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await stub(page);
    await armed(page);
    await aim(page);
    await record(page, 900);
    await page.mouse.click(720, 780);
    await isOpen(page);
    const opening = await recorded(page);
    await record(page, 500, false);
    await send(page, { type: 'exit' });
    await isClosed(page);
    const frames = [...opening, ...await recorded(page)];
    const scaled = frames.filter((s) => s.moving || s.win.scale !== 1 || (s.press && s.press.scale !== 1));
    // Reduced: nothing moves, the app fades in and out. Motion on: the press and the zoom (the check is meaningful).
    expect(scaled.length > 0, reducedMotion).toBe(reducedMotion === 'no-preference');
    expect(frames.some((s) => s.win.opacity > 0 && s.win.opacity < 1), `${reducedMotion}: a fade`).toBe(true);
    await ctx.close();
  }
});

test('the site\'s ⌘K and / stand down while the demo is open (belt and braces: keys normally never reach the page)', async ({ page }) => {
  await armed(page);
  await page.evaluate(() => { document.documentElement.dataset.demo = 'open'; });
  await page.keyboard.press('Meta+k');
  await page.keyboard.press('/');
  await expect(page.locator('dialog.search-sheet')).toBeHidden();
  await page.evaluate(() => { delete document.documentElement.dataset.demo; });
  await page.keyboard.press('Meta+k');
  await expect(page.locator('dialog.search-sheet')).toBeVisible();
});

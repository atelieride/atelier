import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

type Api = { atelier: { settings: { set(p: object): Promise<unknown> } } };

const names = Array.from({ length: 16 }, (_, i) => `component-with-a-long-name-${String(i + 1).padStart(2, '0')}.ts`);

async function withTabs(body: (win: Page, open: (n: string[]) => Promise<void>) => Promise<void>) {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  for (const n of names) writeFileSync(join(project, n), 'export {};\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app: ElectronApplication = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.evaluate(() => (window as unknown as Api).atelier.settings.set({ previewTabs: false }));
    await win.getByRole('button', { name: /^Files/ }).click();
    await body(win, async (list) => { for (const n of list) await win.locator('.tree-row', { hasText: n }).click(); });
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
}

const helpers = (win: Page) => {
  const strip = win.locator('.tab-strip');
  const tab = (name: string) => win.locator('.tab', { hasText: name });
  const inStrip = async (name: string) => {
    const s = (await strip.boundingBox())!;
    const t = (await tab(name).boundingBox())!;
    return t.x >= s.x - 1 && t.x + t.width <= s.x + s.width + 1;
  };
  const scrollLeft = () => strip.evaluate((el) => el.scrollLeft);
  // Waits for the strip to stop gliding and returns where it rests.
  const settled = async () => {
    let at = -1;
    await expect.poll(async () => { const prev = at; at = await scrollLeft(); return at === prev; }).toBe(true);
    return at;
  };
  return { strip, tab, inStrip, scrollLeft, settled };
};

// With many tabs open the strip overflows: a plain mouse wheel did nothing (Chromium scrolls sideways only on Shift),
// and "+" and the Changes toggle scrolled away with the tabs. Drops next to "+", clicks at the edge, fades; and tab drags
// with the pointer: near an edge of an overflowing strip, a dragged tab scrolls it (the
// system drag used to), so it can reach a place scrolled out of view. One window, its tabs opened as the steps need.
test('tab strip: the wheel scrolls it sideways, the active tab comes into view, "+" and Changes stay put; drops next to "+", a clicked tab comes whole under the pointer, a tab dragged to an edge scrolls it; fades follow width and order changes', async () => {
  await withTabs(async (win, open) => {
    const { strip, tab, inStrip, scrollLeft, settled } = helpers(win);
    const order = () => win.locator('.tab .tab-name').allTextContents();

    // Three tabs: the strip's own padding, right after the last tab, takes a dropped tab like "+" does (each in turn,
    // so the order comes back to the first one).
    await open(names.slice(0, 3));
    const pad = (await strip.boundingBox())!;
    await tab(names[0]!).dragTo(strip, { targetPosition: { x: pad.width - 4, y: pad.height / 2 } });
    await expect.poll(order).toEqual([names[1], names[2], names[0]]);
    await tab(names[1]!).dragTo(strip, { targetPosition: { x: pad.width - 4, y: pad.height / 2 } });
    await tab(names[2]!).dragTo(strip, { targetPosition: { x: pad.width - 4, y: pad.height / 2 } });
    await expect.poll(order).toEqual([names[0], names[1], names[2]]);

    // All sixteen: it overflows.
    await open(names.slice(3));
    await expect(win.locator('.tab[data-key^="f:"]')).toHaveCount(16);
    const inWindow = async (sel: string) => {
      const b = (await win.locator(sel).boundingBox())!;
      const width = await win.evaluate(() => window.innerWidth);
      return b.x >= 0 && b.x + b.width <= width;
    };
    // The last opened tab is active and shown; the strip fades on the side with more tabs.
    await expect.poll(() => inStrip(names[15]!)).toBe(true);
    await expect(strip).toHaveAttribute('data-fade', 'start');
    expect(await inWindow('.tab-new')).toBe(true);
    expect(await inWindow('.changes-toggle')).toBe(true);

    // The window narrows: the tab in front, whole, stays whole (it was left cut until clicked).
    const size = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const frames = () => win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const narrowTo = async (width: number) => {
      const was = await strip.evaluate((el) => el.clientWidth);
      await win.setViewportSize({ width, height: size.height });
      await expect.poll(() => strip.evaluate((el) => el.clientWidth)).toBeLessThan(was);
      await frames();
    };
    await narrowTo(size.width - 240);
    expect(await inStrip(names[15]!), 'the tab in front stays whole').toBe(true);
    // Wheeled out of view, then narrower again: left where the user put it.
    await strip.evaluate((el) => { el.scrollLeft = 0; });
    await settled();
    await narrowTo(size.width - 360);
    expect(await scrollLeft(), 'a tab scrolled away stays away').toBe(0);
    await win.setViewportSize(size);
    await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => inStrip(names[15]!)).toBe(true);

    // Activating a tab that is out of view (here from the file tree) scrolls it in.
    await win.locator('.tree-row', { hasText: names[0]! }).click();
    await expect.poll(() => inStrip(names[0]!)).toBe(true);
    await expect(strip).toHaveAttribute('data-fade', 'end');
    const bar = (await strip.boundingBox())!;
    await look(win, 'test-results/tab-strip-active.png', { clip: { x: bar.x - 20, y: bar.y - 6, width: 760, height: 90 } });

    // A vertical mouse wheel over the tabs scrolls them sideways.
    await win.mouse.move(bar.x + 120, bar.y + bar.height / 2);
    await win.mouse.wheel(0, 240);
    await expect.poll(scrollLeft).toBeGreaterThan(100);
    await expect(strip).toHaveAttribute('data-fade', 'start end');
    // Quick notches add up while it glides: none of the distance is lost.
    const at = await settled();
    await win.mouse.wheel(0, 100);
    await win.mouse.wheel(0, 100);
    await win.mouse.wheel(0, 100);
    await expect.poll(async () => Math.round(await scrollLeft())).toBe(Math.round(at) + 300);
    await look(win, 'test-results/tab-strip.png');

    // A tab dropped on "+" moves to the end and, being active, stays in view.
    await win.locator('.tree-row', { hasText: names[1]! }).click();
    await expect.poll(() => inStrip(names[1]!)).toBe(true);
    await tab(names[1]!).dragTo(win.locator('.tab-new'));
    await expect.poll(async () => (await order()).at(-1)).toBe(names[1]);
    await expect.poll(() => inStrip(names[1]!)).toBe(true);

    // Clicking a tab that is partly hidden at the edge brings it whole into view, its × in reach (it used to take
    // wheeling the strip to close it). The strip glides only as far as keeps the clicked point on that tab: the second
    // click of a double click lands on it again.
    const s = (await strip.boundingBox())!;
    const cutAtEnd = () => win.locator('.tab').evaluateAll((els, right) => {
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.left < right - 40 && r.right > right + 10; });
      return el?.querySelector('.tab-name')?.textContent ?? null;
    }, s.x + s.width);
    const under = (x: number, y: number) => win.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest('.tab')?.querySelector('.tab-name')?.textContent ?? null, [x, y]);
    await strip.evaluate((el) => { el.scrollLeft = 0; });
    await settled();
    const cut = await cutAtEnd();
    expect(cut).not.toBeNull();
    const near = (await tab(cut!).boundingBox())!;
    await tab(cut!).click({ position: { x: 20, y: 15 } });
    await expect(tab(cut!)).toHaveClass(/is-active/);
    await expect.poll(() => inStrip(cut!), 'the clicked tab is whole').toBe(true);
    expect(await settled()).toBeGreaterThan(0);
    await expect(tab(cut!).locator('.tab-close')).toBeVisible();
    expect(await under(near.x + 20, near.y + 15), 'the clicked point is still on it').toBe(cut);
    await look(win, 'test-results/tab-strip-clicked.png', { clip: { x: s.x + s.width - 700, y: s.y - 6, width: 760, height: 90 } });
    // Clicked right by the strip's edge (where a full reveal would slide the next tab under the pointer): whole all the
    // same, and still under the pointer. The first tab in front again (from the tree): that one is cut again.
    await win.locator('.tree-row', { hasText: names[0]! }).click();
    await expect(tab(names[0]!)).toHaveClass(/is-active/);
    await strip.evaluate((el) => { el.scrollLeft = 0; });
    await settled();
    const edge = await cutAtEnd();
    expect(edge).toBe(cut);
    const byEdge = { x: s.x + s.width - 6, y: near.y + 15 };
    await win.mouse.click(byEdge.x, byEdge.y);
    await expect(tab(edge!)).toHaveClass(/is-active/);
    await expect.poll(() => inStrip(edge!), 'the tab clicked by the edge is whole').toBe(true);
    await settled();
    expect(await under(byEdge.x, byEdge.y), 'the point clicked by the edge is still on it').toBe(edge);
    // The tab already in front, cut by a scroll: a click on it brings it whole too.
    await strip.evaluate((el, key) => { const t = el.querySelector<HTMLElement>(`.tab[data-key="${key}"]`)!; el.scrollLeft = t.offsetLeft + t.offsetWidth - el.clientWidth - 60; }, await tab(edge!).getAttribute('data-key'));
    await settled();
    expect(await inStrip(edge!)).toBe(false);
    const front = (await tab(edge!).boundingBox())!;
    await win.mouse.click(Math.max(front.x, s.x) + 12, front.y + 15);
    await expect.poll(() => inStrip(edge!), 'the tab in front, clicked, is whole').toBe(true);
    await settled();
    await strip.evaluate((el) => { el.scrollLeft = 0; });
    await settled();

    // The first tab dragged to the right edge: held there, the strip scrolls on its own, to the end; it lands where let go.
    const first = (await tab(names[0]!).boundingBox())!;
    await win.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await win.mouse.down();
    await win.mouse.move(first.x + first.width / 2 + 20, first.y + first.height / 2, { steps: 3 });
    await win.mouse.move(s.x + s.width - 8, first.y + first.height / 2, { steps: 6 });
    await expect.poll(scrollLeft).toBeGreaterThan(200);
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft >= el.scrollWidth - el.clientWidth - 1)).toBe(true);
    await win.mouse.move(s.x + s.width - 120, first.y + first.height / 2, { steps: 3 });
    await win.mouse.up();
    const after = await order();
    expect(after.indexOf(names[0]!)).toBeGreaterThan(10);
    expect(after).toHaveLength(names.length);

    // At the end of the strip, tabs that grow wider (a longer title, a late font) bring back the end fade.
    await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await settled();
    await expect(strip).toHaveAttribute('data-fade', 'start');
    await win.addStyleTag({ content: '.tab { max-width: 400px !important; }' });
    await expect(strip).toHaveAttribute('data-fade', 'start end');
  });
});

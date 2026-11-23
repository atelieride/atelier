import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// In-app transitions. A session picked in the sidebar: the selection glides from its row to the new one and the
// workspace rises in. A tab picked: its crown stretches over to it, then catches up, and the content slides in from the
// side it is on. They never hold a click (one mid-move goes where it lands), leave nothing once they end, and Reduce
// motion plays none.

type Played = { on: string; kf: string };

async function launch(): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // Every script animation the page starts from now on: the class of what it moves and its keyframes (CSS animations
  // don't come through here, only the transitions' own).
  await win.evaluate(() => {
    const w = window as unknown as { played: Played[] };
    w.played = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, kf: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions) {
      w.played.push({ on: this.getAttribute('class') ?? '', kf: JSON.stringify(kf) });
      return animate.call(this, kf, o);
    };
  });
  return { app, home, win };
}
async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}
/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}
const row = (win: Page, name: string) => win.locator('.session-row').filter({ has: win.locator('.session-title', { hasText: new RegExp(`^${name}$`) }) });
const tab = (strip: Locator, name: string) => strip.locator('.tab').filter({ has: strip.page().locator('.tab-name', { hasText: new RegExp(`^${name}$`) }) });
async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(row(win, name)).toHaveClass(/state-waiting/, { timeout: 20000 });
}
/** Sessions One, Two and Three (Three in front), with nothing left moving from their arrival; the record emptied. */
async function threeSessions(win: Page) {
  for (const name of ['One', 'Two', 'Three']) await newSession(win, name);
  await settled(win);
  await played(win);
}
/** What the page played since the last call. */
const played = (win: Page) => win.evaluate(() => (window as unknown as { played: Played[] }).played.splice(0));
const on = (list: Played[], cls: string) => list.filter((p) => p.on.split(/\s+/).includes(cls));
/** Waits until no script animation runs (CSS ones aside: the rows' finite cues may still play). */
const settled = (win: Page) => expect.poll(() => win.evaluate(() => document.getAnimations()
  .filter((a) => a.playState === 'running' && !(a as CSSAnimation).animationName).length)).toBe(0);
/** Freezes the running script animations on `selector` at `ms`; returns how many, and the first one's target's place. */
const freeze = (win: Page, selector: string, ms: number) => win.evaluate(([sel, t]) => {
  const anims = document.getAnimations().filter((a) => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.matches(sel as string));
  for (const a of anims) { a.pause(); a.currentTime = t as number; }
  const el = (anims[0]?.effect as KeyframeEffect | undefined)?.target as HTMLElement | undefined;
  return el ? { top: getComputedStyle(el).top, count: anims.length, box: el.getBoundingClientRect().toJSON() as DOMRect } : null;
}, [selector, ms] as const);
/** Whether one of a transition's own elements is what the pointer would hit at (x, y). */
const hits = (win: Page, x: number, y: number) => win.evaluate(([px, py]) => !!document.elementFromPoint(px!, py!)?.closest('.motion-lane, .motion-pill, .tab-crown-fly'), [x, y]);
const resume = (win: Page) => win.evaluate(() => { for (const a of document.getAnimations()) if (a.playState === 'paused') a.play(); });

test('a session picked in the sidebar: the selection glides to its row, the workspace rises in, a click mid-glide goes to the next row', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await threeSessions(win);
    await expect(row(win, 'Three')).toHaveClass(/is-selected/);

    await row(win, 'One').click();
    const glide = await played(win);
    // One pill, from Three's row to One's; the workspace body rises (one animation, upward); no crown, no slide.
    expect(on(glide, 'motion-pill')).toHaveLength(1);
    const body = on(glide, 'workspace-body');
    expect(body).toHaveLength(1);
    expect(body[0]!.kf).toContain('translateY(6px)');
    expect(on(glide, 'tab-crown-fly')).toHaveLength(0);
    expect(glide.some((p) => p.kf.includes('translateX'))).toBe(false);
    await expect(win.locator('.motion-pill')).toHaveCount(0, { timeout: 600 });
    await expect(win.locator('.motion-lane')).toHaveCount(0);
    await expect(row(win, 'One')).toHaveClass(/is-selected/);
    await expect(row(win, 'One')).not.toHaveClass(/is-gliding/);

    // Mid-glide (held there to look at it): the pill between the rows, the new row's own highlight not drawn yet.
    await row(win, 'Two').click();
    const mid = await freeze(win, '.motion-pill', 60);
    expect(mid?.count).toBe(1);
    await expect(row(win, 'Two')).toHaveClass(/is-gliding/);
    await look(win.locator('.sidebar'), 'test-results/transitions-glide.png');
    // Nothing of it takes the pointer: where only its lane lies (the sidebar's empty end), the sidebar's own gets it.
    const side = (await win.locator('.sidebar').boundingBox())!;
    expect(await hits(win, side.x + side.width / 2, side.y + side.height - 20)).toBe(false);
    // A click on a third row lands on it: the selection goes on from where the pill is.
    await row(win, 'Three').click();
    const next = on(await played(win), 'motion-pill');
    expect(next).toHaveLength(2);
    const start = (JSON.parse(next[1]!.kf) as { top: string }[])[0]!;
    expect(Math.abs(parseFloat(start.top) - parseFloat(mid!.top))).toBeLessThan(1);
    await resume(win);
    await expect(win.locator('.motion-pill')).toHaveCount(0, { timeout: 600 });
    await expect(row(win, 'Three')).toHaveClass(/is-selected/);
    await expect(row(win, 'Two')).not.toHaveClass(/is-selected/);
    await expect(win.locator('.is-gliding')).toHaveCount(0);
    await settled(win);
  } finally {
    await stop(app, home);
  }
});

test('a tab picked: the crown stretches to it and catches up, the content slides in from its side; split, only that pane\'s views move', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await threeSessions(win);
    const strip = win.locator('.tabs .tab-strip');

    // Left, to One: held at its widest (--ease reaches the stretch's .45 about 48 ms in), the crown spans the tabs from
    // Three to One; One's own crown waits under it.
    await tab(strip, 'One').click();
    const mid = await freeze(win, '.tab-crown-fly', 48);
    expect(mid?.count).toBe(1);
    const [one, three] = await Promise.all([tab(strip, 'One').boundingBox(), tab(strip, 'Three').boundingBox()]);
    expect(mid!.box.width).toBeGreaterThan(Math.max(one!.width, three!.width));
    await expect(tab(strip, 'One')).toHaveClass(/is-crown-landing/);
    expect(await hits(win, mid!.box.x + mid!.box.width / 2, mid!.box.y + 1)).toBe(false);
    await look(win.locator('.tabs'), 'test-results/transitions-crown.png');
    await resume(win);
    const left = await played(win);
    expect(on(left, 'tab-crown-fly')).toHaveLength(1);
    const body = on(left, 'workspace-body');
    expect(body).toHaveLength(1);
    expect(body[0]!.kf).toContain('translateX(-14px)');
    expect(on(left, 'motion-pill')).toHaveLength(0);
    await expect(win.locator('.tab-crown-fly')).toHaveCount(0, { timeout: 600 });
    await expect(tab(strip, 'One')).toHaveClass(/is-active/);
    await expect(tab(strip, 'One')).not.toHaveClass(/is-crown-landing/);

    // Right, to Two: from the right.
    await tab(strip, 'Two').click();
    const right = await played(win);
    expect(on(right, 'tab-crown-fly')).toHaveLength(1);
    expect(on(right, 'workspace-body')[0]?.kf).toContain('translateX(14px)');
    await settled(win);

    // Split: the left pane keeps the tabs; a tab picked there moves its own views, never the body or the other pane.
    await menu(app, 'Split Right');
    await expect(win.locator('.workspace-body > .pane-strip')).toHaveCount(2);
    await settled(win);
    await played(win);
    const left0 = win.locator('.pane-strip[data-pane="0"]');
    await tab(left0, 'One').click();
    const split = await played(win);
    expect(on(split, 'tab-crown-fly')).toHaveLength(1);
    expect(on(split, 'workspace-body')).toHaveLength(0);
    const views = split.filter((p) => p.kf.includes('translateX'));
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((p) => !p.on.includes('pane-frame') && !p.on.includes('session-bar'))).toBe(true);
    const placed = await win.evaluate(() => [...document.querySelectorAll<HTMLElement>('.workspace-body > *')]
      .filter((el) => el.getAnimations().some((a) => !(a as CSSAnimation).animationName && a.playState === 'running'))
      .map((el) => el.style.gridColumnStart));
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every((c) => c === 'p0l')).toBe(true);
    await settled(win);
  } finally {
    await stop(app, home);
  }
});

test('Reduce motion: picking a row or a tab plays nothing and leaves nothing', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await threeSessions(win);
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await row(win, 'One').click();
    await expect(row(win, 'One')).toHaveClass(/is-selected/);
    await tab(win.locator('.tabs .tab-strip'), 'Two').click();
    await expect(tab(win.locator('.tabs .tab-strip'), 'Two')).toHaveClass(/is-active/);
    expect(await played(win)).toEqual([]);
    await expect(win.locator('.motion-pill, .motion-lane, .tab-crown-fly, .is-gliding, .is-crown-landing')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

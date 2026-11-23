import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// In-app transitions. A session picked in the sidebar: the selection glides from its row to the new one, the tab crown
// follows it, and the workspace rises in. A tab picked: its crown stretches over to it, then catches up, and the content
// slides in from the side it is on. A new session: a spark arcs from the + to its row and its terminal opens from there.
// They never hold a click (one mid-move goes where it lands), leave nothing once they end, and Reduce motion plays none.

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
const hits = (win: Page, x: number, y: number) => win.evaluate(([px, py]) => !!document.elementFromPoint(px!, py!)?.closest('.motion-lane, .motion-pill, .tab-crown-fly, .motion-fx, .motion-spark, .motion-ring'), [x, y]);
/**
 * Resolves once a new session's spark is on the page (null: none came), every script animation then held where it is
 * (just started), so the test can look at any moment of it. Read in that same task, before anything else can move
 * the list (the session's first state soon moves its row to another section): the middle of the ring's box and of the
 * avatar of row `name` where it rests (its own entrance, a short rise, taken to its end first).
 */
const catchSpark = (win: Page, name: string) => win.evaluate((title) => new Promise<{ ring: number[]; avatar: number[] } | null>((done) => {
  const mid = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2];
  const mo = new MutationObserver(() => {
    const ring = document.querySelector('.motion-ring');
    if (!document.querySelector('.motion-spark') || !ring) return;
    mo.disconnect();
    for (const a of document.getAnimations()) if (!(a as CSSAnimation).animationName) a.pause();
    const row = [...document.querySelectorAll('.sidebar .session-row')].find((r) => r.querySelector('.session-title')?.textContent === title);
    for (const a of row?.getAnimations() ?? []) if ((a as CSSAnimation).animationName === 'atl-enter') a.finish();
    const avatar = row?.querySelector('.avatar');
    done(avatar ? { ring: mid(ring.getBoundingClientRect()), avatar: mid(avatar.getBoundingClientRect()) } : null);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { mo.disconnect(); done(null); }, 15000);
}), name);
const centre = (b: { x: number; y: number; width: number; height: number }) => [b.x + b.width / 2, b.y + b.height / 2] as const;
const resume = (win: Page) => win.evaluate(() => { for (const a of document.getAnimations()) if (a.playState === 'paused') a.play(); });

test('a session picked in the sidebar: the selection glides to its row, the tab crown follows, the workspace rises in, a click mid-glide goes to the next row', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await threeSessions(win);
    await expect(row(win, 'Three')).toHaveClass(/is-selected/);

    await row(win, 'One').click();
    const glide = await played(win);
    // One pill, from Three's row to One's; the tab crown flies along (one motion language for the selection); the
    // workspace body rises (one animation, upward), never a sideways slide.
    expect(on(glide, 'motion-pill')).toHaveLength(1);
    expect(on(glide, 'tab-crown-fly')).toHaveLength(1);
    const body = on(glide, 'workspace-body');
    expect(body).toHaveLength(1);
    expect(body[0]!.kf).toContain('translateY(6px)');
    expect(glide.some((p) => p.kf.includes('translateX'))).toBe(false);
    await expect(win.locator('.motion-pill')).toHaveCount(0, { timeout: 600 });
    await expect(win.locator('.motion-lane, .tab-crown-fly')).toHaveCount(0);
    await expect(win.locator('.is-crown-landing')).toHaveCount(0);
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

test('a new session: a spark arcs from the + to its row, a ring ripples there, its terminal opens in a circle from the sidebar\'s side, and nothing slides', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await newSession(win, 'One');
    await settled(win);
    await played(win);

    // ⌘N (its menu item: synthetic keys don't reach NSMenu), a name, Enter.
    await menu(app, 'New Claude Session');
    await win.getByPlaceholder('Session name (optional)').fill('Two');
    const caught = catchSpark(win, 'Two');
    await win.keyboard.press('Enter');
    // The ring is centred on the avatar, where the row comes to rest.
    const placed = await caught;
    expect(placed).not.toBeNull();
    expect(Math.abs(placed!.ring[0]! - placed!.avatar[0]!)).toBeLessThan(0.5);
    expect(Math.abs(placed!.ring[1]! - placed!.avatar[1]!)).toBeLessThan(0.5);
    const two = row(win, 'Two');
    await expect(two).toHaveCount(1);
    const id = await two.getAttribute('data-term-row');
    const slot = win.locator(`.terminal-slot[data-term-slot="${id}"]`);
    const all = '.motion-spark, .motion-ring, .terminal-slot, .tab-crown-fly';

    // In flight (held early on its way): the dot is at neither end; the new terminal is not open yet; nothing of it
    // takes the pointer.
    const mid = await freeze(win, all, 240);
    expect(mid).not.toBeNull();
    const dot = (await win.locator('.motion-spark').boundingBox())!;
    const plus = (await win.locator('.btn-new').boundingBox())!;
    const avatar = (await two.locator('.avatar').boundingBox())!;
    const [dx, dy] = centre(dot);
    expect(Math.hypot(dx - centre(plus)[0], dy - centre(plus)[1])).toBeGreaterThan(20);
    expect(Math.hypot(dx - centre(avatar)[0], dy - centre(avatar)[1])).toBeGreaterThan(20);
    expect(await slot.evaluate((el) => getComputedStyle(el).clipPath)).toMatch(/^circle\(0px at 0px /);
    expect(await hits(win, dx, dy)).toBe(false);
    await look(win, 'test-results/transitions-spark.png');

    // Landed: the ring ripples out around the row's avatar, then the terminal opens from the sidebar's side. It grows
    // as a box, never by scaling: its edge stays a hairline as it spreads.
    await freeze(win, all, 640);
    const spread = await win.locator('.motion-ring').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { scale: new DOMMatrixReadOnly(cs.transform).a, edge: cs.borderTopWidth, width: el.getBoundingClientRect().width };
    });
    expect(spread.scale).toBe(1);
    // At most its 1.5 px (a screen of 1x draws it as 1).
    expect(parseFloat(spread.edge)).toBeLessThanOrEqual(1.5);
    expect(spread.width).toBeGreaterThan(14);
    await look(win, 'test-results/transitions-spark-landed.png');
    await freeze(win, all, 900);
    expect(await slot.evaluate((el) => getComputedStyle(el).clipPath)).toMatch(/^circle\((?!0px)[\d.]+(px|%) at 0px /);
    await look(win, 'test-results/transitions-spark-reveal.png');
    await resume(win);

    const log = await played(win);
    expect(on(log, 'motion-spark')).toHaveLength(1);
    expect(on(log, 'motion-ring')).toHaveLength(1);
    const reveal = on(log, 'terminal-slot');
    expect(reveal).toHaveLength(1);
    expect(reveal[0]!.kf).toContain('clipPath');
    // The crown goes over to the new tab; the reveal is what the content does: it neither slides nor rises.
    expect(on(log, 'tab-crown-fly')).toHaveLength(1);
    expect(log.some((p) => p.kf.includes('translateX'))).toBe(false);
    expect(on(log, 'workspace-body')).toHaveLength(0);

    // Then nothing of it is left: the dot, the ring and their lane are gone, the terminal rests unclipped.
    await expect(win.locator('.motion-spark, .motion-ring, .motion-fx')).toHaveCount(0, { timeout: 1500 });
    await settled(win);
    expect(await slot.evaluate((el) => getComputedStyle(el).clipPath)).toBe('none');

    // The sidebar hidden, the row is not on screen: no spark, and the terminal simply shows.
    await menu(app, 'Sidebar');
    await expect(win.locator('.sidebar')).toHaveCount(0);
    await played(win);
    await menu(app, 'New Claude Session');
    await win.getByPlaceholder('Session name (optional)').fill('Three');
    await win.keyboard.press('Enter');
    await expect(tab(win.locator('.tabs .tab-strip'), 'Three')).toHaveClass(/is-active/, { timeout: 20000 });
    await expect(win.locator('.sidebar')).toHaveCount(0);
    await settled(win);
    const hidden = await played(win);
    expect(on(hidden, 'motion-spark')).toHaveLength(0);
    expect(on(hidden, 'terminal-slot')).toHaveLength(0);
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
    // A new session too: no spark, no ring, no reveal.
    await newSession(win, 'Four');
    expect(await played(win)).toEqual([]);
    await expect(win.locator('.motion-pill, .motion-lane, .tab-crown-fly, .is-gliding, .is-crown-landing, .motion-fx, .motion-spark, .motion-ring')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('The command palette opens over a receding app; other sheets leave it be', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    const body = win.locator('.body');
    const transform = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).transform);
    await expect(win.locator('.btn-new')).toBeVisible();
    await menu(app, 'Search…');
    await expect(win.locator('.palette-backdrop.is-cmd .palette')).toBeVisible();
    await win.waitForTimeout(400);
    expect(await transform(body)).toMatch(/^matrix\(0\.985,/);
    // The sheet itself is not scaled by the receding app (its own animation rests at the identity).
    expect(await transform(win.locator('.palette'))).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    expect(await win.locator('.palette').evaluate((el) => getComputedStyle(el).animationName)).toBe('atl-sheet-drop');
    await look(win, 'test-results/transitions-palette-open.png');
    await win.keyboard.press('Escape');
    await expect(win.locator('.palette')).toHaveCount(0);
    await win.waitForTimeout(400);
    expect(await transform(body)).toBe('none');

    // Another sheet sharing the palette's classes keeps its own entrance and leaves the app where it is.
    await menu(app, 'New Claude Session');
    const sheet = win.locator('.palette.new-session');
    await expect(sheet).toBeVisible();
    await win.waitForTimeout(400);
    expect(await sheet.evaluate((el) => getComputedStyle(el).animationName)).toBe('atl-pop');
    expect(await transform(body)).toBe('none');
  } finally {
    await stop(app, home);
  }
});

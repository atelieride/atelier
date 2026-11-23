import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv, writePrefs } from './env';
import { look } from './shots';

// In-app transitions. A session picked in the sidebar: the selection glides from its row to the new one, the tab
// crown follows it, and the workspace rises in. A tab picked: its crown stretches over to it, then catches up, and the
// content slides in from the side it is on. A new session: a spark arcs from the + to its row and its terminal opens
// from there. A split: the layout is there at once, the new pane's content springs in past its place and settles, its
// line draws. A session that finishes: a flat green wave crosses its row and a check takes its avatar a moment; one
// that waits for you keeps an amber edge on its row. They never hold a click (one mid-move goes where it lands), paint
// nothing outside their box, leave nothing once they end, and Reduce motion plays none.

type Played = { on: string; kf: string };

async function launch(prefs?: Record<string, unknown>): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  if (prefs) writePrefs(home, prefs);
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // Every script animation the page starts from now on: the class of what it moves and its keyframes (CSS animations
  // don't come through here, only the transitions' own). While `hold` is on, each one is held at its start.
  await win.evaluate(() => {
    const w = window as unknown as { played: Played[]; hold: boolean };
    w.played = [];
    w.hold = false;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, kf: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions) {
      w.played.push({ on: this.getAttribute('class') ?? '', kf: JSON.stringify(kf) });
      const anim = animate.call(this, kf, o);
      if (w.hold) anim.pause();
      return anim;
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
/** A tab strip's edge fades as set, and as its scroll box calls for now (more than 1 px hidden on that side). */
const fades = (strip: Locator) => strip.evaluate((el) => {
  const max = el.scrollWidth - el.clientWidth;
  const want = [el.scrollLeft > 1 && 'start', max > 1 && el.scrollLeft < max - 1 && 'end'].filter(Boolean).join(' ');
  return { set: (el as HTMLElement).dataset.fade ?? '', want };
});
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
const hits = (win: Page, x: number, y: number) => win.evaluate(([px, py]) => !!document.elementFromPoint(px!, py!)?.closest('.motion-lane, .motion-pill, .tab-crown-fly, .motion-fx, .motion-spark, .motion-ring, .pane-under'), [x, y]);
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
/** Holds every script animation the page starts from now on at its start (on), or lets the next ones play (off). */
const hold = (win: Page, on: boolean) => win.evaluate((h) => { (window as unknown as { hold: boolean }).hold = h; }, on);
type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };
/** Types into session `title`'s terminal (the fake Claude reads its lines). */
async function typeInto(win: Page, title: string, text: string) {
  await win.evaluate(async ({ title, text }) => {
    const api = (window as unknown as { atelier: Api }).atelier;
    const id = (await api.terminals.list()).find((x) => x.title === title)!.id;
    api.terminals.input(id, text);
  }, { title, text });
}

type Cues = { added: { cls: string; row: string; rowCls: string }[]; ended: { name: string; on: string }[] };
/**
 * From this document's start on, every finished session's wave and avatar check that mounts (its class, its row's title
 * and classes) and every animation of theirs that ends. Recorded as it happens, so nothing depends on when it is read.
 */
function recordCues() {
  const w = window as unknown as { cues: Cues };
  const CUE = '.row-wave, .av-done-check';
  w.cues = { added: [], ended: [] };
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue;
      for (const el of [n, ...n.querySelectorAll(CUE)].filter((e) => e.matches(CUE))) {
        const row = el.closest('.session-row');
        w.cues.added.push({ cls: el.getAttribute('class') ?? '', row: row?.querySelector('.session-title')?.textContent ?? '', rowCls: row?.getAttribute('class') ?? '' });
      }
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener('animationend', (e) => {
    const el = e.target as Element;
    if (el.closest?.(CUE)) w.cues.ended.push({ name: e.animationName, on: el.closest(CUE)!.getAttribute('class') ?? '' });
  }, true);
}
const cues = (win: Page) => win.evaluate(() => (window as unknown as { cues: Cues }).cues);
/**
 * Resolves once a finished session's wave is on the page (null: none came), its animations and its avatar check's held
 * at their start: the title of its row, whether that row shows it finished, whether the check is on its avatar.
 */
const catchWave = (win: Page) => win.evaluate(() => new Promise<{ title: string; done: boolean; check: boolean } | null>((done) => {
  const mo = new MutationObserver(() => {
    const wave = document.querySelector('.row-wave');
    if (!wave) return;
    mo.disconnect();
    const row = wave.closest('.session-row');
    for (const el of [wave, ...(row?.querySelectorAll('.av-done-check, .av-done-check *') ?? [])]) for (const a of el.getAnimations()) a.pause();
    done({ title: row?.querySelector('.session-title')?.textContent ?? '', done: !!row?.classList.contains('state-done'), check: !!row?.querySelector('.avatar > .av-done-check') });
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { mo.disconnect(); done(null); }, 15000);
}));
/** What a box-shadow written as `value` computes to here (tokens resolved). */
const shadowOf = (win: Page, value: string) => win.evaluate((v) => {
  const probe = document.createElement('div');
  probe.style.boxShadow = v;
  document.body.append(probe);
  const out = getComputedStyle(probe).boxShadow;
  probe.remove();
  return out;
}, value);
const shadow = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).boxShadow);

type Layout = { columns: string[]; rows: string[]; first: string[] | null; fits: Record<string, string[]> };
/**
 * From now on, every grid template the workspace body is given (each value once, in order), the one it has on the first
 * frame after it is first given one, and every size each terminal slot takes (its first entry: its size now, recorded
 * before this resolves).
 */
const watchLayout = (win: Page) => win.evaluate(() => new Promise<void>((ready) => {
  const w = window as unknown as { layout: Layout; layoutWatch?: { disconnect(): void }[] };
  for (const o of w.layoutWatch ?? []) o.disconnect();
  const body = document.querySelector<HTMLElement>('.workspace-body')!;
  const log: Layout = { columns: [], rows: [], first: null, fits: {} };
  w.layout = log;
  const mo = new MutationObserver(() => {
    const { gridTemplateColumns: c, gridTemplateRows: r } = body.style;
    if (c && log.columns.at(-1) !== c) log.columns.push(c);
    if (r && log.rows.at(-1) !== r) log.rows.push(r);
    if (c && !log.first) {
      log.first = [];
      requestAnimationFrame(() => { log.first = [body.style.gridTemplateColumns, body.style.gridTemplateRows]; });
    }
  });
  mo.observe(body, { attributes: true, attributeFilter: ['style'] });
  // Its first call has every slot's size now.
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const size = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
      const list = (log.fits[(e.target as HTMLElement).dataset.termSlot ?? '?'] ??= []);
      if (list.at(-1) !== size) list.push(size);
    }
    ready();
  });
  const slots = document.querySelectorAll('.workspace-body > .terminal-slot');
  for (const el of slots) ro.observe(el);
  w.layoutWatch = [mo, ro];
  if (!slots.length) ready();
}));
const layoutLog = (win: Page) => win.evaluate(() => (window as unknown as { layout: Layout }).layout);
/** Where pane `pane`'s picker is moved to by its animations (px), and how opaque it is. */
const pickerAt = (win: Page, pane: number) => win.evaluate((i) => {
  const el = [...document.querySelectorAll<HTMLElement>('.workspace-body > .pane-picker')].find((p) => p.style.gridColumnStart === `p${i}l`)!;
  const cs = getComputedStyle(el);
  const m = new DOMMatrixReadOnly(cs.transform);
  return { x: m.m41, y: m.m42, opacity: Number(cs.opacity), transform: cs.transform };
}, pane);
/** How far a divider's line is drawn along it (its scale) and how visible it is; `dir`: row (vertical) or column. */
const lineAt = (win: Page, dir: 'row' | 'column') => win.locator(`.workspace-body > .pane-divider[data-dir="${dir}"]`).evaluate((el, d) => {
  const cs = getComputedStyle(el, '::after');
  const m = new DOMMatrixReadOnly(cs.transform);
  return { scale: d === 'row' ? m.d : m.a, across: d === 'row' ? m.a : m.d, opacity: Number(cs.opacity) };
}, dir);
/**
 * Where the element matching `selector` paints now (its box as its transform moves it, less what its clip-path cuts
 * away), where it rests (the same box without the transform) and how far it is moved, as [left, top, right, bottom].
 */
const paints = (win: Page, selector: string) => win.locator(selector).first().evaluate((el) => {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const m = new DOMMatrixReadOnly(cs.transform);
  // inset(top right bottom left), its sides given as a margin's are.
  const v = (/^inset\(([^)]*)\)$/.exec(cs.clipPath)?.[1] ?? '0').split(/\s+/).map(parseFloat);
  const [t = 0, right = t, b = t, left = right] = v;
  return {
    painted: [r.left + left, r.top + t, r.right - right, r.bottom - b],
    rest: [r.left - m.m41, r.top - m.m42, r.right - m.m41, r.bottom - m.m42],
    moved: [m.m41, m.m42]
  };
});
/** Whether `inner` ([left, top, right, bottom]) lies within `outer`, to half a pixel. */
const within = (inner: number[], outer: number[]) => inner[0]! >= outer[0]! - 0.5 && inner[1]! >= outer[1]! - 0.5 && inner[2]! <= outer[2]! + 0.5 && inner[3]! <= outer[3]! + 0.5;
/** Clicks the app menu's `label` `times` times, `every` ms apart, as a key held down repeats it. */
const repeat = (app: ElectronApplication, label: string, times: number, every: number) => app.evaluate(async ({ Menu, BrowserWindow }, [l, n, ms]) => {
  const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
    for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
    return undefined;
  };
  const item = walk(Menu.getApplicationMenu()!.items)!;
  for (let i = 0; i < (n as number); i++) {
    item.click(undefined, BrowserWindow.getAllWindows()[0]);
    await new Promise((r) => setTimeout(r, ms as number));
  }
}, [label, times, every] as const);
/**
 * From now until `stopSampling`, at every frame an entrance plays on the element matching `selector`: its opacity, in
 * runs of consecutive frames (a frame with none playing ends a run).
 */
const sampleOpacity = (win: Page, selector: string) => win.evaluate((sel) => {
  const w = window as unknown as { runs: number[][]; sampling: boolean };
  w.runs = [];
  w.sampling = true;
  let run: number[] | null = null;
  const tick = () => {
    if (!w.sampling) return;
    const el = document.querySelector(sel);
    const on = !!el?.getAnimations().some((a) => !(a as CSSAnimation).animationName && a.playState === 'running');
    if (on) { if (!run) w.runs.push(run = []); run.push(Number(getComputedStyle(el!).opacity)); } else run = null;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, selector);
const stopSampling = (win: Page) => win.evaluate(() => { const w = window as unknown as { runs: number[][]; sampling: boolean }; w.sampling = false; return w.runs; });
type GlideFrame = { lands: number[]; rests: number[]; own: string; edge: string };
/**
 * From now until `stopGlideProbe`, at every frame a selection pill is on its way: where it lands (its last keyframe, in
 * the window), where row `name` rests (its box without the transform of an entrance), the row's own edge (its
 * box-shadow: none while the pill stands in for it) and the pill's.
 */
const probeGlide = (win: Page, name: string) => win.evaluate((title) => {
  const w = window as unknown as { glides: GlideFrame[]; probing: boolean };
  w.glides = [];
  w.probing = true;
  const tick = () => {
    if (!w.probing) return;
    const pill = document.querySelector<HTMLElement>('.motion-pill');
    const anim = pill?.getAnimations()[0];
    const row = [...document.querySelectorAll<HTMLElement>('.sidebar .session-row')].find((r) => r.querySelector('.session-title')?.textContent === title);
    if (pill && anim && row) {
      const lane = pill.parentElement!.getBoundingClientRect();
      const last = (anim.effect as KeyframeEffect).getKeyframes().at(-1)!;
      const r = row.getBoundingClientRect();
      const m = new DOMMatrixReadOnly(getComputedStyle(row).transform);
      w.glides.push({
        lands: [lane.left + parseFloat(String(last.left)), lane.top + parseFloat(String(last.top))],
        rests: [r.left - m.m41, r.top - m.m42], own: getComputedStyle(row).boxShadow, edge: getComputedStyle(pill).boxShadow
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, name);
const stopGlideProbe = (win: Page) => win.evaluate(() => { const w = window as unknown as { glides: GlideFrame[]; probing: boolean }; w.probing = false; return w.glides; });
/** From now on, the class of every element a ResizeObserver of the page is asked to watch. */
const watchObserved = (win: Page) => win.evaluate(() => {
  const w = window as unknown as { observed: string[] };
  w.observed = [];
  const observe = ResizeObserver.prototype.observe;
  ResizeObserver.prototype.observe = function (this: ResizeObserver, el: Element, o?: ResizeObserverOptions) {
    w.observed.push(el.getAttribute('class') ?? '');
    return observe.call(this, el, o);
  };
});
const observed = (win: Page) => win.evaluate(() => (window as unknown as { observed: string[] }).observed.splice(0));

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
    await expect(win.locator('.motion-pill')).toHaveCount(0);
    await expect(win.locator('.motion-lane, .tab-crown-fly')).toHaveCount(0);
    await expect(win.locator('[data-crown-landing]')).toHaveCount(0);
    await expect(row(win, 'One')).toHaveClass(/is-selected/);
    await expect(row(win, 'One')).not.toHaveAttribute('data-gliding');

    // Mid-glide (held there to look at it): the pill between the rows, the new row's own highlight not drawn yet.
    await row(win, 'Two').click();
    const mid = await freeze(win, '.motion-pill', 60);
    expect(mid?.count).toBe(1);
    await expect(row(win, 'Two')).toHaveAttribute('data-gliding');
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
    await expect(win.locator('.motion-pill')).toHaveCount(0);
    await expect(row(win, 'Three')).toHaveClass(/is-selected/);
    await expect(row(win, 'Two')).not.toHaveClass(/is-selected/);
    await expect(win.locator('[data-gliding]')).toHaveCount(0);
    await settled(win);

    // Rising in (held at its start), the workspace paints only inside its own box: what the rise moves past its
    // bottom edge is cut away, never drawn over the footer.
    await hold(win, true);
    await row(win, 'One').click();
    await freeze(win, '.workspace-body', 0);
    const rise = await paints(win, '.workspace-body');
    expect(rise.moved[1]).toBeGreaterThan(3);
    expect(within(rise.painted, rise.rest), JSON.stringify(rise)).toBe(true);
    await hold(win, false);
    await resume(win);
    await settled(win);
  } finally {
    await stop(app, home);
  }
});

test('a session ready for review picked: seen at once, its row moves to Idle mid-glide, and the selection never lands beside it nor shows twice', async () => {
  test.setTimeout(120000);
  // Ink: a theme whose selected row's edge is not --edge-sel (the pill wears the row's own edge all the way).
  const { app, home, win } = await launch({ theme: 'ink' });
  try {
    await threeSessions(win);
    await expect(row(win, 'Three')).toHaveClass(/is-selected/);
    // Two works on; One finishes, not seen: grouped by state, One (Ready for review) sits between Three (Needs you)
    // and Two (Working).
    await typeInto(win, 'Two', 'hold\r');
    await expect(row(win, 'Two')).toHaveClass(/state-running/, { timeout: 10000 });
    await typeInto(win, 'One', '\r');
    await expect(row(win, 'One')).toHaveClass(/is-unread/, { timeout: 10000 });
    await expect(win.locator('.row-wave, .av-done-check')).toHaveCount(0, { timeout: 5000 });
    await settled(win);
    await played(win);
    const before = (await row(win, 'One').boundingBox())!;

    // Picked: it is seen at once, and leaves Ready for review for Idle, under Two, while the selection is on its way.
    await probeGlide(win, 'One');
    await row(win, 'One').click();
    await expect(row(win, 'One')).not.toHaveClass(/is-unread/);
    await expect.poll(async () => (await row(win, 'One').boundingBox())!.y).toBeGreaterThan(before.y + 20);
    await settled(win);
    const frames = await stopGlideProbe(win);
    expect(on(await played(win), 'motion-pill')).toHaveLength(1);
    // At every frame the pill was there, it was on its way to where the row rests, and the row's own highlight was
    // not drawn under it (its edge none); the pill's edge is the one the row wears once it is selected.
    const own = await shadow(row(win, 'One'));
    expect(own).not.toBe('none');
    for (const f of frames) {
      expect(Math.abs(f.lands[0]! - f.rests[0]!), JSON.stringify(f)).toBeLessThan(1);
      expect(Math.abs(f.lands[1]! - f.rests[1]!), JSON.stringify(f)).toBeLessThan(1);
      expect(f.own, JSON.stringify(f)).toBe('none');
    }
    for (const f of frames) expect(f.edge).toBe(own);
    await expect(win.locator('.motion-pill, .motion-lane, [data-gliding]')).toHaveCount(0);
    await expect(row(win, 'One')).toHaveClass(/is-selected/);
    await look(win.locator('.sidebar'), 'test-results/transitions-glide-review.png');

    // A glide that stays put (Two, working, keeps its place): mid-way, the pill wears the selected row's edge.
    await hold(win, true);
    await row(win, 'Two').click();
    await freeze(win, '.motion-pill', 120);
    const edge = await shadow(win.locator('.motion-pill'));
    await hold(win, false);
    await resume(win);
    await settled(win);
    expect(edge).toBe(await shadow(row(win, 'Two')));
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
    await expect(tab(strip, 'One')).toHaveAttribute('data-crown-landing');
    expect(await hits(win, mid!.box.x + mid!.box.width / 2, mid!.box.y + 1)).toBe(false);
    await look(win.locator('.tabs'), 'test-results/transitions-crown.png');
    // The content held at the start of its slide from the left: it paints only inside its own box (what the slide
    // moves past its left edge, over the sidebar, is cut away).
    await freeze(win, '.workspace-body', 0);
    const fromLeft = await paints(win, '.workspace-body');
    expect(fromLeft.moved[0]).toBeLessThan(-10);
    expect(within(fromLeft.painted, fromLeft.rest), JSON.stringify(fromLeft)).toBe(true);
    await resume(win);
    const left = await played(win);
    expect(on(left, 'tab-crown-fly')).toHaveLength(1);
    const body = on(left, 'workspace-body');
    expect(body).toHaveLength(1);
    expect(body[0]!.kf).toContain('translateX(-14px)');
    expect(on(left, 'motion-pill')).toHaveLength(0);
    await expect(win.locator('.tab-crown-fly')).toHaveCount(0);
    await expect(tab(strip, 'One')).toHaveClass(/is-active/);
    await expect(tab(strip, 'One')).not.toHaveAttribute('data-crown-landing');

    // Right, to Two: from the right, and inside its box there too (nothing drawn over Changes).
    await hold(win, true);
    await tab(strip, 'Two').click();
    const right = await played(win);
    expect(on(right, 'tab-crown-fly')).toHaveLength(1);
    expect(on(right, 'workspace-body')[0]?.kf).toContain('translateX(14px)');
    await freeze(win, '.workspace-body', 0);
    const fromRight = await paints(win, '.workspace-body');
    expect(fromRight.moved[0]).toBeGreaterThan(10);
    expect(within(fromRight.painted, fromRight.rest), JSON.stringify(fromRight)).toBe(true);
    await look(win.locator('.workspace'), 'test-results/transitions-slide-clip.png');
    // Another tab picked while the crown is on its way (still held): the strip watches its tabs' sizes, never the
    // crown in flight.
    await watchObserved(win);
    await tab(strip, 'Three').click();
    await expect(tab(strip, 'Three')).toHaveClass(/is-active/);
    expect((await observed(win)).some((c) => c.split(/\s+/).includes('tab-crown-fly'))).toBe(false);
    await hold(win, false);
    await resume(win);
    await settled(win);
    await played(win);

    // Tabs switched as fast as a key held down repeats (Next Tab, 30 times a second): each entrance goes on from
    // where the one before it is, so the content never drops back to unseen mid-way.
    await sampleOpacity(win, '.workspace-body');
    await repeat(app, 'Next Tab', 8, 33);
    await settled(win);
    const runs = await stopSampling(win);
    expect(on(await played(win), 'workspace-body').length).toBeGreaterThan(4);
    expect(runs.flat().length).toBeGreaterThan(0);
    for (const run of runs) for (let i = 1; i < run.length; i++) expect(run[i]!, JSON.stringify(runs)).toBeGreaterThanOrEqual(run[i - 1]! - 0.01);

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

test('a tab closed while the crown is on its way: once it lands, the strip fades as its tabs alone call for', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await threeSessions(win);
    const strip = win.locator('.tabs .tab-strip');
    expect(await fades(strip)).toEqual({ set: '', want: '' });
    // One picked, the crown held at its start over Three (the last tab); Three's tab closes meanwhile (its session
    // stays). The strip, as wide as its tabs, now has the crown reaching past them.
    await hold(win, true);
    await tab(strip, 'One').click();
    await expect(win.locator('.tab-crown-fly')).toHaveCount(1);
    await tab(strip, 'Three').locator('.tab-close').click();
    await expect(tab(strip, 'Three')).toHaveCount(0);
    expect((await fades(strip)).want).toBe('end');
    // Once it has landed and gone, the fades are the tabs' own again: none.
    await hold(win, false);
    await resume(win);
    await settled(win);
    await expect(win.locator('.tab-crown-fly')).toHaveCount(0);
    expect(await fades(strip)).toEqual({ set: '', want: '' });
  } finally {
    await stop(app, home);
  }
});

test('a new session: a spark arcs from the + to its row, a ring ripples, its terminal opens from the sidebar\'s side', async () => {
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

test('a split: the layout is there at once, the new pane\'s content springs in from its side past its place and settles, its line draws; nothing else moves', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await newSession(win, 'One');
    await settled(win);
    await played(win);
    await watchLayout(win);
    // What a pane's entrance moves: its content (here, its picker) and the divider it was split off on.
    const entrance = '.workspace-body > .pane-picker, .workspace-body > .pane-divider';

    // ⌘\ (its menu item), every animation held as it starts: an empty pane on the right, its picker shown.
    await hold(win, true);
    await menu(app, 'Split Right');
    await expect(win.locator('.workspace-body > .pane-strip')).toHaveCount(2);
    await expect(win.locator('.workspace-body > .pane-picker')).toHaveCount(1);
    const right = await played(win);
    // Its content comes in from the right; the line it was split off on draws along its length. Nothing else moves:
    // neither the left pane, nor the new pane's strip and frame.
    expect(on(right, 'pane-picker').some((p) => p.kf.includes('translateX(48px)'))).toBe(true);
    expect(right.filter((p) => /translate/.test(p.kf)).every((p) => p.on.includes('pane-picker'))).toBe(true);
    const drawn = on(right, 'pane-divider');
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.kf).toContain('scaleY(0)');

    // At its start: 48 px to the right, unseen, the line not drawn yet.
    await freeze(win, entrance, 0);
    expect(await pickerAt(win, 1)).toMatchObject({ x: 48, y: 0, opacity: 0 });
    expect((await lineAt(win, 'row')).scale).toBe(0);
    // Where the content has not arrived yet, the pane's cell shows the pane's own background (not the body's, the colour
    // of the lines between panes), under the strip; it takes no pointer.
    const under = win.locator('.workspace-body > .pane-under');
    await expect(under).toHaveCount(1);
    const [u, s1, f1] = await Promise.all([under, win.locator('.pane-strip[data-pane="1"]'), win.locator('.pane-frame[data-pane="1"]')].map(async (l) => (await l.boundingBox())!));
    expect([u!.x, u!.y, u!.width, u!.y + u!.height]).toEqual([s1!.x, s1!.y + s1!.height, s1!.width, f1!.y + f1!.height]);
    const paint = (sel: string) => win.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await paint('.workspace-body > .pane-under')).toBe(await paint('.workspace-body > .pane-picker'));
    expect(await hits(win, u!.x + 10, u!.y + u!.height / 2)).toBe(false);
    await look(win.locator('.workspace'), 'test-results/transitions-split-start.png');
    // Halfway through the line's draw: drawn from its middle, at its full 1 px across.
    await freeze(win, entrance, 130);
    const half = await lineAt(win, 'row');
    expect(half.scale).toBeGreaterThan(0.2);
    expect(half.scale).toBeLessThan(1);
    expect(half.across).toBe(1);
    expect(half.opacity).toBe(1);
    // Mid-bounce: past its place, towards the line, fully shown, the line drawn.
    await freeze(win, entrance, 240);
    const bounce = await pickerAt(win, 1);
    expect(bounce.x).toBeLessThan(-3);
    expect(bounce.opacity).toBe(1);
    expect((await lineAt(win, 'row')).scale).toBeGreaterThan(0.95);
    await look(win.locator('.workspace'), 'test-results/transitions-split.png');
    await hold(win, false);
    await resume(win);
    await settled(win);

    // At rest: nothing of it is left. The body's template was given once, already right on the first frame, and never
    // changed while the pane came in; the terminal on the left fitted once, to where it rests.
    expect((await pickerAt(win, 1)).transform).toBe('none');
    await expect(win.locator('.pane-divider[data-drawing], .pane-under')).toHaveCount(0);
    let layout = await layoutLog(win);
    expect(layout.columns).toHaveLength(1);
    expect(layout.first).toEqual([layout.columns[0], layout.rows[0]]);
    const fits = Object.values(layout.fits).filter((f) => f[0] !== '0x0');
    expect(fits).toHaveLength(1);
    expect(fits[0]).toHaveLength(2);

    // Split Down from the new pane: an empty pane under it, rising from below; the line across draws along its width.
    await watchLayout(win);
    await hold(win, true);
    await menu(app, 'Split Down');
    await expect(win.locator('.workspace-body > .pane-strip')).toHaveCount(3);
    const down = await played(win);
    expect(on(down, 'pane-picker').some((p) => p.kf.includes('translateY(48px)'))).toBe(true);
    expect(down.filter((p) => /translate/.test(p.kf))).toHaveLength(1);
    expect(on(down, 'pane-divider').map((p) => p.kf)).toEqual([expect.stringContaining('scaleX(0)')]);
    await freeze(win, entrance, 0);
    expect(await pickerAt(win, 2)).toMatchObject({ x: 0, y: 48, opacity: 0 });
    await freeze(win, entrance, 240);
    expect((await pickerAt(win, 2)).y).toBeLessThan(-3);
    expect((await lineAt(win, 'column')).scale).toBeGreaterThan(0.95);
    await look(win.locator('.workspace'), 'test-results/transitions-split-down.png');
    await hold(win, false);
    await resume(win);
    await settled(win);
    expect((await pickerAt(win, 2)).transform).toBe('none');
    layout = await layoutLog(win);
    expect(layout.rows).toHaveLength(1);
    expect(layout.first).toEqual([layout.columns[0], layout.rows[0]]);
    await expect(win.locator('.pane-divider[data-drawing], .pane-under')).toHaveCount(0);

    // A divider moved: no pane is new, nothing springs in.
    const given = layout.columns.length;
    await win.locator('.workspace-body > .pane-divider[data-dir="row"]').focus();
    await win.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await layoutLog(win)).columns.length).toBe(given + 1);
    expect(await played(win)).toEqual([]);
  } finally {
    await stop(app, home);
  }
});

test('a tab moved to a new pane: under its terminal on its way in, the terminal\'s own background (a light theme, terminals kept dark)', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch({ theme: 'paper', terminalColors: 'dark' });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await menu(app, 'New Terminal');
    await menu(app, 'New Terminal');
    const tabs = win.locator('.tabs .tab');
    await expect(tabs).toHaveCount(2);
    await expect(win.locator('.workspace-body > .terminal-slot')).toHaveCount(2);
    await settled(win);
    await played(win);

    // ⌥-click on the second tab (Move to Right Pane), every animation held as it starts: its terminal comes in.
    await hold(win, true);
    await tabs.nth(1).click({ modifiers: ['Alt'] });
    await expect(win.locator('.workspace-body > .pane-strip')).toHaveCount(2);
    await expect(win.locator('.workspace-body > .pane-under')).toHaveCount(1);
    expect(on(await played(win), 'terminal-slot').some((p) => p.kf.includes('translateX(48px)'))).toBe(true);
    await freeze(win, '.workspace-body > .terminal-slot', 0);
    const paint = await win.evaluate(() => {
      const bg = (el: Element) => getComputedStyle(el).backgroundColor;
      const slot = [...document.querySelectorAll<HTMLElement>('.workspace-body > .terminal-slot')].find((el) => el.style.gridColumnStart === 'p1l' && el.getClientRects().length > 0)!;
      const probe = document.createElement('div');
      probe.style.background = 'var(--bg-2)';
      document.body.append(probe);
      const panel = bg(probe);
      probe.remove();
      return { under: bg(document.querySelector('.workspace-body > .pane-under')!), terminal: bg(slot), panel };
    });
    // The terminal keeps its dark background in the light theme: the cell under it on its way is that colour, not
    // the light panel's.
    expect(paint.terminal).not.toBe(paint.panel);
    expect(paint.under).toBe(paint.terminal);
    await look(win.locator('.workspace'), 'test-results/transitions-split-terminal.png');
    await hold(win, false);
    await resume(win);
    await settled(win);
    await expect(win.locator('.pane-under')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('a finished row\'s wave whose end never comes still goes: cancelled, never started, or not drawn at all while its row asks', async () => {
  test.setTimeout(120000);
  // Without avatars the wave is the last of the cue: its end is what ends the cue.
  const { app, home, win } = await launch({ sessionAvatars: false });
  try {
    await win.evaluate(recordCues);
    await newSession(win, 'One');
    await newSession(win, 'Two');
    await settled(win);

    // Cancelled (its row hidden mid-way): the wave goes at once, nothing of it left to play later.
    const caught = catchWave(win);
    await typeInto(win, 'One', '\r');
    expect((await caught)?.title).toBe('One');
    await win.locator('.row-wave').evaluate((el) => { (el as HTMLElement).style.display = 'none'; });
    await expect(win.locator('.row-wave')).toHaveCount(0);

    // Never started (hidden from its first frame, so no end ever comes): it goes once the longest cue is over.
    await typeInto(win, 'One', 'ev:work\r');
    await expect(row(win, 'One')).toHaveClass(/state-running/, { timeout: 10000 });
    await win.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'no-wave';
      s.textContent = '.row-wave { display: none !important; }';
      document.head.append(s);
    });
    const mounted = (await cues(win)).added.length;
    await typeInto(win, 'One', 'ev:stop\r');
    await expect.poll(async () => (await cues(win)).added.length, { timeout: 10000 }).toBe(mounted + 1);
    await expect(win.locator('.row-wave')).toHaveCount(0, { timeout: 5000 });
    await win.evaluate(() => document.getElementById('no-wave')?.remove());

    // Not drawn at all: it finishes while its row asks whether to restart (that form of the row has no wave). Once
    // the question is gone, no wave plays late.
    await typeInto(win, 'One', 'ev:agents:1\r');
    await expect(row(win, 'One')).toContainText('1 agent', { timeout: 10000 });
    await row(win, 'One').locator('.row-main').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Restart Session' }).click();
    const ask = win.locator('.session-row.is-restart-ask');
    await expect(ask).toContainText('Restart now?');
    const asking = (await cues(win)).added.length;
    await typeInto(win, 'One', 'ev:agent-done\r');
    // Its agent done, it is finished again: the question no longer names an agent.
    await expect(ask).toContainText('Its background work', { timeout: 10000 });
    await ask.locator('button.is-cancel').click();
    await expect(ask).toHaveCount(0);
    await expect(row(win, 'One')).toHaveClass(/state-done/);
    expect((await cues(win)).added.slice(asking)).toEqual([]);
    await expect(win.locator('.row-wave')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('a session that finishes: a flat wave crosses its row, a check takes its avatar a moment, both go; never at a reload. A waiting row keeps an amber edge', async () => {
  test.setTimeout(120000);
  const { app, home, win } = await launch();
  try {
    await win.evaluate(recordCues);
    // The same recorder in the documents a reload brings.
    await win.addInitScript(recordCues);
    await newSession(win, 'One');
    await newSession(win, 'Two');

    // Waiting, not the row selected: a calm amber edge on the row. The selected one keeps its own.
    const waitingEdge = await shadowOf(win, 'inset 0 0 0 1px var(--edge-waiting)');
    await expect.poll(() => shadow(row(win, 'One'))).toBe(waitingEdge);
    await expect(row(win, 'Two')).toHaveClass(/is-selected/);
    expect(await shadow(row(win, 'Two'))).not.toBe(waitingEdge);
    expect(await shadow(row(win, 'Two'))).not.toBe('none');
    await look(win.locator('.sidebar'), 'test-results/transitions-waiting-edge.png');

    // Answered, working: the edge goes. Nothing of the finish has played yet (waiting and working are no finish).
    await typeInto(win, 'One', 'hold\r');
    await expect(row(win, 'One')).toHaveClass(/state-running/, { timeout: 10000 });
    await expect.poll(() => shadow(row(win, 'One'))).toBe('none');
    expect((await cues(win)).added).toEqual([]);

    // Finished: the wave mounts on its row (moved to its new section meanwhile), the check on its avatar.
    const caught = catchWave(win);
    await typeInto(win, 'One', '\r');
    const wave = await caught;
    expect(wave).toEqual({ title: 'One', done: true, check: true });
    // Mid-sweep: a flat layer drawn part of the way across, the check over the avatar; neither takes the pointer.
    await freeze(win, '.row-wave, .av-done-check, .av-done-check > *', 300);
    const mid = await row(win, 'One').evaluate((el) => {
      const w = el.querySelector('.row-wave')!;
      const c = el.querySelector('.av-done-check')!;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const av = c.getBoundingClientRect();
      const onCheck = document.elementFromPoint(av.left + av.width / 2, av.top + av.height / 2);
      return { clip: getComputedStyle(w).clipPath, bg: getComputedStyle(w).backgroundImage, check: Number(getComputedStyle(c).opacity), hit: !!hit?.closest('.row-wave, .av-done-check'), onCheck: !!onCheck?.closest('.row-wave, .av-done-check') };
    });
    const right = Number(/^inset\(0px ([\d.]+)%/.exec(mid.clip)?.[1] ?? NaN);
    expect(right).toBeGreaterThan(5);
    expect(right).toBeLessThan(95);
    expect(mid.bg).toBe('none');
    expect(mid.check).toBeGreaterThan(0.9);
    expect(mid.hit).toBe(false);
    expect(mid.onCheck).toBe(false);
    // Over the row's own fill (hovered here; selected alike), not under it: the row stacks on its own while the cue
    // plays (a size container does not), and only then.
    await row(win, 'One').hover();
    expect(await row(win, 'One').evaluate((el) => getComputedStyle(el).isolation)).toBe('isolate');
    await look(win.locator('.sidebar'), 'test-results/transitions-done-wave.png');
    await win.mouse.move(1, 1);
    await resume(win);

    // Then both have played to their end and are gone.
    await expect(win.locator('.row-wave, .av-done-check')).toHaveCount(0, { timeout: 3000 });
    expect(await row(win, 'One').evaluate((el) => getComputedStyle(el).isolation)).toBe('auto');
    let log = await cues(win);
    expect(log.added.map((a) => `${a.cls} on ${a.row}`).sort()).toEqual(['av-done-check on One', 'row-wave on One']);
    expect(log.added.every((a) => /\bstate-done\b/.test(a.rowCls))).toBe(true);
    expect(log.ended.filter((e) => e.on === 'row-wave').map((e) => e.name)).toEqual(['atl-row-wave']);
    expect(log.ended.filter((e) => e.on === 'av-done-check').map((e) => e.name).sort()).toEqual(['atl-check', 'atl-check-cover']);

    // Working again, then finished again: the wave plays again.
    await typeInto(win, 'One', 'ev:work\r');
    await expect(row(win, 'One')).toHaveClass(/state-running/, { timeout: 10000 });
    await typeInto(win, 'One', 'ev:stop\r');
    await expect(row(win, 'One')).toHaveClass(/state-done/, { timeout: 10000 });
    await expect.poll(async () => (await cues(win)).ended.filter((e) => e.on === 'row-wave').length).toBe(2);
    await expect(win.locator('.row-wave, .av-done-check')).toHaveCount(0, { timeout: 3000 });
    expect((await cues(win)).added.map((a) => `${a.cls} on ${a.row}`).sort()).toEqual(['av-done-check on One', 'av-done-check on One', 'row-wave on One', 'row-wave on One']);

    // A reload shows the finished row as it is: no wave, no check (a mount is no finish). Recorded from the new
    // document's start, so a cue played and gone before this reads would still be counted.
    await win.reload();
    await expect(row(win, 'One')).toHaveClass(/state-done/, { timeout: 20000 });
    await expect(row(win, 'Two')).toHaveClass(/state-waiting/);
    log = await cues(win);
    expect(log.added).toEqual([]);
    await expect(win.locator('.row-wave, .av-done-check')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('Reduce motion: picking a row or a tab, a new session, a split play nothing and leave nothing', async () => {
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
    // And a split: the new pane is simply there, its line too.
    await menu(app, 'Split Right');
    await expect(win.locator('.workspace-body > .pane-picker')).toHaveCount(1);
    expect(await played(win)).toEqual([]);
    await expect(win.locator('.motion-pill, .motion-lane, .tab-crown-fly, [data-gliding], [data-crown-landing], .motion-fx, .motion-spark, .motion-ring, [data-drawing], .pane-under')).toHaveCount(0);
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
    // Every result row as it mounts: its flat index, whether it carries the entrance and its animation delay. Recorded
    // by an observer, so the check does not depend on when the page is read.
    await win.evaluate(() => {
      const w = window as unknown as { rows: { i: string; enter: boolean; delay: string }[] };
      w.rows = [];
      new MutationObserver((list) => {
        for (const m of list) for (const n of m.addedNodes) {
          for (const el of n instanceof Element ? [n, ...n.querySelectorAll('.palette-item')] : []) {
            if (el.classList.contains('palette-item')) {
              w.rows.push({ i: (el as HTMLElement).style.getPropertyValue('--i'), enter: el.classList.contains('is-enter'), delay: getComputedStyle(el).animationDelay });
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const rows = () => win.evaluate(() => (window as unknown as { rows: { i: string; enter: boolean; delay: string }[] }).rows.slice());
    await menu(app, 'Search…');
    await expect(win.locator('.palette-backdrop.is-cmd .palette')).toBeVisible();
    // The app recedes by a mark on the root the palette sets while it is open (never a :has() the page re-checks).
    const mark = () => win.evaluate(() => document.documentElement.getAttribute('data-palette'));
    expect(await mark()).toBe('open');
    // The entrance follows the flat index: 60 ms, then 22 ms a row, for the first eight results only.
    const opened = await rows();
    expect(opened.length).toBeGreaterThan(8);
    expect(opened.slice(0, 8).map((r) => r.delay)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${(60 + i * 22) / 1000}s`));
    expect(opened.slice(0, 8).every((r, i) => r.enter && r.i === String(i))).toBe(true);
    expect(opened.slice(8).some((r) => r.enter)).toBe(false);
    await expect.poll(() => transform(body)).toMatch(/^matrix\(0\.985,/);
    // The sheet itself is not scaled by the receding app (its own animation rests at the identity).
    expect(await transform(win.locator('.palette'))).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    expect(await win.locator('.palette').evaluate((el) => getComputedStyle(el).animationName)).toBe('atl-sheet-drop');
    await look(win, 'test-results/transitions-palette-open.png');
    // Typing after the opening: the rows it brings have no entrance.
    await expect.poll(() => win.locator('.palette-item.is-enter').count()).toBe(0);
    const before = (await rows()).length;
    await win.keyboard.type('s');
    await expect.poll(async () => (await rows()).length).toBeGreaterThan(before);
    expect((await rows()).slice(before).some((r) => r.enter)).toBe(false);
    await win.keyboard.press('Escape');
    await expect(win.locator('.palette')).toHaveCount(0);
    // It returns at once, so what is measured right after a palette action is the app at rest.
    expect(await transform(body)).toBe('none');
    expect(await mark()).toBeNull();

    // Another sheet sharing the palette's classes keeps its own entrance and leaves the app where it is.
    await menu(app, 'New Claude Session');
    const sheet = win.locator('.palette.new-session');
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate((el) => getComputedStyle(el).animationName)).toBe('atl-pop');
    expect(await transform(body)).toBe('none');
    expect(await mark()).toBeNull();
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // Under Reduce motion the results are simply there: none waits for its turn to show.
    await win.emulateMedia({ reducedMotion: 'reduce' });
    const shown = (await rows()).length;
    await menu(app, 'Search…');
    await expect(win.locator('.palette-backdrop.is-cmd .palette')).toBeVisible();
    await expect.poll(async () => (await rows()).length).toBeGreaterThan(shown + 8);
    const still = (await rows()).slice(shown);
    expect(still.length).toBeGreaterThan(8);
    expect(still.every((r) => r.delay === '0s'), JSON.stringify(still)).toBe(true);
  } finally {
    await stop(app, home);
  }
});

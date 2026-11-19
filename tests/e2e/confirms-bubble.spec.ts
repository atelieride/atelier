// A row's close question is a bubble beside the row: it stays with its row however the list moves, opens on the side
// with room, keeps the keyboard inside and gives it back to the × that asked; with no row in sight it stands centered.
// A row whose terminal is gone folds away, unless motion is reduced, and the copy that folds (the row's look, its
// classes included) is no row to what finds rows: their data-term-row id, which the tests here use too, never a class.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

const SHOTS = resolve('e2e-shots/confirms-bubble');

let app: ElectronApplication;
let win: Page;
let home: string;
/** A terminal running `sleep`: closing it asks. */
let busy: Locator;

const bubble = () => win.getByRole('alertdialog');
const closeBtn = () => bubble().getByRole('button', { name: 'Close', exact: true });
const keepBtn = () => bubble().getByRole('button', { name: /^Keep/ });
const rowById = (id: string) => win.locator(`[data-term-row="${id}"]`);

/** A new terminal's row, by its id. */
async function openTerminal(): Promise<Locator> {
  const ids = () => win.locator('[data-term-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-term-row')!));
  const before = await ids();
  // The empty list's button, else the Terminals head's +.
  await win.getByRole('button', { name: 'Open a terminal' }).or(win.getByRole('button', { name: 'New terminal', exact: true })).first().click();
  let id = '';
  await expect.poll(async () => { id = (await ids()).find((x) => !before.includes(x)) ?? ''; return id; }, { timeout: 10000 }).not.toBe('');
  return rowById(id);
}

/** The busy terminal's question, asked from its row's ×. */
async function ask(): Promise<void> {
  await busy.hover();
  await busy.locator('.row-close').click();
  await expect(bubble()).toBeVisible();
}

/** Close's middle is level with the busy row. */
async function level(): Promise<boolean> {
  const r = await busy.boundingBox();
  const c = await closeBtn().boundingBox();
  if (!r || !c) return false;
  const mid = c.y + c.height / 2;
  return mid > r.y && mid < r.y + r.height;
}

/** The bubble's middle on the window's. */
async function centered(): Promise<boolean> {
  const b = await bubble().boundingBox();
  const width = await win.evaluate(() => window.innerWidth);
  return !!b && Math.abs(b.x + b.width / 2 - width / 2) <= 1;
}

interface Leaving { classes: string; rowish: boolean; duration: string; endHeight: number; afterHeight: number; text: string; marked: string }

/**
 * Records every copy that folds away as it is added: its classes, whether a row selector finds it or anything in it,
 * its animation's length, its text; `seek`: the list's height with the copy at its animation's last frame and once it
 * is gone; `pause`: its animation stopped, as in a window that doesn't render (only the fallback removes it); `hold`:
 * stopped at its first frame, to be looked at.
 */
async function watchLeaving(how: { seek?: boolean; pause?: boolean; hold?: boolean } = {}): Promise<void> {
  await win.evaluate((o) => {
    const w = window as unknown as { leaving: Leaving[]; leavingObserver?: MutationObserver; leavingCopies: HTMLElement[] };
    w.leavingObserver?.disconnect();
    w.leaving = [];
    w.leavingCopies = [];
    const rows = '[data-term-row], [role="listitem"], .is-selected, .is-asking, .is-caret-before, .is-caret-after';
    w.leavingObserver = new MutationObserver((all) => {
      for (const m of all) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement) || !n.classList.contains('row-leaving')) continue;
        const list = n.parentElement!;
        const rec: Leaving = { classes: n.className, rowish: n.matches(rows) || n.querySelector(rows) !== null, duration: getComputedStyle(n).animationDuration, endHeight: -1, afterHeight: -1, text: n.innerText, marked: `${getComputedStyle(n).backgroundImage} ${getComputedStyle(n).boxShadow}` };
        const [fold] = n.getAnimations();
        if (o.pause) fold?.pause();
        if (o.hold && fold) { fold.pause(); fold.currentTime = 0; }
        if (o.seek && fold) {
          fold.pause();
          fold.currentTime = Number(fold.effect!.getComputedTiming().endTime) - 0.01;
          rec.endHeight = list.getBoundingClientRect().height;
          n.remove();
          rec.afterHeight = list.getBoundingClientRect().height;
        }
        w.leavingCopies.push(n);
        w.leaving.push(rec);
      }
    });
    w.leavingObserver.observe(document.body, { childList: true, subtree: true });
  }, how);
}
const leaving = () => win.evaluate(() => (window as unknown as { leaving: Leaving[] }).leaving);

/** Closes a terminal at its prompt from its row's × (it closes at once) and waits for its row to go. */
async function closeIdle(row: Locator): Promise<void> {
  await row.hover();
  await row.locator('.row-close').click();
  await expect(row).toHaveCount(0, { timeout: 10000 });
  await expect(bubble()).toHaveCount(0);
}

test.beforeAll(async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const e = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  home = e.home;
  app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env: e.env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  busy = await openTerminal();
  await busy.click();
  await win.locator('.xterm-helper-textarea:visible').focus();
  await win.keyboard.type('sleep 3000');
  await win.keyboard.press('Enter');
  await expect(busy.locator('.term-cmd')).toContainText('sleep', { timeout: 10000 });
});

// Every test leaves no question open.
test.afterEach(async () => {
  if (await bubble().count()) await win.keyboard.press('Escape');
  await expect(bubble()).toHaveCount(0);
  await win.mouse.move(900, 500);
});

test.afterAll(async () => {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
});

test('a terminal row’s × stays shown, held down, while the pointer and the keyboard are on its question', async () => {
  await ask();
  await expect(keepBtn()).toBeFocused();
  await bubble().hover();
  await expect.poll(() => busy.locator('.row-close').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await look(win, join(SHOTS, 'term-asked.png'), { settle: 300 });
  await keepBtn().click();
});

test('the keyboard stays in the bubble: Tab and Shift+Tab go round its answers, Esc answers; the × and the warning are described', async () => {
  const x = busy.locator('.row-close');
  await expect(x).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(x).toHaveAttribute('aria-expanded', 'false');
  await ask();
  await expect(x).toHaveAttribute('aria-expanded', 'true');
  await expect(bubble()).toHaveAccessibleDescription(/sleep stops\./);
  await expect(keepBtn()).toBeFocused();
  await win.keyboard.press('Tab');
  await expect(closeBtn()).toBeFocused();
  await win.keyboard.press('Tab');
  await expect(keepBtn()).toBeFocused();
  await win.keyboard.press('Shift+Tab');
  await expect(closeBtn()).toBeFocused();
  await win.keyboard.press('Shift+Tab');
  await expect(keepBtn()).toBeFocused();
  await win.keyboard.press('Escape');
  await expect(bubble()).toHaveCount(0);
  await expect(x).toHaveAttribute('aria-expanded', 'false');
});

test('answered Keep or Esc, the keyboard goes back to the × that asked', async () => {
  const x = busy.locator('.row-close');
  await ask();
  await win.keyboard.press('Escape');
  await expect(bubble()).toHaveCount(0);
  await expect(x).toBeFocused();
  // Asked again from the keyboard, answered with the pointer.
  await win.keyboard.press('Enter');
  await expect(bubble()).toBeVisible();
  await keepBtn().click();
  await expect(bubble()).toHaveCount(0);
  await expect(x).toBeFocused();
});

test('the bubble stays with its row when the list moves under it without a scroll', async () => {
  await ask();
  await expect.poll(level).toBe(true);
  // A row above appears, another grows a line, the row changes section: its list moves, nothing scrolls.
  const list = busy.locator('xpath=..');
  await list.evaluate((el) => { (el as HTMLElement).style.paddingTop = '140px'; });
  await expect.poll(level).toBe(true);
  await list.evaluate((el) => { (el as HTMLElement).style.paddingTop = ''; });
  await expect.poll(level).toBe(true);
});

test('a row scrolled out of the sidebar’s sight has no bubble pointing at it: centered, then beside it again', async () => {
  await ask();
  await expect.poll(level).toBe(true);
  // Scrolled just past the sidebar's top edge: in the window, out of the list's sight.
  await busy.evaluate((el) => {
    (el.parentElement as HTMLElement).style.paddingBottom = '3000px';
    const bar = el.closest('.sidebar')!;
    bar.scrollTop += el.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 8;
  });
  await expect(bubble()).toHaveClass(/is-centered/);
  await expect.poll(centered).toBe(true);
  await look(win, join(SHOTS, 'scrolled-out.png'), { settle: 300 });
  await busy.evaluate((el) => { el.closest('.sidebar')!.scrollTop = 0; (el.parentElement as HTMLElement).style.paddingBottom = ''; });
  await expect(bubble()).not.toHaveClass(/is-centered/);
  await expect.poll(level).toBe(true);
});

test('a row hidden while asked (a filter, another workspace) leaves the bubble centered on the window, whatever its width', async () => {
  await ask();
  await expect.poll(level).toBe(true);
  await busy.evaluate((el) => { (el as HTMLElement).style.display = 'none'; });
  await expect(bubble()).toHaveClass(/is-centered/);
  await expect.poll(centered).toBe(true);
  await busy.evaluate((el) => { (el as HTMLElement).style.display = ''; });
  await expect(bubble()).not.toHaveClass(/is-centered/);
  await expect.poll(level).toBe(true);
});

test('Swap Side Panels: the bubble opens left of the row, never over it, its arrow toward the row', async () => {
  const swap = (on: boolean) => win.evaluate((v) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ swapSidePanels: v }), on);
  await swap(true);
  try {
    await expect(win.locator('.body')).toHaveClass(/is-swapped/);
    await ask();
    await expect.poll(async () => {
      const b = (await bubble().boundingBox())!;
      const r = (await busy.boundingBox())!;
      return b.x + b.width <= r.x;
    }).toBe(true);
    await expect.poll(level).toBe(true);
    await expect(bubble()).toHaveClass(/is-left/);
    expect(await bubble().evaluate((el) => getComputedStyle(el, '::before').right)).toBe('-6px');
    await look(win, join(SHOTS, 'swapped.png'), { settle: 300 });
    await keepBtn().click();
  } finally {
    await swap(false);
    await expect(win.locator('.body')).not.toHaveClass(/is-swapped/);
  }
});

test('Reduce motion from the system: a row whose terminal is gone just goes, no copy folds away', async () => {
  await win.emulateMedia({ reducedMotion: 'reduce' });
  try {
    const row = await openTerminal();
    await watchLeaving();
    await closeIdle(row);
    expect(await leaving()).toEqual([]);
  } finally {
    await win.emulateMedia({ reducedMotion: 'no-preference' });
  }
});

test('the copy that folds away is no row (no id, no role, no selection) and its list’s gap closes with it', async () => {
  await win.emulateMedia({ reducedMotion: 'no-preference' });
  const a = await openTerminal();
  const b = await openTerminal();
  await watchLeaving({ seek: true });
  // In the middle of its list, then last in it.
  await closeIdle(a);
  await closeIdle(b);
  const all = await leaving();
  expect(all).toHaveLength(2);
  for (const l of all) {
    expect.soft(Math.abs(l.endHeight - l.afterHeight), `the list at the fold's end: ${l.endHeight} px, then ${l.afterHeight} px`).toBeLessThan(0.5);
    expect.soft(l.rowish, `what finds rows finds the copy: ${l.classes}`).toBe(false);
  }
  // A section's head under a leaving copy is its list's first: no rule above it, as once the copy is gone.
  const head = await win.evaluate(() => {
    const list = document.createElement('div');
    list.className = 'list inbox';
    list.innerHTML = '<div class="row-leaving"></div><div class="inbox-head is-idle"><span class="section-label">Idle</span></div>';
    document.querySelector('.sidebar')!.append(list);
    const cs = getComputedStyle(list.children[1]!);
    const got = { border: cs.borderTopWidth, margin: cs.marginTop, padding: cs.paddingTop };
    list.remove();
    return got;
  });
  expect(head).toEqual({ border: '0px', margin: '0px', padding: '4px' });
});

test('the fold lasts what the motion tokens say, and a copy whose fold never runs still goes then', async () => {
  await win.emulateMedia({ reducedMotion: 'no-preference' });
  const root = (slow: string, fast: string) => win.evaluate(([s, f]) => {
    const r = document.documentElement.style;
    if (s) r.setProperty('--t-slow', s); else r.removeProperty('--t-slow');
    if (f) r.setProperty('--t-fast', f); else r.removeProperty('--t-fast');
  }, [slow, fast]);
  const row = await openTerminal();
  await root('24ms', '12ms');
  try {
    await watchLeaving({ pause: true });
    await closeIdle(row);
    await expect.poll(async () => (await leaving()).length).toBe(1);
    expect((await leaving())[0]!.duration).toBe('0.036s');
    // Its animation stopped (a window that doesn't render): it goes by itself, in step with the tokens.
    await expect.poll(() => win.evaluate(() => (window as unknown as { leavingCopies: HTMLElement[] }).leavingCopies.every((c) => !c.isConnected)), { timeout: 400 }).toBe(true);
  } finally {
    await root('', '');
  }
});

test('a closed session’s row folds away as a copy that looks like it, without being one', async () => {
  await win.emulateMedia({ reducedMotion: 'no-preference' });
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.keyboard.press('Enter');
  const session = win.locator('[data-term-row]', { has: win.locator('.session-title') });
  await expect(session).toHaveClass(/state-waiting/, { timeout: 20000 });
  const title = (await session.locator('.session-title').textContent())!.trim();
  const sidebar = win.locator('.body > .sidebar');
  await win.mouse.move(900, 500);
  await look(sidebar, join(SHOTS, 'session-row.png'), { settle: 300 });
  await watchLeaving({ hold: true });
  await session.hover();
  await session.locator('.row-close').click();
  await closeBtn().click();
  await expect(session).toHaveCount(0, { timeout: 10000 });
  await expect.poll(async () => (await leaving()).length).toBe(1);
  const [copy] = await leaving();
  expect(copy!.rowish, copy!.classes).toBe(false);
  expect(copy!.text).toContain(title);
  // The row was the selected one: its copy isn't marked as it (another row is, now).
  expect(copy!.marked).toBe('none none');
  // Held at its first frame: the row as it was, closing — its content faded as the row's was, the copy itself not
  // faded further (no jump as the fold starts).
  expect(await win.evaluate(() => {
    const c = document.querySelector('.row-leaving')!;
    return [getComputedStyle(c).opacity, getComputedStyle(c.querySelector('.row-main')!).opacity];
  })).toEqual(['1', '0.55']);
  const held = (await win.locator('.row-leaving').boundingBox())!;
  expect(held.height).toBeGreaterThanOrEqual(46);
  await win.mouse.move(900, 500);
  await look(sidebar, join(SHOTS, 'session-row-leaving.png'));
  await win.evaluate(() => (window as unknown as { leavingCopies: HTMLElement[] }).leavingCopies.forEach((c) => c.remove()));
});

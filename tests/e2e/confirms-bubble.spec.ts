// A row's close question is a bubble beside the row: it stays with its row however the list moves, opens on the side
// with room, keeps the keyboard inside and gives it back to the × that asked; with no row in sight it stands centered.
// A row whose terminal is gone folds away, unless motion is reduced, and the copy that folds is no row to anything
// that looks for one. The rows are found by their data-term-row id, never by a class.
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

test.beforeAll(async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const e = e2eEnv();
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

// Moving a file or a plain terminal to another project's window: by the
// tab's menu, by dragging a pop-out's handle over the other window, by tearing a tab off and releasing it there. A
// Claude session never moves. The test cursor (ATELIER_TEST_CURSOR) stands for the real one, never moved.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

const SHOTS = 'test-results';
type Bounds = { x: number; y: number; width: number; height: number };

async function launch(home?: { env: Record<string, string>; home: string; alpha: string; beta: string }) {
  const made = home ?? (() => {
    const alpha = mkdtempSync(join(tmpdir(), 'atl-prj-alpha-'));
    const beta = mkdtempSync(join(tmpdir(), 'atl-prj-beta-'));
    writeFileSync(join(alpha, 'notes.md'), 'Notes\n');
    writeFileSync(join(alpha, 'plan.md'), 'Plan\n');
    writeFileSync(join(beta, 'readme.md'), 'Beta\n');
    const e = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CURSOR: '1' });
    writeFileSync(join(e.home, 'ui-state.json'), JSON.stringify({ openProjects: [alpha, beta], recent: [alpha, beta], quitInfoShown: true }));
    return { ...e, alpha, beta };
  })();
  const app = await electron.launch({ args: ['out/main/index.js'], env: made.env });
  await expect.poll(() => app.windows().length).toBe(2);
  const pages: Record<string, Page> = {};
  for (const page of app.windows()) {
    await expect(page.locator('.header')).toBeVisible({ timeout: 15000 });
    const text = await page.locator('.header').innerText();
    const root = [made.alpha, made.beta].find((r) => text.includes(basename(r)));
    if (root) pages[root] = page;
  }
  const a = pages[made.alpha]!;
  const b = pages[made.beta]!;
  // Side by side, apart (alpha left, beta right): the point over beta is never over alpha.
  await (await app.browserWindow(a)).evaluate((w) => w.setBounds({ x: 0, y: 40, width: 960, height: 640 }));
  await (await app.browserWindow(b)).evaluate((w) => w.setBounds({ x: 1100, y: 40, width: 960, height: 640 }));
  return { app, a, b, ...made };
}

async function stop(app: ElectronApplication, home: string) {
  await app.evaluate(() => { process.env.ATELIER_TEST_UNSAVED_ANSWER = 'discard'; }).catch(() => {});
  await app.close().catch(() => {});
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const setCursor = (app: ElectronApplication, x: number, y: number) => app.evaluate((_, p) => { (globalThis as { __atelierTestCursor?: { x: number; y: number } }).__atelierTestCursor = p; }, { x, y });
const contentOf = async (app: ElectronApplication, page: Page): Promise<Bounds> => (await app.browserWindow(page)).evaluate((w) => w.getContentBounds());

async function openFile(page: Page, name: string) {
  const files = page.getByRole('button', { name: /^Files/ });
  // The item in front clicked again hides the sidebar: Files only when it isn't in front.
  if ((await files.getAttribute('aria-pressed')) !== 'true') await files.click();
  await page.locator('.tree-row', { hasText: name }).first().dblclick();
  await expect(page.locator('.file-view:visible .cm-content')).toBeVisible();
}

/** Tab › Move to Window › the window named. */
async function moveByMenu(page: Page, tab: string, to: string) {
  await page.locator('.tab', { hasText: tab }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Window' }).click();
  await page.getByRole('menuitem', { name: to }).click();
}

/** File › Save for that page's window (synthetic keys don't go through NSMenu). */
const saveIn = async (app: ElectronApplication, page: Page) => {
  const target = await app.browserWindow(page);
  await target.evaluate((w) => { (globalThis as { __saveTarget?: unknown }).__saveTarget = w; });
  await app.evaluate(({ Menu }) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === 'Save') return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, (globalThis as { __saveTarget?: Electron.BrowserWindow }).__saveTarget);
  });
};

const terminalText = (page: Page) => page.locator('.terminal-slot:visible .xterm-rows').first().evaluate((el) =>
  [...el.querySelectorAll(':scope > div')].map((r) => (r.textContent ?? '').replace(/\s+$/, '')).join('\n'));

test('by the tab menu: an unsaved file keeps its buffer in the other window; a terminal keeps its screen and takes input there, also after a relaunch; a session never offers it', async () => {
  const t = await launch();
  let app = t.app;
  try {
    const { a, b } = t;
    // An unsaved file.
    await openFile(a, 'notes.md');
    await a.locator('.file-view:visible .cm-content').click();
    await a.keyboard.press('End');
    await a.keyboard.type(' — unsaved');
    await expect(a.locator('.tab', { hasText: 'notes.md' }).locator('.tab-dirty')).toBeVisible();
    await moveByMenu(a, 'notes.md', basename(t.beta));
    await expect(b.locator('.tab', { hasText: 'notes.md' })).toBeVisible();
    await expect(b.locator('.tab', { hasText: 'notes.md' }).locator('.tab-dirty')).toBeVisible();
    await expect(b.locator('.file-view:visible .cm-content')).toContainText('Notes — unsaved');
    await expect(a.locator('.tab', { hasText: 'notes.md' })).toHaveCount(0);
    expect(readFileSync(join(t.alpha, 'notes.md'), 'utf8')).toBe('Notes\n');
    await look(b, `${SHOTS}/move-window-file.png`);
    // Saved from beta (granted there by the move): on disk, the dirty dot gone.
    await saveIn(app, b);
    await expect.poll(() => readFileSync(join(t.alpha, 'notes.md'), 'utf8')).toContain('unsaved');
    await expect(b.locator('.tab', { hasText: 'notes.md' }).locator('.tab-dirty')).toHaveCount(0);

    // A plain terminal: its screen comes along, typing reaches it from beta; alpha no longer lists it.
    await a.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(a.locator('.terminal-slot:visible .xterm-rows')).toContainText('›', { timeout: 15000 });
    await a.keyboard.type('echo before-$((40+2))\n');
    await expect.poll(() => terminalText(a)).toContain('before-42');
    const termTab = (await a.locator('.tab.is-active .tab-name').innerText()).trim();
    await moveByMenu(a, termTab, basename(t.beta));
    await expect(b.locator('.tab.is-active', { hasText: termTab })).toBeVisible({ timeout: 10000 });
    await expect.poll(() => terminalText(b)).toContain('before-42');
    await expect(a.locator('.tab', { hasText: termTab })).toHaveCount(0);
    await expect(a.locator('.sidebar .term-row', { hasText: termTab })).toHaveCount(0);
    await b.locator('.terminal-slot:visible .xterm').click();
    await b.keyboard.type('echo after-$((50+5))\n');
    await expect.poll(() => terminalText(b)).toContain('after-55');
    // And back to alpha: its screen is live there again (not the one alpha had before the move).
    await moveByMenu(b, termTab, basename(t.alpha));
    await expect(a.locator('.tab.is-active', { hasText: termTab })).toBeVisible({ timeout: 10000 });
    await expect.poll(() => terminalText(a)).toContain('after-55');
    await a.locator('.terminal-slot:visible .xterm').click();
    await a.keyboard.type('echo back-$((6*7))\n');
    await expect.poll(() => terminalText(a)).toContain('back-42');
    await expect(b.locator('.tab', { hasText: termTab })).toHaveCount(0);
    // To beta once more: that is where a relaunch finds it.
    await moveByMenu(a, termTab, basename(t.beta));
    await expect(b.locator('.tab.is-active', { hasText: termTab })).toBeVisible({ timeout: 10000 });

    // A Claude session: no Move to Window, in the tab's menu or its row's.
    await a.locator('.btn-new').click();
    await a.getByRole('menuitem', { name: 'Claude Session' }).click();
    await a.getByPlaceholder('Session name (optional)').fill('Stays');
    await a.keyboard.press('Enter');
    await a.getByRole('button', { name: /^Sessions/ }).click();
    await expect(a.locator('.session-row', { hasText: 'Stays' })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => a.locator('.session-row', { hasText: 'Stays' }).getAttribute('class'), { timeout: 15000 }).not.toMatch(/is-starting/);
    await a.locator('.tab', { hasText: 'Stays' }).click({ button: 'right' });
    await expect(a.getByRole('menuitem', { name: 'Move to New Window' })).toBeVisible();
    await expect(a.getByRole('menuitem', { name: 'Move to Window' })).toHaveCount(0);
    await a.keyboard.press('Escape');

    // A relaunch: the terminal is still beta's.
    await app.close();
    const again = await launch({ env: t.env, home: t.home, alpha: t.alpha, beta: t.beta });
    app = again.app;
    await expect(again.b.locator('.sidebar .term-row', { hasText: termTab })).toBeVisible({ timeout: 15000 });
    await expect(again.a.locator('.sidebar .term-row', { hasText: termTab })).toHaveCount(0);
  } finally {
    await stop(app, t.home);
  }
});

test('by dragging: a pop-out\'s handle over the other window shows "Move here" and lands there; a torn-off tab released over it too', async () => {
  const t = await launch();
  const { app, a, b } = t;
  try {
    // Pop out plan.md from alpha.
    await openFile(a, 'plan.md');
    await a.locator('.tab', { hasText: 'plan.md' }).click({ button: 'right' });
    const [pop] = await Promise.all([app.waitForEvent('window'), a.getByRole('menuitem', { name: 'Move to New Window' }).click()]);
    await expect(pop.locator('.popout-bar')).toBeVisible({ timeout: 15000 });
    const popWin = await app.browserWindow(pop);
    await popWin.evaluate((w) => w.setBounds({ x: 300, y: 720, width: 600, height: 300 }));
    const start = await popWin.evaluate((w) => w.getBounds());
    const handle = (await pop.locator('.popout-handle').boundingBox())!;
    const hx = handle.x + handle.width / 2;
    const hy = handle.y + handle.height / 2;
    const bc = await contentOf(app, b);
    const body = (await b.locator('.workspace-body').boundingBox())!;
    await setCursor(app, start.x + hx, start.y + hy);
    await pop.mouse.move(hx, hy);
    await pop.mouse.down();
    await expect(pop.locator('.popout-handle')).toHaveClass(/is-dragging/);
    // Over beta's workspace: its drop hint says the tab moves here.
    await setCursor(app, bc.x + Math.round(body.x + body.width / 2), bc.y + Math.round(body.y + body.height / 2));
    await expect(b.locator('.pane-drop')).toContainText('Move here');
    await b.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    await look(b, `${SHOTS}/move-window-drag.png`);
    await Promise.all([pop.waitForEvent('close'), (async () => { await pop.mouse.move(hx + 20, hy + 10); await pop.mouse.up(); })()]);
    await expect(b.locator('.tab.is-active', { hasText: 'plan.md' })).toBeVisible();
    await expect(b.locator('.file-view:visible .cm-content')).toContainText('Plan');
    await expect(b.locator('.pane-drop')).toHaveCount(0);

    // Tear notes.md off alpha's strip and release it over beta: no pop-out, it lands in beta.
    await openFile(a, 'notes.md');
    const ac = await contentOf(app, a);
    const tab = (await a.locator('.tab', { hasText: 'notes.md' }).boundingBox())!;
    await setCursor(app, ac.x + tab.x + tab.width / 2, ac.y + tab.y + tab.height / 2);
    await a.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
    await a.mouse.down();
    await a.mouse.move(tab.x + tab.width / 2 + 12, tab.y + tab.height / 2, { steps: 3 });
    await expect(a.locator('.tab-drag-chip')).toHaveCount(1);
    const over = { x: bc.x + Math.round(body.x + body.width / 2), y: bc.y + Math.round(body.y + body.height / 2) };
    await setCursor(app, over.x, over.y);
    await a.mouse.move(over.x - ac.x, over.y - ac.y, { steps: 2 });
    await expect(b.locator('.pane-drop')).toContainText('Move here');
    await a.mouse.up();
    await expect(b.locator('.tab.is-active', { hasText: 'notes.md' })).toBeVisible();
    await expect(a.locator('.tab', { hasText: 'notes.md' })).toHaveCount(0);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isFocusable() && w.getMinimumSize()[0] === 480).length)).toBe(0);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isFocusable()).length)).toBe(0);
  } finally {
    await stop(app, t.home);
  }
});

test('refused: the other window has that file open and the buffer coming has changes — it stays here, a toast says why', async () => {
  const t = await launch();
  const { app, a, b } = t;
  try {
    // Beta shows alpha's notes.md too (an outside file there), then alpha edits its own copy.
    await openFile(a, 'notes.md');
    await a.locator('.file-view:visible .cm-content').click();
    await a.keyboard.press('End');
    await a.keyboard.type(' — mine');
    await moveByMenu(a, 'notes.md', basename(t.beta));
    await expect(b.locator('.tab', { hasText: 'notes.md' })).toBeVisible();
    await b.locator('.file-view:visible .cm-content').click();
    // Back in alpha (opened again from its tree) with changes of its own: beta refuses.
    await openFile(a, 'notes.md');
    await a.locator('.file-view:visible .cm-content').click();
    await a.keyboard.press('End');
    await a.keyboard.type(' — again');
    await moveByMenu(a, 'notes.md', basename(t.beta));
    await expect(a.locator('.toast')).toContainText('Save it here first');
    await expect(a.locator('.tab', { hasText: 'notes.md' }).locator('.tab-dirty')).toBeVisible();
    await expect(b.locator('.file-view:visible .cm-content')).toContainText('Notes — mine');
    await expect(b.locator('.file-view:visible .cm-content')).not.toContainText('again');
  } finally {
    await stop(app, t.home);
  }
});

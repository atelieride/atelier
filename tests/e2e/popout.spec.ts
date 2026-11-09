import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look, shotsOn } from './shots';

// Tab pop-out windows: a tab in a window of its own — popped out from the menus or by a
// drag out of the window, moved back by its button, the menu, a drag of its handle into the main window, restored on
// relaunch. Windows stay hidden (ATELIER_TEST_BACKGROUND); the pointer main reads is a test cursor
// (ATELIER_TEST_CURSOR + globalThis.__atelierTestCursor), never the real one.

const SHOTS = 'test-results';
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `const r${i + 1} = ${(i + 1) * 10};`).join('\n') + '\n';

type Which = 'main' | 'popout';

/** A project folder: a git repo with src/a.ts (committed) and src/rate.ts (committed, then changed on disk). */
function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'atl-pop-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'src', 'rate.ts'), lines(12));
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  writeFileSync(join(project, 'src', 'rate.ts'), lines(12).replace('const r4 = 40;', 'const r4 = 4000;'));
  return project;
}

async function launch(opts: { project?: string; env?: Record<string, string>; home?: string } = {}) {
  const project = opts.project ?? makeProject();
  const made = opts.env ? { env: opts.env, home: opts.home! } : e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CURSOR: '1' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env: made.env });
  const win = await app.firstWindow();
  await expect(win.locator('.header')).toBeVisible();
  return { app, win, project, env: made.env, home: made.home };
}

async function stop(app: ElectronApplication, home: string) {
  // Whatever a test set the unsaved answer to, the app quits without a dialog.
  await app.evaluate(() => { process.env.ATELIER_TEST_UNSAVED_ANSWER = 'discard'; }).catch(() => {});
  await app.close().catch(() => {});
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const still = (page: Page) => page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

/** Pop-out windows are the ones with the pop-out's minimum width (480; a project window's is 960). The tear-off's ghost
 * (never focusable) is neither. */
const windowCounts = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const all = BrowserWindow.getAllWindows().filter((w) => w.isFocusable());
  const pop = all.filter((w) => w.getMinimumSize()[0] === 480).length;
  return { main: all.length - pop, popout: pop };
});
const boundsOf = (app: ElectronApplication, which: Which) => app.evaluate(({ BrowserWindow }, w) =>
  BrowserWindow.getAllWindows().find((b) => b.isFocusable() && (b.getMinimumSize()[0] === 480) === (w === 'popout'))!.getBounds(), which);
const contentOf = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().find((b) => b.isFocusable() && b.getMinimumSize()[0] !== 480)!.getContentBounds());
/** The tear-off's ghosts: their opacity (0 hidden, 1 shown) and bounds. */
const ghosts = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().filter((b) => !b.isFocusable()).map((b) => ({ opacity: b.getOpacity(), bounds: b.getBounds(), url: b.webContents.getURL() })));
const setCursor = (app: ElectronApplication, x: number, y: number) => app.evaluate((_, p) => { (globalThis as { __atelierTestCursor?: { x: number; y: number } }).__atelierTestCursor = p; }, { x, y });

/** An app menu item clicked for the given window (synthetic key presses don't go through NSMenu). */
async function menu(app: ElectronApplication, label: string, which: Which = 'main') {
  await app.evaluate(({ Menu, BrowserWindow }, { l, w }) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    const target = BrowserWindow.getAllWindows().find((b) => b.isFocusable() && (b.getMinimumSize()[0] === 480) === (w === 'popout'))!;
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, target);
  }, { l: label, w: which });
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.tab.is-active', { hasText: name })).toBeVisible({ timeout: 15000 });
}

async function newTerminal(win: Page) {
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('>new terminal');
  await win.locator('.palette-item', { has: win.locator('.palette-label', { hasText: /^New terminal$/ }) }).click();
  await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('›', { timeout: 15000 });
}

async function openFile(win: Page, ...names: string[]) {
  const files = win.getByRole('button', { name: /^Files/ });
  // The item in front clicked again hides the sidebar: Files only when it isn't in front.
  if ((await files.getAttribute('aria-pressed')) !== 'true') await files.click();
  for (const n of names) await win.locator('.tree-row', { hasText: n }).first().click();
  await expect(win.locator('.file-view:visible .cm-content')).toBeVisible();
}

/** "Move to New Window" from a tab's context menu: the new window's page. */
async function popOutFromTab(app: ElectronApplication, win: Page, name: string): Promise<Page> {
  await win.locator('.tab', { hasText: name }).click({ button: 'right' });
  const [pop] = await Promise.all([app.waitForEvent('window'), win.getByRole('menuitem', { name: 'Move to New Window' }).click()]);
  await expect(pop.locator('.popout-bar')).toBeVisible({ timeout: 15000 });
  return pop;
}

/**
 * A negative check ("nothing happens"): what `read` gives stays `want`, sampled for `ms` — a late change fails it
 * instead of being slept past.
 */
async function stays<T>(read: () => Promise<T>, want: T, ms = 600): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    expect(await read() as unknown).toEqual(want);
    if (Date.now() >= end) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const terminalText = (page: Page) => page.locator('.terminal-slot .xterm-rows').first().evaluate((el) =>
  [...el.querySelectorAll(':scope > div')].map((r) => (r.textContent ?? '').replace(/\s+$/, '')).join('\n'));

test('a session pops out from its tab menu: its own window, gone from the strip, marked in the sidebar; ⌘K goes to the main window; a row click adds no tab; Move Back brings it back in front', async () => {
  const { app, win, home } = await launch();
  try {
    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    await win.locator('.tab', { hasText: 'Alfa' }).click();
    await expect(win.locator('.tab.is-active')).toContainText('Alfa');

    // The tab's context menu has the item (screenshot of the menu).
    await win.locator('.tab', { hasText: 'Alfa' }).click({ button: 'right' });
    const item = win.getByRole('menuitem', { name: 'Move to New Window' });
    await expect(item).toBeVisible();
    await item.hover();
    await still(win);
    await look(win, `${SHOTS}/popout-tab-menu.png`);
    const [pop] = await Promise.all([app.waitForEvent('window'), item.click()]);

    // The pop-out: its bar with the session's title and Move Back, the session's terminal under it.
    const bar = pop.locator('.popout-bar');
    await expect(bar).toBeVisible({ timeout: 15000 });
    await expect(bar).toContainText('Alfa');
    await expect(bar.getByRole('button', { name: 'Move Back' })).toBeVisible();
    await expect(pop.locator('.popout-handle')).toBeVisible();
    await expect(pop.locator('.terminal-slot .xterm-rows')).toBeVisible();
    // No sidebar, no tab strip, no footer.
    await expect(pop.locator('.sidebar')).toHaveCount(0);
    await expect(pop.locator('.tab-strip')).toHaveCount(0);
    await expect.poll(() => pop.title()).toMatch(/^Alfa — atl-pop-/);
    expect(await windowCounts(app)).toEqual({ main: 1, popout: 1 });

    // The main window: no tab for it (Beta, the neighbour, in front), its row marked.
    await expect(win.locator('.tab', { hasText: 'Alfa' })).toHaveCount(0);
    await expect(win.locator('.tab.is-active')).toContainText('Beta');
    const row = win.locator('.session-row', { hasText: 'Alfa' });
    await expect(row.locator('.row-popout')).toBeVisible();
    await expect(row.locator('.row-popout')).toHaveAttribute('aria-label', 'In a separate window');
    await expect(win.locator('.session-row', { hasText: 'Beta' }).locator('.row-popout')).toHaveCount(0);
    await still(pop);
    await win.mouse.move(600, 400);
    await look(win, `${SHOTS}/popout-main-after.png`);
    await look(pop, `${SHOTS}/popout-session.png`);
    // The bar's hover states: the handle, then Move Back.
    await pop.locator('.popout-handle').hover();
    await look(pop.locator('.popout-bar'), `${SHOTS}/popout-bar-handle-hover.png`);
    await bar.getByRole('button', { name: 'Move Back' }).hover();
    await look(pop.locator('.popout-bar'), `${SHOTS}/popout-bar-back-hover.png`);
    // Narrow (its minimum width): the project label and Move Back's name give way, nothing overlaps.
    const resize = (width: number) => app.evaluate(({ BrowserWindow }, wd) => { const w = BrowserWindow.getAllWindows().find((b) => b.getMinimumSize()[0] === 480)!; w.setSize(wd, w.getSize()[1]!); }, width);
    const wide = (await boundsOf(app, 'popout')).width;
    await resize(480);
    await expect(bar.locator('.popout-back span')).toBeHidden();
    await look(pop.locator('.popout-bar'), `${SHOTS}/popout-bar-narrow.png`);
    await resize(wide);
    await expect(bar.locator('.popout-back span')).toBeVisible();
    // The bar's context menu: Move Back first, the session's own items, nothing about the strip.
    await bar.locator('.popout-project').click({ button: 'right' });
    await expect(pop.getByRole('menuitem', { name: 'Move Back to Main Window' })).toBeVisible();
    await expect(pop.getByRole('menuitem', { name: 'Move to New Window' })).toHaveCount(0);
    await expect(pop.getByRole('menuitem', { name: 'Close Tab' })).toHaveCount(0);
    await look(pop, `${SHOTS}/popout-bar-menu.png`);
    await pop.keyboard.press('Escape');
    await expect(pop.getByRole('menuitem', { name: 'Move Back to Main Window' })).toHaveCount(0);

    // A click on its row brings its window forward: no tab appears in the main strip, Beta stays in front.
    await row.locator('.row-main').click();
    await stays(async () => [await win.locator('.tab', { hasText: 'Alfa' }).count(), await win.locator('.tab.is-active .tab-name').textContent(), await windowCounts(app)], [0, 'Beta', { main: 1, popout: 1 }]);
    // Its row menu: Show Window and Move Back to Main Window, no Move to New Window.
    await row.click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Show Window' })).toBeVisible();
    await expect(win.getByRole('menuitem', { name: 'Move Back to Main Window' })).toBeVisible();
    await expect(win.getByRole('menuitem', { name: 'Move to New Window' })).toHaveCount(0);
    await win.keyboard.press('Escape');

    // ⌘K/F1 in the pop-out: the palette opens in the main window; the pop-out has none.
    await pop.locator('.terminal-slot').click();
    await pop.keyboard.press('F1');
    await expect(win.locator('.palette-input')).toBeVisible();
    await expect(pop.locator('.palette-input')).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(win.locator('.palette-input')).toHaveCount(0);

    // Move Back: the window closes, the tab comes back after the active one and in front.
    await Promise.all([pop.waitForEvent('close'), bar.getByRole('button', { name: 'Move Back' }).click()]);
    await expect(win.locator('.tab.is-active')).toContainText('Alfa');
    expect(await win.locator('.tab .tab-name').allTextContents()).toEqual(['Beta', 'Alfa']);
    await expect(row.locator('.row-popout')).toHaveCount(0);
    expect(await windowCounts(app)).toEqual({ main: 1, popout: 0 });
  } finally {
    await stop(app, home);
  }
});

test('⇧⌘O pops the tab in front out of the main window, and in the pop-out moves it back', async () => {
  const { app, win, home } = await launch();
  try {
    await newSession(win, 'Alfa');
    // The palette offers it for the tab in front.
    const paletteMove = async () => {
      await win.keyboard.press('F1');
      await win.locator('.palette-input').fill('>move tab');
      const n = await win.locator('.palette-item', { has: win.locator('.palette-label', { hasText: /^Move Tab to New Window$/ }) }).count();
      await win.keyboard.press('Escape');
      await expect(win.locator('.palette-input')).toHaveCount(0);
      return n;
    };
    await win.locator('.tab', { hasText: 'Alfa' }).click();
    expect(await paletteMove()).toBe(1);
    const [pop] = await Promise.all([app.waitForEvent('window'), menu(app, 'Move Tab to New Window', 'main')]);
    await expect(pop.locator('.popout-bar')).toContainText('Alfa', { timeout: 15000 });
    await expect(win.locator('.tab', { hasText: 'Alfa' })).toHaveCount(0);
    // No tab in front: the palette has no such command, and a second ⇧⌘O pops nothing out.
    expect(await paletteMove()).toBe(0);
    await menu(app, 'Move Tab to New Window', 'main');
    await stays(() => windowCounts(app), { main: 1, popout: 1 });
    // In the pop-out the same command moves it back.
    await Promise.all([pop.waitForEvent('close'), menu(app, 'Move Tab to New Window', 'popout')]);
    await expect(win.locator('.tab.is-active')).toContainText('Alfa');
    expect(await windowCounts(app)).toEqual({ main: 1, popout: 0 });
    // ⌘W (Close Tab) in a pop-out moves its tab back too: the session is never closed by it.
    const [again] = await Promise.all([app.waitForEvent('window'), menu(app, 'Move Tab to New Window', 'main')]);
    await expect(again.locator('.popout-bar')).toContainText('Alfa', { timeout: 15000 });
    await Promise.all([again.waitForEvent('close'), menu(app, 'Close Tab', 'popout')]);
    await expect(win.locator('.tab.is-active')).toContainText('Alfa');
    await expect(win.locator('.session-row', { hasText: 'Alfa' })).toBeVisible();
  } finally {
    await stop(app, home);
  }
});

test('a popped-out terminal: typing reaches its shell; exit closes its window', async () => {
  const { app, win, home } = await launch();
  try {
    await newTerminal(win);
    const name = (await win.locator('.tab.is-active .tab-name').textContent())!;
    const pop = await popOutFromTab(app, win, name);
    await expect(pop.locator('.terminal-slot .xterm-rows')).toContainText('›', { timeout: 15000 });
    await pop.locator('.terminal-slot').click();
    await pop.keyboard.type('echo popped-$((40+2))');
    await pop.keyboard.press('Enter');
    await expect.poll(() => terminalText(pop), { timeout: 10000 }).toContain('popped-42');
    await expect(win.locator('.term-row').first().locator('.row-popout')).toBeVisible();

    // The shell ends: nothing to move back, the window closes and the row goes.
    await Promise.all([pop.waitForEvent('close', { timeout: 15000 }), (async () => { await pop.keyboard.type('exit'); await pop.keyboard.press('Enter'); })()]);
    await expect(win.locator('.term-row')).toHaveCount(0, { timeout: 10000 });
    expect(await windowCounts(app)).toEqual({ main: 1, popout: 0 });
  } finally {
    await stop(app, home);
  }
});

/** A main window smaller than the display, at its top left, so there is room outside it. */
async function smallMain(app: ElectronApplication) {
  return app.evaluate(({ screen, BrowserWindow }) => {
    const wa = screen.getPrimaryDisplay().workArea;
    BrowserWindow.getAllWindows()[0]!.setBounds({ x: wa.x, y: wa.y, width: 960, height: 640 });
    return wa;
  });
}

/** Presses a tab and moves past the threshold: the drag has started (the pointer still over the strip). */
async function pressAndLift(app: ElectronApplication, win: Page, name: string) {
  const box = (await win.locator('.tab', { hasText: name }).boundingBox())!;
  // Main's cursor where the page's pointer is (over the tab).
  const c = await contentOf(app);
  await setCursor(app, c.x + box.x + box.width / 2, c.y + box.y + box.height / 2);
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  await expect(win.locator('.tab-drag-chip')).toHaveCount(1);
}

/** The pointer at a screen point: main's test cursor, and the page's mouse at the same place (client coordinates). */
async function pointAt(app: ElectronApplication, win: Page, screenX: number, screenY: number) {
  const c = await contentOf(app);
  await setCursor(app, screenX, screenY);
  await win.mouse.move(screenX - c.x, screenY - c.y, { steps: 2 });
}

test('tear-off: outside the window a ghost of the pop-out follows the pointer; released there, the window opens in its place', async () => {
  const { app, win, home } = await launch();
  try {
    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    const area = await smallMain(app);
    // Alfa on screen: the ghost shows a snapshot of its view.
    await win.locator('.tab', { hasText: 'Alfa' }).click();
    await pressAndLift(app, win, 'Alfa');
    // Still over the window: a reorder never makes a ghost.
    await pointAt(app, win, area.x + 500, area.y + 60);
    await stays(async () => (await ghosts(app)).length, 0, 300);

    // Out of the window: one ghost, shown, where the pop-out will open (the pointer on its grip), following it.
    const out = { x: area.x + 960 + 260, y: area.y + 140 };
    await pointAt(app, win, out.x, out.y);
    await expect.poll(async () => (await ghosts(app)).map((g) => g.opacity)).toEqual([1]);
    // Its page may still be loading when it shows (transparent until then).
    await expect.poll(async () => (await ghosts(app))[0]?.url.endsWith('/ghost.html')).toBe(true);
    const g1 = (await ghosts(app))[0]!;
    expect([g1.bounds.x, g1.bounds.y]).toEqual([out.x - 101, out.y - 22]);
    await expect(win.locator('.tab-drag-chip.is-out')).toHaveCount(1);
    await pointAt(app, win, out.x + 40, out.y + 30);
    await expect.poll(async () => (await ghosts(app))[0]?.bounds.x).toBe(out.x + 40 - 101);
    // Filled with the tab (its title; its view's snapshot, the session being on screen): looked at, not compared.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((b) => !b.isFocusable())!
      .webContents.executeJavaScript("document.querySelector('.ghost-title')?.textContent + '|' + document.querySelector('.ghost-body')?.classList.contains('has-shot')"))).toBe('Alfa|true');
    if (shotsOn()) {
      const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find((b) => !b.isFocusable())!.webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(join(SHOTS, 'tearoff-ghost.png'), Buffer.from(shot, 'base64'));
    }

    // Back over the window: it fades away (still the one ghost), the chip and the drop zones are back (over its own
    // pane's right edge: a new pane; its middle has none, it is already there).
    const body = (await win.locator('.workspace-body').boundingBox())!;
    await pointAt(app, win, area.x + body.x + body.width - 20, area.y + body.y + body.height / 2);
    await expect.poll(async () => (await ghosts(app)).map((g) => g.opacity)).toEqual([0]);
    await expect(win.locator('.pane-drop')).toBeVisible();
    await expect(win.locator('.pane-drop')).toHaveAttribute('data-zone', 'right');
    await look(win, join(SHOTS, 'tearoff-inside.png'));
    // Out again and released: the pop-out opens exactly where the ghost was, and the ghost goes.
    await pointAt(app, win, out.x, out.y);
    await expect.poll(async () => (await ghosts(app)).map((g) => g.opacity)).toEqual([1]);
    const at = (await ghosts(app))[0]!.bounds;
    await win.mouse.up();
    await expect.poll(() => windowCounts(app)).toEqual({ main: 1, popout: 1 });
    expect(await boundsOf(app, 'popout')).toEqual(at);
    await expect.poll(async () => (await ghosts(app)).length).toBe(0);
    await expect(win.locator('.tab', { hasText: 'Alfa' })).toHaveCount(0);
    await expect(win.locator('.tab-drag-chip')).toHaveCount(0);
    const pop = app.windows().find((p) => p !== win && !p.url().endsWith('/ghost.html'))!;
    await expect(pop.locator('.popout-bar')).toContainText('Alfa', { timeout: 15000 });
  } finally {
    await stop(app, home);
  }
});

test('tear-off: a fast flick out (the first move it sees is outside, reported with no button) still tears the tab off', async () => {
  const { app, win, home } = await launch();
  try {
    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    const area = await smallMain(app);
    const box = (await win.locator('.tab', { hasText: 'Alfa' }).boundingBox())!;
    const c = await contentOf(app);
    await setCursor(app, c.x + box.x + box.width / 2, c.y + box.y + box.height / 2);
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    // The flick: macOS may report the first move out of the window, before the pointer is captured, with no button.
    const out = { x: area.x + 960 + 260, y: area.y + 140 };
    await setCursor(app, out.x, out.y);
    await win.evaluate(({ x, y, sx, sy }) => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, screenX: sx, screenY: sy, buttons: 0, bubbles: true }));
    }, { x: out.x - c.x, y: out.y - c.y, sx: out.x, sy: out.y });
    await win.mouse.move(out.x - c.x, out.y - c.y, { steps: 1 });
    await win.mouse.up();
    await expect.poll(() => windowCounts(app)).toEqual({ main: 1, popout: 1 });
    await expect.poll(async () => (await ghosts(app)).length).toBe(0);
  } finally {
    await stop(app, home);
  }
});

test('tear-off: Esc or a release over the sidebar leaves the tab and the ghost goes; a press that never moved is a click', async () => {
  const { app, win, home } = await launch();
  try {
    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    const area = await smallMain(app);
    const order = () => win.locator('.tab .tab-name').allTextContents();

    // Out, then Esc: the ghost goes, nothing moves, the next click is a plain click.
    await pressAndLift(app, win, 'Alfa');
    await pointAt(app, win, area.x + 960 + 260, area.y + 140);
    await expect.poll(async () => (await ghosts(app)).length).toBe(1);
    await win.keyboard.press('Escape');
    await expect.poll(async () => (await ghosts(app)).length).toBe(0);
    await win.mouse.up();
    await stays(() => windowCounts(app), { main: 1, popout: 0 }, 400);
    expect(await order()).toEqual(['Alfa', 'Beta']);
    await expect(win.locator('.tab-drag-chip')).toHaveCount(0);

    // Out, back, released over the sidebar: nothing changes, no ghost left.
    await pressAndLift(app, win, 'Alfa');
    await pointAt(app, win, area.x + 960 + 260, area.y + 140);
    await expect.poll(async () => (await ghosts(app)).length).toBe(1);
    await pointAt(app, win, area.x + 100, area.y + 300);
    await win.mouse.up();
    await expect.poll(async () => (await ghosts(app)).length).toBe(0);
    await stays(async () => [await windowCounts(app), await order()], [{ main: 1, popout: 0 }, ['Alfa', 'Beta']], 400);

    // A press and release without moving: the tab is activated, no drag, no ghost.
    await win.locator('.tab', { hasText: 'Alfa' }).click();
    await expect(win.locator('.tab.is-active')).toContainText('Alfa');
    expect(await ghosts(app)).toEqual([]);
    // Released on the strip before Alfa: Beta moves there, and the click it ends with doesn't activate Alfa.
    await pressAndLift(app, win, 'Beta');
    const alfa = (await win.locator('.tab', { hasText: 'Alfa' }).boundingBox())!;
    await win.mouse.move(alfa.x + 6, alfa.y + alfa.height / 2, { steps: 3 });
    await expect(win.locator('.tab.is-drop')).toContainText('Alfa');
    await win.mouse.up();
    await expect.poll(order).toEqual(['Beta', 'Alfa']);
  } finally {
    await stop(app, home);
  }
});

test('tear-off: a tab gone while pressed starts no drag; a page reloading mid-drag leaves no ghost', async () => {
  const { app, win, home } = await launch();
  try {
    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    const area = await smallMain(app);
    // Pressed on Beta (in front), closed from the menu before the pointer moved: then moving and leaving does nothing.
    const box = (await win.locator('.tab', { hasText: 'Beta' }).boundingBox())!;
    const c = await contentOf(app);
    await setCursor(app, c.x + box.x + box.width / 2, c.y + box.y + box.height / 2);
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await menu(app, 'Close Tab');
    await expect(win.locator('.tab', { hasText: 'Beta' })).toHaveCount(0);
    await win.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 3 });
    await pointAt(app, win, area.x + 960 + 260, area.y + 140);
    await stays(async () => [(await ghosts(app)).length, await win.locator('.tab-drag-chip').count(), await win.evaluate(() => document.documentElement.classList.contains('is-tab-dragging'))], [0, 0, false], 400);
    await win.mouse.up();

    // A drag out, then the page reloads: the ghost goes with it.
    await pressAndLift(app, win, 'Alfa');
    await pointAt(app, win, area.x + 960 + 260, area.y + 140);
    await expect.poll(async () => (await ghosts(app)).length).toBe(1);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((b) => b.isFocusable())!.webContents.reload(); });
    await expect.poll(async () => (await ghosts(app)).length).toBe(0);
    await win.mouse.up();
    // Quitting while the page is still loading can hang Playwright's close (with or without a drag): it comes back first.
    await expect(win.locator('.header')).toBeVisible();
  } finally {
    await stop(app, home);
  }
});

test('drag back: the handle dragged over the main strip shows the caret, released docks there; Esc puts the window back', async () => {
  const { app, win, home } = await launch();
  try {
    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    await newSession(win, 'Gamma');
    expect(await win.locator('.tab .tab-name').allTextContents()).toEqual(['Alfa', 'Beta', 'Gamma']);
    const pop = await popOutFromTab(app, win, 'Gamma');
    await expect(win.locator('.tab', { hasText: 'Gamma' })).toHaveCount(0);
    const content = await contentOf(app);
    const handle = (await pop.locator('.popout-handle').boundingBox())!;
    const hx = handle.x + handle.width / 2;
    const hy = handle.y + handle.height / 2;

    // Esc during a drag: the window goes back where it started, nothing docks.
    const start = await boundsOf(app, 'popout');
    await setCursor(app, start.x + hx, start.y + hy);
    await pop.mouse.move(hx, hy);
    await pop.mouse.down();
    await setCursor(app, start.x + hx + 150, start.y + hy + 90);
    await expect.poll(async () => (await boundsOf(app, 'popout')).x).toBe(start.x + 150);
    await pop.keyboard.press('Escape');
    await expect.poll(() => boundsOf(app, 'popout')).toEqual(start);
    await pop.mouse.up();
    await expect(pop.locator('.popout-handle')).not.toHaveClass(/is-dragging/);
    await stays(async () => [await windowCounts(app), await boundsOf(app, 'popout')], [{ main: 1, popout: 1 }, start], 400);

    // Dragged over Alfa's left half in the main strip: the caret on Alfa (it would land before it); the window fades.
    const alfa = (await win.locator('.tab', { hasText: 'Alfa' }).boundingBox())!;
    await setCursor(app, start.x + hx, start.y + hy);
    await pop.mouse.move(hx, hy);
    await pop.mouse.down();
    await expect(pop.locator('.popout-handle')).toHaveClass(/is-dragging/);
    await setCursor(app, content.x + Math.round(alfa.x + 8), content.y + Math.round(alfa.y + alfa.height / 2));
    await expect(win.locator('.tab.is-drop')).toHaveCount(1);
    await expect(win.locator('.tab.is-drop')).toContainText('Alfa');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getMinimumSize()[0] === 480)!.getOpacity())).toBeCloseTo(0.55, 2);
    await still(win);
    await look(win, `${SHOTS}/popout-dock-strip.png`);

    // Over the workspace: the pane zones of a tab drag.
    const body = (await win.locator('.workspace-body').boundingBox())!;
    await setCursor(app, content.x + Math.round(body.x + body.width - 40), content.y + Math.round(body.y + body.height / 2));
    await expect(win.locator('.tab.is-drop')).toHaveCount(0);
    await expect(win.locator('.pane-drop')).toBeVisible();
    await look(win, `${SHOTS}/popout-dock-pane.png`);

    // Over "+" and the empty tab bar after it: the end of the strip, the caret on "+".
    const plus = (await win.locator('.tab-new').boundingBox())!;
    await setCursor(app, content.x + Math.round(plus.x + plus.width / 2), content.y + Math.round(plus.y + plus.height / 2));
    await expect(win.locator('.tab-new.is-drop')).toHaveCount(1);
    await expect(win.locator('.tab.is-drop')).toHaveCount(0);
    await setCursor(app, content.x + Math.round(plus.x + plus.width + 60), content.y + Math.round(plus.y + plus.height / 2));
    await expect(win.locator('.tab-new.is-drop')).toHaveCount(1);

    // Back over Alfa's left half and released: Gamma lands before Alfa, in front; the window is gone.
    await setCursor(app, content.x + Math.round(alfa.x + 8), content.y + Math.round(alfa.y + alfa.height / 2));
    await expect(win.locator('.tab.is-drop')).toContainText('Alfa');
    await Promise.all([pop.waitForEvent('close'), (async () => { await pop.mouse.move(hx + 30, hy + 10); await pop.mouse.up(); })()]);
    await expect(win.locator('.tab.is-active')).toContainText('Gamma');
    expect(await win.locator('.tab .tab-name').allTextContents()).toEqual(['Gamma', 'Alfa', 'Beta']);
    await expect(win.locator('.tab.is-drop')).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('an unsaved file moves with its tab: text, dirty dot, cursor and undo; back again with no dialog', async () => {
  // Cancel to any unsaved-files dialog: a dialog would keep the pop-out open, so its closing proves there was none.
  const project = makeProject();
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CURSOR: '1', ATELIER_TEST_UNSAVED_ANSWER: 'cancel' });
  const { app, win } = await launch({ project, env, home });
  try {
    await openFile(win, 'src', 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('XYZ');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(1);

    const pop = await popOutFromTab(app, win, 'a.ts');
    const editor = pop.locator('.file-view .cm-content');
    await expect(editor).toContainText('XYZ');
    await expect(pop.locator('.popout-bar .tab-dirty')).toHaveCount(1);
    await expect(pop.locator('.popout-bar')).toContainText('a.ts');
    // The main window has nothing unsaved for it any more.
    await expect(win.locator('.tab', { hasText: 'a.ts' })).toHaveCount(0);
    await expect(pop.locator('.file-foot')).toContainText('Ln 2, Col 4');
    await still(pop);
    await look(pop, `${SHOTS}/popout-file.png`);

    // The caret is where it was (typing goes on there), and undo reaches back past the move.
    await pop.keyboard.type('W');
    await expect(editor).toContainText('XYZW');
    await pop.keyboard.press('Meta+z');
    await expect(editor).not.toContainText('XYZW');
    await expect(editor).toContainText('XYZ');
    // The edit made in the main window is undone here: the history came along.
    await pop.keyboard.press('Meta+z');
    await expect(editor).not.toContainText('XYZ');
    await expect(pop.locator('.popout-bar .tab-dirty')).toHaveCount(0);
    await pop.keyboard.type('QQ');
    await expect(pop.locator('.popout-bar .tab-dirty')).toHaveCount(1);

    // Move Back: the text comes back with its dot; no dialog (the window closes although the answer is Cancel).
    await Promise.all([pop.waitForEvent('close'), pop.locator('.popout-bar').getByRole('button', { name: 'Move Back' }).click()]);
    await expect(win.locator('.tab.is-active')).toContainText('a.ts');
    await expect(win.locator('.tab.is-active .tab-dirty')).toHaveCount(1);
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('QQ');
    expect(await windowCounts(app)).toEqual({ main: 1, popout: 0 });
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    // Its undo history came back too.
    await win.locator('.file-view:visible .cm-content').focus();
    await win.keyboard.press('Meta+z');
    await expect(win.locator('.file-view:visible .cm-content')).not.toContainText('QQ');
  } finally {
    await stop(app, home);
  }
});

test('a dirty file whose tab is in Diff mode pops out in the margin view with its text; a deleted file\'s buffer moves with the deleted band', async () => {
  const { app, win, home, project } = await launch();
  try {
    await expect(win.locator('.changes .change-row', { hasText: 'rate.ts' })).toBeVisible({ timeout: 10000 });
    await openFile(win, 'src', 'rate.ts');
    await win.locator('.file-view:visible .cm-line', { hasText: 'const r9 = 90;' }).click();
    await win.keyboard.press('End');
    await win.keyboard.type(' // mine');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(1);
    // Opened again from Changes: the tab asks for the Diff view (shown in the margin while unsaved).
    await win.locator('.changes .change-row', { hasText: 'rate.ts' }).click();
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('// mine');
    const pop = await popOutFromTab(app, win, 'rate.ts');
    await expect(pop.locator('.file-view .cm-content')).toContainText('const r9 = 90; // mine');
    await expect(pop.locator('.file-view .cm-diff-add')).toHaveCount(0);
    await expect(pop.locator('.popout-bar .tab-dirty')).toHaveCount(1);
    // The editor is editable (margin view): typing goes into the buffer.
    await pop.keyboard.type('!');
    await expect(pop.locator('.file-view .cm-content')).toContainText('// mine!');
    await Promise.all([pop.waitForEvent('close'), pop.locator('.popout-bar').getByRole('button', { name: 'Move Back' }).click()]);
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('// mine!');
    await expect(win.locator('.tab.is-active .tab-dirty')).toHaveCount(1);
    // Undone back to the disk's text: the tab's Diff view shows (its mode went there and back).
    await win.locator('.file-view:visible .cm-content').focus();
    await expect(async () => {
      await win.keyboard.press('Meta+z');
      await expect(win.locator('.tab.is-active .tab-dirty')).toHaveCount(0, { timeout: 300 });
    }).toPass({ timeout: 5000 });
    await expect(win.locator('.file-view:visible .cm-diff-add').first()).toBeVisible();

    // A file deleted on disk with unsaved edits: the buffer moves, the deleted band shows in the pop-out.
    await openFile(win, 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('// kept');
    unlinkSync(join(project, 'src', 'a.ts'));
    await expect(win.locator('.file-view:visible .conflict-band.is-gone')).toBeVisible({ timeout: 10000 });
    const gone = await popOutFromTab(app, win, 'a.ts');
    await expect(gone.locator('.file-view .cm-content')).toContainText('// kept');
    await expect(gone.locator('.conflict-band.is-gone')).toBeVisible({ timeout: 10000 });
    await expect(gone.locator('.popout-bar .tab-dirty')).toHaveCount(1);
    await still(gone);
    await look(gone, `${SHOTS}/popout-file-deleted.png`);
  } finally {
    await stop(app, home);
  }
});

test('relaunch: a popped-out session comes back in its window at the same place and size', async () => {
  const project = makeProject();
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CURSOR: '1' });
  let { app, win } = await launch({ project, env, home });
  try {
    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    await popOutFromTab(app, win, 'Alfa');
    // Moved and resized (a hidden window gets no 'moved' from macOS, the resize saves the bounds; a unit test covers
    // 'moved').
    const moved = { x: 140, y: 160, width: 620, height: 420 };
    await app.evaluate(({ BrowserWindow }, b) => { BrowserWindow.getAllWindows().find((w) => w.getMinimumSize()[0] === 480)!.setBounds(b); }, moved);
    const before = await boundsOf(app, 'popout');
    // Saved after the move settles (debounced).
    await expect.poll(() => JSON.parse(readFileSync(join(home, 'ui-state.json'), 'utf8')).popouts?.[0]?.bounds).toEqual(before);
    await app.close();

    app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
    await app.firstWindow();
    await expect.poll(async () => (await windowCounts(app)).popout, { timeout: 20000 }).toBe(1);
    const after = await boundsOf(app, 'popout');
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(2);
    // The pages: the pop-out shows Alfa in its bar; the main window has the sidebar.
    const pageWith = async (sel: string) => {
      let found: Page | undefined;
      await expect.poll(async () => {
        for (const p of app.windows()) if (await p.locator(sel).count().catch(() => 0)) { found = p; return true; }
        return false;
      }, { timeout: 15000 }).toBe(true);
      return found!;
    };
    const pop = await pageWith('.popout-bar');
    await expect(pop.locator('.popout-bar')).toContainText('Alfa');
    win = await pageWith('.sidebar');
    await expect(win.locator('.session-row', { hasText: 'Alfa' }).locator('.row-popout')).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.tab', { hasText: 'Beta' })).toHaveCount(1);
    await expect(win.locator('.tab', { hasText: 'Alfa' })).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('Save As of an untitled buffer in its pop-out: the window shows the file; Move Back docks that file', async () => {
  const { app, win, home, project } = await launch();
  try {
    await menu(app, 'New File');
    await expect(win.locator('.tab', { hasText: 'Untitled-1' })).toHaveClass(/is-active/);
    // The editor takes the focus once mounted, after the tab: keys typed before it are lost.
    await expect(win.locator('.file-view:visible .cm-content')).toBeFocused();
    await win.keyboard.type('hello');
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('hello');
    const pop = await popOutFromTab(app, win, 'Untitled-1');
    await expect(pop.locator('.file-view .cm-content')).toContainText('hello');
    // At the pop-out's narrowest (480 px) the sheet fits the window, its pinned Save Outside the Project… row whole
    //.
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getMinimumSize()[0] === 480)!; w.setBounds({ ...w.getBounds(), width: 480 }); });
    await expect.poll(() => pop.evaluate(() => window.innerWidth)).toBe(480);
    await menu(app, 'Save', 'popout');
    const input = pop.locator('.save-as-sheet input');
    await expect(input).toBeFocused();
    // Measured once its entrance (a scale) is over.
    await pop.locator('.save-as-sheet').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const sheetBox = (await pop.locator('.save-as-sheet').boundingBox())!;
    // A 16 px gutter on each side, as the other sheets at narrow widths.
    expect(sheetBox.x).toBeGreaterThanOrEqual(16);
    expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(480 - 16);
    const out = pop.locator('.save-as-outside');
    const outBox = (await out.boundingBox())!;
    expect(outBox.x + outBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width);
    expect(outBox.height).toBeLessThan(40);
    // The field's key hint stays on one line (the field gives way).
    expect((await pop.locator('.save-as-sheet .palette-search .popover-hint').boundingBox())!.height).toBeLessThan(22);
    expect(await out.locator('.palette-label').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await look(pop, 'test-results/save-as-outside-narrow.png', { settle: 300 });
    await input.fill('notes.md');
    await input.press('Enter');
    await expect.poll(() => { try { return readFileSync(join(project, 'notes.md'), 'utf8'); } catch { return null; } }).toBe('hello');
    // The window keeps showing it, now as the file.
    await expect(pop.locator('.popout-bar')).toContainText('notes.md');
    await expect(pop.locator('.file-view .cm-content')).toContainText('hello');
    await expect(win.locator('.tab', { hasText: 'Untitled-1' })).toHaveCount(0);
    // Back in the main window: the file's tab, with its text.
    await Promise.all([pop.waitForEvent('close'), pop.locator('.popout-bar').getByRole('button', { name: 'Move Back' }).click()]);
    await expect(win.locator('.tab.is-active')).toContainText('notes.md');
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('hello');
  } finally {
    await stop(app, home);
  }
});

test('an outside file popped out stays watched (a change on disk reloads it) and is readable again after a relaunch', async () => {
  const project = makeProject();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atl-pop-out-')));
  const notes = join(outside, 'notes.txt');
  writeFileSync(notes, 'first line\n');
  // The grace of a file just opened shortened from 3 s.
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CURSOR: '1', ATELIER_TEST_PICK_FILES: notes, ATELIER_TEST_OUTSIDE_GRACE_MS: '300' });
  let { app, win } = await launch({ project, env, home });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((b) => b.getMinimumSize()[0] !== 480)!.webContents.send('ev:command', 'open-file'));
    await expect(win.locator('.tab', { hasText: 'notes.txt' })).toBeVisible({ timeout: 10000 });
    // Past the grace of a file just opened: from now on only the tabs reports keep it watched.
    await win.waitForTimeout(500);
    const pop = await popOutFromTab(app, win, 'notes.txt');
    await expect(pop.locator('.file-view .cm-content')).toContainText('first line');
    // The main window reports its tabs again (debounced), without the file: the pop-out's count all the same.
    await openFile(win, 'src', 'a.ts');
    // That report saved the main window's tabs too (the same message): a.ts in, notes.txt out.
    const mainFiles = () => { try { return Object.values((JSON.parse(readFileSync(join(home, 'tabs.json'), 'utf8')) as { projects: Record<string, { tabs: { files: string[] } }> }).projects).flatMap((e) => e.tabs.files); } catch { return []; } };
    await expect.poll(mainFiles).toEqual([expect.stringMatching(/\/src\/a\.ts$/)]);
    writeFileSync(notes, 'changed by another editor\n');
    await expect(pop.locator('.file-view .cm-content')).toContainText('changed by another editor', { timeout: 10000 });

    // Remembered (it was granted), and after a relaunch its window reads it again (grants live in memory only).
    await expect.poll(() => (JSON.parse(readFileSync(join(home, 'ui-state.json'), 'utf8')) as { popouts?: { key: string }[] }).popouts?.map((p) => p.key)).toContain(`f:${notes}`);
    await app.close();
    app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
    await app.firstWindow();
    let again: Page | undefined;
    await expect.poll(async () => {
      for (const p of app.windows()) if (await p.locator('.popout-bar').count().catch(() => 0)) { again = p; return true; }
      return false;
    }, { timeout: 20000 }).toBe(true);
    await expect(again!.locator('.file-view .cm-content')).toContainText('changed by another editor', { timeout: 15000 });
  } finally {
    await stop(app, home);
  }
});

test('a comment written in a popped-out file shows in the main window\'s review', async () => {
  const { app, win, home } = await launch();
  try {
    await expect(win.locator('.changes .change-row', { hasText: 'rate.ts' })).toBeVisible({ timeout: 10000 });
    await openFile(win, 'src', 'rate.ts');
    const pop = await popOutFromTab(app, win, 'rate.ts');
    // The main window's review of all changes, open meanwhile.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>review all');
    await win.keyboard.press('Enter');
    const review = win.locator('.review-view');
    await expect(review.locator('.cm-line', { hasText: 'const r4 = 4000;' })).toBeVisible({ timeout: 10000 });
    await expect(review.locator('.lc-card')).toHaveCount(0);

    // In the pop-out: lines 3–4 selected, Comment on Selection (a command of the tab: it stays there).
    const editor = pop.locator('.file-view');
    await editor.locator('.cm-line', { hasText: 'const r3 = 30;' }).click();
    await editor.locator('.cm-line', { hasText: 'const r4 = 4000;' }).click({ modifiers: ['Shift'] });
    await menu(app, 'Comment on Selection', 'popout');
    const box = editor.locator('.lc-box');
    await expect(box).toBeVisible();
    await pop.keyboard.type('Seconds, please');
    await pop.keyboard.press('Meta+Enter');
    await expect(editor.locator('.lc-card')).toContainText('Seconds, please');

    // The main window got it through storage: the card in its review.
    await expect(review.locator('.lc-card')).toContainText('Seconds, please', { timeout: 10000 });
  } finally {
    await stop(app, home);
  }
});

test('closing the project window with an unsaved pop-out: Cancel keeps both windows; Don\'t Save closes both', async () => {
  const project = makeProject();
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CURSOR: '1', ATELIER_TEST_UNSAVED_ANSWER: 'cancel' });
  const { app, win } = await launch({ project, env, home });
  try {
    // A session popped out too: nothing unsaved, its window closes at once with the project's.
    await newSession(win, 'Alfa');
    const session = await popOutFromTab(app, win, 'Alfa');
    await openFile(win, 'src', 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('XYZ');
    const pop = await popOutFromTab(app, win, 'a.ts');
    await expect(pop.locator('.popout-bar .tab-dirty')).toHaveCount(1);

    // The project window closes: its pop-outs close first, the file's asks, Cancel → the project stays open, and so
    // does the file's pop-out; the session's window, already closed, comes back.
    const back = app.waitForEvent('window');
    await Promise.all([session.waitForEvent('close'), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getMinimumSize()[0] !== 480)!.close())]);
    const again = await back;
    await expect(again.locator('.popout-bar')).toContainText('Alfa', { timeout: 15000 });
    await expect.poll(() => windowCounts(app)).toEqual({ main: 1, popout: 2 });
    await expect(pop.locator('.file-view .cm-content')).toContainText('XYZ');
    await expect(win.locator('.header')).toBeVisible();
    await expect(win.locator('.tab', { hasText: 'a.ts' })).toHaveCount(0);
    await expect(win.locator('.tab', { hasText: 'Alfa' })).toHaveCount(0);
    await win.getByRole('button', { name: /^Sessions/ }).click();
    await expect(win.locator('.session-row', { hasText: 'Alfa' }).locator('.row-popout')).toBeVisible();

    // Later, Don't Save: both windows close.
    await app.evaluate(() => { process.env.ATELIER_TEST_UNSAVED_ANSWER = 'discard'; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getMinimumSize()[0] !== 480)!.close());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 10000 }).toBe(0);
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  } finally {
    await stop(app, home);
  }
});

test('closing the project window, its own unsaved file answered Cancel: the pop-out closed first comes back', async () => {
  const project = makeProject();
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CURSOR: '1', ATELIER_TEST_UNSAVED_ANSWER: 'cancel' });
  const { app, win } = await launch({ project, env, home });
  try {
    await newSession(win, 'Alfa');
    const session = await popOutFromTab(app, win, 'Alfa');
    // The unsaved file is the main window's own.
    await openFile(win, 'src', 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('XYZ');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(1);

    // The pop-out closes first (nothing unsaved), then the main window asks: Cancel → the project stays open and the
    // session's window comes back.
    const back = app.waitForEvent('window');
    await Promise.all([session.waitForEvent('close'), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getMinimumSize()[0] !== 480)!.close())]);
    const again = await back;
    await expect(again.locator('.popout-bar')).toContainText('Alfa', { timeout: 15000 });
    await expect.poll(() => windowCounts(app)).toEqual({ main: 1, popout: 1 });
    await expect(win.locator('.tab', { hasText: 'Alfa' })).toHaveCount(0);
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('XYZ');
  } finally {
    await stop(app, home);
  }
});

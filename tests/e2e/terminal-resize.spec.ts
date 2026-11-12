import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// A pane dragged wider or narrower changes the terminal's width every frame. On the normal buffer a program can't
// redraw what has scrolled into the scrollback: each width it is told leaves its output wrapped at that width there
// (Claude Code's classic renderer, resized while it writes, stacked one copy of the same lines per width). So the
// program gets only the size the pane settles at; a full-screen program (alternate buffer) redraws its whole screen
// and follows the drag live.

type Resize = { id: string; cols: number; rows: number };

async function launch(): Promise<{ app: ElectronApplication; win: Page; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('›', { timeout: 15000 });
  // Every size the window asks atelierd for, as main receives them.
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { ptyResizes: Resize[] };
    g.ptyResizes = [];
    ipcMain.on('term:resize', (_e, a: Resize) => { g.ptyResizes.push(a); });
  });
  return { app, win, home };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const sent = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { ptyResizes: Resize[] }).ptyResizes.map((r) => r.cols));
const forget = (app: ElectronApplication) => app.evaluate(() => { (globalThis as unknown as { ptyResizes: Resize[] }).ptyResizes = []; });

/** The view's columns, as the footer shows them ("120×42"). */
async function viewCols(win: Page): Promise<number> {
  const m = /(\d+)×(\d+)/.exec(await win.locator('.foot-dim', { hasText: '×' }).innerText());
  return m ? Number(m[1]) : 0;
}

/** A divider dragged: the terminal's pane changes by 8 px a frame, 24 frames (to `from + 24 × step` px of room). */
async function drag(win: Page, from: number, step: number): Promise<void> {
  await win.locator('.terminal-slot:visible').evaluate(async (el: HTMLElement, o) => {
    for (let i = 1; i <= 24; i++) {
      el.style.right = `${o.from + i * o.step}px`;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  }, { from, step });
}

/** `stty size` in the terminal: the columns its program was told. */
async function ptyCols(win: Page, n: number): Promise<number> {
  await win.locator('.terminal-slot:visible .xterm-helper-textarea').focus();
  await win.keyboard.type(`echo SZ${n}-$(stty size | cut -d' ' -f2)-END`);
  await win.keyboard.press('Enter');
  const re = new RegExp(`SZ${n}-(\\d+)-END`);
  await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText(re, { timeout: 5000 });
  return Number(re.exec(await win.locator('.terminal-slot:visible .xterm-rows').innerText())![1]);
}

test('a drag on the normal buffer tells the program only the settled width; a full-screen program follows it live', async () => {
  const { app, win, home } = await launch();
  try {
    await expect.poll(() => viewCols(win)).toBeGreaterThan(60);
    const start = await viewCols(win);
    await forget(app);

    // The shell's prompt: the normal buffer. The view follows every frame, the PTY gets the end of the drag.
    await drag(win, 0, 8);
    await expect.poll(() => viewCols(win)).toBeLessThan(start - 15);
    const narrow = await viewCols(win);
    await expect.poll(async () => (await sent(app)).at(-1)).toBe(narrow);
    // One size, or two if a frame came late: never one per frame (it was ~24).
    expect((await sent(app)).length).toBeLessThan(3);
    expect(await ptyCols(win, 1)).toBe(narrow);
    await look(win.locator('.terminal-slot:visible'), 'test-results/terminal-resize/normal-buffer.png');

    // A full-screen program: every width reaches it during the drag.
    await win.keyboard.type(`printf '\\e[?1049hALT-SCREEN'; read`);
    await win.keyboard.press('Enter');
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('ALT-SCREEN', { timeout: 5000 });
    await forget(app);
    await drag(win, 24 * 8, -8);
    await expect.poll(() => viewCols(win)).toBe(start);
    await expect.poll(async () => (await sent(app)).at(-1)).toBe(start);
    expect((await sent(app)).length).toBeGreaterThan(10);
    await win.keyboard.press('Enter');
  } finally {
    await stop(app, home);
  }
});

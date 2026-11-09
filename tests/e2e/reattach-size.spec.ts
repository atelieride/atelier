import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Reopening the app reattaches to terminals still alive in atelierd: their PTY must take the size fitted in the new
// window, or full-screen programs (Claude Code) keep drawing at the old size until the window is resized by hand.

/** The view's size, as the footer shows it ("120×42"). */
async function viewSize(win: Page): Promise<string> {
  const text = await win.locator('.foot-dim', { hasText: '×' }).innerText();
  const m = /(\d+)×(\d+)/.exec(text);
  return m ? `${m[2]} ${m[1]}` : '';
}

/** `stty size` in the visible terminal ("rows cols"), told apart from earlier runs with a marker. */
async function ptySize(win: Page, n: number): Promise<string> {
  await win.locator('.terminal-slot:visible .xterm-helper-textarea').focus();
  await win.keyboard.type(`echo SZ${n}-$(stty size | tr ' ' x)-END`);
  await win.keyboard.press('Enter');
  const re = new RegExp(`SZ${n}-(\\d+)x(\\d+)-END`);
  await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText(re, { timeout: 5000 });
  const m = re.exec(await win.locator('.terminal-slot:visible .xterm-rows').innerText());
  return `${m![1]} ${m![2]}`;
}

const setWindowSize = (app: Awaited<ReturnType<typeof electron.launch>>, w: number, h: number) =>
  app.evaluate(({ BrowserWindow }, [w, h]) => { BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!); }, [w, h]);

/** A small window: the view's new size once it is fitted. */
async function shrink(app: Awaited<ReturnType<typeof electron.launch>>, win: Page): Promise<string> {
  await expect.poll(() => viewSize(win)).not.toBe('');
  const before = await viewSize(win);
  await setWindowSize(app, 900, 560);
  await expect.poll(() => viewSize(win)).not.toBe(before);
  return viewSize(win);
}

// The incident of 2026-10-11: a Claude session behind another tab at reopen had its screen written into an xterm
// never fitted (80×24 by default), so it showed cut and shifted (status line gone) until the window was resized; the
// PTY already had the window's size, so no SIGWINCH came to redraw it. Here a full-screen-like drawing stands in for
// Claude Code: a long line on row 3 and a status line on the last row, then `read` keeps it as it is.
test('a terminal behind another tab on reopen shows its screen at the fitted size', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const { env, home } = e2eEnv();
  let app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    let win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 15000 });
    await expect.poll(() => viewSize(win)).not.toBe('');
    const size = await viewSize(win);
    await expect.poll(() => ptySize(win, 1), { timeout: 5000 }).toBe(size);
    await win.keyboard.type(`clear; L=$(stty size | cut -d' ' -f1); printf '\\e[3;1H%s' "$(printf 'W%.0s' {1..110})"; printf "\\e[$L;1H%s" "STATUS-LINE-$((1+1))"; printf '\\e[1;1H'; read`);
    await win.keyboard.press('Enter');
    const rows = win.locator('.terminal-slot:visible .xterm-rows > div');
    await expect(rows.last()).toHaveText(/STATUS-LINE-2/, { timeout: 5000 });
    const before = (await rows.allInnerTexts()).map((l) => l.trimEnd());
    expect(before[2]).toBe('W'.repeat(110));
    // A second terminal: the one in front at reopen.
    await win.evaluate(() => (window as unknown as { atelier: { terminals: { create(o: object): Promise<unknown> } } }).atelier.terminals.create({ cols: 80, rows: 24 }));
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 10000 });
    await app.close();

    // Same window size: the PTY keeps its size, nothing makes the program redraw.
    app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
    win = await app.firstWindow();
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 15000 });
    await expect.poll(() => viewSize(win)).not.toBe('');
    await win.waitForTimeout(500);
    await win.locator('.term-row').first().click();
    const shown = win.locator('.terminal-slot:visible .xterm-rows > div');
    await expect.poll(async () => (await shown.allInnerTexts()).map((l) => l.trimEnd()), { timeout: 5000 }).toEqual(before);
    await look(win.locator('.terminal-slot:visible'), 'test-results/reattach-hidden.png');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('reopening the app at another window size: the terminal in front is resized to the fitted size, the one behind another tab once shown', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const { env, home } = e2eEnv();
  let app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    let win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 15000 });
    const small = await shrink(app, win);
    await expect.poll(() => ptySize(win, 1), { timeout: 5000 }).toBe(small);
    // A second terminal, in front at reopen (the last one is selected).
    await win.evaluate(() => (window as unknown as { atelier: { terminals: { create(o: object): Promise<unknown> } } }).atelier.terminals.create({ cols: 80, rows: 24 }));
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 10000 });
    await app.close();

    app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
    win = await app.firstWindow();
    await setWindowSize(app, 1500, 950);
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 15000 });
    // The terminal in front, reattached at another window size, takes the fitted size.
    await expect.poll(() => viewSize(win)).toMatch(/\d/);
    await expect.poll(() => viewSize(win)).not.toBe(small);
    expect(await ptySize(win, 3)).toBe(await viewSize(win));
    await win.locator('.term-row').first().click();
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('SZ1-', { timeout: 15000 });
    await expect.poll(() => viewSize(win)).not.toBe(small);
    const big = await viewSize(win);
    expect(await ptySize(win, 2)).toBe(big);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

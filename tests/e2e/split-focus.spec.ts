import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv, writePrefs } from './env';
import { look } from './shots';

// Split view: the keyboard follows the pane focus. A pane whose view has no keyboard
// target (Services) never lets typing reach the terminal that had it; a header click keeps the keyboard in its pane; a
// file dropped on a pane's terminal focuses that pane; the focused header says so to assistive tech (aria-current).

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

/** The screen text of the terminal shown in grid column `col` (1-based). */
const textOf = (win: Page, col: number) => win.evaluate((c) => [...document.querySelectorAll<HTMLElement>('.workspace-body > .terminal-slot')]
  .find((el) => el.style.display !== 'none' && Number(el.style.gridColumnStart || 1) === c)?.querySelector('.xterm-rows')?.textContent ?? '', col);

test('split view: typing never reaches a pane that is not focused; strip clicks and drops keep the keyboard in their pane', async () => {
  // Test-ONLY tmux server (a Services pane): socket in the run's temp root (tests/support/temp-root.ts), dedicated name.
  // Never the user's server. Not one folder deeper: tmux resolves it to /private/var/…/atl-run-XXXXXX/tmux-<uid>/<server>,
  // max 103 bytes.
  const tmuxDir = tmpdir();
  const server = `ae2e-focus-${process.pid}`;
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
  delete (tmuxEnv as Record<string, string | undefined>).TMUX;
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', server, ...a], { env: tmuxEnv });
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  mkdirSync(join(project, 'api'));
  writeFileSync(join(project, 'api', 'server.log'), 'Server listening on port 3998\n');
  writeFileSync(join(project, 'notes.md'), 'Notes\n');
  tmux('new-session', '-d', '-s', 'focus', '-x', '120', '-y', '30', '-c', join(project, 'api'), `tail -n +1 -f '${join(project, 'api', 'server.log')}'`);
  tmux('select-pane', '-t', 'focus:0.0', '-T', 'api');

  const { env, home } = e2eEnv({ TMUX_TMPDIR: tmuxDir, ATELIER_TMUX_SERVER: server, ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  writePrefs(home, { showServices: true });
  delete env.TMUX;
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const strip = (i: number) => win.locator(`.pane-strip[data-pane="${i}"]`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    // Terminal A, ready.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').first().focus();
    await win.keyboard.type('echo AL""PHAREADY\n');
    await expect.poll(() => win.locator('.terminal-slot:visible .xterm-rows').first().evaluate((el) => el.textContent ?? ''), { timeout: 15000 }).toContain('ALPHAREADY');

    // [A | Services]: Split Right, then the Services row fills the empty focused pane.
    await menu(app, 'Split Right');
    await expect(win.locator('.pane-picker')).toBeVisible();
    await win.getByRole('button', { name: 'Services (⌘⇧3)' }).click();
    await win.locator('.svc-row', { hasText: 'api' }).click({ timeout: 15000 });
    await expect(strip(1)).toHaveClass(/is-focused/);
    await expect(strip(1)).toContainText('Services');

    // Keyboard into A through the pane focus (⌘⌥←), then to Services (⌘⌥→): typing must not reach A.
    await menu(app, 'Focus Previous Pane');
    await expect(strip(0)).toHaveClass(/is-focused/);
    await win.keyboard.type('echo MA""RKA\n');
    await expect.poll(() => textOf(win, 1)).toContain('MARKA');
    await menu(app, 'Focus Next Pane');
    await expect(strip(1)).toHaveClass(/is-focused/);
    // minor 7: the focused pane's strip is the current one for assistive tech, the other isn't.
    await expect(strip(1)).toHaveAttribute('aria-current', 'true');
    await expect(strip(0)).not.toHaveAttribute('aria-current', /.*/);
    // Typing reaches nothing in A; the keyboard is in the Services view.
    await win.waitForTimeout(300);
    await win.keyboard.type('echo LE""AK\n');
    await win.waitForTimeout(600);
    expect(await textOf(win, 1)).not.toContain('LE""AK');
    expect(await textOf(win, 1)).not.toContain('LEAK');
    await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('.services-grid, .services-empty'))).toBe(true);
    // Looked at: Services focused (its tab crowned in its strip, no focus ring on the view), A's terminal unfocused.
    await look(win.locator('.workspace'), 'test-results/split-focus-services.png', { settle: 300 });

    // minor 6: a click on a blank part of A's strip focuses A and the keyboard goes to its terminal — also when A is
    // already the focused pane (the click must not take the keyboard away from it).
    const blank = async () => {
      const g = (await strip(0).locator('.grow').boundingBox())!;
      await win.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
    };
    await blank();
    await expect(strip(0)).toHaveClass(/is-focused/);
    await win.keyboard.type('echo HE""ADONE\n');
    await expect.poll(() => textOf(win, 1)).toContain('HEADONE');
    await blank();
    await win.keyboard.type('echo HE""ADTWO\n');
    await expect.poll(() => textOf(win, 1)).toContain('HEADTWO');

    // I-3 (b): [A | B] with B focused; a file dropped from the tree onto A's terminal focuses A, and typing goes on in A.
    await menu(app, 'Focus Next Pane');
    await menu(app, 'New Terminal');
    await expect(win.locator('.workspace-body > .terminal-slot:visible')).toHaveCount(2, { timeout: 10000 });
    await expect(strip(1)).toHaveClass(/is-focused/);
    await win.keyboard.type('echo BR""AVOREADY\n');
    await expect.poll(() => textOf(win, 2), { timeout: 15000 }).toContain('BRAVOREADY');
    await win.getByRole('button', { name: /Files/ }).click();
    const slotA = win.locator('.workspace-body > .terminal-slot:visible').filter({ hasText: 'ALPHAREADY' });
    await win.locator('.tree-row', { hasText: 'notes.md' }).dragTo(slotA);
    await expect.poll(() => textOf(win, 1), { timeout: 5000 }).toContain('notes.md');
    await expect(strip(0)).toHaveClass(/is-focused/);
    await win.keyboard.type('\u0015echo DR""OPPED\n');
    await expect.poll(() => textOf(win, 1)).toContain('DROPPED');
    expect(await textOf(win, 2)).not.toContain('DROPPED');
  } finally {
    await app.close();
    try { tmux('kill-server'); } catch { /* already stopped */ }
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

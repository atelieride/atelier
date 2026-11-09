import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// 2026-10-18: after the Mac slept (external display), every Claude session showed its box drawn over stale rows until
// the app restarted, while atelierd's screen was right. Here a view put out of step on purpose (output sent to the
// window only, never to atelierd) stands in for it: the screen comes back from atelierd on a wake, or by hand.

type Api = { terminals: { list(): Promise<{ id: string; title: string; foreground: string; session: unknown }[]> } };

/** Output that reaches the window's xterm only: its view no longer matches atelierd's screen. */
const stale = (app: ElectronApplication, id: string, text: string) =>
  app.evaluate(({ BrowserWindow }, [id, text]) => { BrowserWindow.getAllWindows()[0]!.webContents.send('ev:data', id, `\x1b[2J\x1b[H${text}`); }, [id, text]);
const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);
const wake = (app: ElectronApplication) => app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); });
const firstTerminal = async (win: Page) => (await win.evaluate(() => (window as unknown as { atelier: Api }).atelier.terminals.list()))[0]!;

async function open() {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  const rows = win.locator('.terminal-slot:visible .xterm-rows');
  await expect(rows).toContainText('›', { timeout: 15000 });
  return { app, win, home, rows, id: (await firstTerminal(win)).id };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

// One launch: Redraw Terminal by hand first, then a wake with a plain terminal and a Claude session both out of step.
test('Redraw Terminal shows the real screen again; waking the Mac: a Claude session gets its screen again from atelierd, a plain terminal keeps its view', async () => {
  const { app, win, home, rows, id } = await open();
  try {
    await win.keyboard.type('echo REAL-$((20+22))');
    await win.keyboard.press('Enter');
    await expect(rows).toContainText('REAL-42');
    // The view out of step hides its cursor too (the shell's is shown).
    await stale(app, id, 'STALE-VIEW\x1b[?25l');
    await expect(rows).toContainText('STALE-VIEW');
    await expect(rows).not.toContainText('REAL-42');
    await expect(rows.locator('.xterm-cursor')).toHaveCount(0);
    await command(app, 'redraw-terminal');
    await expect(rows).toContainText('REAL-42', { timeout: 5000 });
    await expect(rows).not.toContainText('STALE-VIEW');
    // atelierd's screen says the cursor is shown: xterm's reset() alone would keep the view's hidden cursor hidden.
    await expect(rows.locator('.xterm-cursor')).toHaveCount(1);
    // Typing still goes to the shell afterwards.
    await win.keyboard.type('echo AFTER-$((1+1))');
    await win.keyboard.press('Enter');
    await expect(rows).toContainText('AFTER-2');
    // Discoverable in the palette.
    await win.keyboard.press('F1');
    await win.keyboard.type('redraw');
    await expect(win.locator('.palette')).toContainText(/Redraw terminal/i);
    await win.keyboard.press('Escape');

    // A plain terminal, even running a command: left alone on a wake (a new screen would drop its command blocks).
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('echo PLAIN-$((3*3)); sleep 600');
    await win.keyboard.press('Enter');
    await expect(rows).toContainText('PLAIN-9');
    await expect.poll(async () => (await firstTerminal(win)).foreground, { timeout: 10000 }).toBe('sleep');
    await stale(app, id, 'PLAIN-VIEW');
    await expect(rows).toContainText('PLAIN-VIEW');
    // A Claude session next to it.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('Sleepy');
    await win.keyboard.press('Enter');
    const session = async () => (await win.evaluate(() => (window as unknown as { atelier: Api }).atelier.terminals.list())).find((t) => t.title === 'Sleepy' && t.session);
    await expect.poll(async () => !!(await session()), { timeout: 20000 }).toBe(true);
    const sid = (await session())!.id;
    await expect(rows).toContainText('FAKE-CLAUDE waiting', { timeout: 10000 });
    const real = (await rows.innerText()).trim();
    // Both views out of step, then one wake.
    await stale(app, sid, 'SESSION-VIEW');
    await expect(rows).toContainText('SESSION-VIEW');
    await wake(app);
    // The Claude session's screen comes back once the wake settles...
    await expect(rows).not.toContainText('SESSION-VIEW', { timeout: 5000 });
    expect((await rows.innerText()).trim()).toBe(real);
    await look(win.locator('.terminal-slot:visible'), 'test-results/screen-resync.png');
    // ...in the same pass that left the plain terminal alone: its view is still its own.
    await win.locator('.tab', { has: win.locator('.tab-term') }).click();
    await expect(rows).toContainText('PLAIN-VIEW');
    await expect(rows).not.toContainText('PLAIN-9');
  } finally { await stop(app, home); }
});

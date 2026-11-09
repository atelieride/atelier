import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';

// In-app confirms: quitting asks in the front window, never with a native dialog.
const shots = process.env.ATELIER_E2E_SHOTS;

test('a quit with a busy terminal asks in the window: Cancel keeps the app running, no native dialog', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  // The setting decides, not the e2e default that keeps everything running.
  const { env, home } = e2eEnv({ ATELIER_TEST_CLOSE_SESSIONS: '' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { nativeAsked: number };
      g.nativeAsked = 0;
      dialog.showMessageBox = (async () => { g.nativeAsked++; return { response: 2, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
    });
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();
    // The page listens (it says so once its listeners are in): only then main asks it.
    await expect.poll(() => win.evaluate(() => document.readyState)).toBe('complete');
    const id = await win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.create({ cols: 100, rows: 30 })).id);
    // Its pid comes a moment after create (the shell's launchd job reports it); typed once main lists it.
    const pidOf = () => win.evaluate(async (i) => (await (window as unknown as { atelier: AtelierApi }).atelier.terminals.list()).find((x) => x.id === i)?.pid ?? 0, id);
    await expect.poll(pidOf, { timeout: 10000 }).toBeGreaterThan(0);
    await win.evaluate((i) => (window as unknown as { atelier: AtelierApi }).atelier.terminals.input(i, 'sleep 40\r'), id);
    // Running in the foreground (its terminal's foreground group isn't the shell's), as main reads it.
    await expect.poll(async () => {
      const pid = await pidOf();
      if (!pid) return false;
      try { const [g, t] = execFileSync('/bin/ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number); return g !== t; } catch { return false; }
    }, { timeout: 10000 }).toBe(true);
    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); });
    const sheet = win.locator('.confirm-sheet');
    await expect(sheet).toContainText('Quit Atelier?');
    await expect(sheet).toContainText('sleep 40');
    await expect(sheet.getByRole('button', { name: 'Keep in Background' })).toBeFocused();
    if (shots) { await win.waitForTimeout(400); await win.screenshot({ path: join(shots, 'confirm-quit-sessions.png') }); }
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(win.locator('.header')).toBeVisible();
    expect(await app.evaluate(() => (globalThis as unknown as { nativeAsked: number }).nativeAsked)).toBe(0);

    // The git-write sheet as main sends it (its wiring is quitPrompt's, unit-tested): the running op, Wait focused. Main
    // never asked this one, so its broker would disown it (shown: false) and the page drop it: main is told it did.
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('ask:shown'); ipcMain.handle('ask:shown', () => true); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:ask', { id: 'look', request: { kind: 'quit-git', title: 'A push is running in api', detail: 'Wait lets it finish. Quit Anyway stops it, as Cancel would.', ops: [{ noun: 'push', repo: 'api' }] } }));
    await expect(sheet).toContainText('A push is running in api');
    await expect(sheet.getByRole('button', { name: 'Wait' })).toBeFocused();
    if (shots) { await win.waitForTimeout(400); await win.screenshot({ path: join(shots, 'confirm-quit-git.png') }); }
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  } finally {
    // The sleep still runs: a quit would ask again, so the app exits instead.
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

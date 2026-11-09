import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

// The new terminal is shown from the create reply: it must not wait for atelierd's list (debounced, ~100 ms later).
test('a new terminal mounts, attaches and shows its prompt before any terminal list reaches the window', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows').first()).toContainText('›', { timeout: 15000 });

    // From now on the lists stop at the main process (the main process itself still receives them).
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents;
      const g = globalThis as unknown as { heldLists: unknown[][]; releaseLists: () => void };
      const send = wc.send.bind(wc);
      g.heldLists = [];
      wc.send = (channel: string, ...args: unknown[]) => { if (channel === 'ev:terminals') g.heldLists.push(args); else send(channel, ...args); };
      g.releaseLists = () => { wc.send = send; for (const a of g.heldLists.splice(0)) send('ev:terminals', ...a); };
    });

    await win.locator('.tab-new').click();
    await win.getByRole('menuitem', { name: /^Terminal\s*⌘T$/ }).click();
    await expect(win.locator('.tab')).toHaveCount(2, { timeout: 5000 });
    await expect(win.locator('.xterm-rows')).toHaveCount(2);
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('›', { timeout: 5000 });
    await expect(win.locator('.terminal-slot:visible .xterm-helper-textarea')).toBeFocused();
    // The Atelier prompt can show before atelierd's debounced list even leaves (~100 ms): it arrives later, held here.
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldLists: unknown[][] }).heldLists.length)).toBeGreaterThan(0);

    // The list catches up: no duplicate tab, row or view.
    await app.evaluate(() => (globalThis as unknown as { releaseLists: () => void }).releaseLists());
    await win.waitForTimeout(300);
    await expect(win.locator('.tab')).toHaveCount(2);
    await expect(win.locator('.term-row')).toHaveCount(2);
    await expect(win.locator('.xterm-rows')).toHaveCount(2);
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toContainText('›');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

// The size fitted before the attach completes is refused by the main process (not attached yet): it must be sent again
// once attached, or the shell keeps the size it was created with. A slow attach makes the race certain.
test('a terminal attached slowly still gets the fitted size, and its first output from the snapshot', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).waitFor();
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
      const attach = handlers.get('term:attach')!;
      ipcMain.removeHandler('term:attach');
      ipcMain.handle('term:attach', async (...a: unknown[]) => { await new Promise((r) => setTimeout(r, 300)); return attach(...a); });
    });
    // First terminal of the window: created with the default size (no terminal fitted yet), then fitted to the pane.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 15000 });
    const rows = await win.locator('.xterm-rows > div').count();
    await win.keyboard.type('stty size\n');
    await expect(win.locator('.xterm-rows')).toContainText(/\n?\s*\d+ \d+/, { timeout: 5000 });
    const text = await win.locator('.xterm-rows').innerText();
    const size = /stty size\s+(\d+) (\d+)/.exec(text);
    expect(size?.[1]).toBe(String(rows));
    expect(rows).not.toBe(36);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

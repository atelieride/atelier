import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';

// Keys typed into a new terminal before its screen arrived were dropped by main (the window was not attached yet): the
// first keystroke right after opening a terminal could vanish. A slow attach (test-only delay) makes that window wide.
test('input typed while a new terminal is still attaching reaches the shell, in order', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_TEST_ATTACH_DELAY_MS: '800' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await win.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached' });
    await win.locator('.xterm-helper-textarea').first().focus();
    await win.keyboard.type('echo EA""RLY-$((40+2))\n');
    await expect(win.locator('.xterm-rows').first()).toContainText('EARLY-42', { timeout: 15000 });
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

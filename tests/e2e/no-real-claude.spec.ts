import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';

// e2e must never start the user's real Claude Code: in the default (Atelier) profile, also after atelierd has captured
// the shell environment, `claude` refuses (ATELIER_E2E) and a `claude` found on PATH is the blocking guard.
test('e2e guard: claude is blocked in an Atelier-profile terminal, after the environment capture too', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    // The capture is kept in memory: atelierd's log says when it is ready.
    const log = join(home, 'logs', 'atelierd.log');
    await expect.poll(() => existsSync(log) && readFileSync(log, 'utf8').includes('shell environment captured'), { timeout: 20000 }).toBe(true);
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('command claude; echo "path-rc=$?"\n');
    await expect(win.locator('.xterm-rows:visible')).toContainText('REAL-CLAUDE-BLOCKED', { timeout: 10000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('path-rc=97');
    await win.keyboard.type('claude --version; echo "fn-rc=$?"\n');
    await expect(win.locator('.xterm-rows:visible')).toContainText('fn-rc=97', { timeout: 10000 });
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

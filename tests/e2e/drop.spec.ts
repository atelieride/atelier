import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

test('a file dragged from the tree onto the terminal pastes its path (with spaces escaped)', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  mkdirSync(join(project, 'my shots'));
  writeFileSync(join(project, 'my shots', 'a b.png'), 'x');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await win.getByRole('button', { name: /Files/ }).click();
    await win.locator('.tree-row', { hasText: 'my shots' }).click();
    await win.locator('.tree-row', { hasText: 'a b.png' }).dragTo(win.locator('.terminal-slot:visible'));
    await expect(win.locator('.xterm-rows:visible')).toContainText('my\\ shots/a\\ b.png', { timeout: 5000 });
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

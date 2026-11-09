import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { e2eEnv } from './env';
import { join } from 'node:path';
import { look } from './shots';

test('opens a project, creates a terminal, the terminal survives closing the app', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv();

  let app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  let win = await app.firstWindow();
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  // The shell's prompt (the Atelier prompt's ›): what is typed from now on is not lost.
  await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 10000 });
  await win.locator('.xterm-helper-textarea').focus();
  await win.keyboard.type('echo prova-atelier-$((40+2))\n');
  await expect(win.locator('.xterm-rows')).toContainText('prova-atelier-42', { timeout: 10000 });
  await look(win, 'test-results/essentials-terminal.png');
  await app.close();

  // The app is closed but atelierd is not: on reopening, the screen is identical.
  app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  win = await app.firstWindow();
  await expect(win.locator('.xterm-rows')).toContainText('prova-atelier-42', { timeout: 10000 });
  await app.close();

  // Chromium data does not end up in atelierd's root.
  expect(existsSync(join(home, 'electron'))).toBe(true);

  // Cleanup: stop the test service.
  const info = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
  process.kill(info.pid, 'SIGTERM');
});

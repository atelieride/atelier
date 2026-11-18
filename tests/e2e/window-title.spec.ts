import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { e2eEnv } from './env';

// A project window's title (the Window menu, the Dock menu, Mission Control): the selected session, then the project.

async function stop(app: ElectronApplication, home: string) {
  await app.close().catch(() => {});
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.tab.is-active', { hasText: name })).toBeVisible({ timeout: 15000 });
}

/** The title the system shows for the project window, as main knows it. */
const nativeTitle = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().find((b) => b.isFocusable())!.getTitle());

test('a project window is titled after its selected session, and follows the selection', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-title-'));
  const name = basename(project);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();
    // No session yet: the project.
    await expect.poll(() => nativeTitle(app)).toBe(name);

    await newSession(win, 'Alfa');
    await expect.poll(() => nativeTitle(app)).toBe(`Alfa — ${name}`);
    await newSession(win, 'Beta');
    await expect.poll(() => nativeTitle(app)).toBe(`Beta — ${name}`);

    await win.locator('.session-row', { hasText: 'Alfa' }).click();
    await expect.poll(() => nativeTitle(app)).toBe(`Alfa — ${name}`);
  } finally {
    await stop(app, home);
  }
});

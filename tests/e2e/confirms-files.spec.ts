import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';

// In-app confirms: unsaved files are asked about in the window — under the tab for one
// file, a sheet with a box per file for several, and a sheet when the window itself closes. Never a native dialog.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });
const shots = process.env.ATELIER_E2E_SHOTS;

async function launch(extra: Record<string, string> = {}) {
  const project = mkdtempSync(join(tmpdir(), 'atl-confirm-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'src', 'b.ts'), 'export const b = 1;\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  const { env, home } = e2eEnv({ ATELIER_TEST_TRASH_DIR: mkdtempSync(join(tmpdir(), 'atl-trash-')), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  // A native dialog would be a failure: recorded, answered Cancel.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { nativeAsked: string[] };
    g.nativeAsked = [];
    const record = (...a: unknown[]) => { const o = a.find((x) => x && typeof x === 'object' && 'message' in (x as object)) as { message: string } | undefined; g.nativeAsked.push(o?.message ?? '?'); return { response: 2, checkboxChecked: false }; };
    dialog.showMessageBox = (async (...a: unknown[]) => record(...a)) as typeof dialog.showMessageBox;
    dialog.showMessageBoxSync = ((...a: unknown[]) => record(...a).response) as typeof dialog.showMessageBoxSync;
  });
  const win = await app.firstWindow();
  await expect(win.locator('.header')).toBeVisible();
  return { app, home, project, win };
}

async function stop(app: ElectronApplication, home: string) {
  expect(await app.evaluate(() => (globalThis as unknown as { nativeAsked: string[] }).nativeAsked)).toEqual([]);
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** The app menu's item for an accelerator, clicked (synthetic keys don't go through NSMenu). */
async function menu(app: ElectronApplication, accelerator: string) {
  await app.evaluate(({ Menu, BrowserWindow }, acc) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.accelerator === acc) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, accelerator);
}

/** Opens a file for good (double click: not the preview tab) and types at its end. */
async function edit(win: Page, name: string, text: string) {
  const files = win.getByRole('button', { name: /^Files/ });
  if (!(await win.locator('.tree-row', { hasText: 'a.ts' }).count())) {
    await files.click();
    await win.locator('.tree-row', { hasText: 'src' }).first().click();
  }
  await win.locator('.tree-row', { hasText: name }).first().dblclick();
  await expect(win.locator('.tab.is-active', { hasText: name })).toBeVisible();
  await win.locator('.file-view:visible .cm-content').click();
  await win.keyboard.press('Meta+ArrowDown');
  await win.keyboard.type(text);
  await expect(win.locator('.tab.is-active .tab-dirty')).toHaveCount(1);
}

test('one file: asked under its tab — Esc keeps it, Don\'t Save drops the edit, Save writes it; several (Close All): a sheet with a box each, the checked one saved, the other dropped', async () => {
  const { app, home, project, win } = await launch();
  try {
    await edit(win, 'a.ts', '// one');
    await menu(app, 'CmdOrCtrl+W');
    const pop = win.locator('.confirm-pop');
    await expect(pop).toContainText('Save changes to a.ts?');
    await expect(pop.getByRole('button', { name: /^Save/ })).toBeFocused();
    if (shots) { await win.waitForTimeout(400); await win.screenshot({ path: join(shots, 'confirm-unsaved-tab.png') }); }
    await win.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(win.locator('.tab', { hasText: 'a.ts' })).toHaveCount(1);

    await menu(app, 'CmdOrCtrl+W');
    await pop.getByRole('button', { name: /^Don't Save/ }).click();
    await expect(win.locator('.tab', { hasText: 'a.ts' })).toHaveCount(0);
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');

    await edit(win, 'a.ts', '// two');
    await menu(app, 'CmdOrCtrl+W');
    await pop.getByRole('button', { name: /^Save/ }).click();
    await expect(win.locator('.tab', { hasText: 'a.ts' })).toHaveCount(0);
    await expect.poll(() => readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n// two');

    // Several files (Close All): a sheet with a box each.
    await edit(win, 'a.ts', '// keep');
    await edit(win, 'b.ts', '// drop');
    await win.locator('.tab', { hasText: 'a.ts' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Close All' }).click();
    const sheet = win.locator('.confirm-sheet');
    await expect(sheet).toContainText('2 files have unsaved changes');
    await expect(sheet.getByRole('button', { name: /Save All & Close/ })).toBeFocused();
    await sheet.locator('.confirm-file', { hasText: 'b.ts' }).getByRole('checkbox').uncheck();
    await expect(sheet.getByRole('button', { name: /Save 1 & Close/ })).toBeVisible();
    if (shots) { await win.waitForTimeout(400); await win.screenshot({ path: join(shots, 'confirm-unsaved-sheet.png') }); }
    await sheet.getByRole('button', { name: /Save 1 & Close/ }).click();
    await expect(win.locator('.tab', { hasText: /[ab]\.ts/ })).toHaveCount(0);
    await expect.poll(() => readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n// two// keep');
    expect(readFileSync(join(project, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
  } finally {
    await stop(app, home);
  }
});

test('the window closing with unsaved files: its sheet — Cancel keeps the window, Don\'t Save closes it', async () => {
  const { app, home, project, win } = await launch({ ATELIER_TEST_UNSAVED_ANSWER: 'ask' });
  try {
    await edit(win, 'a.ts', '// edit');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    const sheet = win.locator('.confirm-sheet');
    await expect(sheet).toContainText('You have unsaved changes');
    await expect(sheet).toContainText('Save them before the window closes?');
    await expect(sheet.locator('.confirm-file')).toHaveText(/a\.ts\s*src/);
    await expect(sheet.getByRole('button', { name: /Save & Close/ })).toBeFocused();
    if (shots) { await win.waitForTimeout(400); await win.screenshot({ path: join(shots, 'confirm-unsaved-window.png') }); }
    await sheet.getByRole('button', { name: /^Cancel/ }).click();
    await expect(sheet).toHaveCount(0);
    await expect(win.locator('.tab.is-active .tab-dirty')).toHaveCount(1);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    const closed = win.waitForEvent('close');
    await sheet.getByRole('button', { name: /^Don't Save/ }).click();
    await closed;
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  } finally {
    await stop(app, home);
  }
});

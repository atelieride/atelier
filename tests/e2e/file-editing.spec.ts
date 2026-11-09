import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

async function launch(extra: Record<string, string> = {}) {
  const project = mkdtempSync(join(tmpdir(), 'atl-edit-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'win.txt'), 'uno\r\ndue\r\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'primo');
  // The test trash is a temporary folder: the user's real Trash is never touched.
  const { env, home } = e2eEnv({ ATELIER_TEST_TRASH_DIR: mkdtempSync(join(tmpdir(), 'atl-trash-')), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.header')).toBeVisible();
  return { app, home, project, win };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** The app menu shortcuts are tested by clicking the item (synthetic events do not go through NSMenu). */
async function menu(app: ElectronApplication, accelerator: string) {
  await app.evaluate(({ Menu, BrowserWindow }, acc) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.accelerator === acc) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, accelerator);
}

async function openFile(win: Awaited<ReturnType<typeof launch>>['win'], ...names: string[]) {
  const files = win.getByRole('button', { name: /^Files/ });
  // The item in front clicked again hides the sidebar: Files only when it isn't in front.
  if ((await files.getAttribute('aria-pressed')) !== 'true') await files.click();
  for (const n of names) await win.locator('.tree-row', { hasText: n }).first().click();
}

test('edit and ⌘S: the file changes on disk, the dot disappears, Changes shows it; a CRLF file stays CRLF', async () => {
  const { app, home, project, win } = await launch();
  try {
    await openFile(win, 'src', 'a.ts');
    const editor = win.locator('.file-view:visible .cm-content');
    await editor.click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('export const b = 2;');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(1);
    await expect(win.locator('.file-view:visible .foot-modified')).toBeVisible();
    await menu(app, 'CmdOrCtrl+S');
    await expect.poll(() => readFileSync(join(project, 'src', 'a.ts'), 'utf8'), { timeout: 5000 }).toBe('export const a = 1;\nexport const b = 2;');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(0);
    await expect(win.locator('.changes .change-row', { hasText: 'a.ts' })).toBeVisible({ timeout: 10000 });

    // A CRLF file stays CRLF after saving.
    await openFile(win, 'win.txt');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('tre');
    await menu(app, 'CmdOrCtrl+S');
    await expect.poll(() => readFileSync(join(project, 'win.txt'), 'utf8'), { timeout: 5000 }).toBe('uno\r\ndue\r\ntre');
  } finally {
    await stop(app, home);
  }
});

test('conflict: the file changes on disk with unsaved edits → banner; Compare; Reload takes the disk; Keep Mine overwrites it', async () => {
  const { app, home, project, win } = await launch();
  try {
    await openFile(win, 'src', 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('// mio');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(1);
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 42; // claude\n');
    const band = win.locator('.conflict-band');
    await expect(band).toBeVisible({ timeout: 10000 });
    // Edits are not lost: the editor still has the user's text.
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('// mio');
    await band.getByRole('button', { name: 'Compare' }).click();
    await expect(win.locator('.compare-layer')).toBeVisible();
    await expect(win.locator('.compare-layer .cm-content')).toContainText('claude');
    await win.locator('.compare-layer').getByRole('button', { name: 'Close' }).click();
    await band.getByRole('button', { name: 'Reload' }).click();
    await expect(band).toHaveCount(0);
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('42; // claude');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(0);

    // A second conflict: Keep Mine overwrites the disk with the editor text.
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('// mio');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(1);
    writeFileSync(join(project, 'src', 'a.ts'), 'claude\n');
    await band.getByRole('button', { name: 'Keep Mine' }).click();
    await expect.poll(() => readFileSync(join(project, 'src', 'a.ts'), 'utf8'), { timeout: 5000 }).toBe('export const a = 42; // claude\n// mio');
    await expect(band).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('tree: new file, rename, duplicate and trash from the right-click menu', async () => {
  const { app, home, project, win } = await launch();
  try {
    await win.getByRole('button', { name: /^Files/ }).click();
    const src = win.locator('.tree-row', { hasText: 'src' }).first();
    await src.click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'New File…' }).click();
    const input = win.locator('.tree-input');
    await expect(input).toBeFocused();
    await input.fill('nuovo.ts');
    await input.press('Enter');
    await expect.poll(() => existsSync(join(project, 'src', 'nuovo.ts')), { timeout: 5000 }).toBe(true);
    await expect(win.locator('.tab', { hasText: 'nuovo.ts' })).toBeVisible();

    await win.locator('.tree-row', { hasText: 'nuovo.ts' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Rename…' }).click();
    await win.locator('.tree-input').fill('rinominato.ts');
    await win.locator('.tree-input').press('Enter');
    await expect.poll(() => existsSync(join(project, 'src', 'rinominato.ts')), { timeout: 5000 }).toBe(true);
    expect(existsSync(join(project, 'src', 'nuovo.ts'))).toBe(false);
    await expect(win.locator('.tab', { hasText: 'rinominato.ts' })).toBeVisible();
    await expect(win.locator('.tab', { hasText: 'nuovo.ts' })).toHaveCount(0);

    await win.locator('.tree-row', { hasText: 'a.ts' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect.poll(() => existsSync(join(project, 'src', 'a copy.ts')), { timeout: 5000 }).toBe(true);

    // Move to Trash asks in the row: Cancel keeps it, Move to Trash moves it.
    await win.locator('.tree-row', { hasText: 'rinominato.ts' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Move to Trash…' }).click();
    const asking = win.locator('.tree-row.is-confirming');
    await expect(asking).toContainText('Move “rinominato.ts” to the Trash?');
    await expect(asking).toContainText('You can restore it from the Trash.');
    await expect(asking.getByRole('button', { name: /^Cancel/ })).toBeFocused();
    await asking.getByRole('button', { name: /^Cancel/ }).click();
    await expect(asking).toHaveCount(0);
    expect(existsSync(join(project, 'src', 'rinominato.ts'))).toBe(true);
    // A folder says how many files go with it; Esc keeps it.
    await win.locator('.tree-row', { hasText: 'src' }).first().click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Move to Trash…' }).click();
    await expect(asking).toContainText(/The folder and the \d+ files inside/);
    await look(win, 'test-results/confirm-trash.png', { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(asking).toHaveCount(0);
    await win.locator('.tree-row', { hasText: 'rinominato.ts' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Move to Trash…' }).click();
    await asking.getByRole('button', { name: 'Move to Trash' }).click();
    await expect.poll(() => existsSync(join(project, 'src', 'rinominato.ts')), { timeout: 5000 }).toBe(false);
    await expect(win.locator('.tab', { hasText: 'rinominato.ts' })).toHaveCount(0);
    await expect(win.locator('.tree-row', { hasText: 'rinominato.ts' })).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('file deleted on disk with edits: the text stays, Save to Recreate rewrites it', async () => {
  const { app, home, project, win } = await launch();
  try {
    await openFile(win, 'src', 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('// mio');
    await expect(win.locator('.tab .tab-dirty')).toHaveCount(1);
    unlinkSync(join(project, 'src', 'a.ts'));
    await expect(win.locator('.conflict-band.is-gone')).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('// mio');
    await win.getByRole('button', { name: 'Save to Recreate' }).click();
    await expect.poll(() => existsSync(join(project, 'src', 'a.ts')) && readFileSync(join(project, 'src', 'a.ts'), 'utf8'), { timeout: 5000 }).toBe('export const a = 1;\n// mio');
  } finally {
    await stop(app, home);
  }
});

test('renaming a file with unsaved edits: it is saved first (answer Save), the text is not lost', async () => {
  const { app, home, project, win } = await launch();
  try {
    await openFile(win, 'src', 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('// mio');
    await win.locator('.tree-row', { hasText: 'a.ts' }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Rename…' }).click();
    await win.locator('.tree-input').fill('b.ts');
    await win.locator('.tree-input').press('Enter');
    // Asked in the window, Save focused.
    const sheet = win.locator('.confirm-sheet');
    await expect(sheet).toContainText('Save changes to a.ts?');
    expect(existsSync(join(project, 'src', 'b.ts'))).toBe(false);
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => existsSync(join(project, 'src', 'b.ts')) && readFileSync(join(project, 'src', 'b.ts'), 'utf8'), { timeout: 5000 }).toBe('export const a = 1;\n// mio');
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('// mio');
  } finally {
    await stop(app, home);
  }
});

test('reloading or closing the window with unsaved edits asks (answer Cancel: everything stays)', async () => {
  const { app, home, win } = await launch({ ATELIER_TEST_UNSAVED_ANSWER: 'cancel' });
  try {
    await openFile(win, 'src', 'a.ts');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('// mio');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload());
    await win.waitForTimeout(800);
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('// mio');
    // ⌘W right after a keystroke (before the "unsaved" state delay): it asks anyway, under the tab; Esc keeps it.
    await win.keyboard.type('x');
    await menu(app, 'CmdOrCtrl+W');
    await expect(win.locator('.confirm-pop')).toContainText('Save changes to a.ts?');
    await win.keyboard.press('Escape');
    await expect(win.locator('.confirm-pop')).toHaveCount(0);
    await expect(win.locator('.tab', { hasText: 'a.ts' })).toHaveCount(1);
  } finally {
    // To end the test, answer "Don't Save".
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => { w.webContents.removeAllListeners('will-prevent-unload'); w.webContents.on('will-prevent-unload', (e) => e.preventDefault()); }));
    await stop(app, home);
  }
});

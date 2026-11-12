import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

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

test('Save Outside the Project…: the pinned row opens the save panel; Cancel keeps the sheet; saved, the tab is an outside file ⌘S keeps saving; a replaced file goes to the Trash', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'notes'));
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-')));
  writeFileSync(join(out, 'keep.md'), 'the old one\n');
  // The path the save panel would return, read at every save (empty: Cancel).
  const panel = join(mkdtempSync(join(tmpdir(), 'atl-panel-')), 'save-path');
  writeFileSync(panel, '');
  const { env, home } = e2eEnv({ ATELIER_TEST_SAVE_PATH: panel });
  const trash = env.ATELIER_TEST_TRASH_DIR!;
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();
    await menu(app, 'CmdOrCtrl+Alt+N');
    await expect(win.locator('.file-view:visible .cm-content')).toBeFocused();
    await win.keyboard.type('drafted in Atelier');
    await menu(app, 'CmdOrCtrl+S');
    const sheet = win.locator('.save-as-sheet');
    const input = sheet.locator('input');
    await expect(input).toBeFocused();

    // Pinned under the folders, one line, never clipped; the list's last option for the keyboard (↑ wraps to it).
    const row = sheet.locator('.save-as-outside');
    await expect(row).toHaveText('Save Outside the Project…');
    const box = (await row.boundingBox())!;
    const sheetBox = (await sheet.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(sheetBox.y + sheetBox.height);
    expect(box.height).toBeLessThan(40);
    expect(await row.locator('.palette-label').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(sheet.locator('.folder-item.is-active')).toHaveCount(1);
    await input.press('ArrowUp');
    await expect(row).toHaveClass(/is-active/);
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.locator('.palette-list .folder-item.is-active')).toHaveCount(0);
    // The field's hint says what Enter does now.
    await expect(sheet.locator('.palette-search .popover-hint')).toHaveText('↵ choose where · esc');
    await look(win.locator('.save-as-sheet'), 'test-results/save-as-outside-row.png', { settle: 300 });
    await input.press('ArrowDown');
    await expect(row).not.toHaveClass(/is-active/);
    await expect(sheet.locator('.palette-list .folder-item').first()).toHaveClass(/is-active/);

    // No folder matching: the arrows go on and off the pinned row (Enter saves the typed name once off it).
    await input.fill('zzz/');
    await expect(sheet.locator('.palette-list .folder-item')).toHaveCount(0);
    await input.press('ArrowDown');
    await expect(row).toHaveClass(/is-active/);
    await input.press('ArrowDown');
    await expect(row).not.toHaveClass(/is-active/);
    await expect(sheet.locator('.palette-search .popover-hint')).toHaveText('↵ save · ⇥ folder · esc');

    // Canceled in the panel: the sheet as it was, the field focused, nothing on disk.
    await input.fill('draft.md');
    await row.click();
    await expect(sheet).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('draft.md');
    await expect(sheet.getByRole('alert')).toHaveCount(0);

    // The panel puts it outside: Enter on the highlighted row saves there; the tab is that outside file.
    writeFileSync(panel, join(out, 'draft.md'));
    // Still under the pointer from the click: highlighted. Off and on again with the arrows (no folder matches).
    await expect(row).toHaveClass(/is-active/);
    await input.press('ArrowDown');
    await expect(row).not.toHaveClass(/is-active/);
    await input.press('ArrowUp');
    await expect(row).toHaveClass(/is-active/);
    await input.press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => existsSync(join(out, 'draft.md'))).toBe(true);
    expect(readFileSync(join(out, 'draft.md'), 'utf8')).toBe('drafted in Atelier');
    const saved = win.locator('.tab', { hasText: 'draft.md' });
    await expect(saved).toHaveClass(/is-active/);
    await expect(saved.locator('.tab-dirty')).toHaveCount(0);
    await expect(saved.locator('.tab-dir')).toHaveText(basename(out));
    await expect(win.locator('.file-view:visible .file-note.is-outside')).toHaveText('Outside project');
    // ⌘S keeps saving it there (granted for editing).
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type(', then edited');
    await menu(app, 'CmdOrCtrl+S');
    await expect.poll(() => readFileSync(join(out, 'draft.md'), 'utf8')).toBe('drafted in Atelier, then edited');

    // Over a file the panel said to replace (Tab on the row): the old one in the Trash, never deleted.
    await menu(app, 'CmdOrCtrl+Alt+N');
    await expect(win.locator('.tab', { hasText: 'Untitled-1' })).toHaveClass(/is-active/);
    await expect(win.locator('.file-view:visible .cm-content')).toBeFocused();
    await win.keyboard.type('the new one');
    await menu(app, 'CmdOrCtrl+S');
    await expect(input).toBeFocused();
    expect(readFileSync(join(out, 'draft.md'), 'utf8')).toBe('drafted in Atelier, then edited');
    writeFileSync(panel, join(out, 'keep.md'));
    await input.press('ArrowUp');
    await input.press('Tab');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => readFileSync(join(out, 'keep.md'), 'utf8')).toBe('the new one');
    expect(readdirSync(trash).map((n) => readFileSync(join(trash, n), 'utf8'))).toEqual(['the old one\n']);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => { w.webContents.removeAllListeners('will-prevent-unload'); w.webContents.on('will-prevent-unload', (e) => e.preventDefault()); }));
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('untitled file: ⌘⌥N, type, ⌘S → Save as sheet; refusals shown; saved into an existing folder; closing a dirty one asks', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'notes'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  writeFileSync(join(project, 'notes', 'readme.md'), '# Notes\n');
  writeFileSync(join(project, 'existing.md'), 'keep me\n');
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();

    await menu(app, 'CmdOrCtrl+Alt+N');
    const untitled = win.locator('.tab', { hasText: 'Untitled-1' });
    await expect(untitled).toHaveClass(/is-active/);
    await expect(untitled).not.toHaveClass(/is-preview/);
    const editor = win.locator('.file-view:visible .cm-content');
    await expect(editor).toBeFocused();
    await win.keyboard.type('hello\nworld');
    await expect(untitled.locator('.tab-dirty')).toHaveCount(1);
    await expect(win.locator('.file-view:visible .file-foot')).toContainText('Plain text');

    await menu(app, 'CmdOrCtrl+S');
    const sheet = win.locator('.save-as-sheet');
    const input = sheet.locator('input');
    await expect(input).toBeFocused();
    const refused = async (path: string, why: string) => {
      await input.fill(path);
      await input.press('Enter');
      await expect(sheet.getByRole('alert')).toContainText(why);
    };
    await refused('../x.md', 'outside the project');
    await refused('.git/x.md', 'inside .git');
    await refused('existing.md', 'already exists');
    await look(win, 'test-results/save-as-error.png', { settle: 300 });
    await refused('missing/x.md', 'folder does not exist');
    expect(readFileSync(join(project, 'existing.md'), 'utf8')).toBe('keep me\n');
    expect(existsSync(join(project, '.git', 'x.md'))).toBe(false);

    // Folder completion: what is typed before the slash searches the folders, Tab completes.
    await input.fill('no');
    await expect(sheet.locator('.folder-item.is-active')).toContainText('notes/');
    await input.press('Tab');
    await expect(input).toHaveValue('notes/');
    await input.pressSequentially('todo.md');
    await look(win, 'test-results/save-as-sheet.png');
    await input.press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => existsSync(join(project, 'notes', 'todo.md'))).toBe(true);
    expect(readFileSync(join(project, 'notes', 'todo.md'), 'utf8')).toBe('hello\nworld');
    const saved = win.locator('.tab', { hasText: 'todo.md' });
    await expect(saved).toHaveClass(/is-active/);
    await expect(saved.locator('.tab-dirty')).toHaveCount(0);
    await expect(win.locator('.tab', { hasText: 'Untitled-1' })).toHaveCount(0);
    await expect(win.locator('.file-view:visible .file-foot')).toContainText('Markdown');
    // Files opens with the file in front revealed: notes/ is already expanded.
    await win.getByRole('button', { name: /Files/ }).click();
    await expect(win.locator('.tree-row', { hasText: 'todo.md' })).toBeVisible();

    // Closing a dirty untitled tab asks under its tab; "Save" opens the sheet; Esc there keeps
    // the tab.
    await menu(app, 'CmdOrCtrl+Alt+N');
    await expect(win.locator('.tab', { hasText: 'Untitled-1' })).toHaveClass(/is-active/);
    // As for the first one: its editor has the keyboard, and the text, before ⌘W asks about it.
    await expect(editor).toBeFocused();
    await win.keyboard.type('second');
    await expect(editor).toHaveText('second');
    await menu(app, 'CmdOrCtrl+W');
    const asking = win.locator('.confirm-pop');
    await expect(asking).toContainText('Save changes to Untitled-1?');
    await asking.getByRole('button', { name: /^Save/ }).click();
    await expect(input).toBeFocused();
    await input.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(win.locator('.tab', { hasText: 'Untitled-1' })).toHaveCount(1);
    await menu(app, 'CmdOrCtrl+W');
    // ⌘S answers the question (the app menu's Save).
    await expect(asking).toBeVisible();
    await menu(app, 'CmdOrCtrl+S');
    await input.fill('second.txt');
    await input.press('Enter');
    await expect.poll(() => existsSync(join(project, 'second.txt'))).toBe(true);
    expect(readFileSync(join(project, 'second.txt'), 'utf8')).toBe('second');
    await expect(win.locator('.tab', { hasText: 'Untitled-1' })).toHaveCount(0);
    await expect(win.locator('.tab', { hasText: 'second.txt' })).toHaveCount(0);
  } finally {
    // A failure may leave a dirty untitled tab: the window must still close ("Don't Save").
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => { w.webContents.removeAllListeners('will-prevent-unload'); w.webContents.on('will-prevent-unload', (e) => e.preventDefault()); }));
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

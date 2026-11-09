import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Word wrap switched from where you are: View › Word Wrap (a checkbox), ⌥Z in an
// editor, the palette, and the command with Settings open.

/** View › Word Wrap as the native menu has it now (the menu is rebuilt after every settings change). */
const wrapItem = (app: ElectronApplication) => app.evaluate(({ Menu }) => {
  const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
    for (const it of items) { if (it.label === 'Word Wrap') return it; const sub = it.submenu ? find(it.submenu.items) : undefined; if (sub) return sub; }
    return undefined;
  };
  const it = find(Menu.getApplicationMenu()!.items);
  return it ? { type: it.type, checked: it.checked, accelerator: it.accelerator ?? null } : null;
});

/** A click on the native item, as Electron runs it (it flips a checkbox before the click handler). */
const clickWrap = (app: ElectronApplication) => app.evaluate(({ Menu, BrowserWindow }) => {
  const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
    for (const it of items) { if (it.label === 'Word Wrap') return it; const sub = it.submenu ? find(it.submenu.items) : undefined; if (sub) return sub; }
    return undefined;
  };
  find(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
});

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

test('View › Word Wrap, ⌥Z in the editor and the palette switch word wrap; with Settings open the sheet stays', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'lungo.txt'), `${'parola '.repeat(80)}\n`);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: /Files/ }).click();
    await win.locator('.tree-row', { hasText: 'lungo.txt' }).click();
    const view = win.locator('.file-view:visible');
    await expect(view.locator('.cm-content')).toBeVisible();
    await expect(view.locator('.cm-lineWrapping')).toHaveCount(0);
    expect(await wrapItem(app)).toEqual({ type: 'checkbox', checked: false, accelerator: null });

    // The menu: wraps the open file, and the item comes back checked.
    await clickWrap(app);
    await expect(view.locator('.cm-lineWrapping')).toHaveCount(1);
    await expect.poll(async () => (await wrapItem(app))?.checked).toBe(true);
    await look(win, 'test-results/word-wrap-on.png');

    // ⌥Z in the editor: unwrapped, nothing typed, the menu follows.
    const text = await view.locator('.cm-content').textContent();
    await view.locator('.cm-content').click();
    await win.keyboard.press('Alt+KeyZ');
    await expect(view.locator('.cm-lineWrapping')).toHaveCount(0);
    await expect.poll(async () => (await wrapItem(app))?.checked).toBe(false);
    expect(await view.locator('.cm-content').textContent()).toBe(text);

    // The palette: the key in the hint, "on" once it is on.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>word wrap');
    const entry = win.locator('.palette-item', { hasText: 'Toggle word wrap' });
    await expect(entry).toBeVisible();
    await expect(entry.locator('.palette-hint')).toHaveText('⌥Z');
    await win.keyboard.press('Enter');
    await expect(view.locator('.cm-lineWrapping')).toHaveCount(1);
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>word wrap');
    await expect(entry.locator('.palette-hint')).toHaveText(/^on\s+⌥Z$/);
    await win.keyboard.press('Escape');

    // With Settings open (on Appearance) the command keeps the sheet and goes to Editor: the toggle changes in front of you.
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('switch', { name: 'Word wrap' })).toHaveCount(0);
    await command(app, 'toggle-word-wrap');
    const toggle = dialog.getByRole('switch', { name: 'Word wrap' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(dialog).toBeVisible();
    await command(app, 'toggle-word-wrap');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await look(dialog, 'test-results/word-wrap-settings.png');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

/** The editor inside `l` gets a mark: still there later, it is the same editor (never destroyed and made again). */
const mark = (l: Locator) => l.locator('.cm-editor').evaluate((el) => { (el as HTMLElement).dataset.kept = '1'; });
const kept = (l: Locator) => l.locator('.cm-editor[data-kept]');
const focusIn = (win: Page, sel: string) => win.evaluate((s) => !!document.activeElement?.closest(s), sel);

test('the commit diff, a file at a revision and the Review keep their editor (place, focus) when ⌥Z switches word wrap, from their keyboard area too', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scm-')));
  const long = (w: string) => `${`${w} `.repeat(80)}\n`;
  writeFileSync(join(project, 'lungo.txt'), long('uno'));
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'first');
  writeFileSync(join(project, 'lungo.txt'), long('uno') + long('due'));
  git(project, 'commit', '-q', '-am', 'second');
  writeFileSync(join(project, 'lungo.txt'), long('uno') + long('due') + long('tre'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
    await command(app, 'view-scm');
    await win.getByRole('button', { name: 'Show History' }).click();
    const row = (subject: string) => win.locator('.history-view .hv-row', { hasText: subject });

    // A commit's diff: ⌥Z from the diff's keyboard area (j/k) and inside its text, once each, the same editor.
    await row('second').click();
    const cd = win.locator('.history-view .cd');
    await cd.locator('.cd-file', { hasText: 'lungo.txt' }).click();
    await expect(cd.locator('.cm-diff-add')).toHaveCount(1);
    await mark(cd);
    await cd.locator('.cd-diff').focus();
    await win.keyboard.press('Alt+KeyZ');
    await expect(cd.locator('.cm-lineWrapping')).toHaveCount(1);
    await cd.locator('.cm-content').click();
    await win.keyboard.press('Alt+KeyZ');
    await expect(cd.locator('.cm-lineWrapping')).toHaveCount(0);
    await expect(kept(cd)).toHaveCount(1);

    // A file at a revision: the same editor, the keyboard still in it (a second ⌥Z works).
    await row('second').dblclick();
    const rev = win.locator('.rev-view:visible');
    await expect(rev.locator('.cm-content')).toContainText('due');
    await mark(rev);
    await rev.locator('.cm-content').click();
    await win.keyboard.press('Alt+KeyZ');
    await expect(rev.locator('.cm-lineWrapping')).toHaveCount(1);
    await expect(kept(rev)).toHaveCount(1);
    expect(await focusIn(win, '.rev-view')).toBe(true);
    await win.keyboard.press('Alt+KeyZ');
    await expect(rev.locator('.cm-lineWrapping')).toHaveCount(0);

    // The Review: from its keyboard area (j/k/n/p) and inside a diff, once each.
    await command(app, 'review-all');
    const review = win.locator('.review-view');
    await expect(review.locator('.cm-diff-add')).toHaveCount(1, { timeout: 8000 });
    await review.locator('.rv-scroll').focus();
    await win.keyboard.press('Alt+KeyZ');
    await expect(review.locator('.cm-lineWrapping')).toHaveCount(1);
    await review.locator('.cm-content').click();
    await win.keyboard.press('Alt+KeyZ');
    await expect(review.locator('.cm-lineWrapping')).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

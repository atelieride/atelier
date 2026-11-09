import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const prefs = (home: string) => JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')) as Record<string, unknown>;

test('Settings: the terminal changes immediately, preferences are saved in the Atelier home', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows')).toBeVisible({ timeout: 10000 });
    const rowsFont = () => win.locator('.xterm-rows').evaluate((el) => getComputedStyle(el).fontSize);
    expect(await rowsFont()).toBe('13px');
    // Terminal columns from the footer ("… · 120×36"): with a larger font they must decrease.
    const cols = async () => Number(/(\d+)×\d+/.exec((await win.locator('.footer').textContent()) ?? '')?.[1] ?? 0);
    await expect.poll(cols).toBeGreaterThan(0);
    const before = await cols();

    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    await dialog.getByRole('button', { name: 'Increase Font size' }).click();
    await expect(dialog.getByRole('group', { name: 'Font size' })).toContainText('14 px');
    await expect.poll(rowsFont).toBe('14px');
    expect(prefs(home).terminalFontSize).toBe(14);
    await expect.poll(cols).toBeLessThan(before);
    await dialog.getByRole('radio', { name: 'Block' }).click();
    await expect(dialog.getByRole('radio', { name: 'Block' })).toHaveAttribute('aria-checked', 'true');
    // Keyboard: the arrow keys move through the options and select them, focus follows.
    await win.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: 'Underline' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('radio', { name: 'Underline' })).toBeFocused();
    await win.keyboard.press('ArrowLeft');
    await expect(dialog.getByRole('radio', { name: 'Block' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => prefs(home).cursorStyle).toBe('block');
    // Last control of the section with a non-last option selected: Tab returns to the start of the sheet, it does not leave.
    await dialog.getByRole('radio', { name: '1k', exact: true }).click();
    await win.keyboard.press('Tab');
    await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await look(win, 'test-results/settings-terminal-settings-terminal.png');

    // Larger interface: the window zoom changes in main.
    await dialog.getByRole('button', { name: 'Appearance' }).click();
    await dialog.getByRole('radio', { name: 'Large', exact: true }).click();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBeCloseTo(1.1);

    // Esc closes the sheet.
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

test('Settings: new sessions start with the chosen model and permissions', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Claude' }).click();
    await dialog.getByRole('radio', { name: 'Sonnet' }).click();
    // By default no flag: the default mode in the user's Claude settings decides.
    await expect(dialog.getByRole('radiogroup', { name: 'Permission mode' }).getByRole('radio', { name: 'Claude settings' })).toHaveAttribute('aria-checked', 'true');
    // "Ask" really passes --permission-mode default (it used to pass nothing and the user's mode applied, e.g. auto).
    await dialog.getByRole('radiogroup', { name: 'Permission mode' }).getByRole('radio', { name: 'Ask', exact: true }).click();
    await expect.poll(() => prefs(home).claudePermissionMode).toBe('default');
    await look(win, 'test-results/settings-terminal-settings-claude.png');
    await win.keyboard.press('Escape');

    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.keyboard.press('Enter');
    await expect(win.locator('.xterm-rows')).toContainText('claude --model sonnet --permission-mode default', { timeout: 20000 });
  } finally {
    await stop(app, home);
  }
});

test('Settings: Esc also closes after a click on text or with the + at its maximum; a command or a notification click closes the sheet; shortcuts with search, About and restoring defaults', async () => {
  const { app, home } = await launch();
  try {
    const win = await app.firstWindow();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    // Esc also closes after a click on text or with the + at its maximum.
    await win.getByRole('button', { name: 'Settings' }).click();
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    await dialog.getByText('Line height').click();
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await win.getByRole('button', { name: 'Settings' }).click();
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const plus = dialog.getByRole('button', { name: 'Increase Font size' });
    await plus.focus();
    for (let i = 0; i < 11; i++) await win.keyboard.press('Enter');
    await expect(dialog.getByRole('group', { name: 'Font size' })).toContainText('24 px');
    await expect(plus).toBeDisabled();
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // A command or a notification click closes the sheet instead of working underneath it.
    await win.getByRole('button', { name: 'Settings' }).click();
    await expect(dialog).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'new-terminal'));
    await expect(dialog).toHaveCount(0);
    await expect(win.locator('.xterm-rows')).toBeVisible({ timeout: 10000 });
    // ⌘, with the sheet open does not change section.
    await win.getByRole('button', { name: 'Settings' }).click();
    await dialog.getByRole('button', { name: 'Editor' }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'open-settings'));
    await expect(dialog.getByRole('heading', { name: 'Editor' })).toBeVisible();
    const id = await win.evaluate(async () => (await (window as unknown as { atelier: { terminals: { list(): Promise<{ id: string }[]> } } }).atelier.terminals.list())[0]!.id);
    await app.evaluate(({ BrowserWindow }, tid) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:select', tid), id);
    await expect(dialog).toHaveCount(0);

    // Shortcuts with search, About and restoring defaults (last: it restores what the steps above changed).
    await win.getByRole('button', { name: 'Settings' }).click();
    await dialog.getByRole('button', { name: 'Editor' }).click();
    await dialog.getByRole('switch', { name: 'Word wrap' }).click();
    await expect(dialog.getByRole('switch', { name: 'Word wrap' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => prefs(home).wordWrap).toBe(true);

    await dialog.getByRole('button', { name: 'Keyboard' }).click();
    await dialog.getByRole('textbox', { name: 'Search shortcuts' }).fill('palette');
    // F1, ⌘⇧P, `:n`, the two task rows (`task:`, ⌘⏎ on a task), `#` (workspaces) and
    // ⌘⏎ on a table.
    await expect(dialog.locator('.kb-row')).toHaveCount(7);
    await look(win, 'test-results/settings-terminal-settings-keyboard.png');

    await dialog.getByRole('button', { name: 'About' }).click();
    await expect(dialog).toContainText(/atelierd .* running/, { timeout: 10000 });
    await look(win, 'test-results/settings-terminal-settings-about.png');

    // Asked in the nav: Esc keeps the settings and the sheet, Restore restores.
    await dialog.getByRole('button', { name: 'Restore Defaults' }).click();
    const asking = dialog.locator('.set-restore-confirm');
    await expect(asking).toContainText('Claude accounts and launch flags included');
    await expect(asking.getByRole('button', { name: /^Cancel/ })).toBeFocused();
    await look(win, 'test-results/confirm-restore.png', { settle: 300 });
    await win.keyboard.press('Escape');
    await expect(asking).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(prefs(home).wordWrap).toBe(true);
    await dialog.getByRole('button', { name: 'Restore Defaults' }).click();
    await asking.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => prefs(home).wordWrap).toBe(false);
    // Click outside closes.
    await win.mouse.click(8, 400);
    await expect(dialog).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});


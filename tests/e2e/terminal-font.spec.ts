import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Terminal font: Settings › Terminal › Font and Change Terminal Font… list JetBrains
// Mono and the machine's monospaced fonts (Menlo and Courier New ship with macOS); moving through the list shows the
// font on the terminals and the Settings preview at once, Esc goes back, Enter keeps it.
const SHOTS = 'test-results/terminal-font';

async function launch(prefs?: Record<string, unknown>): Promise<{ app: ElectronApplication; win: Page; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  if (prefs) writeFileSync(join(home, 'preferences.json'), JSON.stringify(prefs), { mode: 0o600 });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  await expect(win.locator('.terminal-slot:visible .xterm-rows')).toBeVisible({ timeout: 10000 });
  return { app, win, home };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const saved = (home: string) => {
  try { return (JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')) as { terminalFontFamily?: string }).terminalFontFamily; } catch { return undefined; }
};
const command = (app: ElectronApplication, c: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), c);
const termFont = (win: Page) => win.locator('.terminal-slot:visible .xterm-rows').evaluate((el) => getComputedStyle(el).fontFamily);
const previewFont = (win: Page) => win.locator('.term-preview').evaluate((el) => getComputedStyle(el).fontFamily);

async function openTerminalSettings(win: Page) {
  await win.getByRole('button', { name: 'Settings' }).click();
  const dialog = win.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Terminal', exact: true }).click();
  return dialog;
}

test('Settings › Terminal › Font: the list previews on the terminal and in the preview, Esc goes back, Enter keeps', async () => {
  const { app, win, home } = await launch();
  try {
    expect(await termFont(win)).toMatch(/^"?JetBrains Mono"?,/);
    const dialog = await openTerminalSettings(win);
    const button = dialog.getByRole('button', { name: 'Font: JetBrains Mono' });
    await expect(button).toContainText('Default');
    await button.click();
    const picker = win.getByRole('dialog', { name: 'Terminal font' });
    await expect(picker.getByRole('combobox', { name: 'Search fonts' })).toBeFocused();
    await expect(picker.getByRole('option', { name: /JetBrains Mono/ })).toHaveAttribute('aria-selected', 'true');
    await expect(picker.getByRole('option', { name: /^Menlo/ })).toBeVisible();
    // Only monospaced fonts: Helvetica is installed on every Mac, never listed.
    await expect(picker.getByRole('option', { name: /Helvetica/ })).toHaveCount(0);

    // The pointer previews: the terminal and the Settings preview draw with Menlo, nothing is saved.
    await picker.getByRole('option', { name: /^Menlo/ }).hover();
    await expect.poll(() => termFont(win)).toMatch(/^"?Menlo"?,/);
    await expect.poll(() => previewFont(win)).toMatch(/^"?Menlo"?,/);
    await expect(win.locator('.term-preview .tp-tag')).toHaveText('Menlo · 13 px');
    await look(win, `${SHOTS}/settings-picker.png`);
    expect(saved(home)).toBeUndefined();

    // Esc: back to the font in use; the Settings sheet stays open, the button has the focus again.
    await win.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(button).toBeFocused();
    await expect.poll(() => termFont(win)).toMatch(/^"?JetBrains Mono"?,/);

    // Searching selects and previews the best match; Enter keeps it.
    await button.click();
    await picker.getByRole('combobox', { name: 'Search fonts' }).fill('menl');
    await expect(picker.getByRole('option', { name: /^Menlo/ })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => termFont(win)).toMatch(/^"?Menlo"?,/);
    await win.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect.poll(() => saved(home)).toBe('Menlo');
    await expect(dialog.getByRole('button', { name: 'Font: Menlo' })).toBeFocused();
    await expect.poll(() => termFont(win)).toMatch(/^"?Menlo"?,/);
    await look(win, `${SHOTS}/settings-kept.png`);

    // A search with no match says so.
    await dialog.getByRole('button', { name: 'Font: Menlo' }).click();
    await picker.getByRole('combobox', { name: 'Search fonts' }).fill('zzqx');
    await expect(picker).toContainText('No monospaced font matches “zzqx”.');
    await win.keyboard.press('Escape');
    await expect.poll(() => termFont(win)).toMatch(/^"?Menlo"?,/);
  } finally {
    await stop(app, home);
  }
});

test('Change Terminal Font…: from the palette; the arrows preview on the terminal, Esc goes back, Enter keeps', async () => {
  const { app, win, home } = await launch();
  try {
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>terminal font');
    await win.locator('.palette-item', { hasText: 'Change terminal font…' }).click();
    const sheet = win.getByRole('dialog', { name: 'Change Terminal Font' });
    await expect(sheet.getByRole('option', { name: /JetBrains Mono/ })).toHaveAttribute('aria-selected', 'true');
    // The installed fonts are read when the sheet opens (the first time in a window: a moment).
    await expect(sheet.getByRole('option', { name: /^Menlo/ })).toBeVisible();
    await win.keyboard.press('ArrowDown');
    await expect.poll(() => termFont(win)).not.toMatch(/^"?JetBrains Mono"?,/);
    await look(win, `${SHOTS}/palette-preview.png`);
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => termFont(win)).toMatch(/^"?JetBrains Mono"?,/);
    expect(saved(home)).toBeUndefined();

    // Closed another way (View › Change Theme… takes its place): the font in use comes back too.
    await command(app, 'change-terminal-font');
    await expect(sheet.getByRole('option', { name: /^Menlo/ })).toBeVisible();
    await sheet.getByRole('option', { name: /^Menlo/ }).hover();
    await expect.poll(() => termFont(win)).toMatch(/^"?Menlo"?,/);
    await command(app, 'change-theme');
    await expect(win.getByRole('dialog', { name: 'Change Theme' })).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => termFont(win)).toMatch(/^"?JetBrains Mono"?,/);
    await win.keyboard.press('Escape');
    await expect(win.getByRole('dialog', { name: 'Change Theme' })).toHaveCount(0);

    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>terminal font');
    await win.locator('.palette-item', { hasText: 'Change terminal font…' }).click();
    await sheet.getByRole('combobox').fill('courier');
    await expect.poll(() => termFont(win)).toMatch(/^"Courier New",/);
    await win.keyboard.press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => saved(home)).toBe('Courier New');
    await expect.poll(() => termFont(win)).toMatch(/^"Courier New",/);
  } finally {
    await stop(app, home);
  }
});

test('a saved font this Mac lacks: the terminal draws with JetBrains Mono, Settings says so', async () => {
  const { app, win, home } = await launch({ terminalFontFamily: 'Atelier Missing Mono' });
  try {
    const dialog = await openTerminalSettings(win);
    await expect(dialog.getByRole('button', { name: /^Font: Atelier Missing Mono/ })).toBeVisible();
    await expect(dialog.getByRole('note').filter({ hasText: 'Atelier Missing Mono' })).toHaveText('Atelier Missing Mono isn’t installed on this Mac: terminals use JetBrains Mono until it is.');
    await look(win, `${SHOTS}/missing.png`);
  } finally {
    await stop(app, home);
  }
});

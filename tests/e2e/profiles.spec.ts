import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Terminal profiles: the e2e atelierd is this build's, with the capability;
// ATELIER_TEST_NO_PROFILES makes the app behave as with an older atelierd.

async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; home: string; win: Page }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  // A git repository on branch main: the Atelier prompt shows the branch.
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, win: await app.firstWindow() };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const prefs = (home: string) => JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')) as Record<string, unknown>;
const terminals = (win: Page) => win.evaluate(() => (window as unknown as { atelier: AtelierApi }).atelier.terminals.list());
const screen = (win: Page) => win.locator('.xterm-rows:visible');

test('profiles: Atelier by default with its prompt, another profile from the + menu with a chip, the Settings default for the next one', async () => {
  const { app, home, win } = await launch();
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    // Atelier prompt: dim path, branch, ›. The e2e user config is empty, so the › can only come from the Atelier profile.
    await expect(screen(win)).toContainText(/main ›/, { timeout: 10000 });
    await expect.poll(async () => (await terminals(win)).map((x) => x.profile)).toEqual(['atelier']);
    // The default profile: no chip.
    await expect(win.locator('.term-row')).toHaveCount(1);
    await expect(win.locator('.term-row .profile-chip')).toHaveCount(0);

    // ⌘← / ⌘→: start and end of the line.
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('cho profiles-ok');
    await win.keyboard.press('Meta+ArrowLeft');
    await win.keyboard.type('e');
    await win.keyboard.press('Meta+ArrowRight');
    await win.keyboard.type('-end\n');
    // The rows' text has no line breaks: the command line, then its output.
    await expect(screen(win)).toContainText('echo profiles-ok-endprofiles-ok-end', { timeout: 5000 });
    await look(win, 'test-results/profiles-atelier-prompt.png');

    // "+" › Terminal with Profile › zsh (your config): a terminal with the zsh chip.
    await win.locator('.tab-new').click();
    await win.getByRole('menuitem', { name: 'Terminal with Profile' }).hover();
    await look(win, 'test-results/profiles-plus-submenu.png', { settle: 300 });
    await win.getByRole('menuitem', { name: 'zsh (your config)' }).click();
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 10000 });
    await expect(win.locator('.term-row .profile-chip')).toHaveText(['zsh']);
    await expect(win.locator('.tab .profile-chip')).toHaveText(['zsh']);
    await expect.poll(async () => (await terminals(win)).map((x) => x.profile).sort()).toEqual(['atelier', 'user']);

    // Keyboard: → opens the submenu, Enter picks.
    await win.locator('.tab-new').click();
    const menu = win.locator('.ctx-menu').first();
    for (let i = 0; i < 3; i++) await menu.press('ArrowDown');
    await menu.press('ArrowRight');
    await expect(win.locator('.ctx-submenu')).toBeVisible();
    await menu.press('Escape');
    await expect(win.locator('.ctx-submenu')).toHaveCount(0);
    await expect(win.locator('.ctx-menu')).toHaveCount(1);
    await menu.press('Escape');

    // Settings › Terminal › Default profile: bash. The next terminal is bash; the Atelier one now shows its chip.
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    await expect(dialog.locator('.set-notice')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Default profile: Atelier' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reload' })).toBeVisible();
    await look(win, 'test-results/profiles-settings.png', { settle: 400 }); // after the entrance animations
    await dialog.getByRole('button', { name: 'Default profile: Atelier' }).click();
    await look(win, 'test-results/profiles-settings-menu.png', { settle: 400 }); // after the entrance animations
    await win.getByRole('menuitem', { name: 'bash', exact: true }).click();
    await expect.poll(() => prefs(home).terminalProfile).toBe('/bin/bash');
    await expect(dialog.getByRole('button', { name: 'Default profile: bash' })).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'new-terminal'));
    await expect(win.locator('.term-row')).toHaveCount(3, { timeout: 10000 });
    await expect.poll(async () => (await terminals(win)).filter((x) => typeof x.profile === 'object').map((x) => x.profile)).toEqual([{ shell: '/bin/bash' }]);
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('echo "shell=$0"\n');
    await expect(screen(win)).toContainText(/shell=\S*bash/, { timeout: 5000 });
    await expect(win.locator('.term-row .profile-chip')).toHaveText(['Atelier', 'zsh']);
    await look(win, 'test-results/profiles-chips.png');

    // Palette: one entry per profile, and the environment reload (done with a toast).
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>New terminal:');
    for (const label of ['New terminal: Atelier', 'New terminal: zsh (your config)', 'New terminal: bash']) await expect(win.locator('.palette-item', { hasText: label })).toHaveCount(1);
    await win.locator('.palette-input').fill('Reload shell');
    await win.locator('.palette-item', { hasText: 'Reload shell environment' }).click();
    await expect(win.locator('.toast')).toContainText('Shell environment reloaded', { timeout: 20000 });
  } finally {
    await stop(app, home);
  }
});

test('an atelierd without profiles: no profile is sent, profile entries are off, Settings explains how to get them', async () => {
  const { app, home, win } = await launch({ ATELIER_TEST_NO_PROFILES: '1' });
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    // Not sent: atelierd started its default, the user's zsh, although the setting says Atelier.
    await expect.poll(async () => (await terminals(win)).map((x) => x.profile)).toEqual(['user']);
    await expect(win.locator('.profile-chip')).toHaveCount(0);

    await win.locator('.tab-new').click();
    await expect(win.getByRole('menuitem', { name: 'Terminal with Profile' })).toBeDisabled();
    await win.keyboard.press('Escape');

    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>New terminal');
    await expect(win.locator('.palette-item', { hasText: 'New terminal' }).first()).toBeVisible();
    await expect(win.locator('.palette-item', { hasText: 'New terminal:' })).toHaveCount(0);
    await win.locator('.palette-input').fill('Reload shell');
    await expect(win.locator('.palette-item')).toHaveCount(0);
    await win.keyboard.press('Escape');

    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const notice = dialog.locator('.set-notice');
    // Hidden capabilities: an atelierd older than profiles (and than v2.0): one notice says both.
    await expect(notice).toContainText('Terminal profiles, richer session states and command blocks need a newer atelierd. Restart atelierd (closes running terminals; Claude sessions can be resumed).');
    await expect(dialog.getByRole('button', { name: 'Reload' })).toHaveCount(0);
    await look(win, 'test-results/profiles-notice.png', { settle: 400 }); // after the entrance animations
    // The button is File › Restart atelierd: its confirmation (answered Cancel here) comes first.
    await app.evaluate(({ dialog: d }) => {
      (globalThis as { asked?: string }).asked = '';
      d.showMessageBox = (async (...args: unknown[]) => { (globalThis as { asked?: string }).asked = (args.at(-1) as { message: string }).message; return { response: 1, checkboxChecked: false }; }) as typeof d.showMessageBox;
    });
    await notice.getByRole('button', { name: 'Restart atelierd…' }).click();
    // Asked in the window, over Settings: Cancel keeps everything, Settings stays open.
    const sheet = win.locator('.confirm-sheet');
    await expect(sheet).toContainText('Restart atelierd?');
    await expect(sheet).toContainText('Every terminal and Claude session closes.');
    await expect(sheet.getByRole('button', { name: /^Cancel/ })).toBeFocused();
    await look(win, 'test-results/confirm-restart.png', { settle: 400 });
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await app.evaluate(() => (globalThis as { asked?: string }).asked)).toBe('');
    await expect.poll(async () => (await terminals(win)).length).toBe(1);
  } finally {
    await stop(app, home);
  }
});

// A config that fails the capture (it has no terminal there): Atelier terminals open in the user's zsh, with its chip,
// and Settings › Terminal says why next to Reload.
test('failed shell environment capture: Settings says why, new terminals open in your zsh', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  writeFileSync(join(env.ZDOTDIR!, '.zshrc'), '[[ -t 0 ]] || exit 3\nPS1="userzsh$ "\n');
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  try {
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const notice = dialog.locator('.set-notice', { hasText: 'Could not read your shell environment' });
    await expect(notice).toBeVisible({ timeout: 20000 });
    await expect(notice).toContainText('exited (3)');
    await expect(notice).toContainText('open with your zsh config');
    await look(win, 'test-results/profiles-env-failed.png', { settle: 400 });
    await win.keyboard.press('Escape');
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(screen(win)).toContainText('userzsh$', { timeout: 10000 });
    await expect.poll(async () => (await terminals(win)).map((x) => x.profile)).toEqual(['user']);
    await expect(win.locator('.term-row .profile-chip')).toHaveText(['zsh']);
  } finally {
    await stop(app, home);
  }
});

// Spec Atelier profile aliases: the e2e user's own zsh config defines an alias; Atelier terminals get it, and
// Settings › Terminal › Aliases from your shell leaves it out of the next terminals.
test('aliases from your shell: an Atelier terminal runs the user\'s alias; turned off in Settings, new terminals go without', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  writeFileSync(join(env.ZDOTDIR!, '.zshrc'), "alias greet='echo ALIAS-$((6*7))'\n");
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(screen(win)).toContainText('›', { timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    await win.keyboard.type('greet\n');
    await expect(screen(win)).toContainText('ALIAS-42', { timeout: 5000 });

    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const toggle = dialog.getByRole('switch', { name: 'Aliases from your shell' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The e2e config's alias plus zsh's own (run-help, which-command).
    await expect(dialog.locator('.set-row', { hasText: 'Aliases from your shell' })).toContainText(/: \d+ found\./);
    await expect(dialog.locator('.set-notice')).toHaveCount(0);
    await look(win, 'test-results/profiles-aliases-settings.png', { settle: 400 }); // after the entrance animations
    await toggle.click();
    await expect.poll(() => prefs(home).terminalAliases).toBe(false);
    await win.keyboard.press('Escape');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'new-terminal'));
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 10000 });
    await expect(screen(win)).toContainText('›', { timeout: 10000 });
    await win.locator('.xterm-helper-textarea:visible').focus();
    // Computed markers: the typed line is echoed, the results only appear as output.
    await win.keyboard.type('alias greet >/dev/null && echo HAS-$((1+1)) || echo NO-$((2+2))\n');
    await expect(screen(win)).toContainText(/NO-4|HAS-2/, { timeout: 5000 });
    await expect(screen(win)).toContainText('NO-4');
  } finally {
    await stop(app, home);
  }
});

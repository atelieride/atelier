import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Shell environment auto-reload: the e2e user's zsh config (the empty
// ZDOTDIR of e2eEnv) gains an alias after atelierd captured it; the next Atelier terminal reloads first and has it.

async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; home: string; win: Page; zdot: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ...extra });
  const zdot = env.ZDOTDIR!;
  writeFileSync(join(zdot, '.zshrc'), "alias greet='echo GREET-$((6*7))'\n");
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  // The first capture is over: Atelier terminals use it (before that they fall back to the user's zsh).
  await expect.poll(() => win.evaluate(async () => (await (window as unknown as { atelier: AtelierApi }).atelier.daemonState())?.shellEnv?.state), { timeout: 15000 }).toBe('ready');
  return { app, home, win, zdot };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const prefs = (home: string) => JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')) as Record<string, unknown>;
const screen = (win: Page) => win.locator('.xterm-rows:visible');
const newTerminal = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'new-terminal'));

let probe = 0;
/**
 * Runs `alias name` in the focused terminal: computed markers (the echoed line can't contain them), new ones for every
 * call (the screen keeps earlier answers), say whether the alias exists.
 */
async function hasAlias(win: Page, name: string): Promise<boolean> {
  const n = ++probe * 100;
  await expect(screen(win)).toContainText('›', { timeout: 10000 });
  await win.locator('.xterm-helper-textarea:visible').focus();
  await win.keyboard.type(`alias ${name} >/dev/null && echo HAS-$((${n}+1)) || echo NO-$((${n}+2))\n`);
  await expect(screen(win)).toContainText(new RegExp(`HAS-${n + 1}|NO-${n + 2}`), { timeout: 5000 });
  return (await screen(win).textContent())!.includes(`HAS-${n + 1}`);
}

test('an alias added to .zshrc after the capture: the next Atelier terminal reloads first (toast) and has it', async () => {
  const { app, home, win, zdot } = await launch();
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    expect(await hasAlias(win, 'greet')).toBe(true);
    expect(await hasAlias(win, 'hello')).toBe(false);

    appendFileSync(join(zdot, '.zshrc'), "alias hello='echo HELLO-$((7*6))'\n");
    await newTerminal(app);
    await expect(win.locator('.toast')).toContainText('Reloading the shell environment: .zshrc changed…', { timeout: 10000 });
    await win.waitForTimeout(300); // entrance animation
    await look(win, 'test-results/shell-env-auto-toast.png');
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 15000 });
    expect(await hasAlias(win, 'hello')).toBe(true);
    await win.keyboard.type('hello\n');
    await expect(screen(win)).toContainText('HELLO-42', { timeout: 5000 });
  } finally {
    await stop(app, home);
  }
});

test('turned off in Settings: no reload until Reload; Checked files lists zsh\'s files and the added ones', async () => {
  const extra = mkdtempSync(join(tmpdir(), 'atl-e2e-extra-'));
  writeFileSync(join(extra, 'aliases.zsh'), '# sourced by .zshrc\n');
  const { app, home, win, zdot } = await launch({ ATELIER_TEST_PICK_FILES: `${join(extra, 'aliases.zsh')}${delimiter}${join(extra, 'gone.zsh')}` });
  try {
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Terminal' }).click();
    const section = dialog.getByRole('region', { name: 'Checked files' });
    // zsh's four startup files, in the e2e ZDOTDIR: its .zprofile (PATH fix) and our .zshrc exist.
    await expect(section.locator('.chk-file.is-builtin')).toHaveCount(4);
    await expect(section.locator('.chk-file.is-builtin:not(.is-absent)')).toHaveText([/\.zprofile/, /\.zshrc/]);
    await section.getByRole('button', { name: 'Add File…' }).click();
    await expect.poll(() => prefs(home).shellEnvWatchFiles).toEqual([join(extra, 'aliases.zsh'), join(extra, 'gone.zsh')]);
    await expect(section.locator('.chk-file:not(.is-builtin)')).toHaveCount(2);
    await expect(section.locator('.chk-file', { hasText: 'gone.zsh' }).locator('.chk-chip')).toHaveText('Not found');
    await expect(section.locator('.chk-file', { hasText: 'aliases.zsh' }).locator('.chk-chip')).toHaveCount(0);
    await win.waitForTimeout(400); // entrance animations
    await dialog.locator('.set-row', { hasText: 'Shell environment' }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await look(win, 'test-results/shell-env-auto-settings.png');
    await section.getByRole('button', { name: /Stop checking .*gone\.zsh/ }).click();
    await expect.poll(() => prefs(home).shellEnvWatchFiles).toEqual([join(extra, 'aliases.zsh')]);
    await expect(section.locator('.chk-file:not(.is-builtin)')).toHaveCount(1);
    // The keyboard stays in the list: the remaining file's remove button.
    await expect(section.getByRole('button', { name: /Stop checking .*aliases\.zsh/ })).toBeFocused();

    const toggle = dialog.getByRole('switch', { name: 'Reload when zsh files change' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect.poll(() => prefs(home).shellEnvAutoReload).toBe(false);
    await expect(section).toHaveClass(/is-off/);
    await win.keyboard.press('Escape');

    appendFileSync(join(zdot, '.zshrc'), "alias hello='echo HELLO'\n");
    await newTerminal(app);
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 15000 });
    expect(await hasAlias(win, 'hello')).toBe(false);

    // The manual Reload (File › Reload Shell Environment): the next terminal has it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'reload-shell-env'));
    await expect(win.locator('.toast')).toContainText('Shell environment reloaded', { timeout: 15000 });
    await newTerminal(app);
    await expect(win.locator('.term-row')).toHaveCount(2, { timeout: 15000 });
    expect(await hasAlias(win, 'hello')).toBe(true);

    // The palette turns it back on (its hint says the current state).
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Shell environment auto-reload');
    await expect(win.locator('.palette-item', { hasText: 'Shell environment auto-reload' })).not.toContainText('On');
    await win.keyboard.press('Enter');
    await expect.poll(() => prefs(home).shellEnvAutoReload).toBe(true);
  } finally {
    await stop(app, home);
  }
});

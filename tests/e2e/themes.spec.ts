import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Themes: Settings › Appearance picks one and everything follows at once (page,
// terminals, main's window); the palette previews and Esc goes back; light themes can keep terminals dark and say how
// Claude Code follows; the choice survives a relaunch.
const SHOTS = 'test-results/themes';
type Api = { settings: { get(): Promise<{ theme: string; terminalColors: string }> } };

const command = (app: ElectronApplication, c: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), c);
const css = (win: Page, sel: string, prop: string) => win.locator(sel).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const dataTheme = (win: Page) => win.evaluate(() => document.documentElement.dataset.theme ?? 'aurora');
const windowBg = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor());
const themeSource = (app: ElectronApplication) => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
const saved = (win: Page) => win.evaluate(() => (window as unknown as { atelier: Api }).atelier.settings.get());
// Poppins fetched and in the page's font set (document.fonts.check() is true for a family that isn't there at all).
const poppinsLoaded = (win: Page) => win.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Poppins' && f.weight === '600' && f.status === 'loaded'));

async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

test('Settings › Appearance › Theme: the app, its terminals and its window switch at once; light themes keep terminals dark on request; a relaunch keeps it', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'a.ts'), 'export const answer = 42;\n');
  const { env } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  let app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    let win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toBeVisible({ timeout: 10000 });
    expect(await dataTheme(win)).toBe('aurora');
    expect(await windowBg(app)).toBe('#08080F');
    // Aurora's mark: solid in the brand (the middle of violet and pink), a white Λ.
    const brand = await win.evaluate(() => { const p = document.createElement('i'); p.style.color = 'var(--brand)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    expect(await win.locator('.project-chip .logo stop').evaluateAll((s) => s.map((e) => getComputedStyle(e).stopColor))).toEqual([brand, brand]);
    expect(await css(win, '.project-chip .logo path', 'stroke')).toBe('rgb(255, 255, 255)');

    await command(app, 'open-settings');
    const themes = win.getByRole('radiogroup', { name: 'Theme' });
    await expect(themes.getByRole('radio')).toHaveText([/Aurora/, /Ember/, /Tide/, /Daylight/, /Minimal · Ink/, /Minimal · Paper/, /Docsy/, /Docsy Night/]);
    // Rows of three: the dark Aurora-likes, then Daylight and Minimal, then Docsy's pair.
    const tops = await themes.getByRole('radio').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(new Set(tops.slice(0, 3)).size).toBe(1);
    expect(new Set(tops.slice(3, 6)).size).toBe(1);
    expect(new Set(tops.slice(6)).size).toBe(1);
    expect(tops[3]).toBeGreaterThan(tops[0]!);
    expect(tops[6]).toBeGreaterThan(tops[3]!);
    // Each card draws its own theme's states, whatever the app's (the waiting dot is the card's mark).
    const cardDot = (id: string) => css(win, `.theme-card[data-value="${id}"] .tt-row i.is-waiting`, 'background-color');
    expect(await cardDot('paper')).toBe('rgb(154, 98, 0)');
    expect(await cardDot('docsy')).toBe('rgb(255, 178, 36)');
    // Each card is named by its theme alone (aria-checked says which is in use).
    await expect(themes.getByRole('radio', { name: 'Aurora', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(themes.getByRole('radio', { name: 'Minimal · Paper', exact: true })).toHaveAttribute('aria-checked', 'false');
    // Dark theme: no terminal colors row, no Claude note.
    await expect(win.getByRole('radiogroup', { name: 'Terminal colors' })).toHaveCount(0);
    await look(win.locator('.settings'), `${SHOTS}/settings-aurora.png`);

    // Ember: another dark theme with Aurora's finish — the page, the terminal, main's window.
    await themes.getByRole('radio', { name: 'Ember', exact: true }).click();
    await expect.poll(() => dataTheme(win)).toBe('ember');
    await expect.poll(() => css(win, 'body', 'background-color')).toBe('rgb(14, 10, 8)');
    await expect.poll(() => css(win, '.terminal-slot', 'background-color')).toBe('rgb(24, 18, 15)');
    await expect.poll(() => windowBg(app)).toBe('#0E0A08');
    expect(await themeSource(app)).toBe('dark');
    await expect(win.getByRole('radiogroup', { name: 'Terminal colors' })).toHaveCount(0);
    await look(win.locator('.settings'), `${SHOTS}/settings-ember.png`);

    // Paper: the page, the terminal (xterm and the slot around it), main's window and native appearance. The colors
    // cross-fade for a moment: the mark comes and goes.
    await win.evaluate(() => {
      const w = window as unknown as { fades: number };
      w.fades = 0;
      new MutationObserver(() => { if (document.documentElement.hasAttribute('data-theme-fade')) w.fades++; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-fade'] });
    });
    await themes.getByRole('radio', { name: /Minimal · Paper/ }).click();
    await expect.poll(() => dataTheme(win)).toBe('paper');
    expect(await win.evaluate(() => (window as unknown as { fades: number }).fades)).toBeGreaterThan(0);
    await expect(win.locator('html[data-theme-fade]')).toHaveCount(0);
    await expect.poll(() => css(win, 'body', 'background-color')).toBe('rgb(247, 247, 246)');
    await expect.poll(() => css(win, '.terminal-slot', 'background-color')).toBe('rgb(255, 255, 255)');
    await expect.poll(() => css(win, '.terminal-slot .xterm-rows', 'color')).toBe('rgb(31, 31, 33)');
    await expect.poll(() => windowBg(app)).toBe('#F7F7F6');
    expect(await themeSource(app)).toBe('light');
    expect((await saved(win)).theme).toBe('paper');
    // Light: the terminal colors row and the note on Claude Code's own colors.
    const termColors = win.getByRole('radiogroup', { name: 'Terminal colors' });
    await expect(termColors.getByRole('radio', { name: 'Follow theme' })).toHaveAttribute('aria-checked', 'true');
    await expect(win.locator('.settings')).toContainText('Claude Code picks its own colors. In each session run /theme and choose a light one.');
    await look(win.locator('.settings'), `${SHOTS}/settings-paper.png`);

    // Always dark: Paper's terminals take Ink's colors; the note goes (nothing to adjust in Claude then).
    await termColors.getByRole('radio', { name: 'Always dark' }).click();
    await expect.poll(() => css(win, '.terminal-slot', 'background-color')).toBe('rgb(20, 20, 21)');
    await expect.poll(() => css(win, '.terminal-slot .xterm-rows', 'color')).toBe('rgb(218, 218, 220)');
    await expect(win.locator('.settings')).not.toContainText('Claude Code picks its own colors');
    expect((await saved(win)).terminalColors).toBe('dark');
    await win.keyboard.press('Escape');
    await look(win, `${SHOTS}/paper-always-dark.png`);
    // The editor follows the theme, not the terminals: Paper's white, Paper's keyword color.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('a.ts');
    await win.locator('.palette-item', { hasText: 'a.ts' }).first().click();
    const keyword = win.locator('.cm-content span[style*="var(--syn-keyword)"]').first();
    await expect(keyword).toBeVisible({ timeout: 10000 });
    expect(await css(win, '.file-view:visible .cm-editor', 'background-color')).toBe('rgb(255, 255, 255)');
    expect(await keyword.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(163, 56, 95)');
    await look(win, `${SHOTS}/paper-editor.png`);

    // Arrow keys move between the cards and choose, as in every radio group.
    await command(app, 'open-settings');
    await themes.getByRole('radio', { name: /Minimal · Paper/ }).focus();
    await win.keyboard.press('ArrowLeft');
    await expect(themes.getByRole('radio', { name: /Minimal · Ink/ })).toHaveAttribute('aria-checked', 'true');
    expect(await dataTheme(win)).toBe('ink');
    expect(await themeSource(app)).toBe('dark');

    // Docsy: ice grey and Poppins, gold to cobalt on the tab's crown; with "Always dark" (still chosen)
    // its terminals take Docsy Night's colors.
    await themes.getByRole('radio', { name: 'Docsy', exact: true }).click();
    await expect.poll(() => dataTheme(win)).toBe('docsy');
    await expect.poll(() => css(win, 'body', 'background-color')).toBe('rgb(245, 246, 248)');
    await expect.poll(() => windowBg(app)).toBe('#F5F6F8');
    expect(await themeSource(app)).toBe('light');
    expect(await css(win, 'body', 'font-family')).toMatch(/^Poppins,/);
    await expect.poll(() => poppinsLoaded(win)).toBe(true);
    expect(await css(win, '.tab.is-active', 'background-image')).toContain('linear-gradient(90deg, rgb(255, 178, 36), rgb(48, 91, 171))');
    // The mark at the top left takes Docsy's brand (its cobalt pair), its Λ Docsy's gold.
    expect(await css(win, '.project-chip .logo stop', 'stop-color')).toBe(await win.evaluate(() => { const p = document.createElement('i'); p.style.color = 'var(--brand)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; }));
    expect(await css(win, '.project-chip .logo path', 'stroke')).toBe('rgb(255, 178, 36)');
    await expect.poll(() => css(win, '.terminal-slot', 'background-color')).toBe('rgb(17, 26, 44)');
    await look(win.locator('.settings'), `${SHOTS}/settings-docsy.png`);
    await win.keyboard.press('ArrowRight');
    await expect.poll(() => dataTheme(win)).toBe('docsy-night');
    await expect.poll(() => css(win, 'body', 'background-color')).toBe('rgb(10, 19, 36)');
    await expect.poll(() => windowBg(app)).toBe('#0A1324');
    expect(await themeSource(app)).toBe('dark');
    await win.keyboard.press('Escape');
    await look(win, `${SHOTS}/docsy-night.png`);

    // A relaunch opens on the theme: the window's first paint and the page, in Poppins.
    await app.close();
    app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
    win = await app.firstWindow();
    expect(await windowBg(app)).toBe('#0A1324');
    // The page knows its theme before React mounts (no Aurora frame, no fade at launch).
    expect(await win.evaluate(() => (window as unknown as { atelier: { bootTheme: string } }).atelier.bootTheme)).toBe('docsy-night');
    await expect.poll(() => dataTheme(win)).toBe('docsy-night');
    await expect.poll(() => poppinsLoaded(win)).toBe(true);
  } finally {
    await app.close();
  }
});

test('Change Theme…: from the palette and the View menu; moving the selection previews, Esc goes back, Enter keeps', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toBeVisible({ timeout: 10000 });

    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>theme');
    await win.locator('.palette-item', { hasText: 'Change theme…' }).click();
    const sheet = win.getByRole('dialog', { name: 'Change Theme' });
    await expect(sheet.getByRole('option')).toHaveText([/Aurora/, /Ember/, /Tide/, /Daylight/, /Minimal · Ink/, /Minimal · Paper/, /Docsy/, /Docsy Night/]);
    await expect(sheet.getByRole('option', { name: /Aurora/ })).toHaveAttribute('aria-selected', 'true');

    // Down: Ember, then Tide, on the whole window, terminals too; nothing saved yet.
    await win.keyboard.press('ArrowDown');
    expect(await dataTheme(win)).toBe('ember');
    await expect.poll(() => css(win, '.terminal-slot', 'background-color')).toBe('rgb(24, 18, 15)');
    await look(win, `${SHOTS}/palette-preview-ember.png`);
    await win.keyboard.press('ArrowDown');
    expect(await dataTheme(win)).toBe('tide');
    await expect.poll(() => css(win, '.terminal-slot', 'background-color')).toBe('rgb(11, 21, 27)');
    expect((await saved(win)).theme).toBe('aurora');
    await look(win, `${SHOTS}/palette-preview-tide.png`);
    // The pointer previews too; Esc goes back to the theme in use.
    await sheet.getByRole('option', { name: /Minimal · Ink/ }).hover();
    expect(await dataTheme(win)).toBe('ink');
    // Another setting changing meanwhile (another window, a menu) leaves the preview on screen.
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ showHiddenFiles: true }));
    await win.waitForFunction(() => document.documentElement.dataset.theme === 'ink');
    await win.waitForTimeout(300);
    expect(await dataTheme(win)).toBe('ink');
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(await dataTheme(win)).toBe('aurora');
    await expect.poll(() => css(win, '.terminal-slot', 'background-color')).toBe('rgb(16, 16, 28)');

    // Searching previews the first match, so Enter keeps what is on screen; Esc goes back.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>theme');
    await win.locator('.palette-item', { hasText: 'Change theme…' }).click();
    await sheet.getByRole('combobox').fill('paper');
    await expect.poll(() => dataTheme(win)).toBe('paper');
    await win.keyboard.press('Escape');
    await expect.poll(() => dataTheme(win)).toBe('aurora');

    // View › Change Theme…: Enter keeps what is previewed.
    await menu(app, 'Change Theme…');
    await expect(sheet).toBeVisible();
    for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter');
    await expect(sheet).toHaveCount(0);
    expect(await dataTheme(win)).toBe('daylight');
    await expect.poll(async () => (await saved(win)).theme).toBe('daylight');
    await expect.poll(() => windowBg(app)).toBe('#F4F3FA');
    await expect.poll(() => css(win, '.terminal-slot', 'background-color')).toBe('rgb(255, 255, 255)');
    await look(win, `${SHOTS}/daylight.png`);
  } finally {
    await app.close();
  }
});

// The app icon follows Docsy's themes: the Dock's icon changes with the applied
// theme, not a preview; Docsy and Docsy Night share it; a relaunch starts on it. In development the bundle's own icon
// is never eligible (only the installed app's is), so nothing is written and no marker appears.
test('App icon: Docsy\'s themes put the Docsy image in the Dock at once, a preview does not, a relaunch keeps it; the bundle is left alone', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const iconLog = join(home, 'test-app-icon.log');
  env.ATELIER_TEST_APP_ICON_LOG = iconLog;
  const lines = () => { try { return readFileSync(iconLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>); } catch { return []; } };
  const set = (win: Page, theme: string) => win.evaluate((t) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ theme: t }), theme);
  let app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    let win = await app.firstWindow();
    // Aurora: the dev icon before ready and again after; the bundle is not eligible in development.
    await expect.poll(lines).toEqual([{ runtime: 'dev' }, { runtime: 'dev' }, { bundle: 'ineligible' }]);

    // A preview in Change Theme… leaves the Dock alone.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.terminal-slot:visible .xterm-rows')).toBeVisible({ timeout: 10000 });
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>theme');
    await win.locator('.palette-item', { hasText: 'Change theme…' }).click();
    const sheet = win.getByRole('dialog', { name: 'Change Theme' });
    // Docsy, the first of the two (Docsy Night follows it).
    await sheet.getByRole('option', { name: /Docsy/ }).first().hover();
    await expect.poll(() => dataTheme(win)).toBe('docsy');
    await win.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(lines()).toHaveLength(3);

    // Applied: the Docsy image at once, then the bundle's turn (none here).
    await set(win, 'docsy');
    await expect.poll(() => lines().slice(3)).toEqual([{ runtime: 'docsy' }, { bundle: 'ineligible' }]);
    // Docsy Night wears the same icon: nothing runs.
    await set(win, 'docsy-night');
    await expect.poll(() => dataTheme(win)).toBe('docsy-night');
    expect(lines()).toHaveLength(5);

    // A relaunch on Docsy Night starts on the Docsy image.
    await app.close();
    writeFileSync(iconLog, '');
    app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
    win = await app.firstWindow();
    await expect.poll(lines).toEqual([{ runtime: 'docsy' }, { runtime: 'docsy' }, { bundle: 'ineligible' }]);

    // Back to Aurora: the bundle's turn first, then the dev icon again.
    await set(win, 'aurora');
    await expect.poll(() => lines().slice(3)).toEqual([{ bundle: 'ineligible' }, { runtime: 'dev' }]);
    expect(existsSync(join(home, 'app-icon.json'))).toBe(false);
  } finally {
    await app.close();
  }
});

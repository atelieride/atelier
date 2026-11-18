// A project's color end to end: each project's window wears one of eight colors (its chip, and a faint tint
// of the header), picked when the window first opens so that open windows differ, changed from the chip's
// right-click menu or the Project Color… command, remembered across relaunches, and turned off in Settings › Appearance.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

const SHOTS = 'test-results/project-color';

const folder = (name: string): string => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'atl-pc-'))), name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.ts'), 'export const answer = 42;\n');
  return dir;
};
const command = (app: ElectronApplication, c: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), c);
const worn = (win: Page) => win.evaluate(() => document.documentElement.dataset.projectColor ?? null);
const css = (win: Page, sel: string, prop: string) => win.locator(sel).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
/** A theme token as the page resolves it. */
const token = (win: Page, name: string) => win.evaluate((n) => { const p = document.createElement('i'); p.style.color = `var(${n})`; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; }, name);
const savedColors = (home: string): Record<string, number> => (JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')) as { projectColors: Record<string, number> }).projectColors;
const stopDaemon = (home: string) => { try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ } };

test('a project window wears its color; the chip\'s menu and the command change it, a relaunch keeps it, Settings turns it off', async () => {
  const root = folder('alpha');
  const made = e2eEnv();
  let app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env: made.env });
  try {
    let win = await app.firstWindow();
    await expect(win.locator('.project-chip')).toBeVisible({ timeout: 15000 });
    // Picked when the window opened, saved at once, and worn by the page.
    await expect.poll(() => worn(win)).toMatch(/^[1-8]$/);
    const first = Number(await worn(win));
    expect(savedColors(made.home)[root]).toBe(first);
    await look(win, `${SHOTS}/first.png`, { settle: 300 });

    // Right-click the chip: Project Color › the eight colors, the worn one checked.
    await win.locator('.project-chip .project-reveal').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Project Color' }).hover();
    const choices = win.getByRole('menuitemradio');
    await expect(choices).toHaveCount(8);
    await expect(win.getByRole('menuitemradio', { checked: true })).toHaveCount(1);
    await look(win, `${SHOTS}/menu.png`, { settle: 200 });
    const next = first === 2 ? 6 : 2;
    await choices.nth(next - 1).click();
    await expect.poll(() => worn(win)).toBe(String(next));
    expect(savedColors(made.home)[root]).toBe(next);
    // The chip's edge is mixed from the color.
    const hue = await token(win, `--ws-${next}`);
    expect(await token(win, '--proj')).toBe(hue);
    // Quiet on purpose: no colored line across the header or the footer, only the chip and a faint header tint.
    expect(await css(win, '.header', 'box-shadow')).toBe('none');
    expect(await css(win, '.footer', 'box-shadow')).toBe('none');
    expect(await css(win, '.header', 'background-color')).not.toBe('rgba(0, 0, 0, 0)');
    expect(await css(win, '.project-chip', 'border-top-color')).not.toBe(await token(win, '--line'));
    await look(win, `${SHOTS}/changed.png`, { settle: 300 });

    // The command (menu bar, palette) opens the same choices under the chip.
    await command(app, 'project-color');
    await expect(win.getByRole('menuitemradio')).toHaveCount(8);
    await win.keyboard.press('Escape');
    await expect(win.getByRole('menuitemradio')).toHaveCount(0);
    await command(app, 'open-palette');
    await win.locator('.palette-input').fill('>Project color');
    await expect(win.locator('.palette-item.is-active')).toContainText('Project color…');
    await win.keyboard.press('Enter');
    await expect(win.getByRole('menuitemradio')).toHaveCount(8);
    await win.keyboard.press('Escape');

    await app.close();
    app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env: made.env });
    win = await app.firstWindow();
    await expect(win.locator('.project-chip')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => worn(win)).toBe(String(next));

    // Settings › Appearance: off, no window wears a color and the chip is as it was.
    await command(app, 'open-settings');
    const toggle = win.getByRole('switch', { name: 'Tint windows by project' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await look(win.getByRole('dialog', { name: 'Settings' }), `${SHOTS}/settings.png`, { settle: 200 });
    await toggle.click();
    await expect.poll(() => worn(win)).toBeNull();
    const line = await token(win, '--line');
    await expect.poll(() => css(win, '.project-chip', 'border-top-color')).toBe(line);
  } finally {
    await app.close();
    stopDaemon(made.home);
  }
});

test('two projects open side by side wear different colors', async () => {
  const a = folder('alpha');
  const b = folder('beta');
  const made = e2eEnv();
  // Both windows were open at the last quit: a launch reopens them.
  writeFileSync(join(made.home, 'ui-state.json'), JSON.stringify({ openProjects: [a, b], recent: [a, b] }));
  const app = await electron.launch({ args: ['out/main/index.js'], env: made.env });
  try {
    await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(2);
    const colors: string[] = [];
    for (const win of app.windows()) {
      await expect(win.locator('.project-chip')).toBeVisible({ timeout: 15000 });
      await expect.poll(() => worn(win)).toMatch(/^[1-8]$/);
      colors.push((await worn(win))!);
      await look(win, `${SHOTS}/side-${colors.length}.png`, { settle: 300 });
    }
    expect(colors[0]).not.toBe(colors[1]);
    expect(Object.keys(savedColors(made.home)).sort()).toEqual([a, b].sort());
  } finally {
    await app.close();
    stopDaemon(made.home);
  }
});

test('the welcome window shows each recent project in its color; its right-click menu changes it there', async () => {
  const a = folder('alpha');
  const b = folder('beta');
  const made = e2eEnv();
  writeFileSync(join(made.home, 'ui-state.json'), JSON.stringify({ openProjects: [], recent: [a, b] }));
  // alpha was colored before; beta was never opened since projects have colors.
  writeFileSync(join(made.home, 'preferences.json'), JSON.stringify({ projectColors: { [a]: 3 } }));
  const app = await electron.launch({ args: ['out/main/index.js'], env: made.env });
  try {
    const win = await app.firstWindow();
    const row = (name: string) => win.locator('.recent-row', { hasText: name });
    await expect(row('alpha')).toBeVisible({ timeout: 15000 });
    await expect(row('alpha')).toHaveAttribute('data-project-color', '3');
    expect(await row('alpha').locator('svg').first().evaluate((el) => getComputedStyle(el).color)).toBe(await token(win, '--ws-3'));
    expect(await row('beta').getAttribute('data-project-color')).toBeNull();
    await look(win, `${SHOTS}/welcome.png`, { settle: 300 });

    await row('beta').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Project Color' }).hover();
    await expect(win.getByRole('menuitemradio')).toHaveCount(8);
    await expect(win.getByRole('menuitemradio', { checked: true })).toHaveCount(0);
    await look(win, `${SHOTS}/welcome-menu.png`, { settle: 200 });
    await win.getByRole('menuitemradio').nth(1).click();
    await expect(row('beta')).toHaveAttribute('data-project-color', '2');
    expect(savedColors(made.home)).toEqual({ [a]: 3, [b]: 2 });
    await look(win, `${SHOTS}/welcome-changed.png`, { settle: 300 });
  } finally {
    await app.close();
    stopDaemon(made.home);
  }
});

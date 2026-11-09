// Services (tmux) and Automations are off until turned on in Settings (2026-11-02): no side-bar view, menu item or
// palette command until then; turned on, they show at once; turned off, the view and its tab go at once.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const icon = (win: Page, name: string) => win.locator(`.activity-bar .act[aria-label^="${name}"]`);
const prefs = (home: string) => { try { return JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')) as Record<string, unknown>; } catch { return {}; } };
/** View's item (the native menu): whether it shows, and its click as its key would send it, shown or not. */
const viewItem = (app: ElectronApplication, label: string, click = false) => app.evaluate(({ Menu, BrowserWindow }, o) => {
  const view = Menu.getApplicationMenu()!.items.find((m) => m.label === 'View')!.submenu!.items.find((it) => it.label === o.label)!;
  if (o.click) view.click(undefined, BrowserWindow.getAllWindows()[0]);
  return view.visible;
}, { label, click });
const commands = async (win: Page, query: string) => {
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill(`>${query}`);
  const labels = await win.locator('.palette-item .palette-label').allTextContents();
  await win.keyboard.press('Escape');
  return labels;
};

test('Services and Automations: hidden by default, shown once turned on in Settings, gone again when turned off', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(icon(win, 'Sessions')).toBeVisible({ timeout: 15000 });
    await expect(icon(win, 'Files')).toBeVisible();
    // Off by default: no icon, no View item, no palette command, and ⌘⇧A (a hidden item keeps its key) does nothing.
    await expect(icon(win, 'Services')).toHaveCount(0);
    await expect(icon(win, 'Automations')).toHaveCount(0);
    expect([await viewItem(app, 'Services'), await viewItem(app, 'Automations')]).toEqual([false, false]);
    expect(await commands(win, 'automation')).toEqual([]);
    expect(await commands(win, 'go to services')).toEqual([]);
    await viewItem(app, 'Automations', true);
    await viewItem(app, 'Services', true);
    await expect(win.locator('.tab[data-key^="au:"]')).toHaveCount(0);
    await expect(icon(win, 'Sessions')).toHaveClass(/is-active/);

    // Settings › Appearance › Services (tmux): on, the icon shows at once (and is saved).
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.locator('.set-nav-item', { hasText: 'Appearance' }).click();
    await dialog.getByRole('switch', { name: 'Services (tmux)' }).click();
    await expect(icon(win, 'Services')).toBeVisible();
    await expect.poll(() => prefs(home).showServices).toBe(true);
    // Settings › Automations: only the switch until it is on, then the rest of the section.
    await dialog.locator('.set-nav-item', { hasText: 'Automations' }).click();
    await expect(dialog.getByRole('switch', { name: 'Pause all automations' })).toHaveCount(0);
    await dialog.getByRole('switch', { name: 'Use automations' }).click();
    await expect(dialog.getByRole('switch', { name: 'Pause all automations' })).toBeVisible();
    await expect(icon(win, 'Automations')).toBeVisible();
    await expect.poll(() => viewItem(app, 'Automations')).toBe(true);
    expect(await viewItem(app, 'Services')).toBe(true);
    await look(win, 'test-results/optional-views-settings.png');
    await win.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Both views open. No automation anywhere yet: Automations opens no tab.
    await icon(win, 'Automations').click();
    await expect(icon(win, 'Automations')).toHaveClass(/is-active/);
    await expect(win.locator('.tab[data-key^="au:"]')).toHaveCount(0);
    await icon(win, 'Services').click();
    await expect(icon(win, 'Services')).toHaveClass(/is-active/);
    expect(await commands(win, 'automations')).toContain('Show All Automations');

    // Turned off again: the icons, the side-bar views and the Automations tab go at once.
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ showServices: false, automationsEnabled: false }));
    await expect(icon(win, 'Services')).toHaveCount(0);
    await expect(icon(win, 'Automations')).toHaveCount(0);
    await expect(win.locator('.tab[data-key^="au:"]')).toHaveCount(0);
    await expect(icon(win, 'Sessions')).toHaveClass(/is-active/);
    await expect.poll(() => viewItem(app, 'Automations')).toBe(false);
  } finally {
    await stop(app, home);
  }
});

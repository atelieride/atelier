import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import type { AtelierApi } from '../../src/shared/api';
import { look } from './shots';

// Rename where it was asked, the name preselected: the row's menu renames in the row
// (also for a session or terminal with no tab), the tab's menu in the tab, a split pane's session bar in the bar (above a
// single terminal the bar has no name: the Session panel renames in the tab); typing replaces the whole name at once.

/** Looked at by hand (git-ignored). */
const SHOTS = resolve('e2e-shots/small-asks');
const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;
const api = (win: Page) => ({
  session: (name: string) => win.evaluate((n) => (window as unknown as { atelier: AtelierApi }).atelier.terminals.createSession({ cols: 100, rows: 30, name: n }), name),
  terminal: (name: string) => win.evaluate((n) => (window as unknown as { atelier: AtelierApi }).atelier.terminals.create({ cols: 100, rows: 30, name: n }), name)
});
/** The whole value is selected: typing replaces it. */
const selectedAll = (input: Locator) => input.evaluate((el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0 && document.activeElement === el);

async function menu(win: Page, target: Locator, item: string) {
  await target.click({ button: 'right' });
  await win.getByRole('menuitem', { name: item, exact: true }).click();
}

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function appMenu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

test('rename opens where it was asked, with the whole name selected', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  try {
    await expect(win.locator('.header')).toBeVisible();
    await api(win).session('Alpha');
    await api(win).session('Beta');
    await api(win).terminal('Logs');
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    await expect(row('Alpha')).toBeVisible({ timeout: 15000 });
    await expect(row('Beta')).toBeVisible({ timeout: 15000 });

    // The row's menu: the field is in the row, not in the tab, and the name is selected.
    await menu(win, row('Alpha'), 'Rename…');
    // (While editing, the name is the field's value: the row is found through the field.)
    const inRow = win.locator('.session-row .rename-input');
    await expect(inRow).toHaveValue('Alpha');
    await expect(win.locator('.tab-rename')).toHaveCount(0);
    expect(await selectedAll(inRow)).toBe(true);
    const box = (await win.locator('.sidebar').boundingBox())!;
    await look(win, join(SHOTS, 'rename-row.png'), { settle: 300, clip: { x: box.x, y: box.y, width: box.width, height: 240 } });
    await win.keyboard.type('Login bug');
    await win.keyboard.press('Enter');
    await expect(row('Login bug')).toBeVisible();
    await expect(win.locator('.session-row .rename-input')).toHaveCount(0);

    // A session with no tab (closed, still running): Rename from its row still works.
    await win.locator('.tab', { hasText: 'Beta' }).locator('.tab-close').click();
    await expect(win.locator('.tab', { hasText: 'Beta' })).toHaveCount(0);
    await menu(win, row('Beta'), 'Rename…');
    await expect(inRow).toHaveValue('Beta');
    expect(await selectedAll(inRow)).toBe(true);
    await win.keyboard.type('Payments');
    await win.keyboard.press('Enter');
    await expect(row('Payments')).toBeVisible();

    // Escape leaves the name as it was.
    await menu(win, row('Payments'), 'Rename…');
    await win.keyboard.type('nope');
    await win.keyboard.press('Escape');
    await expect(row('Payments')).toBeVisible();
    await expect(win.locator('.session-row .rename-input')).toHaveCount(0);

    // A plain terminal's row renames in place too.
    const term = win.locator('.term-row', { hasText: 'Logs' });
    await menu(win, term, 'Rename…');
    await expect(win.locator('.term-row .rename-input')).toHaveValue('Logs');
    expect(await selectedAll(win.locator('.term-row .rename-input'))).toBe(true);
    await win.keyboard.type('Server logs');
    await win.keyboard.press('Enter');
    await expect(win.locator('.term-row', { hasText: 'Server logs' })).toBeVisible();

    // The tab's menu: in the tab, selected.
    const tab = win.locator('.tab', { hasText: 'Login bug' });
    await menu(win, tab, 'Rename…');
    const inTab = win.locator('.tab .tab-rename');
    await expect(inTab).toHaveValue('Login bug');
    expect(await selectedAll(inTab)).toBe(true);
    await expect(win.locator('.session-row .rename-input')).toHaveCount(0);
    await win.keyboard.type('Auth');
    await win.keyboard.press('Enter');
    await expect(row('Auth')).toBeVisible();

    // The Session panel's Rename: in the tab (the bar above a single terminal has no name), selected.
    await row('Auth').click();
    await win.locator('.session-bar .sb-model').click();
    await win.locator('.spanel-action', { hasText: 'Rename' }).click();
    await expect(win.locator('.spanel')).toHaveCount(0);
    await expect(inTab).toHaveValue('Auth');
    expect(await selectedAll(inTab)).toBe(true);
    await expect(win.locator('.session-bar .rename-input')).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(inTab).toHaveCount(0);

    // A split pane's session bar has no name (its tab right above, in the pane's own strip, says
    // who). The Session panel's Rename and the pane's menu rename in that tab, selected.
    await appMenu(app, 'Split Right');
    await win.locator('.pane-picker .pp-item', { hasText: 'Payments' }).click();
    const pane = win.locator('.workspace-body > .session-bar.is-focused');
    await expect(pane.locator('.sb-title, .avatar')).toHaveCount(0);
    const inPaneTab = win.locator('.pane-strip.is-focused .tab .tab-rename');
    await menu(win, row('Payments'), 'Session Panel');
    await win.locator('.spanel-action', { hasText: 'Rename' }).click();
    await expect(inPaneTab).toHaveValue('Payments');
    expect(await selectedAll(inPaneTab)).toBe(true);
    await expect(pane.locator('.rename-input')).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(inPaneTab).toHaveCount(0);
    // The pane's menu (a right-click on its bar): in the tab too. Unsplit All while the field is open: the field goes
    // with the strip it was in, and none pops open when the session lands in a pane again.
    await menu(win, pane.locator('.sb-activity'), 'Rename…');
    await expect(inPaneTab).toHaveValue('Payments');
    await appMenu(app, 'Unsplit All');
    await expect(win.locator('.workspace-body.is-split')).toHaveCount(0);
    await expect(win.locator('.tabs .tab .tab-rename')).toHaveValue('Payments');
    await win.locator('.tabs .tab .tab-rename').press('Escape');
    await expect(win.locator('.rename-input')).toHaveCount(0);
    await appMenu(app, 'Split Right');
    await win.locator('.pane-picker .pp-item', { hasText: 'Auth' }).click();
    // Both strips show their tab's name.
    await expect(win.locator('.pane-strip .tab .tab-name', { hasText: 'Payments' })).toHaveCount(1);
    await expect(win.locator('.pane-strip .tab .tab-name', { hasText: 'Auth' })).toHaveCount(1);
    await expect(win.locator('.rename-input')).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});

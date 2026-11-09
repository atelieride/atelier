// Session avatars off: Settings › Appearance turns them off;
// sidebar rows start with their title, a pinned row keeps its pin at rest, tabs show the session tile; nothing in a row
// collides from 200 px up; the palette turns them back on. The crowded sidebar of narrow-fixture.ts, no real servers.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { collisions, crowd, frames, shownWidth, sidebarByKeys, stage } from './narrow-fixture';
import { look } from './shots';

// One story in one app: each test starts where the last left it (avatars off, CI pinned…); after a red the rest skip
// rather than run in a fresh app with avatars on.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let win: Page;
let home: string;

const ROW_PIECES = '.avatar, .term-icon, .session-title, .term-name, .term-cmd, .cwd-chip, .profile-chip, .account-chip, .row-popout, .port-chip, .session-activity, .work-chip, .sched-chip, .plan-badge, .resume-title, .resume-btn, .row-mark, .row-pin.is-kept';
const still = (w: Page) => w.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
const row = (name: string) => win.locator('.sidebar .session-row', { hasText: name });
const away = async () => { await win.mouse.move(900, 500); await frames(win); };
const command = (cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);
/** A visible button's width (0 when hidden at rest: width 0 and transparent). */
const shown = (l: Locator) => l.evaluate((el) => (Number(getComputedStyle(el).opacity) > 0.05 ? el.getBoundingClientRect().width : 0));

test.beforeAll(async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  const e = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  home = e.home;
  app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env: e.env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await expect(win.locator('.sidebar')).toBeVisible();
  await stage(app, crowd(project), project);
  await stageAutomation(project);
  await expect(win.locator('.session-row')).toHaveCount(5);
  await still(win);
});

/**
 * "Docs for the public API" (folder, profile and account chips) started by an automation: main's automations list in
 * full, staged like the lists (narrow-fixture's stage() keeps main's own sends from replacing it).
 */
async function stageAutomation(project: string): Promise<void> {
  const now = Date.now();
  const automation = {
    id: 'au-docs', name: 'Docs sync', enabled: true, createdAt: now, project, folder: '',
    source: { connector: 'clickup', scopes: ['l1'], labels: ['Docs'] }, conditions: [],
    claude: { account: 'default', model: 'default', mode: 'plan', decideAlone: false, useSourceMcp: false },
    isolation: { worktree: false, base: 'default' }, instructions: '',
    limits: { concurrent: 1, perDay: 5, checkEveryMin: 5, usagePause: null }, rerunWhenMatchesAgain: false
  };
  const run = {
    id: 'run-docs', automationId: 'au-docs', createdAt: now, state: 'review', terminalId: 'n-docs', startedAt: now,
    task: { source: 'clickup', id: 't1', displayId: 'CU-1', title: 'Docs for the public API', url: 'https://app.clickup.com/t/x' }
  };
  const state = { automations: [{ automation, runs: [run], status: { kind: 'on', lastPollAt: null, nextPollAt: null } }] };
  await app.evaluate(({ BrowserWindow }, s) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as { send: (ch: string, ...a: unknown[]) => void; atlStaged?: Record<string, unknown> };
    wc.atlStaged = { ...(wc.atlStaged ?? {}), 'ev:automations': s };
    wc.send('ev:automations', s);
  }, state);
}

/** Pins a row from its hover button, then lets the focus go (a focused button keeps its row's buttons out). */
async function pin(name: string): Promise<void> {
  await row(name).hover();
  await row(name).getByRole('button', { name: 'Pin session' }).click();
  await expect(row(name).locator('.row-pin')).toHaveClass(/is-kept/);
  await row(name).locator('.row-pin').evaluate((el) => (el as HTMLElement).blur());
  await away();
}

test.afterAll(async () => {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
});

test('Settings › Appearance › Session avatars off: rows start with their title, tabs show the session tile', async () => {
  await row('Auth refactor').locator('.row-main').click();
  const tab = win.locator('.tab[data-key="t:n-auth"]');
  await expect(tab.locator('.avatar')).toBeVisible();
  await expect(win.locator('.sidebar .session-row .avatar')).toHaveCount(5);

  await win.getByRole('button', { name: 'Settings' }).click();
  const dialog = win.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  const toggle = dialog.getByRole('switch', { name: 'Session avatars' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await win.keyboard.press('Escape');

  await expect(win.locator('.sidebar .session-row .avatar, .sidebar .resume-row .avatar')).toHaveCount(0);
  await expect(win.locator('.tab .avatar')).toHaveCount(0);
  // The waiting session's tab: the tile, amber.
  await expect(tab.locator('.session-tile')).toHaveClass(/st-waiting/);
  // The title starts at the row's content edge (its padding): no room kept for an avatar.
  await away();
  const r = row('Auth refactor');
  const [rowBox, titleBox] = [(await r.boundingBox())!, (await r.locator('.session-title').boundingBox())!];
  expect(titleBox.x - rowBox.x).toBeLessThanOrEqual(9);
});

test('a pinned row keeps its pin at rest and in place; hovered it adds only the close, at the pin\'s left; an unpinned row adds pin and close', async () => {
  await pin('CI');
  const kept = row('CI').locator('.row-pin');
  expect(await shown(kept)).toBeCloseTo(22, 0);
  expect(await shown(row('CI').locator('.row-close'))).toBe(0);
  const restX = (await kept.boundingBox())!.x;

  // The pin you saw is where you click: the close comes in at its left, never under the pointer.
  await row('CI').hover();
  await frames(win);
  expect(await shown(kept)).toBeCloseTo(22, 0);
  expect(await shown(row('CI').locator('.row-close'))).toBeCloseTo(22, 0);
  expect((await kept.boundingBox())!.x).toBeCloseTo(restX, 0);
  expect((await row('CI').locator('.row-close').boundingBox())!.x).toBeLessThan(restX);
  expect(await collisions(row('CI').locator('.row-actions'), '.row-pin, .row-close')).toEqual([]);

  const docs = row('Docs for the public API');
  await docs.hover();
  await frames(win);
  expect(await shown(docs.locator('.row-pin'))).toBeCloseTo(22, 0);
  expect(await shown(docs.locator('.row-close'))).toBeCloseTo(22, 0);
  await away();
  expect(await shown(docs.locator('.row-pin'))).toBe(0);
});

test('keyboard: Tab from a pinned row reaches its close, then its pin (their order on screen); Shift+F10 opens the row menu', async () => {
  const ci = row('CI');
  await ci.locator('.row-main').focus();
  await win.keyboard.press('Tab');
  await expect(ci.locator('.row-close')).toBeFocused();
  await win.keyboard.press('Tab');
  await expect(ci.locator('.row-pin')).toBeFocused();
  await ci.locator('.row-main').focus();
  await win.keyboard.press('Shift+F10');
  await expect(win.locator('.ctx-menu')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.locator('.ctx-menu')).toHaveCount(0);
});

test('a row started by an automation shows its mark at the end; a click on the mark selects the row, as on the rest of it', async () => {
  const docs = row('Docs for the public API');
  const mark = docs.locator('.row-mark.is-auto');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('aria-label', 'Started by an automation');
  await expect(docs).not.toHaveClass(/is-selected/);
  await mark.click();
  await expect(docs).toHaveClass(/is-selected/);
  // The crowded case for the geometry below: pinned too, with its folder, profile and account chips.
  await pin('Docs for the public API');
});

test('nothing in a row collides and every name reads, at 200 px and the default width, at rest and with the pinned rows hovered', async () => {
  for (const w of [200, 264]) {
    await sidebarByKeys(win, w);
    await away();
    for (const r of await win.locator('.sidebar .session-row, .sidebar .resume-row').all()) {
      const label = `${w} px · ${(await r.innerText()).split('\n')[0]}`;
      expect(await collisions(r, ROW_PIECES), label).toEqual([]);
      const name = r.locator('.session-title, .resume-title').first();
      const [seen, full] = [await shownWidth(name), await name.evaluate((el) => el.scrollWidth)];
      expect(seen, `${label}: name cut to ${seen} px`).toBeGreaterThanOrEqual(Math.min(full, 56) - 0.5);
    }
    for (const name of ['CI', 'Docs for the public API']) {
      await row(name).hover();
      await frames(win);
      expect(await collisions(row(name).locator('.row-actions'), '.row-mark, .row-pin, .row-close'), `${w} px · ${name} hovered`).toEqual([]);
      expect(await shownWidth(row(name).locator('.session-title')), `${w} px · ${name} hovered`).toBeGreaterThan(12);
    }
    await away();
    await look(win.locator('.sidebar'), `test-results/session-avatars-sidebar-${w}.png`);
  }
  await look(win, 'test-results/session-avatars-window.png');
  const theme = (th: string) => win.evaluate((x) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ theme: x }), th);
  await theme('daylight');
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'daylight');
  await look(win, 'test-results/session-avatars-daylight.png', { settle: 150 });
  await theme('aurora');
});

test('the palette\'s Show session avatars turns them back on', async () => {
  await command('open-palette');
  await win.locator('.palette-input').fill('session avatars');
  const item = win.locator('.palette .palette-item', { hasText: 'Show session avatars' });
  // "on" while they show; off now, no hint. (Enter runs the best match, which can be a session named "…session…".)
  await expect(item.locator('.palette-hint')).not.toHaveText('on');
  await item.click();
  await expect(win.locator('.sidebar .session-row .avatar')).toHaveCount(5);
  await expect(win.locator('.tab[data-key="t:n-auth"] .avatar')).toBeVisible();
  await expect(win.locator('.session-tile')).toHaveCount(0);
});

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Session icons (spec session tray icons): a menu bar dot for each session that needs you. The real menu bar is never
// touched: e2eEnv's ATELIER_TEST_TRAY_LOG makes main log what the icons would show, and __atelierTestTray clicks them.

type Api = { terminals: { list(): Promise<{ id: string; title: string }[]>; input(id: string, data: string): void } };
interface Shown { icons: { id: string; kind: string; tooltip: string }[]; more: { count: number; kind: string } | null }

test.skip(process.platform !== 'darwin', 'the per-session icons are macOS\'s (Windows has one aggregate icon)');

async function launch(): Promise<{ app: ElectronApplication; home: string; log: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home, log: env.ATELIER_TEST_TRAY_LOG! };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

/** What the icons show now: the log's last line. */
const shown = (log: string): Shown | null => {
  if (!existsSync(log)) return null;
  const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return lines.length ? (JSON.parse(lines.at(-1)!) as Shown) : null;
};
const kinds = (log: string) => (shown(log)?.icons ?? []).map((i) => `${i.tooltip.split(' · ')[0]}:${i.kind}`);

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toHaveClass(/state-waiting/, { timeout: 20000 });
}

async function idOf(win: Page, title: string): Promise<string> {
  return win.evaluate(async (t) => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).find((x) => x.title === t)!.id, title);
}

test('a dot for each session that needs you, gone once seen or answered; a click opens the session; off in Settings', async () => {
  const { app, home, log } = await launch();
  try {
    const win = await app.firstWindow();
    // Nothing needs you: no icon at all.
    await expect.poll(() => shown(log)).toEqual({ icons: [], more: null });

    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    await expect.poll(() => kinds(log)).toEqual(['Alfa:waiting', 'Beta:waiting']);
    expect(shown(log)!.icons[0]!.tooltip).toMatch(/^Alfa · atl-prj-\w+\nNeeds permission · Bash npm test$/);

    // Alfa finishes while Beta is on screen: its dot turns green and stays until you look at it.
    const alfa = await idOf(win, 'Alfa');
    const beta = await idOf(win, 'Beta');
    await win.evaluate((id) => (window as unknown as { atelier: Api }).atelier.terminals.input(id, '\r'), alfa);
    await expect.poll(() => kinds(log), { timeout: 15000 }).toEqual(['Beta:waiting', 'Alfa:done']);

    // A click on Alfa's dot opens Alfa, which makes it seen: the dot goes.
    await app.evaluate((_e, id) => (globalThis as unknown as { __atelierTestTray: { click(id: string): void } }).__atelierTestTray.click(id), alfa);
    await expect(win.locator('.session-row.is-selected')).toContainText('Alfa');
    await expect.poll(() => kinds(log)).toEqual(['Beta:waiting']);

    // Its menu: the session, its project, turning the icons off.
    const menu = await app.evaluate((_e, id) => (globalThis as unknown as { __atelierTestTray: { menuLabels(id: string): string[] } }).__atelierTestTray.menuLabels(id), beta);
    expect(menu[0]).toBe('Open Session');
    expect(menu[1]).toMatch(/^Open “atl-prj-\w+”$/);
    expect(menu.at(-1)).toBe('Turn Off Menu Bar Icons');

    // Settings › Notifications turns them off: every icon goes at once.
    await command(app, 'open-settings');
    await win.locator('.set-nav-item', { hasText: 'Notifications' }).click();
    const toggle = win.getByRole('switch', { name: 'Sessions in the menu bar' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(win.locator('.set-row', { hasText: 'Sessions in the menu bar' })).toContainText('Atelier’s Λ for each session that needs you');
    await look(win.locator('.set-row', { hasText: 'Sessions in the menu bar' }), 'test-results/tray-setting.png');
    await toggle.click();
    await expect.poll(() => shown(log)).toEqual({ icons: [], more: null });
    await win.keyboard.press('Escape');

    // The palette turns them back on: Beta still waits, its dot is back.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>Session icons in the menu bar');
    await expect(win.locator('.palette-item', { hasText: 'Session icons in the menu bar' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect.poll(() => kinds(log)).toEqual(['Beta:waiting']);
  } finally { await stop(app, home); }
});

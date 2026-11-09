// The quiet sidebar without workspaces: toggles light their icon only, numbers on
// demand, a "+" where sessions and terminals live, the active view and Changes without a box.
import { _electron as electron, expect, test, type ElectronApplication, type Locator } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

const SHOTS = 'test-results';

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** No fill and no ring: what "only the icon lights up" leaves. */
const boxless = (l: Locator) => l.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).boxShadow, getComputedStyle(el).borderTopStyle]);

test('quiet sidebar: icon-only toggles, numbers on hover, "+" next to Sessions and Terminals, no boxes on the view and Changes', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.sidebar .term-row')).toHaveCount(1, { timeout: 10000 });
    const sidebar = win.locator('.sidebar.is-sessions');

    // The macro areas' numbers stay put (revised 2026-11-02: no fading in on hover).
    const count = sidebar.locator('.sidebar-head', { hasText: 'Terminals' }).locator('.count');
    await win.mouse.move(900, 500);
    await expect(count).toHaveCSS('opacity', '1');
    await expect(count).toHaveText('1');

    // Group by state, on: its icon in the light accent, no box (a box only under the pointer).
    const group = sidebar.getByRole('button', { name: 'Group by state' });
    if ((await group.getAttribute('aria-pressed')) !== 'true') await group.click();
    await expect(group).toHaveAttribute('aria-pressed', 'true');
    await win.mouse.move(900, 500);
    await expect.poll(() => boxless(group)).toEqual(['rgba(0, 0, 0, 0)', 'none', 'none']);
    await expect(group).toHaveCSS('color', 'rgb(196, 181, 253)');

    // The active view in the activity bar: its bar and a bright icon, no box.
    expect(await boxless(win.locator('.act.is-active'))).toEqual(['rgba(0, 0, 0, 0)', 'none', 'none']);

    // Changes in the tab bar: no border, no "0" when nothing changed; on, the icon lights up, still no box.
    const changes = win.locator('.changes-toggle');
    await expect(changes).toHaveText('');
    expect(await boxless(changes)).toEqual(['rgba(0, 0, 0, 0)', 'none', 'none']);
    if (!(await win.locator('.changes-toggle.is-on').count())) await changes.click();
    await win.mouse.move(900, 500);
    await expect(win.locator('.changes-toggle.is-on')).toBeVisible();
    await expect.poll(() => boxless(changes)).toEqual(['rgba(0, 0, 0, 0)', 'none', 'none']);
    await expect(changes.locator('svg')).toHaveCSS('color', 'rgb(196, 181, 253)');
    await look(win.locator('.tabs'), `${SHOTS}/quiet-changes-toggle.png`);
    await changes.click();

    // "+" next to Sessions: a drop-down with New Claude Session and Session in Folder…;
    // its right-click, the whole New menu.
    const plus = sidebar.locator('.sidebar-head', { hasText: 'Sessions' }).getByRole('button', { name: 'New session' });
    await expect(plus).toHaveAttribute('aria-haspopup', 'menu');
    await plus.click();
    const items = win.locator('.ctx-menu [role="menuitem"]');
    await expect(items).toHaveText([/New Claude Session\s*⌘N/, /Session in Folder…\s*⌘⌥⇧N/]);
    await look(win.locator('.ctx-menu'), `${SHOTS}/quiet-sessions-plus-menu.png`);
    await win.getByRole('menuitem', { name: /New Claude Session/ }).click();
    await expect(win.getByRole('dialog', { name: 'New Session' })).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.getByRole('dialog', { name: 'New Session' })).toHaveCount(0);
    await plus.click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: /Session in Folder/ })).toBeVisible();
    await win.keyboard.press('Escape');

    // "+" next to Terminals: a new terminal.
    await sidebar.locator('.sidebar-head', { hasText: 'Terminals' }).getByRole('button', { name: 'New terminal' }).click();
    await expect(win.locator('.sidebar .term-row')).toHaveCount(2, { timeout: 10000 });
    await win.mouse.move(900, 500);
    await look(sidebar, `${SHOTS}/quiet-sidebar.png`);
  } finally {
    await stop(app, home);
  }
});

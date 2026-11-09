import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Wider than the tooltip itself (420px): the tooltip must wrap it, not cut it in turn.
const LONG = 'Fix the login flow on the settings page after the OAuth migration and the session refresh on expired tokens';
// Shows the whole text: no ellipsis on it (it wraps instead).
const whole = (el: Element) => el.scrollWidth <= el.clientWidth;

test('a long name cut by its ellipsis shows in full in the tooltip of its sidebar row and of its tab; the palette groups sessions and terminals', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill(LONG);
    await win.keyboard.press('Enter');
    const row = win.locator('.session-row', { hasText: 'Fix the login' });
    await expect(row).toHaveClass(/state-waiting/, { timeout: 20000 });

    // The name really is cut, in the row and in the tab.
    const title = row.locator('.session-title');
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const tabName = win.locator('.tab', { has: win.locator('.avatar') }).locator('.tab-name');
    expect(await tabName.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    // Sidebar row: the full name (its state is already on the row's second line).
    await title.hover();
    const tip = win.locator('.tooltip');
    await expect(tip.locator('.tooltip-text')).toHaveText(LONG);
    expect(await tip.locator('.tooltip-text').evaluate(whole)).toBe(true);
    await look(win, 'test-results/name-tips-row.png');
    // No native tooltip on top of it.
    await expect(row).not.toHaveAttribute('title', /.*/);

    // Tab: the full name heads the tooltip, the folder follows.
    await win.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
    await tabName.hover();
    await expect(tip.locator('.tooltip-line.is-head')).toHaveText(LONG);
    expect(await tip.locator('.tooltip-line.is-head').evaluate(whole)).toBe(true);
    await expect(tip.locator('.tooltip-line').nth(1)).toHaveText(project);
    await look(win, 'test-results/name-tips-tab.png');

    // The session bar above a single terminal shows no name: the tab is right above it.
    await expect(win.locator('.session-bar .sb-title')).toHaveCount(0);

    // A plain terminal's row: its name in the tooltip too.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>new terminal');
    await win.locator('.palette-item', { has: win.locator('.palette-label', { hasText: /^New terminal$/ }) }).click();
    const termName = win.locator('.term-row .term-name');
    await expect(termName).toHaveCount(1, { timeout: 10000 });
    await win.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
    await termName.hover();
    await expect(tip.locator('.tooltip-text')).toHaveText((await termName.textContent())!);

    // The palette's @ lists the Claude session under Sessions and the plain terminal under Terminals, with a terminal glyph.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('@');
    await expect(win.locator('.palette-section')).toHaveText(['Sessions', 'Terminals']);
    const group = (title: string) => win.locator('.palette-list > div', { has: win.locator('.palette-section', { hasText: title }) });
    await expect(group('Sessions').locator('.palette-item')).toHaveCount(1);
    await expect(group('Sessions').locator('.palette-item')).toContainText('Fix the login');
    await expect(group('Sessions').locator('.palette-item .palette-cmd')).toHaveCount(0);
    await expect(group('Terminals').locator('.palette-item')).toHaveCount(1);
    await expect(group('Terminals').locator('.palette-item')).toContainText('Terminal 1');
    await expect(group('Terminals').locator('.palette-item .palette-cmd svg')).toBeVisible();
    await look(win, 'test-results/palette-groups.png');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

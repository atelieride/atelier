import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 15000 });
}

async function newTerminal(win: Page, count: number) {
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('>new terminal');
  await win.locator('.palette-item', { has: win.locator('.palette-label', { hasText: /^New terminal$/ }) }).click();
  await expect(win.locator('.term-row')).toHaveCount(count, { timeout: 10000 });
}

test('pinned sessions and terminals go to the top of their list, survive a reload, and unpin back to their place', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const sessions = () => win.locator('.session-row .session-title').allTextContents();
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    // The flat list (grouping by state is on by default; inbox.spec covers pins inside a section).
    await win.getByRole('button', { name: 'Group by state' }).click();
    await newSession(win, 'Alfa');
    await newSession(win, 'Beta');
    await newSession(win, 'Gamma');
    expect(await sessions()).toEqual(['Alfa', 'Beta', 'Gamma']);
    // Each fake Claude ends its start on a permission request: wait until every row shows it, or a title turns bold
    // (waiting) between two measures below (seen under load: Alfa's title 24.28 → 24.64 px across the hover).
    for (const name of ['Alfa', 'Beta', 'Gamma']) await expect(row(name)).toHaveClass(/\bstate-waiting\b/);

    // The title line's room before anything is pinned (pinning never takes it from anyone).
    const lineW = async (name: string) => (await row(name).locator('.session-line').boundingBox())!.width;
    await win.mouse.move(600, 400);
    const alfaBefore = await lineW('Alfa');
    const gammaBefore = await lineW('Gamma');

    // Hover: the pin button appears next to close; a toggle with a tooltip.
    const pin = row('Gamma').locator('.row-pin');
    await expect(pin).toHaveCSS('width', '0px');
    await row('Gamma').hover();
    await expect(pin).toBeVisible();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await expect(pin).toHaveAttribute('aria-label', 'Pin session');
    await expect(pin).toHaveAttribute('data-tip', 'Pin session');
    await pin.click();
    await expect.poll(sessions).toEqual(['Gamma', 'Alfa', 'Beta']);
    await expect(row('Gamma').locator('.row-pin')).toHaveAttribute('aria-pressed', 'true');
    await expect(row('Gamma').locator('.row-pin')).toHaveAttribute('data-tip', 'Unpin session');

    // From the context menu, a second pin goes after the first one.
    await row('Beta').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect.poll(sessions).toEqual(['Gamma', 'Beta', 'Alfa']);
    // Pinned rows show a pin badge on the avatar; the buttons wait for hover, on every row.
    await win.mouse.move(600, 400);
    await expect(row('Beta').locator('.avatar .av-pin')).toBeVisible();
    await expect(row('Gamma').locator('.avatar .av-pin')).toBeVisible();
    await expect(row('Alfa').locator('.av-pin')).toHaveCount(0);
    await expect(row('Beta').locator('.row-pin')).toHaveCSS('width', '0px');
    await expect(row('Beta').locator('.row-close')).toHaveCSS('opacity', '0');
    // Nobody's title line gets shorter: not the unpinned rows, not the pinned ones.
    expect(await lineW('Alfa')).toBe(alfaBefore);
    expect(await lineW('Gamma')).toBe(gammaBefore);
    // Hover shows the buttons over the end of the title line, which fades under them instead of moving.
    // (x and width: the rows may still be settling vertically after the reorder.)
    const titleBox = async () => { const b = (await row('Alfa').locator('.session-title').boundingBox())!; return { x: b.x, width: b.width }; };
    const before = await titleBox();
    await row('Alfa').hover();
    await expect(row('Alfa').locator('.row-close')).toBeVisible();
    expect(await titleBox()).toEqual(before);
    expect(await row('Alfa').locator('.session-line').evaluate((el) => getComputedStyle(el).webkitMaskImage)).toContain('gradient');
    await row('Beta').hover();
    expect(await row('Beta').locator('.row-pin svg').evaluate((el) => getComputedStyle(el).fill)).not.toBe('none');
    await win.mouse.move(600, 400);
    await look(win.locator('.sidebar'), 'test-results/pins-sidebar.png');
    await row('Beta').hover();
    await look(win.locator('.sidebar'), 'test-results/pins-sidebar-hover.png');

    // Terminals have their own pinned group.
    await newTerminal(win, 1);
    await newTerminal(win, 2);
    const terms = () => win.locator('.term-row .term-name').allTextContents();
    const [first, second] = await terms();
    await win.locator('.term-row', { hasText: second! }).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect.poll(terms).toEqual([second, first]);
    expect(await sessions()).toEqual(['Gamma', 'Beta', 'Alfa']);
    await win.mouse.move(600, 400);
    await expect(win.locator('.term-row', { hasText: second! }).locator('.term-icon .av-pin')).toBeVisible();
    await expect(win.locator('.term-row', { hasText: first! }).locator('.av-pin')).toHaveCount(0);
    // A terminal row's pin takes no room until it shows, as a session's (the row's chips reach its
    // end); the hover opens it without moving the name's start.
    const termRow = win.locator('.term-row', { hasText: first! });
    const pinWidth = async () => Math.round((await termRow.locator('.row-pin').boundingBox())?.width ?? 0);
    const n0 = (await termRow.locator('.term-name').boundingBox())!;
    expect(await pinWidth()).toBe(0);
    await expect(termRow.locator('.row-pin')).toHaveCSS('opacity', '0');
    await termRow.hover();
    await expect(termRow.locator('.row-pin')).toHaveCSS('opacity', '1');
    await expect.poll(pinWidth).toBe(22);
    const n1 = (await termRow.locator('.term-name').boundingBox())!;
    expect(n1.x).toBe(n0.x);
    await win.mouse.move(600, 400);

    // Remembered after a reload.
    await win.reload();
    await expect(win.locator('.session-row')).toHaveCount(3, { timeout: 15000 });
    await expect.poll(sessions).toEqual(['Gamma', 'Beta', 'Alfa']);
    await expect.poll(terms).toEqual([second, first]);

    // Keyboard: the pin button is reachable and toggles with Space.
    // Reached with the keyboard (Shift+Tab, Tab): the row's buttons show for keyboard focus.
    await row('Gamma').locator('.row-main').focus();
    await win.keyboard.press('Shift+Tab');
    await win.keyboard.press('Tab');
    await expect(row('Gamma').locator('.row-main')).toBeFocused();
    await win.keyboard.press('Tab');
    await expect(row('Gamma').locator('.row-pin')).toBeFocused();
    await win.keyboard.press('Space');
    await expect.poll(sessions).toEqual(['Beta', 'Alfa', 'Gamma']);
    // An unpinned row's hidden pin is reachable with Tab too (it has no width until then, but is never display:none).
    await row('Alfa').locator('.row-main').focus();
    await win.keyboard.press('Shift+Tab');
    await win.keyboard.press('Tab');
    await win.keyboard.press('Tab');
    await expect(row('Alfa').locator('.row-pin')).toBeFocused();
    await expect(row('Alfa').locator('.row-pin')).toHaveCSS('opacity', '1');

    // Palette: pin or unpin the selected session.
    await row('Beta').locator('.row-main').click();
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>unpin');
    await expect(win.locator('.palette-item', { hasText: 'Unpin session' })).toBeVisible();
    await win.keyboard.press('Enter');
    await expect.poll(sessions).toEqual(['Alfa', 'Beta', 'Gamma']);
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>pin');
    await expect(win.locator('.palette-item', { hasText: 'Pin session' })).toBeVisible();
    await win.keyboard.press('Escape');

    // A closed pinned terminal: its pin is forgotten, the next terminal is not pinned in its place.
    await win.locator('.term-row', { hasText: second! }).hover();
    await win.locator('.term-row', { hasText: second! }).locator('.row-close').click();
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    const saved = await win.evaluate(() => localStorage.getItem('atelier.pins'));
    expect(Object.values(JSON.parse(saved ?? '{}') as Record<string, string[]>).flat()).toHaveLength(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

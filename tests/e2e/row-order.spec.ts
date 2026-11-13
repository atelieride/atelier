import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Sidebar rows dragged into your own order: pinned among the pinned, unpinned among the unpinned, sessions and
// terminals; a caret shows where the row lands and nothing else moves.

async function launch(): Promise<{ app: ElectronApplication; win: Page; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, win: await app.firstWindow(), home };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

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

const titles = (win: Page) => win.locator('.session-row .session-title').allTextContents();
const termIds = (win: Page) => win.locator('.term-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.termRow ?? ''));

/** Drops `from` on the upper edge of `onto` (it lands before it), with the system drag as a person does. */
async function dropAbove(from: Locator, onto: Locator) {
  await from.dragTo(onto, { targetPosition: { x: 40, y: 4 } });
}

async function pin(win: Page, row: Locator) {
  await row.click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Pin', exact: true }).click();
}

test('sessions: a row dropped above another stays there after a reload; a caret shows where it lands', async () => {
  const { app, win, home } = await launch();
  try {
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    // The flat list: grouping by state is on by default.
    await win.getByRole('button', { name: 'Group by state' }).click();
    for (const name of ['Alfa', 'Beta', 'Gamma']) await newSession(win, name);
    expect(await titles(win)).toEqual(['Alfa', 'Beta', 'Gamma']);

    await dropAbove(row('Gamma'), row('Alfa'));
    await expect.poll(() => titles(win)).toEqual(['Gamma', 'Alfa', 'Beta']);
    await win.reload();
    await expect(win.locator('.session-row')).toHaveCount(3, { timeout: 15000 });
    await expect.poll(() => titles(win)).toEqual(['Gamma', 'Alfa', 'Beta']);

    // While dragging: the dragged row dims, a caret above the row it would land before; no row moves.
    const dt = await win.evaluateHandle(() => new DataTransfer());
    const boxes = async () => Promise.all(['Gamma', 'Alfa', 'Beta'].map(async (n) => (await row(n).boundingBox())!.y));
    const before = await boxes();
    await row('Beta').dispatchEvent('dragstart', { dataTransfer: dt });
    const alfa = (await row('Alfa').boundingBox())!;
    await row('Alfa').dispatchEvent('dragover', { dataTransfer: dt, clientX: alfa.x + 40, clientY: alfa.y + 4 });
    await expect(row('Alfa')).toHaveClass(/\bis-caret-before\b/);
    await expect(row('Beta')).toHaveClass(/\bis-dragging\b/);
    expect(await boxes()).toEqual(before);
    await look(win.locator('.sidebar'), 'test-results/row-order-caret.png');
    // Just above itself: it would stay put, no caret.
    const beta = (await row('Beta').boundingBox())!;
    await row('Beta').dispatchEvent('dragover', { dataTransfer: dt, clientX: beta.x + 40, clientY: beta.y + 4 });
    await expect(win.locator('.is-caret-before, .is-caret-after')).toHaveCount(0);
    await row('Beta').dispatchEvent('dragend', { dataTransfer: dt });
    await expect(win.locator('.is-caret-before, .is-caret-after, .is-dragging')).toHaveCount(0);
    expect(await titles(win)).toEqual(['Gamma', 'Alfa', 'Beta']);

    // The keyboard's way: Shift+F10 on a row, Move Up; the focus comes back to the row.
    await row('Alfa').locator('.row-main').focus();
    await win.keyboard.press('Shift+F10');
    await expect(win.getByRole('menuitem', { name: 'Move Down' })).toBeVisible();
    await win.getByRole('menuitem', { name: 'Move Up' }).click();
    await expect.poll(() => titles(win)).toEqual(['Alfa', 'Gamma', 'Beta']);
    await expect(row('Alfa').locator('.row-main')).toBeFocused();
  } finally {
    await stop(app, home);
  }
});

test('pinned rows move only among the pinned, the others only among the others; terminals too', async () => {
  const { app, win, home } = await launch();
  try {
    const row = (name: string) => win.locator('.session-row', { hasText: name });
    await win.getByRole('button', { name: 'Group by state' }).click();
    for (const name of ['Alfa', 'Beta', 'Gamma']) await newSession(win, name);
    await pin(win, row('Beta'));
    await pin(win, row('Gamma'));
    await expect.poll(() => titles(win)).toEqual(['Beta', 'Gamma', 'Alfa']);
    // Unpinned onto a pinned row: nothing.
    await dropAbove(row('Alfa'), row('Beta'));
    expect(await titles(win)).toEqual(['Beta', 'Gamma', 'Alfa']);
    // Pinned among the pinned: the pin order changes.
    await dropAbove(row('Gamma'), row('Beta'));
    await expect.poll(() => titles(win)).toEqual(['Gamma', 'Beta', 'Alfa']);

    await newTerminal(win, 1);
    await newTerminal(win, 2);
    await newTerminal(win, 3);
    const [first, second, third] = await termIds(win);
    const term = (id: string) => win.locator(`.term-row[data-term-row="${id}"]`);
    await dropAbove(term(third!), term(first!));
    await expect.poll(() => termIds(win)).toEqual([third, first, second]);
  } finally {
    await stop(app, home);
  }
});

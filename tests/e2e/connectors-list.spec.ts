import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { startFake } from './fake-clickup-cli';
import { startFakeNotionCli } from './fake-notion-cli';
import { look } from './shots';

// Settings › Connectors as a list and a details page and the palette's per-connector
// sections, against the local fake ClickUp (main follows the authorize page itself:
// ATELIER_TEST_FOLLOW_AUTH). Main registers ClickUp then Notion, so the list has two rows.

/** Looked at by hand (git-ignored): the list in its states, the details page, the palette's sections. */
const SHOTS = resolve('e2e-shots/connectors-notion');

/** Animations off for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** App menu items are clicked (synthetic key events do not go through NSMenu). */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    const item = walk(Menu.getApplicationMenu()!.items);
    if (!item) throw new Error(`no menu item ${l}`);
    item.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

async function palette(win: Page, query: string) {
  await win.mouse.move(1, 1);
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill(query);
}

type Api = { connectors: { connect(id: 'clickup'): Promise<unknown>; refresh(id: 'clickup'): Promise<unknown>; list(): Promise<{ connectors: { status: string }[] }> } };

async function launch() {
  const fake = await startFake();
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_CLICKUP_URL: fake.url, ATELIER_TEST_FOLLOW_AUTH: '1' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
  await still(win);
  const api = <T>(fn: (a: Api) => Promise<T>) => win.evaluate(`(${fn.toString()})(window.atelier)`) as Promise<T>;
  const status = () => api((a) => a.connectors.list().then((r) => r.connectors[0]?.status));
  return { fake, app, win, home, api, status };
}

test('list → ClickUp row → details → back (button, then ⌘[ with the focus back on the row); the row\'s Connect starts the sign-in without opening the details; the palette has one section per connector', async () => {
  test.setTimeout(60_000);
  mkdirSync(SHOTS, { recursive: true });
  const { fake, app, win, home, status } = await launch();
  try {
    await menu(app, 'Connectors…');
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    const list = dialog.locator('.conn-list');
    const row = dialog.locator('.conn-row[data-connector="clickup"]');
    const open = row.locator('.conn-row-open');
    // The list: the intro, one row (name, short description, no chip while not connected), the footnote; no details yet.
    await expect(dialog.locator('.conn-intro')).toHaveText('Bring work from other apps into Atelier. Read-only: nothing is ever changed there.');
    await expect(row).toContainText('ClickUp');
    await expect(row).toContainText('Start sessions from your ClickUp tasks.');
    await expect(row.locator('.conn-chip')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Connect ClickUp' })).toBeVisible();
    await expect(dialog.locator('.conn-foot')).toHaveText('Every connector is read-only. Tasks stay in memory, never on disk.');
    await expect(dialog.locator('.conn-details')).toHaveCount(0);
    // Notion then Jira follow ClickUp (registry order), also not connected.
    await expect(dialog.locator('.conn-row')).toHaveCount(3);
    await expect(dialog.locator('.conn-row').nth(0)).toHaveAttribute('data-connector', 'clickup');
    await expect(dialog.locator('.conn-row').nth(1)).toHaveAttribute('data-connector', 'notion');
    await expect(dialog.locator('.conn-row').nth(2)).toHaveAttribute('data-connector', 'jira');
    await expect(dialog.locator('.conn-row[data-connector="notion"]')).toContainText('Start sessions from tasks in your Notion databases.');
    await expect(dialog.locator('.conn-row[data-connector="jira"]')).toContainText('Start sessions from the Jira issues in projects you choose.');
    await look(dialog, join(SHOTS, 'list-not-connected.png'));

    // Row → details: the back button, the card's content, no list.
    await open.click();
    const details = dialog.locator('.conn-details');
    await expect(details).toHaveAttribute('data-connector', 'clickup');
    await expect(details.getByRole('heading', { name: 'ClickUp' })).toBeVisible();
    await expect(details.locator('.conn-badge')).toHaveText('Read-only');
    await expect(list).toHaveCount(0);
    const back = dialog.getByRole('button', { name: 'Back to Connectors' });
    await expect(back).toHaveText('Connectors');
    await expect(back).toBeFocused();
    await look(dialog, join(SHOTS, 'details-not-connected.png'));

    // "‹ Connectors" goes back to the list; the focus lands on the row's button.
    await back.click();
    await expect(details).toHaveCount(0);
    await expect(list).toBeVisible();
    await expect(open).toBeFocused();

    // Again, with ⌘[ (wherever the focus is), and back on the row.
    await open.click();
    await expect(details).toBeVisible();
    await win.keyboard.press('Meta+[');
    await expect(details).toHaveCount(0);
    await expect(list).toBeVisible();
    await expect(open).toBeFocused();

    // Esc on the back button goes back; Esc elsewhere closes Settings, as it always did.
    await open.click();
    await expect(back).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(list).toBeVisible();
    await open.press('Enter');
    await expect(details).toBeVisible();
    // The page focuses its back button on the next frame (slow in a hidden window): Tab from there, not before it.
    await expect(back).toBeFocused();
    await win.keyboard.press('Tab');
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The row's Connect starts the sign-in (Connecting + countdown) without opening the details.
    await menu(app, 'Connectors…');
    // The fake holds every MCP reply, so the flow waits after the sign-in.
    await fake.scenario('slow');
    await row.getByRole('button', { name: 'Connect ClickUp' }).click();
    await expect(row).toHaveAttribute('data-status', 'connecting');
    await expect(row.locator('.conn-chip')).toContainText('Connecting');
    await expect(row.locator('.conn-chip-count')).toHaveText(/^[45]:\d\d$/);
    await expect(row.getByRole('button', { name: 'Cancel ClickUp sign-in' })).toBeVisible();
    await expect(dialog.locator('.conn-details')).toHaveCount(0);
    await expect(dialog.locator('.conn-list')).toBeVisible();
    await look(dialog, join(SHOTS, 'list-connecting.png'));
    // Cancel on the row cancels, still without opening the details.
    await row.getByRole('button', { name: 'Cancel ClickUp sign-in' }).click();
    await expect(row).toHaveAttribute('data-status', 'disconnected');
    await expect(dialog.locator('.conn-details')).toHaveCount(0);

    // Connected: the chip says where; the row's states follow the connector.
    await fake.scenario('normal');
    await row.getByRole('button', { name: 'Connect ClickUp' }).click();
    await expect.poll(status, { timeout: 15000 }).toBe('connected');
    await expect(row.locator('.conn-chip')).toContainText('Connected');
    await expect(row.locator('.conn-chip')).toContainText('Fakeworks');
    await expect(row.locator('.conn-row-action')).toHaveCount(0);
    await expect(dialog.locator('.conn-details')).toHaveCount(0);
    await look(dialog, join(SHOTS, 'list-connected.png'));
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The palette has one section per connector. task: → a "ClickUp" section with its glyph and count; clickup: → only it, no count; the search too.
    await palette(win, 'task:');
    const sections = win.locator('.palette-section');
    await expect(sections).toHaveCount(1);
    await expect(sections.first()).toContainText('ClickUp');
    await expect(sections.first().locator('.palette-count')).toHaveText('3');
    await expect(sections.first().locator('svg')).toHaveCount(1);
    await expect(win.locator('.palette-item.task-item')).toHaveCount(3);
    await look(win.locator('.palette'), join(SHOTS, 'palette-task.png'));
    await win.locator('.palette-input').fill('clickup:');
    await expect(win.locator('.palette-mode')).toHaveText('clickup');
    await expect(sections).toHaveCount(1);
    await expect(sections.first()).toContainText('ClickUp');
    await expect(sections.first().locator('.palette-count')).toHaveCount(0);
    await expect(win.locator('.palette-item.task-item')).toHaveCount(3);
    await look(win.locator('.palette'), join(SHOTS, 'palette-clickup.png'));
    await win.locator('.palette-input').fill('backlog');
    await expect(sections.filter({ hasText: 'ClickUp' })).toHaveCount(1);
    await look(win.locator('.palette'), join(SHOTS, 'palette-search.png'));
    await win.keyboard.press('Escape');
    await expect(win.locator('.palette')).toHaveCount(0);
  } finally {
    await stop(app, home);
    fake.close();
  }
});

test('Connect Notion from its list row reaches "Choose databases"', async () => {
  test.setTimeout(60_000);
  const fake = await startFakeNotionCli();
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_NOTION_URL: fake.url, ATELIER_TEST_FOLLOW_AUTH: '1' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
    await still(win);
    await menu(app, 'Connectors…');
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    const row = dialog.locator('.conn-row[data-connector="notion"]');
    await row.getByRole('button', { name: 'Connect Notion' }).click();
    await expect(row).toHaveAttribute('data-status', 'connected', { timeout: 15000 });
    await expect(row.locator('.conn-chip')).toContainText('Choose databases');
    await expect(row).toContainText('no databases chosen yet');
    await expect(dialog.locator('.conn-row[data-connector="clickup"]').locator('.conn-chip')).toHaveCount(0);
    await look(dialog, join(SHOTS, 'list-notion-choose.png'));
  } finally {
    await stop(app, home);
    fake.close();
  }
});

import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConnectorInfo, TaskList } from '../../src/shared/tasks';
import { e2eEnv } from './env';
import { READ_TOOLS, startFake } from './fake-clickup-cli';
import { NOTION_READ_TOOLS, startFakeNotionCli } from './fake-notion-cli';
import { look } from './shots';

// Notion end to end (Testing) against the local fake Notion (tests/fixtures/
// fake-notion.mjs, never the real one) next to the fake ClickUp: connect from the list row, the empty state, the
// picker (search ↵, a pasted link, Esc), the fields editor's preview, a database Atelier can no longer read, Disconnect;
// then the palette's sections and a session started from a Notion task without an ID. Main follows the authorize page
// itself (ATELIER_TEST_FOLLOW_AUTH) and safeStorage is the test stand-in (never the Keychain).

/** Looked at by hand (git-ignored). */
const SHOTS = resolve('e2e-shots/connectors-notion');

// The fake's fictional workspace (tests/fixtures/notion/): Sprint Tasks (no ID column, a status column) and Engineering
// Backlog (ENG- tickets, a "Stage" select whose "Shipped" is guessed as done), both under the Engineering page. These
// are the databases' ids (the picker and a pasted link take them); Settings' rows are keyed by data source.
const SPRINT = '00000006000040008000000000000006';
const BACKLOG = '00000005000040008000000000000005';
const BACKLOG_LINK = `https://www.notion.so/acme/Engineering-Backlog-${BACKLOG}?v=0123456789abcdef0123456789abcdef`;

/** Animations off for screenshots that are looked at. */
const still = (win: Page) => win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; } .xterm-cursor-layer { display: none !important; }' });

async function stop(app: ElectronApplication, home: string) {
  await app.close().catch(() => {});
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

/** A connector's section in the palette: its title row and the rows under it (siblings in one wrapper). */
const section = (win: Page, title: string): Locator =>
  win.locator('.palette-list > div').filter({ has: win.locator('.palette-section', { hasText: title }) });

/** The visible terminal's rows as one string: a long echoed line wraps over several rows. */
const screenText = (win: Page) => win.locator('.terminal-slot:visible .xterm-rows').first().evaluate((el) =>
  [...el.querySelectorAll(':scope > div')].map((r) => r.textContent ?? '').join(''));

async function launch(extra: Record<string, string> = {}) {
  const notion = await startFakeNotionCli();
  const clickup = await startFake();
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'),
    ATELIER_TEST_NOTION_URL: notion.url, ATELIER_TEST_CLICKUP_URL: clickup.url, ATELIER_TEST_FOLLOW_AUTH: '1', ...extra
  });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
  await still(win);
  const list = () => (win.evaluate('window.atelier.connectors.list()') as Promise<{ connectors: ConnectorInfo[] }>).then((r) => r.connectors);
  const statusOf = (id: string) => list().then((cs) => cs.find((c) => c.id === id)?.status);
  const connect = async (id: 'clickup' | 'notion') => {
    await win.evaluate(`window.atelier.connectors.connect('${id}')`);
    await expect.poll(() => statusOf(id), { timeout: 15000 }).toBe('connected');
  };
  const done = async () => {
    // Only Notion's four read tools and ClickUp's five ever reached the fakes.
    expect((await notion.calls()).filter((n) => !NOTION_READ_TOOLS.includes(n))).toEqual([]);
    expect((await clickup.calls()).filter((n) => !READ_TOOLS.includes(n))).toEqual([]);
  };
  const close = async () => { await stop(app, home); notion.close(); clickup.close(); };
  return { notion, clickup, app, win, home, list, statusOf, connect, done, close };
}

test('Notion in Settings: connect, empty state, picker (↵, Esc, a pasted link), fields preview, unreadable database, Disconnect', async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  const t = await launch();
  const { app, win, notion } = t;
  try {
    await t.connect('clickup');
    await menu(app, 'Connectors…');
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    const row = dialog.locator('.conn-row[data-connector="notion"]');

    // Connect from the list row: connected, no database chosen yet.
    await row.getByRole('button', { name: 'Connect Notion' }).click();
    await expect(row).toHaveAttribute('data-status', 'connected', { timeout: 15000 });
    await expect(row.locator('.conn-chip')).toContainText('Choose databases');

    // The details: who and where, "Now choose…", Disconnect only, the empty state with Add Database….
    await row.locator('.conn-row-open').click();
    const details = dialog.locator('.conn-details[data-connector="notion"]');
    await expect(details.locator('.conn-status')).toContainText('Connected as Ada Lovelace · Acme');
    await expect(details.locator('.conn-status')).toContainText('Now choose where your tasks live.');
    await expect(details.locator('.conn-actions button')).toHaveText(['Disconnect']);
    await expect(details.locator('.nsrc-empty-title')).toHaveText('No databases yet');
    const emptyAdd = details.locator('.nsrc-empty .nsrc-add');
    await expect(emptyAdd).toHaveText('Add Database…');
    await look(dialog, join(SHOTS, 'e2e-notion-connected.png'));

    // The picker: the field has the focus; Esc closes only the picker (Settings stays), the focus back on its button.
    const picker = dialog.getByRole('dialog', { name: 'Add Notion databases' });
    const input = picker.getByRole('combobox', { name: 'Search databases' });
    await emptyAdd.click();
    await expect(input).toBeFocused();
    await expect(picker.locator('.nsp-ws')).toHaveText('Acme');
    await win.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(details).toBeVisible();
    await expect(emptyAdd).toBeFocused();

    // Search "Sprint", ↵ adds the active database: its row says whose tasks and how many (2 of mine are open).
    await emptyAdd.press('Enter');
    await expect(input).toBeFocused();
    await input.fill('Sprint');
    await expect(picker.getByRole('option', { name: /Sprint Tasks/ })).toHaveAttribute('aria-selected', 'true');
    await win.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    // Rows are keyed by data source (one per source), so they are found by name here.
    const sprint = details.locator('.nsrc-row').filter({ has: win.locator('.nsrc-name', { hasText: 'Sprint Tasks' }) });
    await expect(sprint.locator('.nsrc-name')).toHaveText('Sprint Tasks');
    await expect(sprint.locator('.nsrc-path')).toHaveText('Engineering');
    await expect(sprint.locator('.nsrc-sub')).toHaveText('Assigned to me · 2 open', { timeout: 15000 });
    await expect(row.locator('.conn-chip')).toHaveCount(0);

    // Again from the header's Add Database…: a chosen database says "Added"…
    await details.locator('.nsrc-head .nsrc-add').click();
    await input.fill('in');
    await expect(picker.getByRole('option')).toHaveCount(2);
    await expect(picker.getByRole('option', { name: /Sprint Tasks/ })).toContainText('Added');
    await expect(picker.getByRole('option', { name: /Engineering Backlog/ })).not.toContainText('Added');
    await look(dialog, join(SHOTS, 'e2e-notion-picker.png'));
    // …and a pasted link offers "Add this database"; ↵ adds the Backlog (its Shipped task hidden: 2 open).
    await input.fill(BACKLOG_LINK);
    await expect(picker.getByRole('option')).toHaveText([/Add this database/]);
    await win.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    const backlog = details.locator('.nsrc-row').filter({ has: win.locator('.nsrc-name', { hasText: 'Engineering Backlog' }) });
    await expect(details.locator('.nsrc-row')).toHaveCount(2);
    await expect(backlog.locator('.nsrc-name')).toHaveText('Engineering Backlog');
    await expect(backlog.locator('.nsrc-sub')).toHaveText('Assigned to me · 2 open', { timeout: 15000 });

    // Both connected, on the list.
    await dialog.getByRole('button', { name: 'Back to Connectors' }).click();
    await expect(dialog.locator('.conn-row[data-connector="clickup"] .conn-chip')).toContainText('Connected');
    await expect(row.locator('.conn-chip')).toContainText('Connected');
    await look(dialog, join(SHOTS, 'e2e-list-both.png'));
    await row.locator('.conn-row-open').click();

    // The fields editor: what Atelier guessed, the preview row as the palette shows it.
    await backlog.getByRole('button', { name: 'Edit fields of Engineering Backlog' }).click();
    const editor = backlog.getByRole('group', { name: 'Edit fields of Engineering Backlog' });
    await expect(editor.getByRole('button', { name: 'Status: Stage' })).toBeEnabled({ timeout: 15000 });
    await expect(editor.getByRole('button', { name: 'Assigned to: Owner' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Due date: Deadline' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'ID: Ticket' })).toBeVisible();
    const chip = (name: string) => editor.getByRole('group', { name: 'Done when' }).getByRole('button', { name });
    await expect(chip('Shipped')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip('Doing')).toHaveAttribute('aria-pressed', 'false');
    const preview = editor.getByRole('group', { name: 'Preview' });
    await expect(preview).toContainText('Dark mode for the billing page');
    await expect(preview.locator('.task-id')).toHaveText('ENG-1');
    await preview.scrollIntoViewIfNeeded();
    await look(dialog, join(SHOTS, 'e2e-notion-fields.png'));
    // Doing and Review mean done too: nothing of mine is left open.
    await chip('Doing').click();
    await expect(chip('Doing')).toHaveAttribute('aria-pressed', 'true');
    await expect(backlog.locator('.nsrc-sub')).toHaveText('Assigned to me · 1 open', { timeout: 15000 });
    await chip('Review').click();
    await expect(backlog.locator('.nsrc-sub')).toHaveText('Assigned to me · 0 open', { timeout: 15000 });
    await expect(preview).toContainText('No tasks match');
    // Shipped no longer means done: the Shipped task is listed, and the preview shows it.
    await chip('Shipped').click();
    await expect(chip('Shipped')).toHaveAttribute('aria-pressed', 'false');
    await expect(backlog.locator('.nsrc-sub')).toHaveText('Assigned to me · 1 open', { timeout: 15000 });
    await expect(preview).toContainText('Ship v2 search');
    await expect(preview.locator('.task-id')).toHaveText('ENG-3');
    // Back as guessed.
    await chip('Shipped').click();
    await chip('Review').click();
    await chip('Doing').click();
    await expect(backlog.locator('.nsrc-sub')).toHaveText('Assigned to me · 2 open', { timeout: 15000 });
    await expect(preview).toContainText('Dark mode for the billing page');
    await backlog.getByRole('button', { name: 'Close the fields of Engineering Backlog' }).click();
    await expect(editor).toHaveCount(0);

    // The Backlog is no longer shared: its row turns amber with Remove; Sprint is fine.
    await notion.scenario('unshare-backlog');
    await details.locator('.conn-actions').getByRole('button', { name: 'Refresh' }).click();
    await expect(backlog).toHaveClass(/is-warn/, { timeout: 15000 });
    await expect(backlog).toContainText("Atelier can't read this database anymore: it was moved, deleted or no longer shared with you.");
    await expect(backlog.getByRole('button', { name: 'Remove Engineering Backlog' })).toBeVisible();
    await expect(sprint).not.toHaveClass(/is-warn/);
    await expect(sprint.locator('.nsrc-sub')).toHaveText('Assigned to me · 2 open');
    await look(dialog, join(SHOTS, 'e2e-notion-unreadable.png'));
    // The list says so on Notion's row; the gear has its amber dot.
    await dialog.getByRole('button', { name: 'Back to Connectors' }).click();
    await expect(row.locator('.conn-chip')).toContainText('1 database needs attention');
    await expect(win.locator('.activity-bar .act-bottom .act-dot')).toHaveCount(1);
    await look(dialog, join(SHOTS, 'e2e-list-attention.png'));

    // Disconnect (with its confirm): the row is back to Connect; the saved connection is gone; the dot too.
    await row.locator('.conn-row-open').click();
    await details.locator('.conn-actions').getByRole('button', { name: 'Disconnect' }).click();
    await details.getByRole('group', { name: 'Disconnect Notion?' }).getByRole('button', { name: 'Disconnect' }).click();
    await expect(details).toHaveAttribute('data-status', 'disconnected');
    await dialog.getByRole('button', { name: 'Back to Connectors' }).click();
    await expect(row.getByRole('button', { name: 'Connect Notion' })).toBeVisible();
    await expect(row.locator('.conn-chip')).toHaveCount(0);
    await expect(win.locator('.activity-bar .act-bottom .act-dot')).toHaveCount(0);
    expect(existsSync(join(t.home, 'connectors', 'notion.bin'))).toBe(false);
    await t.done();
  } finally {
    await t.close();
  }
});

test('the palette with ClickUp and Notion; a Notion task without an ID starts a session (typed, not sent)', async () => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  const t = await launch({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-prompt.pl'), ATELIER_FAKE_START_DELAY: '1' });
  const { win } = t;
  try {
    await t.connect('clickup');
    await t.connect('notion');
    // Notion's "Choose databases": the palette's Notion section says so instead of rows.
    await palette(win, 'notion:');
    await expect(win.locator('.palette-mode')).toHaveText('notion');
    await expect(section(win, 'Notion').locator('.palette-item .palette-label')).toHaveText(['Choose Notion Databases…']);
    await win.keyboard.press('Escape');
    for (const id of [SPRINT, BACKLOG]) {
      expect(await win.evaluate(`window.atelier.connectors.addSource('notion', '${id}')`)).toMatchObject({ ok: true });
    }
    await expect.poll(async () => ((await win.evaluate('window.atelier.tasks.list()')) as TaskList[])
      .find((l) => l.source === 'notion')?.tasks.length, { timeout: 15000 }).toBe(4);

    // Both live: each Refresh names its connector (never two identical "Refresh Tasks").
    await palette(win, '>Refresh');
    const refresh = win.locator('.palette-item .palette-label', { hasText: /Refresh .*Tasks/ });
    await expect(refresh).toHaveCount(2);
    expect((await refresh.allTextContents()).sort()).toEqual(['Refresh ClickUp Tasks', 'Refresh Notion Tasks']);
    await look(win.locator('.palette'), join(SHOTS, 'e2e-palette-refresh.png'));
    await win.keyboard.press('Escape');

    const rows = win.locator('.palette-item.task-item');
    // task: → a ClickUp section then a Notion one, each with its count; Sprint's rows have no ID.
    await palette(win, 'task:');
    await expect(win.locator('.palette-section')).toHaveText(['ClickUp3', 'Notion4']);
    const notionRows = section(win, 'Notion').locator('.task-item');
    await expect(notionRows).toHaveCount(4);
    await expect(section(win, 'ClickUp').locator('.task-item')).toHaveCount(3);
    const rate = notionRows.filter({ hasText: 'Add rate limiting to the export endpoint' });
    await expect(rate.locator('.task-id')).toHaveCount(0);
    await expect(rate.locator('.task-list')).toHaveText('Sprint Tasks');
    await expect(notionRows.filter({ hasText: 'Dark mode for the billing page' }).locator('.task-id')).toHaveText('ENG-1');
    await expect(notionRows.filter({ hasText: 'Ship v2 search' })).toHaveCount(0);
    await look(win.locator('.palette'), join(SHOTS, 'e2e-palette-task.png'));

    // notion: → only Notion's rows, no count; with text, the "only the chosen databases" line.
    await win.locator('.palette-input').fill('notion:');
    await expect(win.locator('.palette-mode')).toHaveText('notion');
    await expect(win.locator('.palette-section')).toHaveText(['Notion']);
    await expect(rows).toHaveCount(4);
    await look(win.locator('.palette'), join(SHOTS, 'e2e-palette-notion.png'));
    await win.locator('.palette-input').fill('notion: rate');
    await expect(rows).toHaveText([/Add rate limiting to the export endpoint/]);
    await expect(win.locator('.palette')).toContainText('Only the databases you chose in Settings › Connectors are searched.');

    // The everything search: one section per connector with its matches.
    await win.locator('.palette-input').fill('login');
    await expect(section(win, 'ClickUp').locator('.task-item')).toHaveText([/Fix the login redirect loop/]);
    const flaky = section(win, 'Notion').locator('.task-item');
    await expect(flaky).toHaveText([/Fix flaky login test on CI/]);
    // The footer names the active row's connector: ClickUp's first, Notion's once its row is active.
    await expect(win.locator('.palette-foot')).toContainText('clickup: only ClickUp');
    await win.keyboard.press('ArrowDown');
    await expect(flaky).toHaveClass(/is-active/);
    await expect(win.locator('.palette-foot')).toContainText('notion: only Notion');
    await look(win.locator('.palette'), join(SHOTS, 'e2e-palette-search.png'));

    // Enter on a task without an ID: its actions (no Copy Task ID), then Start in New Session: the session is named
    // after the title, the prompt is typed and NOT sent, the chip shows the Notion glyph and the title.
    await win.locator('.palette-input').fill('notion: rate');
    // The row itself, highlighted: Enter acts on the highlighted row, and the ↓ above left the second one highlighted
    // until the new query resets it (an effect, late under load: Enter then found no row).
    await expect(rows).toHaveText([/Add rate limiting to the export endpoint/]);
    await expect(rows.first()).toHaveClass(/is-active/);
    await win.keyboard.press('Enter');
    await expect(win.locator('.palette-task-head')).toContainText('Add rate limiting to the export endpoint');
    await expect(win.locator('.palette-item .palette-label')).toHaveText(['Start in New Session', 'Paste into Session…', 'Copy Task']);
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'Add rate limiting to the export endpoint' })).toBeVisible({ timeout: 10000 });
    const chip = win.locator('.session-bar .tchip');
    await expect(chip).toHaveText('Add rate limiting to the export endpoint');
    await expect(chip).toHaveClass(/tchip-titled/);
    // A title reads in the UI font; only an ID is monospaced.
    await expect(chip).not.toHaveClass(/\bmono\b/);
    expect(await chip.evaluate((el) => getComputedStyle(el).fontFamily)).not.toContain('JetBrains');
    await expect.poll(() => screenText(win), { timeout: 15000 }).toContain(
      'If a Notion MCP server is available, use it to read the whole task (description, comments, subtasks, attachments) before you start.⏎⏎Notion task: Add rate limiting to the export endpoint⏎https://');
    await expect(win.locator('.toast')).toContainText('is in the prompt · press Enter to send');
    await win.waitForTimeout(800);
    expect(await screenText(win)).not.toContain('FAKE-CLAUDE submitted');
    // The title is cut short in the chip; its tooltip has the whole title, the status and the database, and the due date.
    expect((await chip.boundingBox())!.width).toBeLessThanOrEqual(200);
    await chip.hover();
    await expect(win.locator('.tooltip')).toContainText('In progress · Sprint Tasks');
    await expect(win.locator('.tooltip')).toContainText(/[Dd]ue /);
    const bar = (await win.locator('.session-bar').boundingBox())!;
    const tip = (await win.locator('.tooltip').boundingBox())!;
    await look(win, join(SHOTS, 'e2e-chip.png'), { clip: { x: bar.x, y: bar.y, width: Math.min(bar.width, 640), height: tip.y + tip.height - bar.y + 12 } });
    await t.done();
  } finally {
    await t.close();
  }
});

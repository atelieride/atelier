import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { BIG_DOC_BYTES } from '../support/pg-fixtures';
import { PgServer } from '../support/pg-server';
import {
  SHOTS, addConnection, addFilter, addFilterBtn, cell, chips, connRow, copies, dbIcon, frames, front, gridRows, header, lastCopy, launchDb, openDbView, openTable,
  relRow, setSettings, shot, stopDb, tabOf
} from './databases-fixture';

// The Databases view end to end: the test Postgres (PGlite, the acme world) on a loopback
// port, added by hand (the view looks for nothing).

type DbApi = { atelier: { databases: { refresh(): Promise<void>; snapshot(): Promise<Record<string, unknown>> } } };

let server: PgServer;
test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  server = await PgServer.start();
});
test.afterAll(async () => { await server?.stop(); });

/** The drawn cells whose value is cut by the column's width (JSON previews and values past 60 characters aside). */
const cutCells = (t: Locator) => t.locator('.dbt-grid').evaluate((grid) => {
  const json = new Set([...grid.querySelectorAll('thead th.is-json')].map((th) => th.getAttribute('data-col')));
  // A table cell doesn't report its overflow (scrollWidth): its content's own width against its content box — a fifth
  // of a pixel over is enough for the ellipsis.
  const cut = (td: HTMLElement) => {
    const r = document.createRange();
    r.selectNodeContents(td);
    const cs = getComputedStyle(td);
    return r.getBoundingClientRect().width > td.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 0.05;
  };
  return [...grid.querySelectorAll<HTMLElement>('tbody td[data-col]')]
    .filter((td) => !json.has(td.getAttribute('data-col')) && (td.textContent ?? '').length <= 60 && cut(td))
    .map((td) => `${grid.querySelector(`thead th[data-col="${td.getAttribute('data-col')}"] .dbt-th-name`)?.textContent}: ${td.textContent}`);
});
const widthsOf = (t: Locator) => t.locator('.dbt-grid thead .dbt-th').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
const footer = (t: Locator) => t.locator('.dbt-foot-label');

test('nothing is looked for — a .env naming the test Postgres shows no icon, suggests nothing, contacts nothing; ⌃⇧B opens the view, a saved connection brings the icon', async () => {
  await server.clearLog();
  const l = await launchDb(server, { dotenv: `DATABASE_URL=${server.url}\n` });
  const { win } = l;
  try {
    await expect(win.locator('.activity-bar .act').first()).toBeVisible({ timeout: 15000 });
    await win.evaluate(() => (window as unknown as DbApi).atelier.databases.refresh());
    expect(Object.keys(await win.evaluate(() => (window as unknown as DbApi).atelier.databases.snapshot())).sort()).toEqual(['catalog', 'connections', 'selected']);
    await expect(dbIcon(win)).toHaveCount(0);
    expect(await server.startupsLog(), 'nothing contacted the server').toEqual([]);
    // View › Databases (⌃⇧B): the view opens anyway, with the two ways to add one — nothing of the project's files.
    expect(await openDbView(l)).toBe('Ctrl+Shift+B');
    await expect(win.locator('.db-empty-title')).toHaveText('No databases yet');
    await expect(win.locator('.db-side')).not.toContainText('Found in this project');
    await expect(win.locator('.db-side')).not.toContainText('.env');
    // The icon stays while its view shows; a connection saved by hand keeps it there.
    await expect(dbIcon(win)).toBeVisible();
    await addConnection(l);
    await win.locator('.activity-bar .act').first().click();
    await expect(dbIcon(win)).toBeVisible();
  } finally {
    await stopDb(l);
  }
});

test('the write note is one line with a × (its script in the menu); Refresh says it works; the database chip switches the connection and closes its table tabs', async () => {
  test.setTimeout(120_000);
  await server.exec('create database shop');
  const l = await launchDb(server);
  const { win, home } = l;
  try {
    await addConnection(l);
    const row = connRow(win, 'postgres');
    // PGlite's role is a superuser — one quiet line under the row, the reason in its tooltip, a × and nothing else.
    const note = win.locator('.db-write');
    await expect(note).toHaveText('This role can write');
    await expect(note.locator('.db-write-text')).toHaveAttribute('data-tip', /^Atelier stays read-only: every statement runs in a read-only transaction/);
    // Whole at the sidebar's default width: nothing cut.
    expect(await note.locator('.db-write-text').evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    await expect(note.getByRole('button')).toHaveCount(1);
    await expect(win.locator('.db-note.is-warn')).toHaveCount(0);
    await shot(win, 'db-write-line');
    // The read-only role's script: the connection's menu, next to Copy psql Command.
    const before = copies(home).length;
    await row.click({ button: 'right' });
    await win.locator('.ctx-menu').first().getByRole('menuitem', { name: 'Copy SQL for a Read-only Role' }).click();
    expect(await lastCopy(home, before)).toContain('CREATE ROLE "atelier_readonly" LOGIN;');
    await note.getByRole('button', { name: 'Dismiss' }).click();
    await expect(note).toHaveCount(0);

    // Refresh turns while it reads (at least one turn), can't be pressed twice, the catalog dims; then it rests.
    const refresh = win.locator('.db-side .sidebar-head').getByRole('button', { name: 'Refresh' });
    await refresh.click();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveClass(/is-busy/);
    await expect(win.locator('.db-list')).toHaveClass(/is-refreshing/);
    await shot(win, 'db-refreshing');
    await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
    await expect(refresh).toBeEnabled();
    await expect(win.locator('.db-list')).not.toHaveClass(/is-refreshing/);

    // The chip names the database; its menu lists the server's; a pick switches (its table tabs close).
    const chip = win.locator('.db-database');
    await expect(chip).toHaveText('postgres');
    await relRow(win, 'orders').dblclick();
    await expect(tabOf(win, 'orders')).toHaveClass(/is-active/);
    // Shift+F10 on the chip: the same menu as a click.
    await chip.focus();
    await win.keyboard.press('Shift+F10');
    const menu = win.locator('.ctx-menu').first();
    await expect(menu.getByRole('menuitemradio', { name: 'postgres' })).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Escape');
    await chip.click();
    await expect(menu.getByRole('menuitemradio')).toHaveText(['postgres', 'shop']);
    await shot(win, 'db-database-menu');
    await menu.getByRole('menuitemradio', { name: 'shop' }).click();
    await expect(win.locator('.toast')).toContainText('Switched to shop');
    await expect(tabOf(win, 'orders')).toHaveCount(0);
    await expect(chip).toHaveText('shop', { timeout: 15000 });
    // The name was the database's: it follows. (PGlite serves one world whatever the name: the same tables.)
    await expect(connRow(win, 'shop')).toHaveClass(/is-connected/, { timeout: 15000 });
    await expect(relRow(win, 'orders')).toBeVisible({ timeout: 15000 });
    // The write note was dismissed for the role on this server: another database of it keeps it so.
    await expect(win.locator('.db-write')).toHaveCount(0);
    await shot(win, 'db-switched');
  } finally {
    await stopDb(l);
    await server.exec('drop database shop').catch(() => undefined);
  }
});

test('an empty maintenance database says so and offers the server\'s other databases, one click each', async () => {
  test.setTimeout(90_000);
  const bare = await PgServer.start({ seed: false });
  await bare.exec('create database acme');
  const l = await launchDb(bare);
  const { win } = l;
  try {
    await addConnection(l, { catalog: false });
    const said = win.locator('.db-cat-note', { hasText: /^No tables in / });
    await expect(said).toHaveText('No tables in postgres.', { timeout: 20000 });
    await expect(win.locator('.db-side')).not.toContainText('Nothing in this schema yet.');
    await expect(win.locator('.db-side .section-label', { hasText: 'Other databases on this server' })).toBeVisible();
    const other = win.locator('.db-other-db', { hasText: 'acme' });
    await expect(other).toHaveAttribute('data-tip', 'Switch to acme');
    await shot(win, 'db-empty-database');
    await other.click();
    await expect(win.locator('.db-database')).toHaveText('acme', { timeout: 15000 });
    // PGlite serves one database whatever the name: acme is empty too, and offers postgres back.
    await expect(said).toHaveText('No tables in acme.', { timeout: 15000 });
    await expect(win.locator('.db-other-db', { hasText: 'postgres' })).toBeVisible();
  } finally {
    await stopDb(l);
    await bare.stop();
  }
});

test('Add by URL → the catalog with counts; the orders grid reads every type; filter, sort, scroll, Count exactly; every read in a READ ONLY transaction', async () => {
  test.setTimeout(120_000);
  await server.clearLog();
  const l = await launchDb(server);
  const { win } = l;
  try {
    await addConnection(l);
    // Tables with their estimated rows (reltuples after the fixture's ANALYZE).
    await expect(relRow(win, 'orders').locator('.db-rel-count')).toHaveText('120');
    await expect(relRow(win, 'order_items').locator('.db-rel-count')).toHaveText('244');
    await expect(relRow(win, 'customers').locator('.db-rel-count')).toHaveText('40');
    // Views and materialized views wait folded under their counts; a fold opens.
    const views = win.locator('.db-fold', { hasText: /^Views/ });
    await expect(views).toHaveText(/Views\s*2/);
    await expect(win.locator('.db-fold', { hasText: /^Materialized views/ })).toHaveText(/Materialized views\s*1/);
    await views.click();
    await expect(views).toHaveAttribute('aria-expanded', 'true');
    await expect(relRow(win, 'paid_orders')).toBeVisible();
    await shot(win, 'db-catalog');

    // orders: typed cells — enum chips, the NULL pill, timestamps to the minute, the key and FK headers.
    const t = await openTable(win, 'orders');
    await expect(tabOf(win, 'orders')).toHaveClass(/is-preview/);
    await expect(header(t, 'id').locator('.dbt-th-pk')).toBeVisible();
    await expect(header(t, 'customer_id').locator('.dbt-th-fk')).toBeVisible();
    await expect(header(t, 'customer_id').locator('.dbt-th-type')).toHaveText('int8 → customers');
    await expect((await cell(t, 0, 'status')).locator('.dbt-en')).toHaveText('shipped');
    await expect((await cell(t, 0, 'created_at')).locator('.dbt-time')).toHaveText(/^2026-10-2\d \d\d:\d\d/);
    await expect((await cell(t, 0, 'total')).locator('.dbt-num')).toBeVisible();
    // Some order has no payment yet: paid_at is NULL (a pill, never the word as text).
    await expect(t.locator(`.dbt-grid tbody td[data-col="${await header(t, 'paid_at').getAttribute('data-col')}"] .dbt-nul`).first()).toBeVisible();
    await expect(footer(t)).toHaveText(/^100 loaded of ~120$/);
    await shot(win, 'db-orders');
    // First widths fit what the first rows show: no value of 60 characters or fewer ends in an ellipsis —
    // a JSON preview aside, cut at its width by design. (The totals' "158.…" in the first shots: a border not counted.)
    expect(await cutCells(t)).toEqual([]);

    // order_items (244 rows): a filter chip, a sort, then scrolling to the bottom loads the next 100.
    const items = await openTable(win, 'order_items');
    await expect(tabOf(win, 'order_items')).toHaveClass(/is-preview/);
    await expect(win.locator('.tab.is-db')).toHaveCount(1);
    const before = await widthsOf(items);
    await addFilter(items, 'quant', 'ge', ['1']);
    await expect(chips(items)).toHaveText(['quantity≥1']);
    // A filter keeps the preview (an investment).
    await expect(tabOf(win, 'order_items')).not.toHaveClass(/is-preview/);
    await header(items, 'sku').locator('.dbt-th-btn').click();
    await expect(header(items, 'sku')).toHaveAttribute('aria-sort', 'ascending');
    await expect(gridRows(items).first()).toBeVisible();
    // The columns keep their first widths through the filter and the sort.
    expect(await widthsOf(items)).toEqual(before);
    await expect(footer(items)).toHaveText(/^100 loaded/);
    const grid = items.locator('.dbt-grid');
    await grid.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(footer(items)).toHaveText(/^200 loaded of ~\d/, { timeout: 10000 });
    await shot(win, 'db-scrolled');
    // Count exactly: count(*) with the filter replaces the estimate.
    await items.locator('.dbt-count').click();
    await expect(footer(items)).toHaveText('200 loaded of 244');
    await shot(win, 'db-counted');
    // Rows 101–200 are the second fetch's (drawn once scrolled to: the grid is virtualized), numbered on.
    await grid.evaluate((el) => { el.scrollTop = 150 * 30; });
    await expect(items.locator('.dbt-grid tbody tr[data-row="150"] .dbt-rn')).toHaveText('151');
    // To the end: the last fetch, the footer says all are loaded, Count exactly has nothing left to count.
    await grid.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(footer(items)).toHaveText('all 244 loaded', { timeout: 10000 });
    await grid.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(items.locator('.dbt-grid tbody tr[data-row="243"] .dbt-rn')).toHaveText('244');
    await expect(items.locator('.dbt-count')).toHaveCount(0);
    await frames(win);

    // Read-only by construction, as the server saw it: every transaction the view opened was READ ONLY
    // with its statement_timeout (local too), each
    // ended in ROLLBACK, never a COMMIT, never a session-level SET.
    const log = await server.statementsLog();
    const begins = log.filter((s) => /^\s*BEGIN/i.test(s));
    expect(begins.length, 'the view read through transactions').toBeGreaterThan(10);
    const wrapper = /^BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = \d+(; SET LOCAL synchronize_seqscans = off; SET LOCAL max_parallel_workers_per_gather = 0)?$/;
    expect(begins.filter((s) => !wrapper.test(s)), 'every BEGIN is READ ONLY').toEqual([]);
    expect(log.filter((s) => /^\s*COMMIT/i.test(s))).toEqual([]);
    expect(log.filter((s) => /^\s*ROLLBACK\s*$/i.test(s)).length, 'each transaction rolled back').toBeGreaterThanOrEqual(begins.length);
    expect(log.filter((s) => /^\s*SET\s/i.test(s)), 'no session-level SET').toEqual([]);
  } finally {
    await stopDb(l);
  }
});

const menu = (win: Page) => win.locator('.ctx-menu').first();
const chipTips = (t: Locator) => chips(t).evaluateAll((els) => els.map((e) => e.getAttribute('data-tip')));

test('the grid: Shift+F10 at the focused cell (scrolled away too), filters from a cell, chips by keyboard, Is any of, Wrap Cells, the last row above the bar, Data ↔ Structure keeps the place', async () => {
  test.setTimeout(120_000);
  const l = await launchDb(server);
  const { win } = l;
  try {
    await addConnection(l);
    const t = await openTable(win, 'orders');
    const grid = t.locator('.dbt-grid');

    // Shift+F10 on a focused cell: its menu, beside that cell.
    const status = await cell(t, 2, 'status');
    await status.click();
    await expect(t.locator('.dbt-grid tbody tr[data-row="2"]')).toHaveClass(/is-sel/);
    await win.keyboard.press('Shift+F10');
    await expect(menu(win)).toBeVisible();
    const at = (await status.boundingBox())!;
    const m = (await menu(win).boundingBox())!;
    expect(Math.abs(m.y - (at.y + at.height)), 'the menu opens at the cell’s foot').toBeLessThan(12);
    expect(m.x, 'the menu starts over the cell').toBeGreaterThanOrEqual(at.x - 1);
    expect(m.x).toBeLessThan(at.x + at.width);
    await expect(menu(win).getByRole('menuitem', { name: 'Filter by This Value' })).toBeVisible();
    await expect(menu(win).getByRole('menuitem', { name: 'Exclude This Value' })).toBeVisible();
    await shot(win, 'db-cell-menu');
    // Filter by This Value: the chip, the rows all shipped… (row 2's status).
    const value = (await status.innerText()).trim();
    await menu(win).getByRole('menuitem', { name: 'Filter by This Value' }).click();
    await expect.poll(() => chipTips(t)).toEqual([`status is any of ${value}`]);
    await expect(t.locator(`.dbt-grid tbody td[data-col="${await header(t, 'status').getAttribute('data-col')}"] .dbt-en`).filter({ hasNotText: value })).toHaveCount(0);
    // The chip goes with ⌫ (the keyboard back on the bar's next stop).
    await chips(t).first().focus();
    await win.keyboard.press('Backspace');
    await expect(chips(t)).toHaveCount(0);
    await expect(addFilterBtn(t)).toBeFocused();
    // Exclude This Value from the same cell's menu (right-click).
    const again = await cell(t, 2, 'status');
    await again.click({ button: 'right' });
    await menu(win).getByRole('menuitem', { name: 'Exclude This Value' }).click();
    await expect.poll(() => chipTips(t)).toEqual([`status is none of ${value}`]);
    await expect(t.locator('.dbt-grid tbody .dbt-en', { hasText: new RegExp(`^${value}$`) })).toHaveCount(0);
    // A chip's menu with Shift+F10: Clear All Filters.
    await chips(t).first().focus();
    await win.keyboard.press('Shift+F10');
    await expect(menu(win).getByRole('menuitem', { name: 'Edit Filter…' })).toBeVisible();
    await menu(win).getByRole('menuitem', { name: 'Clear All Filters' }).click();
    await expect(chips(t)).toHaveCount(0);

    // "Is any of" with a value typed and left in its field (no Enter): Apply takes it.
    await addFilterBtn(t).click();
    const pop = win.locator('.dbt-fpop');
    await pop.getByRole('combobox', { name: 'Find a column' }).fill('coupon');
    await pop.getByRole('combobox', { name: 'Find a column' }).press('Enter');
    await pop.locator('.dbt-fpop-op').selectOption('in');
    await pop.getByRole('textbox', { name: 'Add a value' }).fill('AUTUMN10');
    await pop.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => chipTips(t)).toEqual(['coupon_code is any of AUTUMN10']);
    const coupon = await header(t, 'coupon_code').getAttribute('data-col');
    await expect(t.locator(`.dbt-grid tbody td[data-col="${coupon}"]`).first()).toHaveText('AUTUMN10');
    await expect(t.locator(`.dbt-grid tbody td[data-col="${coupon}"]`).filter({ hasNotText: 'AUTUMN10' })).toHaveCount(0);
    await chips(t).first().focus();
    await win.keyboard.press('Delete');
    await expect(chips(t)).toHaveCount(0);
    await expect(t.locator('.dbt-foot-label')).toHaveText(/^100 loaded/);

    // Shift+F10 with the focused cell scrolled out of view: the row comes back into view, the menu beside it.
    const first = await cell(t, 0, 'total');
    await first.click();
    await grid.evaluate((el) => { el.scrollTop = 40 * 30; });
    await expect(t.locator('.dbt-grid tbody tr[data-row="0"]')).toHaveCount(0);
    await win.keyboard.press('Shift+F10');
    await expect(menu(win)).toBeVisible();
    await expect(t.locator('.dbt-grid tbody tr[data-row="0"]')).toBeVisible();
    const back = (await (await cell(t, 0, 'total')).boundingBox())!;
    const m2 = (await menu(win).boundingBox())!;
    expect(Math.abs(m2.y - (back.y + back.height)), 'the menu at the focused cell’s foot').toBeLessThan(12);
    const g = (await grid.boundingBox())!;
    expect(m2.y).toBeGreaterThan(g.y);
    await win.keyboard.press('Escape');
    await expect(menu(win)).toHaveCount(0);

    // Wrap Cells (⌥Z): rows exactly 120 px; again, 30.
    await grid.focus();
    await win.keyboard.press('Alt+z');
    await expect(grid.locator('.dbt-table')).toHaveClass(/is-wrap/);
    const tall = await gridRows(t).evaluateAll((els) => [...new Set(els.map((e) => e.getBoundingClientRect().height))]);
    expect(tall).toEqual([120]);
    await shot(win, 'db-wrap');
    await win.keyboard.press('Alt+z');
    await expect(grid.locator('.dbt-table')).not.toHaveClass(/is-wrap/);
    expect(await gridRows(t).evaluateAll((els) => [...new Set(els.map((e) => e.getBoundingClientRect().height))])).toEqual([30]);

    // Data → Structure → Data: the grid comes back where it was.
    await grid.evaluate((el) => { el.scrollTop = 33 * 30; });
    await frames(win);
    const top = await grid.evaluate((el) => el.scrollTop);
    await t.getByRole('radio', { name: 'Structure' }).click();
    await expect(t.locator('.dbs')).toBeVisible({ timeout: 10000 });
    await t.getByRole('radio', { name: 'Data' }).click();
    await expect(grid).toBeVisible();
    await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(top);
    await expect(t.locator('.dbt-grid tbody tr[data-row="33"]')).toBeVisible();

    // customers (40 rows, one fetch): ↓ to the last row with rows selected, it stays above the action bar.
    const c = await openTable(win, 'customers');
    await expect(c.locator('.dbt-foot-label')).toHaveText('all 40 loaded');
    await (await cell(c, 0, 'name')).click();
    await expect(c.locator('.db-selbar')).toBeVisible();
    for (let i = 0; i < 39; i++) await win.keyboard.press('ArrowDown');
    const last = c.locator('.dbt-grid tbody tr[data-row="39"]');
    await expect(last).toHaveClass(/is-sel/);
    const lastBox = (await last.boundingBox())!;
    const bar = (await c.locator('.db-selbar').boundingBox())!;
    expect(lastBox.y + lastBox.height, 'the last row ends above the action bar').toBeLessThanOrEqual(bar.y + 0.5);
    await shot(win, 'db-last-row');
  } finally {
    await stopDb(l);
  }
});

const toast = (win: Page) => win.locator('.toast').last();

test('the row inspector: FK peek → Open › (customers filtered), Referenced by → order_items, Filters replaced with Undo, beside ↔ over keeps folds and focus', async () => {
  test.setTimeout(120_000);
  const l = await launchDb(server);
  const { win } = l;
  try {
    await addConnection(l);
    const t = await openTable(win, 'orders');
    // Order 111: the showcase's inspected row (Mara Lindqvist, pro, AUTUMN10).
    await addFilter(t, 'id', 'eq', ['111']);
    await expect.poll(() => chipTips(t)).toEqual(['id equals 111']);
    await expect(t.locator('.dbt-foot-label')).toHaveText('1 row');
    await (await cell(t, 0, 'status')).click();
    await win.keyboard.press('Enter');
    const insp = t.locator('.dbi');
    await expect(insp).toBeVisible();
    await expect(insp).not.toHaveClass(/is-over/);
    await expect(insp.locator('.dbi-key')).toHaveText('111');
    // The FK peek card: the customer's name, the plan chip, Open ›.
    const peek = insp.locator('.dbi-f', { has: win.locator('.dbi-fn-t', { hasText: /^customer_id$/ }) }).locator('.dbi-peek');
    await expect(peek.locator('.dbi-peek-label')).toHaveText('Mara Lindqvist', { timeout: 10000 });
    await expect(peek.locator('.dbi-peek-chip').first()).toHaveText('pro');
    await expect(peek.locator('.dbi-peek-open')).toHaveText('Open ›');
    // Referenced by: each foreign key pointing at orders, this row's count.
    const ref = (table: string) => insp.locator('.dbi-ref', { has: win.locator('.dbi-ref-t', { hasText: new RegExp(`^${table}`) }) });
    await expect(ref('order_items').locator('.dbi-ref-n')).toHaveText('3 rows ›', { timeout: 10000 });
    await expect(ref('payments').locator('.dbi-ref-n')).toHaveText('1 row ›');
    // refunds.order_id has no index: not counted, still openable.
    await expect(ref('refunds').locator('.dbi-ref-n')).toHaveText('Open ›');
    await expect(ref('refunds')).toHaveAttribute('data-tip', /Not counted: no index/);
    await shot(win, 'db-inspector');

    // Open › : customers as a preview, filtered on the key, that row selected, its inspector open.
    await peek.locator('.dbi-peek-open').click();
    await expect(tabOf(win, 'customers')).toHaveClass(/is-active/);
    await expect(tabOf(win, 'customers')).toHaveClass(/is-preview/);
    const c = front(win);
    await expect(c.locator('.dbt-crumb-name')).toHaveText('customers');
    await expect.poll(() => chipTips(c)).toEqual(['id equals 1']);
    await expect(c.locator('.dbt-grid tbody tr[data-row="0"]')).toHaveClass(/is-sel/, { timeout: 10000 });
    await expect(c.locator('.dbi .dbi-key')).toHaveText('1');
    // Its own filter (a cell's Filter by This Value): the tab is theirs now (kept).
    await (await cell(c, 0, 'plan')).click({ button: 'right' });
    await menu(win).getByRole('menuitem', { name: 'Filter by This Value' }).click();
    await expect.poll(() => chipTips(c)).toEqual(['id equals 1', 'plan is any of pro']);
    await expect(tabOf(win, 'customers')).not.toHaveClass(/is-preview/);

    // Referenced by → order_items: a preview filtered on the key (three lines).
    await tabOf(win, 'orders').click();
    await expect(front(win).locator('.dbt-crumb-name')).toHaveText('orders');
    await ref('order_items').click();
    await expect(tabOf(win, 'order_items')).toHaveClass(/is-active/);
    await expect(tabOf(win, 'order_items')).toHaveClass(/is-preview/);
    const oi = front(win);
    await expect.poll(() => chipTips(oi)).toEqual(['order_id equals 111']);
    await expect(oi.locator('.dbt-foot-label')).toHaveText('all 3 loaded');

    // Open › into customers again, now with filters of its own: replaced, said, and Undo brings them back.
    await tabOf(win, 'orders').click();
    await peek.locator('.dbi-peek-open').click();
    await expect(tabOf(win, 'customers')).toHaveClass(/is-active/);
    await expect.poll(() => chipTips(front(win))).toEqual(['id equals 1']);
    await expect(toast(win)).toContainText('Filters replaced');
    await shot(win, 'db-filters-replaced');
    await toast(win).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => chipTips(front(win))).toEqual(['id equals 1', 'plan is any of pro']);

    // Beside ↔ over: a narrower window lays the inspector over the rows; its JSON folds and the keyboard stay.
    await tabOf(win, 'orders').click();
    const meta = insp.locator('.dbi-f', { has: win.locator('.dbi-fn-t', { hasText: /^metadata$/ }) });
    const items = meta.locator('.rd-jl.is-foldable', { hasText: '"items"' });
    await expect(items).toHaveAttribute('aria-expanded', 'true');
    // A folded item's one-line preview (`{ "qty": 1, "sku": … }` and its "2 keys" chip) stays inside the field: the
    // preview ellipsizes, the chip whole (it used to run past the panel's edge, the chip cut).
    expect(await meta.locator('.dbi-json').evaluate((box) => {
      const edge = box.getBoundingClientRect().right;
      const out: string[] = [];
      for (const l of box.querySelectorAll<HTMLElement>('.rd-jl')) {
        for (const el of l.querySelectorAll<HTMLElement>('*')) if (el.getBoundingClientRect().right > edge + 0.5) out.push(`${l.textContent}: ${el.className} past the edge`);
        const chip = l.querySelector<HTMLElement>('.rd-jchip');
        if (chip && chip.scrollWidth > chip.clientWidth) out.push(`${l.textContent}: the chip cut`);
      }
      return out;
    })).toEqual([]);
    await expect(meta.locator('.rd-jchip').first()).toContainText('2 keys');
    // A fold toggled keeps the keyboard on its button (the line used to be drawn anew: the focus fell to the page).
    await items.locator('.rd-jfold').click();
    await expect(items).toHaveAttribute('aria-expanded', 'false');
    await expect(items.locator('.rd-jfold')).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(items).toHaveAttribute('aria-expanded', 'true');
    await expect(items.locator('.rd-jfold')).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(items).toHaveAttribute('aria-expanded', 'false');
    await win.setViewportSize({ width: 900, height: 700 });
    await expect(insp).toHaveClass(/is-over/);
    await expect(items).toHaveAttribute('aria-expanded', 'false');
    expect(await insp.evaluate((el) => el.contains(document.activeElement)), 'the keyboard stays in the inspector').toBe(true);
    await shot(win, 'db-inspector-over');
    await win.setViewportSize({ width: 1440, height: 900 });
    await expect(insp).not.toHaveClass(/is-over/);
    await expect(items).toHaveAttribute('aria-expanded', 'false');
    expect(await insp.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  } finally {
    await stopDb(l);
  }
});

test('the record view: Tab on a row shows it whole — every column, a hidden one read by its key —; ↓ twice, Esc back on that row; Tab back; the toolbar\'s toggle; the last row loaded asks for more; the grid\'s place kept', async () => {
  test.setTimeout(150_000);
  const l = await launchDb(server);
  const { win } = l;
  try {
    await addConnection(l);
    const t = await openTable(win, 'orders');
    const grid = t.locator('.dbt-grid');
    const rec = t.locator('.dbrv');
    const pos = rec.locator('.dbrv-pos');
    // notes hidden from the grid (its column menu): the record view still shows it, read by the row's key.
    await header(t, 'notes').click({ button: 'right' });
    await win.locator('.dbj-cm').getByRole('menuitem', { name: 'Hide Column' }).click();
    await expect(header(t, 'notes')).toHaveCount(0);
    await expect(footer(t)).toHaveText(/^100 loaded/);
    const ids = await Promise.all([0, 1, 2].map(async (r) => (await (await cell(t, r, 'id')).innerText()).trim()));
    // The side inspector open on the first row.
    await (await cell(t, 0, 'status')).click();
    await win.keyboard.press('Enter');
    const insp = t.locator('.dbi');
    await expect(insp).toBeVisible();

    // Tab: the row as a record, in the rows' place; the inspector hides (the same row twice), the grid too.
    await win.keyboard.press('Tab');
    await expect(rec).toBeVisible();
    await expect(t.locator('.dbrv-body')).toBeFocused();
    await expect(grid).toBeHidden();
    await expect(insp).toBeHidden();
    await expect(pos).toHaveText('Row 1 of 100 loaded');
    await expect(rec.locator('.dbrv-key')).toHaveText(ids[0]!);
    await expect(t.getByRole('radio', { name: 'Record' })).toHaveAttribute('aria-checked', 'true');
    // Every column: the grid's in its order, then notes under "Hidden from the grid", its value read (no "Reading…").
    const names = rec.locator('.dbi-fn-t');
    await expect(names).toHaveText(['id', 'customer_id', 'status', 'total', 'currency', 'metadata', 'tags', 'coupon_code', 'created_at', 'paid_at', 'updated_at', 'notes']);
    await expect(rec.locator('.dbrv-sec')).toHaveText('Hidden from the grid');
    const notes = rec.locator('.dbi-f', { has: win.locator('.dbi-fn-t', { hasText: /^notes$/ }) });
    await expect(notes.locator('.dbi-fv')).not.toContainText('Reading', { timeout: 10000 });
    await expect(notes.locator('.dbi-fv')).not.toContainText('not read');
    // JSON as a tree, the customer's card.
    await expect(rec.locator('.dbi-f', { has: win.locator('.dbi-fn-t', { hasText: /^metadata$/ }) }).locator('.rd-json')).toBeVisible();
    await expect(rec.locator('.dbi-peek-label').first()).not.toHaveText(/Reading/, { timeout: 10000 });
    await shot(win, 'db-record');

    // ↓ twice: the third row; Esc: the grid again, that row focused and selected, the keyboard there; the inspector back.
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await expect(pos).toHaveText('Row 3 of 100 loaded');
    await expect(rec.locator('.dbrv-key')).toHaveText(ids[2]!);
    await win.keyboard.press('Escape');
    await expect(rec).toHaveCount(0);
    await expect(grid).toBeFocused();
    await expect(t.locator('.dbt-grid tbody tr[data-row="2"]')).toHaveClass(/is-sel/);
    await expect(t.locator('.dbt-grid tbody tr.is-sel')).toHaveCount(1);
    await expect(t.locator('.dbt-grid tbody tr[data-row="2"] td.is-focus')).toHaveCount(1);
    await expect(insp).toBeVisible();
    await expect(insp.locator('.dbi-key')).toHaveText(ids[2]!);

    // Tab again, Shift+Tab moves the focus out of the body (nothing trapped), Tab from there back to the grid.
    await win.keyboard.press('Tab');
    await expect(pos).toHaveText('Row 3 of 100 loaded');
    await win.keyboard.press('Shift+Tab');
    await expect(t.locator('.dbrv-body')).not.toBeFocused();
    await expect(rec).toBeVisible();
    await win.keyboard.press('Tab');
    await expect(rec).toHaveCount(0);
    await expect(grid).toBeFocused();

    // The toolbar's toggle: Record on the focused row, the keyboard stays on the toggle; Grid back.
    await t.getByRole('radio', { name: 'Record' }).click();
    await expect(pos).toHaveText('Row 3 of 100 loaded');
    await expect(t.getByRole('radio', { name: 'Record' })).toBeFocused();
    await t.getByRole('radio', { name: 'Grid' }).click();
    await expect(rec).toHaveCount(0);
    await expect(t.locator('.dbt-grid tbody tr[data-row="2"]')).toHaveClass(/is-sel/);

    // The last row loaded asks for the next fetch (as the grid near its end); at the very end ↓ stays.
    await grid.focus();
    await win.keyboard.press('Tab');
    for (let i = 0; i < 97; i++) await win.keyboard.press('ArrowDown');
    await expect(pos).toHaveText('Row 100 of 120 loaded', { timeout: 15000 });
    for (let i = 0; i < 25; i++) await win.keyboard.press('ArrowDown');
    await expect(pos).toHaveText('Row 120 of 120 loaded');
    await expect(rec.getByRole('button', { name: 'Next Row' })).toBeDisabled();
    await expect(footer(t)).toHaveText('all 120 loaded');
    // Back: the row it moved to is brought into view.
    await win.keyboard.press('Escape');
    await expect(t.locator('.dbt-grid tbody tr[data-row="119"]')).toHaveClass(/is-sel/);
    await expect(t.locator('.dbt-grid tbody tr[data-row="119"]')).toBeInViewport();

    // A row it didn't move from: the grid's place comes back as it was.
    await grid.evaluate((el) => { el.scrollTop = 33 * 30; });
    await frames(win);
    const top = await grid.evaluate((el) => el.scrollTop);
    await (await cell(t, 36, 'status')).click();
    await win.keyboard.press('Tab');
    await expect(pos).toHaveText('Row 37 of 120 loaded');
    await win.keyboard.press('Tab');
    await expect(grid).toBeFocused();
    await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(top);
  } finally {
    await stopDb(l);
  }
});

/** The inspector's width: 280 by its splitter's Home, else dragged to `w` from its edge. */
async function inspectorTo(win: Page, t: Locator, w: number): Promise<void> {
  const edge = t.locator('.dbi-rs');
  if (w === 280) {
    await edge.focus();
    await win.keyboard.press('Home');
  } else {
    const now = Number(await edge.getAttribute('aria-valuenow'));
    const b = (await edge.boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await win.mouse.move(x, y);
    await win.mouse.down();
    await win.mouse.move(x - (w - now) / 2, y, { steps: 2 });
    await win.mouse.move(x - (w - now), y, { steps: 2 });
    await win.mouse.up();
  }
  await expect(edge).toHaveAttribute('aria-valuenow', String(w));
}

/** The JSON view's breadcrumb: the leaf whole inside the bar, and (`cut`) the start out of it on the left. */
/**
 * The JSON tree's drawn lines at a narrow width: a key of 10 characters or fewer (its quotes included) whole, a longer
 * one at least 10 characters wide — the value gives way first —; each level's indent `indent` px (the 40% cap aside);
 * a line's actions never over its key, inside the line. The problems, named.
 */
function jsonRowsHold(t: Locator, indent: number): Promise<string[]> {
  return t.locator('.dbj-tree').evaluate((tree, perLevel) => {
    const out: string[] = [];
    const ch = parseFloat(getComputedStyle(tree).fontSize) * 0.6;
    for (const row of tree.querySelectorAll<HTMLElement>('.dbj-row[role="treeitem"]')) {
      const k = row.querySelector<HTMLElement>('.dbj-k');
      const text = k?.textContent ?? '';
      const at = `line ${row.querySelector('.dbj-no')?.textContent} ${text}`;
      if (k && text.length <= 10 && k.scrollWidth > k.clientWidth) out.push(`${at}: the key is cut`);
      if (k && text.length > 10 && k.getBoundingClientRect().width < 10 * ch - 1) out.push(`${at}: the key under 10 characters`);
      const level = Number(row.getAttribute('aria-level')) - 1;
      const ind = row.querySelector<HTMLElement>('.dbj-ind')!.getBoundingClientRect().width;
      const want = Math.min(level * perLevel, row.getBoundingClientRect().width * 0.4);
      if (Math.abs(ind - want) > 0.5) out.push(`${at}: indent ${ind}, not ${want}`);
      const acts = row.querySelector<HTMLElement>('.dbj-acts');
      if (acts && getComputedStyle(acts).display !== 'none') {
        const a = acts.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        if (k && a.left < k.getBoundingClientRect().right - 0.5) out.push(`${at}: the actions over the key`);
        if (a.right > r.right + 0.5) out.push(`${at}: the actions past the line`);
      }
    }
    return out;
  }, indent);
}

async function crumbsFit(t: Locator, cut: boolean, where: string): Promise<void> {
  const r = await t.locator('.dbj-crumbs').evaluate((nav) => {
    const box = nav.getBoundingClientRect();
    const items = [...nav.querySelectorAll('.dbj-ci')].map((e) => e.getBoundingClientRect());
    const leaf = nav.querySelector('.dbj-ci.is-leaf')!.getBoundingClientRect();
    return { left: box.left, right: box.right, leafL: leaf.left, leafR: leaf.right, firstL: Math.min(...items.map((i) => i.left)) };
  });
  expect(r.leafL, `${where}: the leaf starts inside the bar`).toBeGreaterThanOrEqual(r.left - 0.5);
  expect(r.leafR, `${where}: the leaf ends inside the bar`).toBeLessThanOrEqual(r.right + 0.5);
  if (cut) expect(r.firstL, `${where}: the start is cut on the left`).toBeLessThan(r.left);
}

test('JSON: Copy Value of a cut cell, a cut copy said; a key as a column; the JSON view (keys, find, Path and SQL copied, breadcrumb); Load full value', async () => {
  test.setTimeout(150_000);
  const l = await launchDb(server);
  const { win, home } = l;
  try {
    await addConnection(l);
    const t = await openTable(win, 'webhook_events');
    // Event 1's payload is over 64 KB: cut in main, marked in the cell.
    const big = await cell(t, 0, 'payload');
    await expect(big.locator('.dbt-cut')).toBeVisible();
    // Copy Value reads it whole (by its key) first.
    let n = copies(home).length;
    await big.click({ button: 'right' });
    await menu(win).getByRole('menuitem', { name: 'Copy Value' }).click();
    const whole = await lastCopy(home, n);
    expect(whole.length).toBe(BIG_DOC_BYTES);
    expect(JSON.parse(whole).data.object.lines.total_count).toBe(320);
    // Three rows copied (TSV): the one cut value in it is said.
    await (await cell(t, 0, 'type')).click();
    await (await cell(t, 2, 'type')).click({ modifiers: ['Shift'] });
    n = copies(home).length;
    await win.keyboard.press('Meta+c');
    const tsv = await lastCopy(home, n);
    expect(tsv.split('\n')[0]).toContain('payload');
    await expect(toast(win)).toHaveText('1 value was cut at 64 KB in this copy');
    await win.keyboard.press('Escape');

    // The key profile: data.object.status added as a column (a JSON column, its values read by main at the path).
    await header(t, 'payload').locator('.dbt-th-menu').click();
    const cm = win.locator('.dbj-cm');
    await expect(cm.locator('.dbj-cm-head')).toContainText('Keys in');
    await shot(win, 'db-key-profile');
    await cm.getByRole('menuitem', { name: /^data\.object\.status · string/ }).click();
    const drv = t.locator('.dbt-th.is-drv');
    await expect(drv.locator('.dbt-th-name')).toHaveText('status');
    await expect(drv.locator('.dbt-th-type')).toContainText('data.object.status');
    const drvCol = await drv.getAttribute('data-col');
    // Event 1 (cut in the payload) has its status too: read at the path, not from the cut text.
    await expect(t.locator(`.dbt-grid tbody tr[data-row="0"] td[data-col="${drvCol}"]`)).toHaveText('open');
    await expect(t.locator(`.dbt-grid tbody td[data-col="${drvCol}"]`, { hasText: /^paid$/ }).first()).toBeVisible();
    // A JSON column is an investment: the preview is kept.
    await expect(tabOf(win, 'webhook_events')).not.toHaveClass(/is-preview/);
    await shot(win, 'db-json-column');

    // The JSON view of event 33, from a double click on its cell.
    const grid = t.locator('.dbt-grid');
    await grid.evaluate((el) => { el.scrollTop = 25 * 30; });
    await (await cell(t, 32, 'payload')).dblclick();
    const jv = t.locator('.dbj');
    await expect(jv).toBeVisible();
    await expect(jv.locator('.dbj-name')).toHaveText('payload');
    await expect(jv.locator('.dbj-meta')).toContainText('row 33');
    const tree = jv.locator('.dbj-tree');
    // The keyboard in the tree at once (it used to stay on the view's frame: ↑/↓ did nothing until a click).
    await expect(tree).toBeFocused({ timeout: 10000 });
    // The keys: ↓ and ↑ move, → / ← open and fold.
    const selNo = () => jv.locator('.dbj-row.is-sel .dbj-no').innerText();
    await win.keyboard.press('ArrowDown');
    await expect(jv.locator('.dbj-row.is-sel')).toHaveCount(1);
    const firstDown = await selNo();
    await win.keyboard.press('ArrowDown');
    await expect.poll(selNo).toBe(String(Number(firstDown) + 1));
    await win.keyboard.press('ArrowUp');
    await expect.poll(selNo).toBe(firstDown);
    // ⌘F: find a key; the hit is selected; its path and SQL in the bottom bar.
    await win.keyboard.press('Meta+f');
    const find = jv.getByRole('textbox', { name: 'Find in this value' });
    await expect(find).toBeFocused();
    await find.fill('unit_amount');
    await expect(jv.locator('.dbj-count')).toHaveText(/^1 of 2$/);
    await expect(jv.locator('.dbj-bar-code').first()).toHaveText('data.object.lines.data[0].price.unit_amount');
    await expect(jv.locator('.dbj-bar-code.is-sql')).toHaveText(/payload"? #>> '\{data,object,lines,data,0,price,unit_amount\}'/);
    await shot(win, 'db-json-view');
    n = copies(home).length;
    await jv.locator('.dbj-bar').getByRole('button', { name: 'Copy Path', exact: true }).click();
    expect(await lastCopy(home, n)).toBe('data.object.lines.data[0].price.unit_amount');
    n = copies(home).length;
    await jv.locator('.dbj-bar').getByRole('button', { name: 'Copy SQL', exact: true }).click();
    expect(await lastCopy(home, n)).toMatch(/payload"? #>> '\{data,object,lines,data,0,price,unit_amount\}'/);
    // Esc in the find clears it (the keyboard back on the tree); Esc again closes the view (back to the grid).
    await find.focus();
    await win.keyboard.press('Escape');
    await expect(find).toHaveValue('');
    await expect(tree).toBeFocused();
    const sel = jv.locator('.dbj-row.is-sel');
    // ← folds the selected node's parent path step by step: on a leaf it goes to its parent.
    await win.keyboard.press('ArrowLeft');
    await expect(sel.locator('.dbj-k')).toHaveText('"price"');
    await win.keyboard.press('ArrowLeft');
    await expect(sel).toHaveAttribute('aria-expanded', 'false');
    await win.keyboard.press('ArrowRight');
    await expect(sel).toHaveAttribute('aria-expanded', 'true');
    // The breadcrumb at 280 and 430 px: the leaf stays whole, the start goes out on the left.
    await inspectorTo(win, t, 280);
    await crumbsFit(t, true, '280 px');
    // Keys first: none cut to "…" while its value keeps room; the levels' indent narrower; the selected line's actions
    // beside its key, inside the line.
    expect(await jsonRowsHold(t, 8), '280 px').toEqual([]);
    await shot(win, 'db-narrow-json-280');
    await inspectorTo(win, t, 430);
    await crumbsFit(t, false, '430 px');
    await shot(win, 'db-narrow-json-430');
    await tree.focus();
    await win.keyboard.press('Escape');
    await expect(jv).toHaveCount(0);
    await expect(grid).toBeFocused();

    // Load full value on event 1 (fields): its tree; then its JSON view scrolls the whole document (virtualized).
    await grid.evaluate((el) => { el.scrollTop = 0; });
    await (await cell(t, 0, 'type')).click();
    await win.keyboard.press('Enter');
    const insp = t.locator('.dbi');
    const payload = insp.locator('.dbi-f', { has: win.locator('.dbi-fn-t', { hasText: /^payload$/ }) });
    await expect(payload.locator('.dbi-cut-t')).toHaveText(/^Showing 64 KB of 10\d(\.\d)? KB$/);
    await payload.getByRole('button', { name: 'Load full value' }).click();
    await expect(payload.locator('.rd-json')).toBeVisible({ timeout: 15000 });
    await expect(payload.locator('.dbi-cut')).toHaveCount(0);
    await payload.getByRole('button', { name: 'Open in JSON View' }).click();
    await expect(jv.locator('.dbj-tree')).toBeVisible();
    await jv.getByRole('button', { name: /Expand all/ }).click();
    const lines = jv.locator('.dbj-lines');
    const height = await lines.evaluate((el) => el.getBoundingClientRect().height);
    // Every line open (the 320 items: 50 drawn, then "… 270 more"), nearly a thousand lines in the scroller.
    expect(height, 'the document’s lines are in the scroller').toBeGreaterThan(900 * 20);
    expect(await jv.locator('.dbj-row').count(), 'only the lines on screen are drawn').toBeLessThan(200);
    await jv.locator('.dbj-tree').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(jv.locator('.dbj-row.is-more .dbj-more')).toHaveText('… 270 more');
    await expect(jv.locator('.dbj-row.is-close').last()).toBeVisible();
    await shot(win, 'db-json-big');
    await jv.getByRole('button', { name: 'Back to Fields' }).click();

    // A JSON column read by its path: data.object.lines of event 1, cut at 64 KB, loaded whole as a tree.
    await header(t, 'payload').locator('.dbt-th-menu').click();
    await cm.getByRole('menuitem', { name: /^data\.object\.lines · object/ }).click();
    // The rows read again from the top (a new column): event 1 stays inspected (as the JSON view's + Column).
    await expect(t.locator('.dbt-th.is-drv .dbt-th-name')).toHaveText(['status', 'lines']);
    await expect(insp.locator('.dbi-key')).toHaveText('1');
    await expect(t.locator('.dbt-grid tbody tr[data-row="0"]')).toHaveClass(/is-sel/);
    const lc = insp.locator('.dbi-f', { has: win.locator('.dbi-fn-t', { hasText: /^payload\.data\.object\.lines$/ }) });
    await expect(lc.locator('.dbi-cut-t')).toBeVisible({ timeout: 10000 });
    await lc.getByRole('button', { name: 'Load full value' }).click();
    await expect(lc.locator('.rd-json')).toBeVisible({ timeout: 15000 });
  } finally {
    await stopDb(l);
  }
});

/** The page statements (a table's rows: LIMIT … OFFSET) among those the server saw. */
const pageReads = (log: string[]) => log.filter((s) => /LIMIT \$\d+ OFFSET \$\d+/.test(s));

/**
 * The server's log once what was asked has ended: some transactions, each rolled back, and no new statement for 400 ms
 * (a read that started later would show up meanwhile).
 */
async function settledLog(srv: PgServer): Promise<string[]> {
  const count = (log: string[], re: RegExp) => log.filter((x) => re.test(x)).length;
  let last: string[] = [];
  await expect.poll(async () => {
    const log = await srv.statementsLog();
    const begins = count(log, /^\s*BEGIN/i);
    const settled = begins > 0 && begins === count(log, /^\s*ROLLBACK\s*$/i) && log.length === last.length;
    last = log;
    return settled;
  }, { timeout: 15000, intervals: [400] }).toBe(true);
  return last;
}

test('Structure (never used), Relations, DDL; ⌘R on Structure reads Structure only; a related table: a click previews it, a double click keeps it', async () => {
  test.setTimeout(120_000);
  const l = await launchDb(server);
  const { win, home } = l;
  try {
    await addConnection(l);
    const t = await openTable(win, 'orders');
    await t.getByRole('radio', { name: 'Structure' }).click();
    // A view switch is an investment: the tab is kept.
    await expect(tabOf(win, 'orders')).not.toHaveClass(/is-preview/);
    const s = t.locator('.dbs');
    await expect(s.locator('.dbs-cols')).toContainText('customer_id', { timeout: 10000 });
    // The partial index nobody scanned: "never used", in amber.
    const pending = s.locator('.dbs-idx tr', { hasText: 'orders_pending_idx' });
    await expect(pending.locator('.dbs-scans.is-never')).toHaveText('never used');
    // The Relations card: what orders points at, and what points at it.
    await expect(s.locator('.dbs-rel')).toContainText('customers');
    await expect(s.locator('.dbs-rel')).toContainText('order_items');
    // The DDL, rebuilt from the catalog, with Copy.
    const ddl = s.locator('.dbs-ddl');
    await expect(ddl).toContainText('CREATE TABLE', { timeout: 10000 });
    await expect(ddl).toContainText('orders_created_at_idx');
    const n = copies(home).length;
    await ddl.getByRole('button', { name: 'Copy' }).click();
    expect(await lastCopy(home, n)).toMatch(/CREATE TABLE "?public"?\."?orders"?/);
    await shot(win, 'db-structure');

    // ⌘R on Structure: Structure read again, the rows not.
    await server.clearLog();
    await s.locator('.dbs-cols').click({ position: { x: 4, y: 4 } });
    await win.keyboard.press('Meta+r');
    // Everything ⌘R started has ended (each transaction rolled back, the log still for a moment): then nothing of it
    // read rows.
    const log = await settledLog(server);
    expect(log.filter((x) => /pg_catalog|pg_class|pg_index/.test(x)).length, 'Structure read again').toBeGreaterThan(0);
    await expect(s.locator('.dbs-cols')).toContainText('customer_id');
    expect(pageReads(log), 'no rows read by Structure’s Refresh').toEqual([]);

    // Open diagram ›: Relations, the table in the middle, its neighbours on both sides.
    await s.getByRole('button', { name: 'Open diagram ›' }).click();
    await expect(t.getByRole('radio', { name: 'Relations' })).toHaveAttribute('aria-checked', 'true');
    const diagram = t.locator('.dbr-view');
    await expect(diagram.locator('.dbr-node.is-center')).toContainText('orders');
    await expect(diagram.locator('.dbr-node.is-left', { hasText: 'customers' })).toBeVisible();
    await expect(diagram.locator('.dbr-node.is-right', { hasText: 'payments' })).toBeVisible();
    await shot(win, 'db-relations');
    // A node's single click: its table as the preview, beside orders (kept: the tab hosting the diagram).
    await diagram.locator('.dbr-node.is-left', { hasText: 'customers' }).click();
    await expect(tabOf(win, 'customers')).toHaveClass(/is-preview/);
    await expect(tabOf(win, 'orders')).toBeVisible();
    await expect(tabOf(win, 'orders')).not.toHaveClass(/is-preview/);
    // Back on orders' diagram: another node replaces that preview; a double click keeps it.
    await tabOf(win, 'orders').click();
    await diagram.locator('.dbr-node.is-right', { hasText: 'payments' }).click();
    await expect(tabOf(win, 'payments')).toHaveClass(/is-preview/);
    await expect(tabOf(win, 'customers')).toHaveCount(0);
    await tabOf(win, 'orders').click();
    await diagram.locator('.dbr-node.is-right', { hasText: 'shipments' }).dblclick();
    await expect(tabOf(win, 'shipments')).toHaveClass(/is-active/);
    await expect(tabOf(win, 'shipments')).not.toHaveClass(/is-preview/);
    // The second press was the double click's: it selected nothing in the table it opened.
    await expect(gridRows(front(win)).first()).toBeVisible();
    await expect(front(win).locator('.dbt-grid tbody tr.is-sel')).toHaveCount(0);
    await expect(front(win).locator('.dbi')).toHaveCount(0);
  } finally {
    await stopDb(l);
  }
});

test('Overview: the tiles; read on show, then every 5 s only while the window is in front (blurred: paused)', async () => {
  test.setTimeout(120_000);
  // Each of the view's reads reaches the server (main shares reads 2 s apart: the page's clock runs faster here).
  const l = await launchDb(server, { env: { ATELIER_TEST_DB_OVERVIEW_MS: '1' } });
  const { win } = l;
  try {
    await addConnection(l);
    // The page's clock is the test's: five seconds pass when the test says so.
    await win.clock.install();
    // In front or not, as the test says. The test window is never shown nor focused (ATELIER_TEST_BACKGROUND), yet its
    // page can report itself focused and visible (Chromium; after a Playwright evaluate, or under load), and a focus
    // event the view hears then makes it poll: what the view reads of the window — its focus, its page shown — and the
    // window's own focus and blur events stand in for the Mac's, from the start.
    const front = (on: boolean) => win.evaluate((v) => {
      document.hasFocus = () => v;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') });
      window.dispatchEvent(new Event(v ? 'focus' : 'blur'));
    }, on);
    await front(false);
    const reads = async () => (await server.statementsLog()).filter((s) => s.includes('pg_database_size')).length;
    await server.clearLog();
    const row = win.locator('.db-conn').first();
    await row.click({ button: 'right' });
    await win.locator('.ctx-menu').getByRole('menuitem', { name: 'Overview' }).click();
    const o = win.locator('.dbo:visible');
    await expect(o.locator('.dbo-tile')).toHaveCount(5);
    await expect(o.locator('.dbo-tile', { hasText: 'Size' }).locator('.dbo-v')).toHaveText(/\d/, { timeout: 10000 });
    await expect(o.locator('.dbo-tile', { hasText: 'Connections' }).locator('.dbo-of')).toHaveText(/^\/ \d+/);
    await expect(o.locator('.dbo-tile', { hasText: 'Cache hit' }).locator('.dbo-v')).not.toHaveText('—');
    await expect(o.locator('.dbo-biggest')).toContainText('orders');
    await shot(win, 'db-overview');
    // Read once on show (the window isn't in front).
    await expect.poll(reads).toBe(1);
    await win.clock.runFor(12_000);
    expect(await reads(), 'no polling in a window that isn’t in front').toBe(1);
    // In front: read at once (the last answer is older than 5 s), then every 5 s.
    await front(true);
    await expect.poll(reads).toBe(2);
    await win.clock.runFor(5_100);
    await expect.poll(reads).toBe(3);
    // Blurred: paused.
    await front(false);
    await win.clock.runFor(15_000);
    // A negative check: sampled a moment (a read the timers fired would reach the server meanwhile).
    for (const end = Date.now() + 600; Date.now() < end;) expect(await reads(), 'paused while the window isn’t in front').toBe(3);
    // In front again: resumed.
    await front(true);
    await expect.poll(reads).toBe(4);
  } finally {
    await stopDb(l);
  }
});

test('Mask values hides password_hash and the token; a boolean filter by the keyboard', async () => {
  test.setTimeout(120_000);
  const l = await launchDb(server);
  const { win } = l;
  try {
    await addConnection(l);
    const t = await openTable(win, 'type_zoo');
    const hash = await cell(t, 0, 'password_hash');
    await expect(hash).toContainText('$argon2id$');
    // Every type's first width holds its values.
    expect(await cutCells(t)).toEqual([]);
    await shot(win, 'db-type-zoo');
    await t.getByRole('button', { name: 'Mask Values' }).click();
    await expect(t.getByRole('button', { name: 'Mask Values' })).toHaveAttribute('aria-pressed', 'true');
    await expect((await cell(t, 0, 'password_hash')).locator('.dbt-mask')).toHaveText('••••••••');
    await expect((await cell(t, 0, 'api_token')).locator('.dbt-mask')).toBeVisible();
    await expect(t.locator('.dbt-grid')).not.toContainText('argon2id');
    // Values that aren't secrets still read.
    await expect((await cell(t, 0, 'c_int4')).locator('.dbt-num')).toHaveText('48,210');
    await shot(win, 'db-masked');
    await t.getByRole('button', { name: 'Mask Values' }).click();
    await expect(await cell(t, 0, 'password_hash')).toContainText('$argon2id$');

    // c_bool is false, chosen with the arrow keys.
    await addFilterBtn(t).click();
    const pop = win.locator('.dbt-fpop');
    await pop.getByRole('combobox', { name: 'Find a column' }).fill('c_bool');
    await pop.getByRole('combobox', { name: 'Find a column' }).press('Enter');
    const yes = pop.getByRole('radio', { name: 'true' });
    await expect(yes).toHaveAttribute('aria-checked', 'true');
    await yes.focus();
    await win.keyboard.press('ArrowRight');
    await expect(pop.getByRole('radio', { name: 'false' })).toHaveAttribute('aria-checked', 'true');
    await expect(pop.getByRole('radio', { name: 'false' })).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(pop).toHaveCount(0);
    await expect.poll(() => chipTips(t)).toEqual(['c_bool is false']);
    await expect(t.locator('.dbt-foot-label')).toHaveText('1 row');
  } finally {
    await stopDb(l);
  }
});

test('Send to a Claude session: the selected rows pasted into its prompt (bracketed, no Enter), named public.orders', async () => {
  test.setTimeout(120_000);
  const l = await launchDb(server);
  const { win } = l;
  try {
    // A Claude session waiting at its prompt.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('db-debug');
    await win.keyboard.press('Enter');
    await expect(win.locator('.session-row', { hasText: 'db-debug' })).toHaveClass(/state-done/, { timeout: 20000 });
    await expect(win.locator('.xterm-rows:visible')).toContainText('>', { timeout: 10000 });
    const fg = () => win.evaluate(async () => (await (window as unknown as { atelier: { terminals: { list(): Promise<{ title: string; foreground?: string }[]> } } }).atelier.terminals.list()).find((x) => x.title === 'db-debug')?.foreground ?? '');
    await expect.poll(async () => { const f = await fg(); return f !== '' && !/^-?(zsh|bash|sh|fish)$/.test(f); }, { timeout: 10000 }).toBe(true);

    await addConnection(l);
    const t = await openTable(win, 'orders');
    await (await cell(t, 0, 'status')).click();
    await (await cell(t, 1, 'status')).click({ modifiers: ['Shift'] });
    const send = t.locator('.db-selbar .sel-send');
    await expect(send).toContainText('Send to db-debug');
    await expect(t.locator('.db-selbar-n')).toHaveText('2 rows');
    await shot(win, 'db-selbar');
    await send.click();
    const term = win.locator('.xterm-rows:visible');
    await expect(term).toContainText('public.orders', { timeout: 15000 });
    await expect(term).toContainText('2 rows');
    // Typed, not sent: no Enter reached the prompt.
    await expect(term).not.toContainText('FAKE-CLAUDE submitted');
  } finally {
    await stopDb(l);
  }
});

test('slow_view with the query timeout at 5 s: "Stopped after 5 s" and the hint', async () => {
  test.setTimeout(120_000);
  // Its own server: slow_view sleeps 8 s on PGlite's one backend.
  const slow = await PgServer.start();
  const l = await launchDb(slow);
  const { win } = l;
  try {
    await setSettings(win, { dbTimeoutSec: 5 });
    await addConnection(l);
    await win.locator('.db-fold', { hasText: /^Views/ }).click();
    await relRow(win, 'slow_view').click();
    const t = front(win);
    await expect(t.locator('.dbt-crumb-name')).toHaveText('slow_view');
    const problem = t.locator('.dbt-problem');
    await expect(problem.locator('.dk-state-title')).toHaveText('Stopped after 5 s', { timeout: 20000 });
    await expect(problem).toContainText('Add a filter or sort by an indexed column.');
    await expect(problem.getByRole('button', { name: 'Try Again' })).toBeVisible();
    await shot(win, 'db-timeout');
  } finally {
    await stopDb(l);
    await slow.stop();
  }
});

test('⌃⇧B (View › Databases), the palette (commands, a table in another schema, ⌘Enter keeps), the footer item, Settings › Keyboard', async () => {
  test.setTimeout(120_000);
  const l = await launchDb(server);
  const { app, win } = l;
  try {
    // Not connected yet: no footer item.
    await expect(win.locator('.activity-bar .act').first()).toBeVisible({ timeout: 20000 });
    await expect(win.locator('.db-foot-item')).toHaveCount(0);
    // View › Databases, ⌃⇧B (the menu's own accelerator: a hidden test window gets no native key, the item is clicked).
    expect(await openDbView({ app, win })).toBe('Ctrl+Shift+B');
    await addConnection(l);
    // Connected: pg · postgres, its environment's tone; a click opens the view.
    const foot = win.locator('.db-foot-item');
    await expect(foot).toHaveText(/pg · postgres/);
    await expect(foot).toHaveClass(/is-ok/);
    await win.locator('.activity-bar .act').first().click();
    await foot.click();
    await expect(win.locator('.db-side')).toBeVisible();

    // The palette's commands.
    await win.keyboard.press('F1');
    const input = win.locator('.palette-input');
    await input.fill('> databases');
    const items = win.locator('.palette-item');
    await expect(items.filter({ hasText: /^Databases$/ }).or(items.filter({ hasText: /Databases\s*⌃⇧B/ })).first()).toBeVisible();
    await expect(items.filter({ hasText: 'Databases: Add Connection…' })).toBeVisible();
    await expect(items.filter({ hasText: 'Databases: Overview' })).toBeVisible();
    await shot(win, 'db-palette-commands');
    // A table in another schema (analytics): Enter opens it there, as the preview.
    await input.fill('page_views');
    const pv = items.filter({ hasText: 'page_views' }).first();
    await expect(pv).toBeVisible();
    await shot(win, 'db-palette-tables');
    await win.keyboard.press('Enter');
    await expect(tabOf(win, 'page_views')).toHaveClass(/is-preview/);
    await expect(front(win).locator('.dbt-crumb-schema')).toHaveText('analytics');
    await expect(gridRows(front(win)).first()).toBeVisible({ timeout: 10000 });
    // ⌘Enter: kept.
    await win.keyboard.press('F1');
    await input.fill('customers');
    await expect(items.filter({ hasText: 'customers' }).first()).toBeVisible();
    await win.keyboard.press('Meta+Enter');
    await expect(tabOf(win, 'customers')).toHaveClass(/is-active/);
    await expect(tabOf(win, 'customers')).not.toHaveClass(/is-preview/);

    // Settings › Keyboard (lazy since T30): the Databases group, every row.
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Keyboard' }).click();
    const group = dialog.locator('.kb-group', { has: win.locator('.set-group-title', { hasText: /^Databases$/ }) });
    await expect(group.locator('.kb-row')).toHaveCount(12);
    await expect(dialog.locator('.kb-row', { hasText: 'Databases (read-only PostgreSQL' })).toBeVisible();
    await win.keyboard.press('Escape');
  } finally {
    await stopDb(l);
  }
});

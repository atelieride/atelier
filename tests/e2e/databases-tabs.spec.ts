import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { PgServer } from '../support/pg-server';
import {
  SHOTS, addConnection, addFilter, cell, copies, dbIcon, dbTabs, gridRows, lastCopy, launchDb, openTable, relRow, setSettings, shot, stopDb, tabOf
} from './databases-fixture';

// Table tabs end to end: the preview rule (italic, replaced, kept), next to a file's
// preview; split view and its narrow panes (the toolbar folding, the inspector over the rows, the popovers on top),
// pop-out and back, a restart, a connection the user disconnected, Settings › Never.

let server: PgServer;
test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  server = await PgServer.start();
});
test.afterAll(async () => { await server?.stop(); });

const ctx = (win: Page) => win.locator('.ctx-menu').first();
/** The table tab showing `name` (one per pane may be visible). */
const shown = (win: Page, name: string): Locator => win.locator('.dbt:visible', { has: win.locator('.dbt-crumb-name', { hasText: new RegExp(`^${name}$`) }) });

test('the preview: a click opens it italic, the next replaces it; a double click, a filter, the tab’s double click keep; Preview tabs off; a file’s preview beside a table’s; Settings › Never', async () => {
  test.setTimeout(150_000);
  const l = await launchDb(server);
  const { win } = l;
  try {
    await addConnection(l);
    // A single click: the preview, italic.
    await openTable(win, 'orders');
    await expect(tabOf(win, 'orders')).toHaveClass(/is-preview/);
    await expect(tabOf(win, 'orders').locator('.tab-name')).toHaveCSS('font-style', 'italic');
    await shot(win, 'db-tab-preview');
    // Another table replaces it, in its place.
    await openTable(win, 'customers');
    await expect(dbTabs(win)).toHaveCount(1);
    await expect(tabOf(win, 'customers')).toHaveClass(/is-preview/);
    // A double click on its row keeps it; the next click opens a new preview beside it.
    await relRow(win, 'customers').dblclick();
    await expect(tabOf(win, 'customers')).not.toHaveClass(/is-preview/);
    await expect(tabOf(win, 'customers').locator('.tab-name')).toHaveCSS('font-style', 'normal');
    await openTable(win, 'payments');
    await expect(dbTabs(win)).toHaveCount(2);
    await expect(tabOf(win, 'payments')).toHaveClass(/is-preview/);
    // A filter keeps it.
    const p = shown(win, 'payments');
    await addFilter(p, 'method', 'eq', ['card']);
    await expect(tabOf(win, 'payments')).not.toHaveClass(/is-preview/);
    // The tab's own double click keeps it.
    await openTable(win, 'refunds');
    await expect(tabOf(win, 'refunds')).toHaveClass(/is-preview/);
    await tabOf(win, 'refunds').dblclick();
    await expect(tabOf(win, 'refunds')).not.toHaveClass(/is-preview/);
    await expect(dbTabs(win)).toHaveCount(3);

    // Preview tabs off (Settings › Editor): every table opens kept.
    await setSettings(win, { previewTabs: false });
    await openTable(win, 'coupons');
    await expect(tabOf(win, 'coupons')).not.toHaveClass(/is-preview/);
    await openTable(win, 'shipments');
    await expect(dbTabs(win)).toHaveCount(5);
    await setSettings(win, { previewTabs: true });

    // A file's preview (Sessions) and a table's (Databases) at once: each its own slot, each in its own space.
    await win.getByRole('button', { name: /^Files/ }).click();
    await win.locator('.tree-row', { hasText: 'src' }).first().click();
    await win.locator('.tree-row', { hasText: 'schema.sql' }).click();
    await expect(win.locator('.tab.is-preview', { hasText: 'schema.sql' })).toBeVisible();
    await dbIcon(win).click();
    await openTable(win, 'employees');
    await expect(tabOf(win, 'employees')).toHaveClass(/is-preview/);
    await expect(win.locator('.tab.is-preview')).toHaveCount(1);
    await shot(win, 'db-tab-two-previews');
    await win.getByRole('button', { name: /^Files/ }).click();
    await expect(win.locator('.tab.is-preview', { hasText: 'schema.sql' })).toBeVisible();
    await dbIcon(win).click();
    await expect(tabOf(win, 'employees')).toHaveClass(/is-preview/);

    // The Disconnected card: the user disconnects; what a tab hasn't read yet waits for their Connect — Structure
    // (never shown in this tab) and a table opened since. Rows already read stay on screen.
    const row = win.locator('.db-conn').first();
    // item_notes opened straight on Structure (the sidebar's menu): its rows not read yet.
    await relRow(win, 'item_notes').click({ button: 'right' });
    await ctx(win).getByRole('menuitem', { name: 'Structure' }).click();
    await expect(shown(win, 'item_notes').locator('.dbs-cols')).toContainText('author_email', { timeout: 15000 });
    const disconnect = async () => {
      await row.click({ button: 'right' });
      await ctx(win).getByRole('menuitem', { name: 'Disconnect' }).click();
      await expect(row).toHaveClass(/is-idle/);
    };
    await disconnect();
    await tabOf(win, 'shipments').click();
    const sh = shown(win, 'shipments');
    await expect(gridRows(sh).first()).toBeVisible();
    await sh.getByRole('radio', { name: 'Structure' }).click();
    const card = sh.locator('.dk-state', { hasText: 'Disconnected' });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('You disconnected postgres in this session.');
    await shot(win, 'db-tab-disconnected');
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(sh.locator('.dbs-cols')).toContainText('carrier', { timeout: 15000 });
    await expect(row).toHaveClass(/is-connected/);
    await disconnect();
    await tabOf(win, 'item_notes').click();
    const notes = shown(win, 'item_notes');
    await notes.getByRole('radio', { name: 'Data' }).click();
    await expect(notes.locator('.dk-state', { hasText: 'Disconnected' })).toBeVisible({ timeout: 10000 });
    await notes.getByRole('button', { name: 'Connect' }).click();
    await expect(gridRows(notes).first()).toBeVisible({ timeout: 15000 });
    await expect(row).toHaveClass(/is-connected/);

    // Settings › Databases › Never: the icon and every table tab go.
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Databases' }).click();
    await dialog.getByRole('radio', { name: 'Never' }).click();
    await win.keyboard.press('Escape');
    await expect(dbIcon(win)).toHaveCount(0);
    await expect(dbTabs(win)).toHaveCount(0);
    await expect(win.locator('.tab.is-preview', { hasText: 'schema.sql' })).toBeVisible();
  } finally {
    await stopDb(l);
  }
});

test('split view: a ~430 px pane lays the inspector over the rows only, the popovers above it; Shift+F10 on the bar; Esc in the SQL popover; the toolbar folds at ~260 and ~200 px', async () => {
  test.setTimeout(150_000);
  const l = await launchDb(server, { width: 1170, height: 800 });
  const { app, win, home } = l;
  try {
    await expect(win.locator('.activity-bar .act').first()).toBeVisible({ timeout: 20000 });
    await addConnection(l);
    // Tables live in Databases: another table in the left pane.
    await openTable(win, 'customers', 'dblclick');
    await openTable(win, 'orders', 'dblclick');
    // ⌥-click: Move to Right Pane.
    await tabOf(win, 'orders').click({ modifiers: ['Alt'] });
    await expect(win.locator('.pane-divider')).toHaveCount(1);
    const t = shown(win, 'orders');
    await expect(gridRows(t).first()).toBeVisible();
    // The window sized so each pane is about 430 px (the two panes share what the side panels leave).
    const w0 = (await t.boundingBox())!.width;
    await win.setViewportSize({ width: Math.round(win.viewportSize()!.width + 2 * (430 - w0)), height: 800 });
    await expect.poll(async () => Math.abs((await t.boundingBox())!.width - 430)).toBeLessThan(6);

    // Under 640 px the footer drops its scroll hint, and "100 loaded of ~120" reads whole (the hint's own display rule
    // came after the container query and undid it: the label was cut to "100 loaded of ~…").
    await expect(t.locator('.dbt-foot-hint')).toBeHidden();
    await expect(t.locator('.dbt-foot-label')).toHaveText('100 loaded of ~120');
    // At ~430 px the Grid / Record toggle has folded into ⋯ (Record View there); Mask, Refresh, SQL stay.
    await expect(t.locator('.dbt-rv')).toBeHidden();
    await expect(t.locator('.dbt-fold')).toBeVisible();
    await expect(t.locator('.dbt-sql')).toBeVisible();
    // The path gave way from its start: "public / orders", the table's name whole.
    await expect(t.locator('.dbt-crumb-conn')).toBeHidden();
    await expect(t.locator('.dbt-crumb-schema')).toBeVisible();
    expect(await t.locator('.dbt-crumb-name').evaluate((el) => el.scrollWidth <= el.clientWidth), 'the table’s name whole at ~430 px').toBe(true);
    expect(await t.locator('.dbt-foot-label').evaluate((el) => el.scrollWidth <= el.clientWidth), 'the footer label whole').toBe(true);
    // The inspector over the rows only: the toolbar, the filter bar and the footer stay clear.
    await (await cell(t, 1, 'status')).click();
    await win.keyboard.press('Enter');
    const insp = t.locator('.dbi');
    await expect(insp).toHaveClass(/is-over/);
    const ib = (await insp.boundingBox())!;
    const rows = (await t.locator('.dbt-rows').boundingBox())!;
    expect(ib.y, 'below the toolbar and the filter bar').toBeGreaterThanOrEqual(rows.y - 0.5);
    expect(ib.y + ib.height, 'above the footer').toBeLessThanOrEqual(rows.y + rows.height + 0.5);
    // The SQL popover lies above the inspector, and works there.
    const sqlBtn = t.locator('.dbt-sql');
    await sqlBtn.click();
    const pop = t.locator('.dbt-pop');
    await expect(pop).toBeVisible();
    const top = await pop.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height - 12);
      return !!hit && el.contains(hit);
    });
    expect(top, 'the popover is on top of the inspector').toBe(true);
    await shot(win, 'db-split-inspector-sql');
    const n = copies(home).length;
    await pop.getByRole('button', { name: 'Copy' }).click();
    expect(await lastCopy(home, n)).toMatch(/^SELECT .* FROM "public"\."orders"/s);
    // Esc in the popover: closed, the keyboard back on SQL.
    await pop.getByRole('button', { name: 'Copy' }).focus();
    await win.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(sqlBtn).toBeFocused();
    // The filter popover lies above the inspector too.
    await t.locator('button.dbt-fadd').click();
    const fpop = win.locator('.dbt-fpop');
    await expect(fpop).toBeVisible();
    const ftop = await fpop.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height - 12);
      return !!hit && el.contains(hit);
    });
    expect(ftop, 'the filter popover is on top of the inspector').toBe(true);
    await win.keyboard.press('Escape');
    await expect(fpop).toHaveCount(0);

    // Shift+F10 on the bar: its menu (Mask, Refresh, SQL).
    await t.getByRole('radio', { name: 'Data' }).focus();
    await win.keyboard.press('Shift+F10');
    await expect(ctx(win).getByRole('menuitem', { name: 'Show SQL' })).toBeVisible();
    await expect(ctx(win).getByRole('menuitemcheckbox', { name: 'Mask Values' }).or(ctx(win).getByRole('menuitem', { name: 'Mask Values' }))).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.locator('.ctx-menu')).toHaveCount(0);

    /** The orders pane at `w` px: the window sized so (the two panes share what the side panels leave). */
    const paneTo = async (w: number) => {
      const w0 = (await t.boundingBox())!.width;
      await win.setViewportSize({ width: Math.round(win.viewportSize()!.width + 2 * (w - w0)), height: 800 });
      await expect.poll(async () => Math.abs((await t.boundingBox())!.width - w)).toBeLessThan(6);
    };
    // ~260 px: Mask, Refresh and SQL fold into ⋯, the view switch stays; ⋯ has every one of them.
    await paneTo(260);
    const fold = t.locator('.dbt-fold');
    await expect(fold).toBeVisible();
    await expect(t.locator('.dbt-views')).toBeVisible();
    await expect(sqlBtn).toBeHidden();
    await expect(t.getByRole('button', { name: 'Mask Values' })).toBeHidden();
    await expect(t.locator('.dbt-bar').getByRole('button', { name: 'Refresh' })).toBeHidden();
    await fold.click();
    await expect(ctx(win).getByRole('menuitemcheckbox', { name: 'Mask Values' }).or(ctx(win).getByRole('menuitem', { name: 'Mask Values' }))).toBeVisible();
    for (const name of ['Refresh', 'Show SQL', 'Copy SQL']) await expect(ctx(win).getByRole('menuitem', { name })).toBeVisible();
    await shot(win, 'db-narrow-fold-260');
    // Record View from ⋯: the record view on the focused row; ⋯ again, unchecked: the grid.
    await ctx(win).getByRole('menuitemcheckbox', { name: 'Record View' }).click();
    await expect(t.locator('.dbrv-pos')).toHaveText('Row 2 of 100 loaded');
    await shot(win, 'db-narrow-record-260');
    await fold.click();
    await expect(ctx(win).getByRole('menuitemcheckbox', { name: 'Record View' })).toHaveAttribute('aria-checked', 'true');
    await expect(ctx(win).getByRole('menuitemcheckbox', { name: 'Row Inspector' })).toBeDisabled();
    await ctx(win).getByRole('menuitemcheckbox', { name: 'Record View' }).click();
    await expect(t.locator('.dbrv')).toHaveCount(0);
    await expect(t.locator('.dbt-grid tbody tr[data-row="1"]')).toHaveClass(/is-sel/);
    // ~200 px: the view switch folds too; ⋯ has the views, Structure works from there.
    await paneTo(200);
    await expect(t.locator('.dbt-views')).toBeHidden();
    await expect(fold).toBeVisible();
    await fold.click();
    await ctx(win).getByRole('menuitemradio', { name: 'Structure' }).or(ctx(win).getByRole('menuitem', { name: 'Structure' })).click();
    await expect(t.locator('.dbs')).toBeVisible({ timeout: 10000 });
    await shot(win, 'db-narrow-fold-200');
  } finally {
    await stopDb(l);
  }
});

test('pop-out and back: the table in a window of its own; Open › there opens in the project window as a preview, the pop-out keeps its view; a restart restores the kept tab', async () => {
  test.setTimeout(150_000);
  const l = await launchDb(server);
  const { app, win } = l;
  let again = l;
  try {
    await addConnection(l);
    await openTable(win, 'orders', 'dblclick');
    await tabOf(win, 'orders').click({ button: 'right' });
    const [pop] = await Promise.all([app.waitForEvent('window'), ctx(win).getByRole('menuitem', { name: 'Move to New Window' }).click()]);
    await expect(pop.locator('.popout-bar')).toBeVisible({ timeout: 15000 });
    await expect(tabOf(win, 'orders')).toHaveCount(0);
    const pt = pop.locator('.dbt');
    await expect(gridRows(pt).first()).toBeVisible({ timeout: 15000 });
    await shot(pop, 'db-popout');
    // Its inspector's Open ›: customers opens in the project window, as the preview; the pop-out stays on orders' Data.
    await (await cell(pt, 0, 'status')).click();
    await pop.keyboard.press('Enter');
    const peek = pt.locator('.dbi-f', { has: pop.locator('.dbi-fn-t', { hasText: /^customer_id$/ }) }).locator('.dbi-peek');
    await expect(peek.locator('.dbi-peek-open')).toBeVisible({ timeout: 10000 });
    await peek.locator('.dbi-peek-open').click();
    await expect(tabOf(win, 'customers')).toHaveClass(/is-preview/, { timeout: 10000 });
    await expect(pt.locator('.dbt-crumb-name')).toHaveText('orders');
    await expect(pt.getByRole('radio', { name: 'Data' })).toHaveAttribute('aria-checked', 'true');
    await expect(pt.locator('.dbi')).toBeVisible();
    // Move Back: the table in the project window again.
    await pop.locator('.popout-bar').getByRole('button', { name: 'Move Back' }).click();
    await expect(tabOf(win, 'orders')).toBeVisible({ timeout: 15000 });
    await expect(tabOf(win, 'orders')).not.toHaveClass(/is-preview/);

    // The inspector's width is the app's — set in one tab, another tab draws it, and so does the next start.
    const inspect = async (w: Page, name: string) => {
      await tabOf(w, name).click();
      const t = w.locator('.dbt:visible').first();
      await expect(gridRows(t).first()).toBeVisible({ timeout: 20000 });
      if ((await t.locator('.dbi').count()) === 0) {
        await (await cell(t, 0, 'id')).click();
        await w.keyboard.press('Enter');
      }
      return t.locator('.dbi-rs');
    };
    const edge = await inspect(win, 'orders');
    await edge.focus();
    // Home: 280 px, a width every pane here draws whole (a wider one is drawn as far as the pane allows).
    await win.keyboard.press('Home');
    await expect(edge).toHaveAttribute('aria-valuenow', '280');
    await expect(await inspect(win, 'customers')).toHaveAttribute('aria-valuenow', '280');

    // A restart: the kept tab comes back (the preview doesn't), and reads when shown.
    await stopDb(l, false);
    again = await launchDb(server, { again: { home: l.home, root: l.root, env: l.env } });
    const w2 = again.win;
    // The window opens on Sessions; the table is back in Databases.
    await expect(dbIcon(w2)).toBeVisible({ timeout: 20000 });
    await dbIcon(w2).click();
    await expect(tabOf(w2, 'orders')).toBeVisible({ timeout: 20000 });
    await tabOf(w2, 'orders').click();
    // It reads when shown (in Databases, whose sidebar shows its connection now: no table without its space).
    await expect(gridRows(w2.locator('.dbt:visible').first()).first()).toBeVisible({ timeout: 20000 });
    await shot(w2, 'db-restored');
    await expect(await inspect(w2, 'orders')).toHaveAttribute('aria-valuenow', '280');
  } finally {
    await stopDb(again);
  }
});

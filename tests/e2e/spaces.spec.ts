import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PgServer } from '../support/pg-server';
import { addConnection, dbIcon, dbTabs, frames, launchDb, openTable, stopDb, tabOf } from './databases-fixture';
import { look } from './shots';

// Spaces: Sessions, Docker, Redis, Databases and Automations each keep their own tabs; the
// activity bar switches them; nothing is lost on the way, nothing of one space shows in another.

const SHOTS = resolve('e2e-shots/view-spaces');
let server: PgServer;
test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  server = await PgServer.start();
});
test.afterAll(async () => { await server?.stop(); });

const icon = (win: Page, name: string) => win.locator(`.activity-bar .act[aria-label^="${name}"]`);
/** The keys of the tabs the strip shows (one pane: all of them), left to right. */
const strip = (win: Page) => win.locator('.tabs .tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-key') ?? ''));
const active = (win: Page) => win.locator('.tabs .tab.is-active').getAttribute('data-key');
async function shot(win: Page, name: string) {
  await win.mouse.move(1430, 890);
  await look(win, join(SHOTS, `${name}.png`), { settle: 350 });
}
async function newTerminal(win: Page) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: /^Terminal(?! with)/ }).first().click();
}

test('tables live in Databases, terminals in Sessions: switching keeps each strip and its tab in front; a split, Changes, a relaunch', async () => {
  test.setTimeout(120_000);
  const l = await launchDb(server);
  const { win } = l;
  try {
    // Sessions: a terminal.
    await expect(icon(win, 'Sessions')).toBeVisible({ timeout: 20000 });
    await newTerminal(win);
    await expect.poll(() => strip(win)).toEqual([expect.stringMatching(/^t:/)]);
    const terminal = (await strip(win))[0]!;

    // Databases: a connection, two tables kept, one in front. No terminal among them.
    await addConnection(l);
    await openTable(win, 'orders', 'dblclick');
    await openTable(win, 'customers', 'dblclick');
    await tabOf(win, 'orders').click();
    await expect.poll(() => strip(win)).toEqual([expect.stringMatching(/^db:.*orders$/), expect.stringMatching(/^db:.*customers$/)]);
    await expect(win.locator('.changes')).toHaveCount(0);
    await expect(win.locator('.changes-toggle')).toHaveCount(0);
    await shot(win, 'databases');

    // Sessions: the terminal alone, in front; Changes back.
    await icon(win, 'Sessions').click();
    await expect.poll(() => strip(win)).toEqual([terminal]);
    expect(await active(win)).toBe(terminal);
    await expect(dbTabs(win)).toHaveCount(0);
    await expect(win.locator('.changes-toggle')).toBeVisible();
    await shot(win, 'sessions');

    // Back to Databases: the same two tables, orders in front.
    await dbIcon(win).click();
    await expect(dbTabs(win)).toHaveCount(2);
    expect(await active(win)).toMatch(/orders$/);

    // A split there (⌥-click a tab): Databases' own; Sessions stays one pane.
    await tabOf(win, 'customers').click({ modifiers: ['Alt'] });
    await expect(win.locator('.pane-divider')).toHaveCount(1);
    await shot(win, 'databases-split');
    await icon(win, 'Sessions').click();
    await expect(win.locator('.pane-divider')).toHaveCount(0);
    await expect.poll(() => strip(win)).toEqual([terminal]);
    await dbIcon(win).click();
    await expect(win.locator('.pane-divider')).toHaveCount(1);

    // Closing every table: Databases' empty state, never the terminal.
    await win.locator('.pane-close').first().click();
    await expect(win.locator('.pane-divider')).toHaveCount(0);
    for (const name of ['orders', 'customers']) await tabOf(win, name).locator('.tab-close').click();
    await expect(dbTabs(win)).toHaveCount(0);
    await expect(win.locator('.space-empty[data-space="databases"]')).toBeVisible();
    await expect(win.locator('.space-empty')).toContainText('No table open');
    await expect(win.locator('.xterm:visible')).toHaveCount(0);
    await shot(win, 'databases-empty');

    // A relaunch: the tables come back in Databases, the window opens on Sessions.
    await openTable(win, 'orders', 'dblclick');
    await frames(win);
    await win.waitForTimeout(700);
    await stopDb(l, false);
    const again = await launchDb(server, { again: l });
    try {
      await expect(icon(again.win, 'Sessions')).toHaveClass(/is-active/, { timeout: 20000 });
      await expect.poll(() => strip(again.win), { timeout: 20000 }).toEqual([terminal]);
      await dbIcon(again.win).click();
      await expect(dbTabs(again.win)).toHaveCount(1);
      await expect(tabOf(again.win, 'orders')).toHaveClass(/is-active/);
    } finally {
      await stopDb(again);
    }
  } catch (e) {
    await stopDb(l).catch(() => {});
    throw e;
  }
});

test('the activity bar sets the spaces apart; a narrow window keeps every strip and the empty state whole', async () => {
  const l = await launchDb(server, { width: 900, height: 700 });
  const { win } = l;
  try {
    await expect(icon(win, 'Sessions')).toBeVisible({ timeout: 20000 });
    await addConnection(l);
    // The hairline sits right before the first space's icon.
    const gap = win.locator('.activity-bar .act-gap');
    await expect(gap).toHaveCount(1);
    await expect(gap.locator('xpath=following-sibling::button[1]')).toHaveAttribute('aria-label', /^(Docker|Redis|Databases|Automations)/);
    // The Databases empty state at 900 px: nothing clipped, nothing wrapped.
    await expect(win.locator('.space-empty')).toBeVisible();
    const card = (await win.locator('.space-empty .ws-empty-card').boundingBox())!;
    const body = (await win.locator('.workspace-body').boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(body.x);
    expect(card.x + card.width).toBeLessThanOrEqual(body.x + body.width + 0.5);
    const title = win.locator('.space-empty h2');
    expect(await title.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    // Tables in a narrow strip: each tab inside the strip.
    await openTable(win, 'orders', 'dblclick');
    await openTable(win, 'customers', 'dblclick');
    const tabs = win.locator('.tabs');
    const box = (await tabs.boundingBox())!;
    for (const t of await dbTabs(win).all()) {
      const r = (await t.boundingBox())!;
      expect(r.y).toBeGreaterThanOrEqual(box.y - 0.5);
      expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
    }
    await shot(win, 'narrow');
    // A tab dragged past the last one: the caret for the end of the strip, though Databases has no "+"; dropped, it
    // goes last.
    const from = (await dbTabs(win).first().boundingBox())!;
    const end = (await dbTabs(win).last().boundingBox())!;
    await win.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await win.mouse.down();
    await win.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 30, { steps: 4 });
    await win.mouse.move(end.x + end.width + 120, end.y + end.height / 2, { steps: 8 });
    const caret = win.locator('.tabs .tab-end.is-drop');
    await expect(caret).toBeVisible();
    // Right after the last tab.
    const c = (await caret.boundingBox())!;
    expect(c.x).toBeGreaterThanOrEqual(end.x + end.width - 1);
    expect(c.x).toBeLessThanOrEqual(end.x + end.width + 16);
    await look(win, join(SHOTS, 'drop-end.png'), { settle: 200 });
    await win.mouse.up();
    await expect(win.locator('.tabs .tab-end')).toHaveCount(0);
    await expect(dbTabs(win)).toHaveText([/customers/, /orders/]);
  } finally {
    await stopDb(l);
  }
});

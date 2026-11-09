import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { PgServer } from '../support/pg-server';
import {
  SHOTS, addConnection, addFilter, cell, connRow, frames, front, launchDb, openTable, relRow, shot, stopDb, tabOf, type Launched
} from './databases-fixture';
import { layoutProblems, NO_PROBLEMS } from './layout';

// Layout at every width: at the narrowest sizes the UI allows — the sidebar at
// its minimum, the inspector at 280 px, a 900 × 600 window, split view — and at a wide 1600 × 1000, nothing overlaps,
// spills out of its box, wraps inside a control or is cut without an ellipsis, on every surface of the view. The data is
// made long on purpose: a customer's name that can't fit beside its plan chip and "Open ›", a session with a long name
// for Send; the write note's line and the database chip at the sidebar's narrowest.

const LONG_NAME = 'Maximiliana Konstantinopoulou-Lindqvist von Hohenberg';
const SESSION = 'db narrow · index failure for UUID 36341188-1cb4-4574-8c1f-b0cfc3f23a23 in prod';

let server: PgServer;
test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  server = await PgServer.start();
  await server.exec(`update customers set name = '${LONG_NAME}' where id = 1;`);
});
test.afterAll(async () => { await server?.stop(); });

type Surface = { name: string; root: string; parts: string[] };
const KIDS = [':scope > *'];

/** Every surface the view draws, as roots (each match checked) and their parts. */
const SURFACES: Surface[] = [
  // The sidebar.
  { name: 'sidebar head', root: '.db-side > .sidebar-head', parts: KIDS },
  { name: 'connection row', root: '.db-conn', parts: ['.db-glyph', '.db-name', '.db-env', '.db-conn-sub'] },
  // The role can write — one line under the row, its × whole.
  { name: 'write note line', root: '.db-write', parts: KIDS },
  // The database chip and the schema chip share the bar's first line, the filter after them.
  { name: 'catalog bar', root: '.db-cat-bar', parts: KIDS },
  { name: 'database chip', root: '.db-database', parts: KIDS },
  { name: 'section fold', root: '.db-fold', parts: KIDS },
  { name: 'catalog row', root: '.db-rel', parts: KIDS },
  { name: 'sidebar foot', root: '.db-foot', parts: KIDS },
  // A table tab.
  { name: 'toolbar', root: '.dbt-bar', parts: ['.dbt-crumb', '.dbt-ro', '.dbt-est', '.dbt-rv', '.dbt-rv button', '.dbt-views', '.dbt-views button', '.dbt-ib', '.dbt-sql', '.dbt-fold'] },
  { name: 'filter bar', root: '.dbt-fbar', parts: ['.dbt-fbar-icon', '.dbt-fchips > .dbt-fchip', '.dbt-fchips > button', '.dbt-cchip'] },
  { name: 'filter chip', root: '.dbt-fchips > .dbt-fchip', parts: ['.dbt-fchip-col', '.dbt-fchip-op', '.dbt-fchip-val', '.dbt-fchip-x'] },
  { name: 'grid header cell', root: '.dbt-grid th.dbt-th', parts: ['.dbt-th-pk', '.dbt-th-drv', '.dbt-th-name', '.dbt-th-fk', '.dbt-th-sort', '.dbt-th-type', '.dbt-th-menu'] },
  { name: 'table footer', root: '.dbt-foot', parts: KIDS },
  { name: 'action bar', root: '.db-selbar', parts: KIDS },
  { name: 'action bar in its tab', root: '.dbt-gridbox', parts: ['.db-selwrap'] },
  // The row inspector.
  { name: 'inspector head', root: '.dbi-head', parts: KIDS },
  { name: 'inspector field', root: '.dbi-f', parts: ['.dbi-fn', '.dbi-ft', '.dbi-facts', '.dbi-fv', '.dbi-peek'] },
  { name: 'field name line', root: '.dbi-fk', parts: KIDS },
  { name: 'FK peek card', root: '.dbi-peek', parts: ['.dbi-peek-label', '.dbi-peek-head > .dbi-peek-chip', '.dbi-peek-open', '.dbi-peek-sub'] },
  { name: 'FK peek line', root: '.dbi-peek-sub', parts: KIDS },
  { name: 'Referenced by row', root: '.dbi-ref', parts: KIDS },
  { name: 'more fields', root: '.dbi-more', parts: KIDS },
  // The record view: its head; each field's name block, Copy JSON, value and card (the inspector's rows).
  { name: 'record head', root: '.dbrv-head', parts: KIDS },
  { name: 'record field', root: '.dbrv .dbi-f', parts: ['.dbi-fk', '.dbi-facts', '.dbi-fv', '.dbi-peek'] },
  // The JSON view.
  { name: 'JSON view head', root: '.dbj-head', parts: KIDS },
  { name: 'JSON find bar', root: '.dbj-findbar', parts: KIDS },
  { name: 'JSON path bar', root: '.dbj-bar-row', parts: KIDS },
  // Structure, Relations.
  { name: 'Structure head', root: '.dbs-head', parts: KIDS },
  { name: 'Structure cards', root: '.dbs-grid', parts: ['.dbs-card, .dbs-sec'] },
  { name: 'Structure section head', root: '.dbs-sec-head', parts: KIDS },
  { name: 'Structure row', root: '.dbs-table tr', parts: [':scope > td', ':scope > th', '.dbs-badge', '.dbs-scans', '.dbs-null'] },
  { name: 'Structure cell', root: '.dbs-table td', parts: KIDS },
  { name: 'Relations card', root: '.dbs-rel', parts: ['.dbr-node', '.dbs-link'] },
  { name: 'diagram', root: '.dbr-plane', parts: ['.dbr-node'] },
  { name: 'diagram node', root: '.dbr-node', parts: ['.dbr-node-name', '.dbr-node-via', '.dbr-node-n'] },
  // The overview.
  { name: 'Overview head', root: '.dbo-head', parts: KIDS },
  { name: 'Overview tiles', root: '.dbo-tiles', parts: ['.dbo-tile'] },
  { name: 'Overview tile', root: '.dbo-tile', parts: ['.section-label', '.dbo-v', '.dbo-s', '.dbo-spark'] },
  { name: 'Overview card head', root: '.dbo-card-head', parts: KIDS },
  // Add / Edit Connection.
  { name: 'sheet field', root: '.db-sheet .db-field', parts: KIDS },
  { name: 'sheet segmented', root: '.db-sheet .db-seg', parts: ['button, [role="radio"]'] },
  { name: 'sheet foot', root: '.db-sheet-foot', parts: KIDS },
  { name: 'sheet engine', root: '.db-engine', parts: KIDS },
  // The palette's tables, the footer item.
  { name: 'palette row', root: '.palette-item', parts: KIDS },
  { name: 'footer', root: '.footer', parts: [':scope > *'] },
  // An empty pane (Split Right with nothing left to show): what it offers.
  { name: 'pane picker', root: '.pp-card', parts: ['.pp-head', '.pp-list', '.pp-none', '.pp-actions'] },
  { name: 'pane picker actions', root: '.pp-actions', parts: KIDS }
];

/** The sidebar's surfaces, in every view of the database. */
const SIDEBAR = ['sidebar head', 'connection row', 'write note line', 'catalog bar', 'database chip', 'section fold', 'catalog row', 'sidebar foot', 'footer'];
/** What each view must show (each surface named here with no root drawn fails: a hidden surface never passes silently). */
const EXPECTED = {
  data: [...SIDEBAR, 'toolbar', 'filter bar', 'filter chip', 'grid header cell', 'table footer', 'inspector head', 'inspector field', 'field name line',
    'FK peek card', 'FK peek line', 'Referenced by row'],
  selected: [...SIDEBAR, 'toolbar', 'filter bar', 'filter chip', 'grid header cell', 'table footer', 'action bar', 'action bar in its tab'],
  record: [...SIDEBAR, 'toolbar', 'filter bar', 'filter chip', 'table footer', 'record head', 'record field', 'field name line', 'FK peek card', 'FK peek line'],
  json: [...SIDEBAR, 'JSON view head', 'JSON find bar', 'JSON path bar'],
  structure: [...SIDEBAR, 'Structure head', 'Structure cards', 'Structure section head', 'Structure row', 'Structure cell', 'Relations card'],
  relations: [...SIDEBAR, 'diagram', 'diagram node'],
  overview: [...SIDEBAR, 'Overview head', 'Overview tiles', 'Overview tile', 'Overview card head'],
  sheetStep1: ['sheet field', 'sheet foot', 'sheet engine'],
  sheetForm: ['sheet field', 'sheet segmented', 'sheet foot'],
  palette: ['palette row'],
  sidebar: SIDEBAR,
  picker: ['pane picker', 'pane picker actions', 'footer']
} satisfies Record<string, string[]>;

/**
 * Every surface on screen now: its problems (soft: one run says them all), `where` in each message; each surface in
 * `expected` must have a root drawn.
 */
async function noProblems(win: Page, where: string, expected: readonly string[]): Promise<number> {
  for (const name of expected) expect(SURFACES.some((s) => s.name === name), `a known surface: ${name}`).toBe(true);
  let checked = 0;
  for (const s of SURFACES) {
    const roots = await win.locator(`${s.root}:visible`).all();
    if (expected.includes(s.name)) expect.soft(roots.length, `${where} · ${s.name} is drawn`).toBeGreaterThan(0);
    for (const root of roots) {
      const p = await layoutProblems(root, s.parts);
      checked++;
      expect.soft(p, `${where} · ${s.name}`).toEqual(NO_PROBLEMS);
    }
  }
  return checked;
}

/** The words of `l`'s text cut across two lines (its box narrower than they are). */
function brokenWords(l: Locator): Promise<string[]> {
  return l.evaluate((el) => {
    const out: string[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      for (const m of (n.textContent ?? '').matchAll(/\S+/g)) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
        if (tops.size > 1) out.push(m[0]);
      }
    }
    return out;
  });
}

/** orders' neighbours on the diagram, the table itself in the middle. */
const ORDERS_NODES = ['coupons', 'customers', 'order_items', 'orders', 'payments', 'refunds', 'shipments'];

/**
 * The diagram's names in `scope` as drawn (sorted), and the lines its nodes cut — names, and the view's keys' columns
 * under them (follow-up 1: "order…", "payme…" in a card with room for them). Cut: the text's own width (laid out
 * unconstrained for a moment) past its box, in fractions of a pixel — scrollWidth rounds a cut under half a pixel away,
 * while the ellipsis shows.
 */
function diagramText(scope: Locator): Promise<{ names: string[]; cut: string[] }> {
  return scope.locator('.dbr-node-name, .dbr-node-via').evaluateAll((els) => ({
    names: els.filter((e) => e.classList.contains('dbr-node-name')).map((e) => e.textContent ?? '').sort(),
    cut: els.filter((e) => {
      const el = e as HTMLElement;
      const box = el.getBoundingClientRect().width;
      const was = el.style.cssText;
      el.style.cssText = `${was};flex:none;width:max-content;max-width:none`;
      const text = el.getBoundingClientRect().width;
      el.style.cssText = was;
      return text > box + 0.01;
    }).map((e) => e.textContent ?? '')
  }));
}

/**
 * The record view's fields as drawn: how many lay the name block beside the value (a wide pane), how many
 * over it (a narrow one), and the names of any that do neither (the value across the name).
 */
function recordFields(t: Locator): Promise<{ side: number; stacked: number; across: string[]; apart: string[]; width: number }> {
  return t.locator('.dbrv').evaluate((rec) => {
    let side = 0;
    let stacked = 0;
    const across: string[] = [];
    // Copy JSON drawn far from its name (a tall value stretched the name's row: it sat halfway down the tree).
    const apart: string[] = [];
    for (const f of rec.querySelectorAll('.dbi-f')) {
      const k = f.querySelector('.dbi-fk')!.getBoundingClientRect();
      const v = f.querySelector('.dbi-fv')?.getBoundingClientRect();
      const facts = f.querySelector('.dbi-facts')?.getBoundingClientRect();
      const name = f.querySelector('.dbi-fn-t')?.textContent ?? '?';
      if (facts && facts.top - k.bottom > 12) apart.push(name);
      if (!v) continue;
      if (v.left >= k.right - 0.5) side++;
      else if (v.top >= k.bottom - 0.5) stacked++;
      else across.push(name);
    }
    return { side, stacked, across, apart, width: rec.getBoundingClientRect().width };
  });
}

/** The sidebar at `w` px: its edge's keys (the width the user would get by dragging). */
async function sidebarTo(win: Page, w: number | 'min'): Promise<number> {
  const edge = win.getByRole('separator', { name: 'Resize sessions bar' });
  await edge.focus();
  const min = Number(await edge.getAttribute('aria-valuemin'));
  const want = w === 'min' ? min : w;
  for (let i = 0; i < 60 && Number(await edge.getAttribute('aria-valuenow')) > want; i++) await win.keyboard.press('ArrowLeft');
  for (let i = 0; i < 60 && Number(await edge.getAttribute('aria-valuenow')) < want; i++) await win.keyboard.press('ArrowRight');
  await frames(win);
  return Number(await edge.getAttribute('aria-valuenow'));
}

/** The inspector at 280 px (its splitter's Home). */
async function inspector280(win: Page, t: Locator): Promise<void> {
  const edge = t.locator('.dbi-rs');
  await edge.focus();
  await win.keyboard.press('Home');
  await expect(edge).toHaveAttribute('aria-valuenow', '280');
}

/** An app menu item clicked for the main window. */
async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows().find((b) => b.isFocusable())!);
  }, label);
}

/** The app with a long-named Claude session (the action bar's Send), the database added, orders 111 inspected. */
async function stage(o: { width: number; height: number }): Promise<Launched> {
  const l = await launchDb(server, { width: o.width, height: o.height });
  const { win } = l;
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(SESSION);
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: 'db narrow' })).toHaveClass(/state-done/, { timeout: 20000 });
  await addConnection(l);
  // PGlite's role is a superuser: the write note's one line stays under the row (never dismissed here).
  await expect(win.locator('.db-write')).toBeVisible();
  return l;
}

/** orders, three filters, order 111 selected and inspected (the peek card with the long name, Referenced by). */
async function ordersWithInspector(win: Page): Promise<Locator> {
  await relRow(win, 'orders').click();
  const t = front(win);
  await expect(t.locator('.dbt-crumb-name')).toHaveText('orders');
  // Back on Data (a round before left it on Relations).
  const data = t.getByRole('radio', { name: 'Data' });
  if ((await data.getAttribute('aria-checked')) !== 'true') await data.click();
  await expect(t.locator('.dbt-grid tbody tr[data-row]').first()).toBeVisible({ timeout: 15000 });
  if ((await t.locator('.dbt-fchips > .dbt-fchip').count()) === 0) {
    await addFilter(t, 'id', 'le', ['111']);
    await addFilter(t, 'currency', 'eq', ['EUR']);
    await addFilter(t, 'coupon', 'notnull');
  }
  // Order 111: sorted by id descending, the first row.
  const id = t.locator('.dbt-th', { has: win.locator('.dbt-th-name', { hasText: /^id$/ }) });
  while ((await id.getAttribute('aria-sort')) !== 'descending') await id.locator('.dbt-th-btn').click();
  // Sorted, the short name is still whole: its column's first width left room for the arrow (it was "i…").
  const idName = id.locator('.dbt-th-name');
  await expect(id.locator('.dbt-th-sort')).toBeVisible();
  expect(await idName.evaluate((el) => el.scrollWidth - el.clientWidth), 'the sorted "id" header is not cut').toBeLessThanOrEqual(0);
  // The first column: in view at any width (a round before may have left it inspected: a 280 px inspector over a
  // 280 px pane covers the rows).
  const key = t.locator('.dbi .dbi-key');
  if ((await key.count()) === 0 || (await key.innerText()) !== '111') {
    await (await cell(t, 0, 'id')).click();
    if ((await t.locator('.dbi').count()) === 0) await win.keyboard.press('Enter');
  }
  await expect(t.locator('.dbi .dbi-key')).toHaveText('111');
  await expect(t.locator('.dbi-peek-label').first()).toHaveText(LONG_NAME, { timeout: 15000 });
  await expect(t.locator('.dbi-ref').first()).toBeVisible();
  return t;
}

/** Every view of the database, each checked: Data with the inspector, the JSON view, Structure, Relations, the overview, the sheet, the palette. */
async function everyView(l: Launched, where: string, o: { inspector280?: boolean; shots?: string; wholeNames?: boolean } = {}): Promise<void> {
  const { win } = l;
  const t = await ordersWithInspector(win);
  if (o.inspector280) {
    await inspector280(win, t);
    // The peek card at 280 px: the long name gives way with an ellipsis, Open › whole.
    const label = t.locator('.dbi-peek-label').first();
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'), 'the name ellipsized').toBe(true);
    await expect(t.locator('.dbi-peek-open').first()).toHaveText('Open ›');
    const open = (await t.locator('.dbi-peek-open').first().boundingBox())!;
    const card = (await t.locator('.dbi-peek').first().boundingBox())!;
    expect(open.x + open.width, 'Open › inside the card').toBeLessThanOrEqual(card.x + card.width + 0.5);
  }
  await frames(win);
  expect(await noProblems(win, `${where} · Data`, EXPECTED.data)).toBeGreaterThan(20);
  if (o.shots) await shot(win, `db-narrow-${o.shots}-data`);
  // The record view: Tab on the row (the grid takes the keys even under a 280 px inspector over a narrow
  // pane). Every surface holds; each name beside its value when the pane is wide, over it when narrow, never across.
  await t.locator('.dbt-grid').focus();
  await win.keyboard.press('Tab');
  const rec = t.locator('.dbrv');
  await expect(rec).toBeVisible();
  await expect(rec.locator('.dbrv-key')).toHaveText('111');
  await expect(rec.locator('.dbi-peek-label').first()).toHaveText(LONG_NAME, { timeout: 15000 });
  await expect(t.locator('.dbi')).toBeHidden();
  await frames(win);
  await noProblems(win, `${where} · Record`, EXPECTED.record);
  const fields = await recordFields(t);
  expect.soft(fields.across, `${where} · Record: no value across its name`).toEqual([]);
  expect.soft(fields.apart, `${where} · Record: Copy JSON right by its name`).toEqual([]);
  if (fields.width > 520) expect.soft(fields, `${where} · Record (${Math.round(fields.width)} px): names beside the values`).toMatchObject({ stacked: 0, side: 12 });
  else expect.soft(fields, `${where} · Record (${Math.round(fields.width)} px): names over the values`).toMatchObject({ side: 0, stacked: 12 });
  // The FK card at the record's width: the long name ellipsized, Open › whole inside the card.
  const label = rec.locator('.dbi-peek-label').first();
  expect.soft(await label.evaluate((el) => el.scrollWidth <= el.clientWidth || getComputedStyle(el).textOverflow === 'ellipsis'), `${where} · Record: the card's name whole or ellipsized`).toBe(true);
  const open = (await rec.locator('.dbi-peek-open').first().boundingBox())!;
  const card = (await rec.locator('.dbi-peek').first().boundingBox())!;
  expect.soft(open.x + open.width, `${where} · Record: Open › inside the card`).toBeLessThanOrEqual(card.x + card.width + 0.5);
  await shot(win, `db-record-${o.shots ?? 'wide'}`);
  await win.keyboard.press('Escape');
  await expect(rec).toHaveCount(0);
  await expect(t.locator('.dbi')).toBeVisible();
  // The JSON view of metadata.
  await t.locator('.dbi-f', { has: win.locator('.dbi-fn-t', { hasText: /^metadata$/ }) }).getByRole('button', { name: 'Open in JSON View' }).click();
  await expect(t.locator('.dbj-bar')).toBeVisible();
  // A node selected (its path and SQL in the bottom bar): the find's first hit.
  await t.getByRole('textbox', { name: 'Find in this value' }).fill('percent');
  await expect(t.locator('.dbj-bar-code').first()).toHaveText('discount.percent');
  await frames(win);
  await noProblems(win, `${where} · JSON view`, EXPECTED.json);
  if (o.shots) await shot(win, `db-narrow-${o.shots}-json`);
  await t.getByRole('button', { name: 'Back to Fields' }).click();
  // Structure, Relations.
  await t.getByRole('radio', { name: 'Structure' }).or(t.locator('.dbt-fold')).first().click();
  if (await win.locator('.ctx-menu').count()) await win.locator('.ctx-menu').getByRole('menuitemradio', { name: 'Structure' }).or(win.locator('.ctx-menu').getByRole('menuitem', { name: 'Structure' })).click();
  await expect(t.locator('.dbs-ddl')).toContainText('CREATE TABLE', { timeout: 15000 });
  await frames(win);
  await noProblems(win, `${where} · Structure`, EXPECTED.structure);
  // Follow-up 1: a card with room for the names shows them whole, the 1:N mark beside them; the
  // view, its keys' columns under them too.
  const whole = { names: ORDERS_NODES, cut: [] as string[] };
  if (o.wholeNames) expect.soft(await diagramText(t.locator('.dbs-rel')), `${where}: the Relations card's names whole`).toEqual(whole);
  if (o.shots) await shot(win, `db-narrow-${o.shots}-structure`);
  await t.locator('.dbs-link', { hasText: 'Open diagram' }).click();
  await expect(t.locator('.dbr-view .dbr-node.is-center')).toBeVisible({ timeout: 15000 });
  await frames(win);
  await noProblems(win, `${where} · Relations`, EXPECTED.relations);
  if (o.wholeNames) expect.soft(await diagramText(t.locator('.dbr-view')), `${where}: the Relations view's names and columns whole`).toEqual(whole);
  if (o.shots) await shot(win, `db-narrow-${o.shots}-relations`);
  // The overview.
  await connRow(win, 'postgres').click({ button: 'right' });
  await win.locator('.ctx-menu').getByRole('menuitem', { name: 'Overview' }).click();
  await expect(win.locator('.dbo:visible .dbo-tile .dbo-v').first()).toHaveText(/\d/, { timeout: 15000 });
  await frames(win);
  await noProblems(win, `${where} · Overview`, EXPECTED.overview);
  if (o.shots) await shot(win, `db-narrow-${o.shots}-overview`);
  // Add Connection: step 1, then the form.
  await win.locator('.db-side .sidebar-head').getByRole('button', { name: 'Add Connection…' }).click();
  await expect(win.locator('.db-sheet')).toBeVisible();
  await noProblems(win, `${where} · Add Connection`, EXPECTED.sheetStep1);
  // T31: the engines say their names and what they read whole at the sheet's width — "Later" never squeezes them.
  for (const el of await win.locator('.db-engine-text > *').all()) {
    expect.soft(await el.evaluate((e) => e.scrollWidth - e.clientWidth), `${where}: "${await el.textContent()}" whole`).toBeLessThanOrEqual(0);
  }
  await expect.soft(win.locator('.db-engine:disabled .db-later'), `${where}: each later engine still says so`).toHaveCount(5);
  await win.locator('.db-sheet').getByLabel('Connection URL').fill('postgresql://reporting_reader@ep-long-warehouse-name-a1b2c3.eu-central-1.aws.neon.tech:5432/warehouse_reporting_replica');
  await win.locator('.db-sheet').getByRole('button', { name: 'Continue' }).click();
  await expect(win.locator('.db-sheet').getByLabel('Host')).toBeVisible();
  await frames(win);
  await noProblems(win, `${where} · Add Connection form`, EXPECTED.sheetForm);
  if (o.shots) await shot(win, `db-narrow-${o.shots}-sheet`);
  await win.keyboard.press('Escape');
  await expect(win.locator('.db-sheet')).toHaveCount(0);
  // The palette's tables.
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('order');
  await expect(win.locator('.palette-item', { hasText: 'order_items' }).first()).toBeVisible();
  await noProblems(win, `${where} · palette`, EXPECTED.palette);
  if (o.shots) await shot(win, `db-narrow-${o.shots}-palette`);
  await win.keyboard.press('Escape');
}

/**
 * Two rows selected, the inspector closed (a narrow pane: the action bar has the grid's width): every surface, and the
 * bar inside its pane, each of its buttons whole inside the bar.
 */
async function selectedRows(win: Page, where: string, shots?: string): Promise<void> {
  await relRow(win, 'orders').click();
  const t = front(win);
  await expect(t.locator('.dbt-crumb-name')).toHaveText('orders');
  const data = t.getByRole('radio', { name: 'Data' });
  if ((await data.getAttribute('aria-checked')) !== 'true') await data.click();
  if (await t.locator('.dbi').count()) await t.getByRole('button', { name: 'Close Inspector' }).click();
  await expect(t.locator('.dbi')).toHaveCount(0);
  await (await cell(t, 0, 'id')).click();
  await (await cell(t, 1, 'id')).click({ modifiers: ['Shift'] });
  const bar = t.locator('.db-selbar');
  await expect(t.locator('.dbt-grid tbody tr.is-sel')).toHaveCount(2);
  await expect(bar).toBeVisible();
  await expect(bar.locator('.sel-send')).toBeVisible();
  await frames(win);
  await noProblems(win, `${where} · 2 rows selected`, EXPECTED.selected);
  const pane = (await t.boundingBox())!;
  const b = (await bar.boundingBox())!;
  expect(b.x, `${where}: the bar starts inside the pane`).toBeGreaterThanOrEqual(pane.x - 0.5);
  expect(b.x + b.width, `${where}: the bar ends inside the pane`).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
  for (const el of await bar.locator('button:visible').all()) {
    const r = (await el.boundingBox())!;
    expect(r.x + r.width, `${where}: "${await el.getAttribute('aria-label')}" inside the bar`).toBeLessThanOrEqual(b.x + b.width + 0.5);
    expect(await el.evaluate((e) => e.scrollWidth - e.clientWidth), `${where}: "${await el.getAttribute('aria-label')}" holds its content`).toBeLessThanOrEqual(1);
  }
  await expect(bar.locator('.sel-send')).toHaveAttribute('aria-label', /^Send to db narrow/);
  if (shots) await shot(win, `db-narrow-${shots}-selected`);
  await win.keyboard.press('Escape');
}

test('1600 × 1000: every surface holds', async () => {
  test.setTimeout(240_000);
  const l = await stage({ width: 1600, height: 1000 });
  try {
    await everyView(l, '1600 × 1000', { wholeNames: true });
    await shot(l.win, 'db-wide');
  } finally {
    await stopDb(l);
  }
});

test('900 × 600, the sidebar at its minimum, the inspector at 280 px: every surface holds', async () => {
  test.setTimeout(240_000);
  const l = await stage({ width: 900, height: 600 });
  try {
    const w = await sidebarTo(l.win, 'min');
    expect(w).toBeLessThanOrEqual(200);
    await shot(l.win, 'db-narrow-sidebar');
    expect(await noProblems(l.win, `sidebar ${w} px`, EXPECTED.sidebar)).toBeGreaterThan(5);
    await everyView(l, `900 × 600, sidebar ${w} px, inspector 280`, { inspector280: true, shots: '900' });
  } finally {
    await stopDb(l);
  }
});

test('split view (~430 and ~280 px panes): every surface holds, the overview tiles too', async () => {
  test.setTimeout(240_000);
  const l = await stage({ width: 1440, height: 900 });
  const { app, win } = l;
  try {
    // Tables live in Databases: another table in the left pane, orders to its right.
    await openTable(win, 'customers', 'dblclick');
    await openTable(win, 'orders', 'dblclick');
    await tabOf(win, 'orders').click({ modifiers: ['Alt'] });
    await expect(win.locator('.pane-divider')).toHaveCount(1);
    // The right pane's view: a table tab, or the overview the last round left in front (the left one shows customers).
    const view = () => win.locator('.dbt:visible, .dbo:visible').filter({ hasNot: win.locator('.dbt-crumb-name', { hasText: /^customers$/ }) }).first();
    for (const pane of [430, 280]) {
      const w0 = (await view().boundingBox())!.width;
      await win.setViewportSize({ width: Math.round(win.viewportSize()!.width + 2 * (pane - w0)), height: 900 });
      await expect.poll(async () => Math.abs((await view().boundingBox())!.width - pane)).toBeLessThan(8);
      // A 430 px pane has room for every name and column on the diagram (follow-up 1).
      await everyView(l, `split, a ${pane} px pane`, { inspector280: true, shots: `split-${pane}`, wholeNames: pane === 430 });
      await selectedRows(win, `split, a ${pane} px pane`, `split-${pane}`);
    }
    // Three panes, the new one empty (nothing left to show): its picker in this window, then in a 640 × 600 one (each
    // pane ~100 px: the narrowest the split allows; no Changes panel in Databases, so the window
    // is narrower than the 900 px it took beside one).
    await menu(app, 'Split Right');
    await expect(win.locator('.pane-divider')).toHaveCount(2);
    await expect(win.locator('.pp-card')).toBeVisible();
    await frames(win);
    await noProblems(win, 'three panes', EXPECTED.picker);
    await win.setViewportSize({ width: 640, height: 600 });
    await expect.poll(async () => (await win.locator('.pane-picker').boundingBox())!.width).toBeLessThan(140);
    await frames(win);
    await noProblems(win, 'three panes in 640 × 600', EXPECTED.picker);
    // What the checks above can't see at ~95 px: a name shrunk to nothing (its separators left alone), a chip with
    // neither its label nor its glyph, a message cut a letter or two per line.
    const t = win.locator('.dbt:visible', { has: win.locator('.dbt-crumb-name', { hasText: /^orders$/ }) });
    expect.soft((await t.locator('.dbt-crumb-name').boundingBox())?.width ?? 0, 'a ~95 px pane names its table').toBeGreaterThan(16);
    await expect.soft(t.locator('.dbt-crumb-sep:visible'), 'no path separators around nothing').toHaveCount(0);
    expect.soft((await t.locator('.dbt-cchip svg').boundingBox())?.width ?? 0, 'the columns chip keeps its glyph').toBeGreaterThan(0);
    expect.soft(await brokenWords(win.locator('.pp-none')), 'the empty pane says its words whole').toEqual([]);
    // The session pane's bar at ~95 px needs a session beside the tables: Databases is a space of its own now, so a
    // session's bar in a ~95 px pane belongs to Sessions' own three-pane checks.
    await shot(win, 'db-narrow-three-panes');
  } finally {
    await stopDb(l);
  }
});

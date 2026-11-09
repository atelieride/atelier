// CSV viewer: rainbow and aligned Source with the cell address, the Table (types, sort,
// filter, column menu, freeze/hide, range selection and copies), Split in sync, rows that don't match the header,
// parse options, a large file with Go to Row and the cell peek.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look, shotsOn } from './shots';

const SHOTS = resolve('e2e-shots/csv-viewer');

const ORDERS = [
  'order_id;created_at;customer;country;status;items;total_eur;paid',
  'A-10231;2026-07-01 09:14;Bottega Rossi;IT;delivered;3;284,50;true',
  'A-10232;2026-07-01 11:02;Nordlicht GmbH;DE;delivered;12;1284,00;true',
  'A-10233;2026-07-02 16:40;Atelier Lumière;FR;shipped;5;612,90;true',
  'A-10234;2026-07-03 08:05;Casa Verde SL;ES;pending;1;49,00;false',
  'A-10235;2026-07-03 10:31;Fratelli Neri;IT;refunded;2;130,00;true',
  'A-10236;2026-07-04 14:22;Kaffeehaus Berg;DE;shipped;8;948,40;true',
  'A-10237;2026-07-05 09:58;Studio Marino;IT;delivered;4;356,20;true',
  'A-10238;2026-07-06 12:47;Maison Duval;FR;cancelled;6;512,00;false',
  'A-10239;2026-07-07 17:15;Olivar del Sur;ES;delivered;10;1102,75;true',
  'A-10240;2026-07-08 08:39;Lanificio Biella;IT;shipped;15;2310,00;true',
  'A-10241;2026-07-08 13:03;"Hafen & Co; Bremen";DE;pending;2;98,60;false',
  'A-10242;2026-07-09 10:20;Le Petit Four;FR;delivered;3;187,30;true',
  'A-10243;2026-07-10 15:44;Ceramiche Sole;IT;delivered;7;734,10;true',
  'A-10244;2026-07-11 09:09;Viñedo Alto;ES;shipped;9;865,00;true'
].join('\r\n') + '\r\n';

// Row 3 has a stray delimiter (4 fields), row 5 lacks one (2); a title line on top.
const RAGGED = ['Quarterly export', 'region,city,visits', 'eu,Milan,120', 'eu,Paris,95', 'us,New York,eh,300', 'us,Austin,88', 'ap,Tokyo', 'ap,Sydney,40'].join('\n') + '\n';

function large(): string {
  const levels = ['info', 'info', 'info', 'warn', 'error'];
  const services = ['checkout', 'catalog', 'payments', 'auth', 'search', 'shipping'];
  const out = ['ts,level,service,route,status,duration_ms,user_id,payload'];
  for (let i = 0; i < 25_000; i++) {
    const payload = JSON.stringify({ method: i % 2 ? 'GET' : 'POST', cart: { items: i % 7, currency: 'EUR' }, retry: i % 5 === 0, region: 'eu-south-1', n: i });
    out.push(`2026-10-14T18:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z,${levels[i % 5]},${services[i % 6]},/api/r/${i},${i % 13 === 0 ? 504 : 200},${(i * 37) % 2400},u_${(i * 7919) % 100000},"${payload.replaceAll('"', '""')}"`);
  }
  return out.join('\n') + '\n';
}

async function launch(): Promise<{ app: ElectronApplication; home: string; log: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'exports'));
  mkdirSync(join(project, 'logs'));
  // One copy of the orders per test (they share the app): nothing one leaves in a file's view reaches another.
  for (const name of ['orders-q3', 'orders-table', 'orders-select']) writeFileSync(join(project, 'exports', `${name}.csv`), ORDERS);
  writeFileSync(join(project, 'exports', 'visits.csv'), RAGGED);
  writeFileSync(join(project, 'logs', 'requests.csv'), large());
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 950));
  return { app, home, log: env.ATELIER_TEST_CLIPBOARD_LOG! };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

/** The app menu shortcuts are tested by clicking the item (synthetic events do not go through NSMenu). */
async function menu(app: ElectronApplication, accelerator: string) {
  await app.evaluate(({ Menu, BrowserWindow }, acc) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.accelerator === acc) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, accelerator);
}

async function open(win: Page, folder: string, name: string) {
  const file = win.locator('.tree-row', { hasText: name }).first();
  if (!(await file.isVisible())) {
    if (!(await win.locator('.tree-row').first().isVisible())) await win.getByRole('button', { name: /Files/ }).click();
    await win.locator('.tree-row', { hasText: folder }).first().click();
  }
  await file.dblclick();
  await expect(win.locator('.file-view:visible .json-switch')).toBeVisible();
}

const fv = (win: Page) => win.locator('.file-view:visible');
const sw = (win: Page, name: string) => fv(win).locator('.json-switch').getByRole('radio', { name });
const copied = (log: string) => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string); } catch { return []; } };
const addr = (win: Page) => fv(win).locator('.file-bar .csv-addr');
const cell = (win: Page, row: number, col: number) => fv(win).locator('.csv-table tbody tr').filter({ has: win.locator('td.csv-rn', { hasText: new RegExp(`^${row}$`) }) }).locator('td[role="gridcell"]').nth(col);
const shot = async (win: Page, name: string) => { if (shotsOn()) mkdirSync(SHOTS, { recursive: true }); await look(win, join(SHOTS, name)); };

// One app for the whole file, each test in its own file tab (in order: a failure stops the ones after it).
test.describe.configure({ mode: 'serial' });
let shared: { app: ElectronApplication; home: string; log: string } | undefined;
test.beforeAll(async () => { shared = await launch(); });
test.afterAll(async () => { if (shared) await stop(shared.app, shared.home); });

test('Source: rainbow columns, the cell address and Copy cell, Align columns, no "Plain text"; CSV in Change Language Mode', async () => {
  const { app, log } = shared!;
  const win = await app.firstWindow();
  await open(win, 'exports', 'orders-q3.csv');
  await expect(sw(win, 'Source')).toHaveAttribute('aria-checked', 'true');
  await expect(sw(win, 'Table')).toBeVisible();
  await expect(fv(win).locator('.foot-lang')).toHaveText('CSV');
  await expect(fv(win).locator('.file-note', { hasText: 'Plain text' })).toHaveCount(0);
  // Each column its color, delimiters dim, the header row bold.
  await expect.poll(() => fv(win).locator('.cm-csv-c6').count()).toBeGreaterThan(10);
  await expect(fv(win).locator('.cm-line.cm-csv-head')).toHaveCount(1);
  await expect(fv(win).locator('.cm-csv-c2', { hasText: '"Hafen & Co; Bremen"' })).toHaveCount(1);
  // The field under the cursor: its address, column and type in the file bar.
  await fv(win).locator('.cm-csv-c6', { hasText: '948,40' }).click();
  await expect(addr(win)).toHaveText('G6');
  await expect(fv(win).locator('.csv-crumb-col')).toHaveText('total_eur');
  await expect(fv(win).locator('.csv-crumb .json-type')).toHaveText('decimal · 2 places · line 7, field 7 of 8');
  await fv(win).locator('.csv-copy').click();
  await expect(fv(win).locator('.json-copied')).toHaveText('Copied 948,40');
  expect(copied(log).at(-1)).toBe('948,40');
  // A quoted field: copied without its quotes.
  await fv(win).locator('.cm-csv-c2', { hasText: 'Hafen' }).click();
  await expect(addr(win)).toHaveText('C11');
  await fv(win).locator('.csv-copy').click();
  await expect.poll(() => copied(log).at(-1)).toBe('Hafen & Co; Bremen');
  await shot(win, '01-source-rainbow.png');
  // Align columns: spacers on screen, the text unchanged.
  await fv(win).getByRole('button', { name: 'Align columns' }).click();
  await expect.poll(() => fv(win).locator('.cm-csv-pad').count()).toBeGreaterThan(50);
  await shot(win, '02-source-aligned.png');
  await fv(win).getByRole('button', { name: 'Align columns' }).click();
  await expect(fv(win).locator('.cm-csv-pad')).toHaveCount(0);
  await fv(win).getByRole('button', { name: 'Rainbow' }).click();
  await expect(fv(win).locator('.cm-csv-c6')).toHaveCount(0);
  await fv(win).getByRole('button', { name: 'Rainbow' }).click();
  await expect.poll(() => fv(win).locator('.cm-csv-c6').count()).toBeGreaterThan(10);
});

test('Table: ⇧⌘V, typed headers, sort and ⌥ sort, filter, the column menu with value filters, freeze and hide', async () => {
  const { app, log } = shared!;
  const win = await app.firstWindow();
  await open(win, 'exports', 'orders-table.csv');
  await menu(app, 'CmdOrCtrl+Shift+V');
  await expect(sw(win, 'Table')).toHaveAttribute('aria-checked', 'true');
  const table = fv(win).locator('.csv-table');
  await expect(table).toBeVisible();
  await expect(fv(win).locator('.file-body')).toBeHidden();
  const th = (name: string) => table.locator('th', { has: win.locator('.csv-name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(th('total_eur').locator('.csv-type')).toHaveText('decimal · 2 places');
  await expect(th('status').locator('.csv-type')).toHaveText('category · 5');
  await expect(th('order_id').locator('.csv-type')).toHaveText('text · unique');
  await expect(th('created_at').locator('.csv-type')).toHaveText('datetime');
  await expect(th('paid').locator('.csv-type')).toHaveText('boolean');
  await expect(fv(win).locator('.csv-pchip')).toHaveText('; semicolon · header · decimal ,');
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('14 rows · 8 columns');
  // Typed cells: numbers grouped with bars, categories as pills, codes as chips.
  await expect(cell(win, 2, 6)).toHaveText('1 284,00');
  await expect(cell(win, 2, 6).locator('.csv-bar')).toHaveCount(1);
  await expect(cell(win, 1, 4).locator('.csv-pill')).toHaveText('delivered');
  await expect(cell(win, 1, 3).locator('.csv-code')).toHaveText('IT');
  // Sort: ascending, descending, off; row numbers stay the file's.
  await th('total_eur').locator('.csv-sort').click();
  await th('total_eur').locator('.csv-sort').click();
  await expect(th('total_eur')).toHaveAttribute('aria-sort', 'descending');
  await expect(table.locator('tbody tr td.csv-rn').first()).toHaveText('10');
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('14 rows · 8 columns · sorted by total_eur');
  // ⌥-click adds a key: country first, then total_eur.
  await th('total_eur').locator('.csv-sort').click();
  await th('country').locator('.csv-sort').click();
  await th('total_eur').locator('.csv-sort').click({ modifiers: ['Alt'] });
  await expect(table.locator('tbody tr td.csv-rn')).toHaveText(['11', '6', '2', '4', '14', '9', '12', '8', '3', '5', '1', '7', '13', '10']);
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('14 rows · 8 columns · sorted by country, total_eur');
  // Filter rows.
  const filter = fv(win).locator('.csv-tools .json-field input');
  await filter.fill('lumi');
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('1 of 14 rows');
  await filter.fill('zzz');
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('No matches');
  await filter.fill('');
  // The column menu: uncheck three statuses → a chip; ⌥-click keeps one value only.
  await th('status').hover();
  await th('status').locator('.csv-col-menu').click();
  const pop = fv(win).locator('.csv-colmenu');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.csv-v')).toHaveCount(5);
  for (const v of ['pending', 'refunded', 'cancelled']) await pop.locator('.csv-v', { hasText: v }).click();
  await expect(fv(win).locator('.csv-fchip')).toHaveText('status delivered, shipped');
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('10 of 14 rows');
  await shot(win, '03-table-column-menu.png');
  await pop.locator('.csv-v', { hasText: 'shipped' }).click({ modifiers: ['Alt'] });
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('4 of 14 rows');
  await win.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await fv(win).locator('.csv-fchip-x').click();
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('14 rows · 8 columns · sorted by country, total_eur');
  // Freeze up to customer, hide paid; Copy Column copies the visible values.
  await th('customer').click({ button: 'right' });
  await fv(win).locator('.csv-colmenu').getByRole('button', { name: 'Freeze Columns up to Here' }).click();
  await expect(th('customer')).toHaveClass(/is-frozen-end/);
  await th('paid').click({ button: 'right' });
  await fv(win).locator('.csv-colmenu').getByRole('button', { name: 'Hide Column' }).click();
  await expect(th('paid')).toHaveCount(0);
  await expect(fv(win).locator('.csv-tools .json-tool-btn', { hasText: 'Columns' })).toHaveText('Columns 7/8');
  await th('country').click({ button: 'right' });
  await fv(win).locator('.csv-colmenu').getByRole('button', { name: /Copy Column/ }).click();
  await expect.poll(() => copied(log).at(-1)).toBe('DE\nDE\nDE\nES\nES\nES\nFR\nFR\nFR\nIT\nIT\nIT\nIT\nIT');
  await shot(win, '04-table-frozen.png');
  // Column summaries: a histogram for numbers and dates, proportions for categories.
  await fv(win).getByRole('button', { name: 'Column summaries' }).click();
  await expect(table.locator('th .csv-summary')).toHaveCount(7);
  await expect(th('total_eur').locator('.csv-bins i')).toHaveCount(12);
  await expect(th('status').locator('.csv-sum-text')).toHaveText('delivered 6 · shipped 4 · +3');
  await shot(win, '04b-table-summaries.png');
  await fv(win).getByRole('button', { name: 'Column summaries' }).click();
  await expect(table.locator('th .csv-summary')).toHaveCount(0);
});

test('Selection: a range with its totals, ⌘C as TSV, Copy As Markdown, the cell menu filters; Split follows both ways', async () => {
  const { app, log } = shared!;
  const win = await app.firstWindow();
  await open(win, 'exports', 'orders-select.csv');
  await sw(win, 'Table').click();
  await cell(win, 3, 5).click();
  await expect(addr(win)).toHaveText('F3');
  await expect(fv(win).locator('.foot-json').first()).toHaveText('Row 3 · line 4 · column F');
  await cell(win, 9, 6).click({ modifiers: ['Shift'] });
  await expect(addr(win)).toHaveText('F3:G9');
  await expect(fv(win).locator('.csv-crumb .json-type')).toHaveText('7 rows × 2 columns · lines 4–10');
  await expect(fv(win).locator('.foot-csv-totals')).toHaveText('items Σ 36 · avg 5,14 · min 1 · max 10total_eur Σ 3 711,25 · avg 530,18 · min 49 · max 1 102,75');
  await win.keyboard.press('Meta+c');
  await expect.poll(() => copied(log).at(-1)).toBe('5\t612,90\n1\t49,00\n2\t130,00\n8\t948,40\n4\t356,20\n6\t512,00\n10\t1102,75');
  // Copy As › Markdown Table, with the header.
  await cell(win, 6, 6).click({ button: 'right' });
  await win.getByRole('menuitem').filter({ hasText: /^Copy As/ }).first().hover();
  await shot(win, '05-table-copy-as.png');
  await win.getByRole('menuitem').filter({ hasText: 'Markdown Table' }).click();
  await expect.poll(() => copied(log).at(-1)).toMatch(/^\| items \| total_eur \|\n\| *-+: *\| *-+: *\|\n\| +5 \| +612,90 \|/);
  // Exclude a value from the cell menu: a chip.
  await cell(win, 1, 4).click({ button: 'right' });
  await win.getByRole('menuitem').filter({ hasText: 'Exclude delivered' }).click();
  await expect(fv(win).locator('.csv-fchip')).toHaveText('status ≠ delivered');
  await fv(win).locator('.csv-link', { hasText: 'Clear filters' }).click();

  // Split: a cell picked in the table puts the cursor on its field; the cursor selects the cell.
  await sw(win, 'Split').click();
  await expect(fv(win).locator('.file-body')).toBeVisible();
  await cell(win, 6, 6).click();
  await expect.poll(() => win.evaluate(() => (document.querySelector('.file-view:not([style*="none"]) .cm-activeLine') as HTMLElement | null)?.textContent)).toContain('A-10236');
  await fv(win).locator('.cm-csv-c2', { hasText: 'Ceramiche Sole' }).click();
  await expect(fv(win).locator('.csv-table td.is-focus')).toHaveText('Ceramiche Sole');
  await expect(addr(win)).toHaveText('C13');
  // A range made in Split stays a range (the cursor's echo doesn't collapse it).
  await cell(win, 3, 5).click();
  await cell(win, 5, 6).click({ modifiers: ['Shift'] });
  await expect(addr(win)).toHaveText('F3:G5');
  await win.waitForTimeout(400);
  await expect(addr(win)).toHaveText('F3:G5');
  await expect(fv(win).locator('.csv-table td.is-in')).toHaveCount(6);
  await shot(win, '06-split.png');
});

test('Rows that don\'t match: Skip lines fixes the header, the band, F8, Only these rows, the problem count', async () => {
  const { app } = shared!;
  const win = await app.firstWindow();
  await open(win, 'exports', 'visits.csv');
  await sw(win, 'Table').click();
  // The title line is read as the header: one column, every row "too long".
  await fv(win).locator('.csv-pchip').click();
  const opts = fv(win).locator('.csv-options');
  await expect(opts).toBeVisible();
  await opts.getByRole('button', { name: 'More' }).click();
  await expect(fv(win).locator('.csv-table th .csv-name')).toHaveText(['region', 'city', 'visits', 'no header']);
  // The chip closes what it opened.
  await fv(win).locator('.csv-pchip').click();
  await expect(opts).toHaveCount(0);
  await fv(win).locator('.csv-pchip').click();
  await expect(opts).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(opts).toHaveCount(0);
  await expect(fv(win).locator('.csv-band')).toContainText("2 rows don't match the header (3 fields)");
  await expect(fv(win).locator('.csv-band .json-band-at')).toHaveText('row 3 · 4 fields   row 5 · 2 fields');
  await expect(fv(win).locator('.foot-problems')).toHaveText('2 problems');
  await expect(cell(win, 5, 2).locator('.csv-missing')).toHaveText('missing');
  await fv(win).locator('.csv-table-wrap').focus();
  await win.keyboard.press('F8');
  await expect(addr(win)).toHaveText('A3');
  await expect(addr(win)).toHaveClass(/is-bad/);
  await win.keyboard.press('F8');
  await expect(addr(win)).toHaveText('A5');
  await fv(win).locator('.csv-band').getByRole('button', { name: 'Only these rows' }).click();
  await expect(fv(win).locator('.csv-table tbody td.csv-rn')).toHaveText(['3', '5']);
  await shot(win, '07-problems.png');
  // The source marks those lines.
  await sw(win, 'Source').click();
  await expect(fv(win).locator('.cm-line.cm-csv-bad')).toHaveCount(2);
  await expect(fv(win).locator('.cm-line.cm-csv-skip')).toHaveCount(1);
});

test('A large file: virtualized rows, the parsed chip, Go to Row (⌃G) with a cell address, the cell peek with JSON', async () => {
  const { app, log } = shared!;
  const win = await app.firstWindow();
  await open(win, 'logs', 'requests.csv');
  await sw(win, 'Table').click();
  await expect(fv(win).locator('.json-stat')).toContainText('25 000 rows · 8 columns · parsed in');
  expect(await fv(win).locator('.csv-table tbody tr:not(.csv-spacer)').count()).toBeLessThan(80);
  await expect(fv(win).locator('.csv-table th', { hasText: 'payload' }).locator('.csv-type')).toHaveText('JSON');
  await cell(win, 1, 0).click();
  await win.keyboard.press('Control+g');
  const go = fv(win).locator('.csv-goto input');
  await expect(go).toBeFocused();
  await go.fill('H20000');
  await go.press('Enter');
  await expect(addr(win)).toHaveText('H20000');
  await expect(fv(win).locator('.csv-table td.is-focus .csv-chip')).toHaveText('{5}');
  await win.keyboard.press('Space');
  const peek = fv(win).locator('.csv-peek');
  await expect(peek).toBeVisible();
  await expect(peek.locator('.csv-peek-meta')).toHaveText('payload · JSON object · 5 entries');
  await expect(peek.locator('.csv-peek-body')).toContainText('"region": "eu-south-1"');
  // The cell stays in view above the peek.
  await expect(fv(win).locator('.csv-table td.is-focus')).toBeInViewport();
  await shot(win, '08-large-peek.png');
  await peek.getByRole('button', { name: /Copy Value/ }).click();
  await expect.poll(() => copied(log).at(-1)).toContain('"n":19999');
  await win.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
  // ⌘↓ goes to the last row.
  await fv(win).locator('.csv-table-wrap').focus();
  await win.keyboard.press('Meta+ArrowDown');
  await expect(addr(win)).toHaveText('H25000');
  // Scrolled to the end, a filter that leaves a few rows shows them (no empty grid).
  await fv(win).locator('.csv-tools .json-field input').fill('u_0');
  await expect(fv(win).locator('.csv-tools .json-meta')).toHaveText('1 of 25 000 rows');
  await expect(fv(win).locator('.csv-table tbody td.csv-rn')).toHaveText(['1']);
  await expect(fv(win).locator('.csv-table tbody td.csv-rn').first()).toBeInViewport();
});

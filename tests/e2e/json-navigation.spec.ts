// JSON navigation: folding and the path in Source, the Tree, Split with invalid
// JSON, the table of an array of objects, a large file in chunks.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look, shotsOn } from './shots';

const SHOTS = resolve('e2e-shots/json-navigation');

const APP = {
  name: 'orbit-api',
  version: '2.4.0',
  private: true,
  server: { host: '0.0.0.0', port: 8080, cors: { origins: ['https://app.orbit.dev', 'http://localhost:5173'], credentials: true } },
  database: { url: 'postgres://orbit@db:5432/orbit', pool: { min: 2, max: 20, idleMs: 30000 }, replicas: null },
  cache: { driver: 'redis', url: 'redis://cache:6379/0', ttl: 3600 },
  features: [
    { id: 'billing-v2', enabled: true, rollout: 0.25 },
    { id: 'search-redis', enabled: false, rollout: 0 },
    { id: 'new-onboarding', enabled: true, rollout: 1 }
  ],
  workers: ['mailer', 'indexer', 'thumbnails', 'webhooks'],
  logLevel: 'info'
};

const REGIONS = [
  ['eu-south-1', 'Milan', 18, true, ['primary', 'gdpr'], { rps: 900, burst: 1800 }],
  ['eu-central-1', 'Frankfurt', 24, true, ['gdpr'], { rps: 1200, burst: 2400 }],
  ['eu-west-3', 'Paris', 29, true, ['gdpr', 'edge'], { rps: 600, burst: 1200 }],
  ['eu-west-2', 'London', 33, true, ['edge'], { rps: 800, burst: 1600 }],
  ['eu-north-1', 'Stockholm', 41, false, ['standby'], null],
  ['us-east-1', 'N. Virginia', 96, true, ['primary'], { rps: 2000, burst: 4000 }],
  ['us-east-2', 'Ohio', 104, true, ['edge'], { rps: 700, burst: 1400 }],
  ['us-west-2', 'Oregon', 151, true, ['edge', 'ml'], { rps: 900, burst: 1800 }],
  ['ap-northeast-1', 'Tokyo', 228, true, ['edge'], { rps: 500, burst: 1000 }],
  ['ap-southeast-2', 'Sydney', 287, false, ['standby'], { rps: 300, burst: 600 }]
].map(([code, name, latencyMs, active, tags, limits]) => ({ code, name, latencyMs, active, tags, ...(limits ? { limits } : {}) }));

function lockfile(): string {
  const packages: Record<string, unknown> = { '': { name: 'orbit-api', version: '2.4.0', dependencies: { react: '^18.3.1' } } };
  for (let i = 0; i < 9000; i++) {
    packages[`node_modules/pkg-${String(i).padStart(4, '0')}`] = {
      version: '1.2.3', resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.2.3.tgz`, integrity: `sha512-${'x'.repeat(80)}`, dev: i % 2 === 0, license: 'MIT'
    };
  }
  return JSON.stringify({ name: 'orbit-api', version: '2.4.0', lockfileVersion: 3, requires: true, packages }, null, 2);
}

async function launch(): Promise<{ app: ElectronApplication; home: string; log: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  mkdirSync(join(project, 'config'));
  mkdirSync(join(project, 'fixtures'));
  writeFileSync(join(project, 'config', 'app.json'), JSON.stringify(APP, null, 2) + '\n');
  writeFileSync(join(project, 'fixtures', 'regions.json'), JSON.stringify(REGIONS, null, 2) + '\n');
  writeFileSync(join(project, 'package-lock.json'), lockfile() + '\n');
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

async function open(win: Page, folder: string | null, name: string) {
  const file = win.locator('.tree-row', { hasText: name }).first();
  if (!(await file.isVisible())) {
    if (!(await win.locator('.tree-row').first().isVisible())) await win.getByRole('button', { name: /Files/ }).click();
    if (folder) await win.locator('.tree-row', { hasText: folder }).first().click();
  }
  await file.dblclick();
  await expect(win.locator('.file-view:visible .json-switch')).toBeVisible();
}

const fv = (win: Page) => win.locator('.file-view:visible');
const sw = (win: Page, name: string) => fv(win).locator('.json-switch').getByRole('radio', { name });
const copied = (log: string) => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string); } catch { return []; } };
const segs = (win: Page) => fv(win).locator('.json-path .json-seg');
/** A click on a line of the editor (the cursor lands at its end, whatever Shiki's spans). */
const line = (win: Page, text: string) => fv(win).locator('.cm-line', { hasText: text }).first().click();
/** The cursor at the end of line n, by keyboard (no click racing a scroll). */
async function goLine(win: Page, n: number) {
  await fv(win).locator('.cm-content').focus();
  await win.keyboard.press('Meta+ArrowUp');
  for (let k = 1; k < n; k++) await win.keyboard.press('ArrowDown');
  await win.keyboard.press('End');
}
const shot = async (win: Page, name: string) => { if (shotsOn()) mkdirSync(SHOTS, { recursive: true }); await look(win, join(SHOTS, name)); };

// One app for the whole file: each test opens its own file (Source, Tree and Split share app.json in this order, Split
// setting its view itself); a failure skips the rest.
test.describe.configure({ mode: 'serial' });
let app: ElectronApplication;
let home: string;
let log: string;
let win: Page;
test.beforeAll(async () => {
  ({ app, home, log } = await launch());
  win = await app.firstWindow();
});
test.afterAll(async () => { await stop(app, home); });

test('Source: fold chevrons, the "3 keys" pill, fold all / unfold all and keys; the path under the cursor, its type and Copy Path', async () => {
  await open(win, 'config', 'app.json');
  await expect(sw(win, 'Source')).toHaveAttribute('aria-checked', 'true');
  await expect(sw(win, 'Tree')).toBeVisible();
  const content = fv(win).locator('.cm-content');
  // The fold column: a chevron on every line that opens a block closed later.
  await expect.poll(() => fv(win).locator('.cm-json-chev').count()).toBeGreaterThan(5);
  // The path under the cursor, with its type.
  await line(win, '"port": 8080');
  await expect(segs(win)).toHaveText(['server', 'port']);
  await expect(fv(win).locator('.json-type')).toHaveText('number');
  await line(win, '"http://localhost:5173"');
  await expect(segs(win)).toHaveText(['server', 'cors', 'origins', '[1]']);
  await expect(fv(win).locator('.json-type')).toHaveText('string · 21 chars');
  await fv(win).locator('.json-copy').click();
  await expect(fv(win).locator('.json-copied')).toHaveText('Copied .server.cors.origins[1]');
  expect(copied(log).at(-1)).toBe('.server.cors.origins[1]');
  await shot(win, '01-source-path.png');
  // A segment moves the cursor to that value.
  await segs(win).filter({ hasText: 'cors' }).click();
  await expect(segs(win)).toHaveText(['server', 'cors']);
  await expect(fv(win).locator('.json-type')).toHaveText('object · 2 keys');

  // ⌥⌘[ folds the block at the cursor, the pill says what it hides, a click on it unfolds.
  await line(win, '"database"');
  await win.keyboard.press('Meta+Alt+BracketLeft');
  const pill = fv(win).locator('.cm-json-fold-ph');
  await expect(pill).toHaveText('3 keys');
  await expect(fv(win).locator('.cm-json-chev.is-folded')).toHaveCount(1);
  await pill.click();
  await expect(pill).toHaveCount(0);
  // A chevron in the column folds its line.
  const gutter = await fv(win).locator('.cm-json-gutter').boundingBox();
  const serverLine = await fv(win).locator('.cm-line', { hasText: '"server"' }).boundingBox();
  await win.mouse.click(gutter!.x + gutter!.width / 2, serverLine!.y + serverLine!.height / 2);
  await expect(pill).toHaveText('3 keys');
  // Fold all: the root's children (five blocks), not the root; unfold all.
  await fv(win).getByRole('button', { name: 'Fold all', exact: true }).click();
  await expect(pill).toHaveCount(5);
  await expect(pill).toHaveText(['3 keys', '3 keys', '3 keys', '3 items', '4 items']);
  await shot(win, '02-source-folded.png');
  await fv(win).getByRole('button', { name: 'Unfold all' }).click();
  await expect(pill).toHaveCount(0);
  // ⌃⌥[ / ⌃⌥] too.
  await content.click();
  await win.keyboard.press('Control+Alt+BracketLeft');
  await expect(pill).toHaveCount(5);
  await win.keyboard.press('Control+Alt+BracketRight');
  await expect(pill).toHaveCount(0);
  // ⌥⇧⌘C copies the path at the cursor.
  await line(win, '"idleMs"');
  await win.keyboard.press('Meta+Alt+Shift+KeyC');
  await expect.poll(() => copied(log).at(-1)).toBe('.database.pool.idleMs');
});

test('Tree: ⇧⌘V, rows with chips and previews, the filter, the keyboard, the row actions, the context menu, Show in Source', async () => {
  await open(win, 'config', 'app.json');
  await menu(app, 'CmdOrCtrl+Shift+V');
  await expect(sw(win, 'Tree')).toHaveAttribute('aria-checked', 'true');
  const tree = fv(win).locator('.json-tree');
  await expect(tree).toBeVisible();
  await expect(fv(win).locator('.file-body')).toBeHidden();
  const row = (text: string) => tree.locator('.jt-row', { has: win.locator('.jt-key', { hasText: new RegExp(`^${text}$`) }) }).first();
  // A small file opens two levels: server and its cors are open, origins is closed with a preview.
  await expect(row('host')).toBeVisible();
  await expect(row('origins').locator('.jt-chip')).toHaveText('[2]');
  await expect(row('origins').locator('.jt-pv')).toHaveText('"https://app.orbit.dev", "http://localhost:5173"');
  await expect(row('port').locator('.jt-v-number')).toHaveText('8080');
  await expect(row('port').locator('.jt-lno')).toHaveText('L7');
  await expect(fv(win).locator('.foot-json')).toHaveText(/^55 lines · 42 nodes · 0\.9 KB$/);

  // Filter: matches on keys and values, highlighted; the ancestors open.
  const filter = fv(win).locator('.json-field input');
  await filter.fill('redis');
  await expect(fv(win).locator('.json-count')).toHaveText('3 matches');
  await expect(tree.locator('.jt-hit')).toHaveCount(3);
  await expect(row('cache')).toHaveClass(/is-miss/);
  await shot(win, '03-tree-filter.png');
  await filter.press('Escape');
  await expect(fv(win).locator('.json-count')).toHaveCount(0);

  // Keyboard: select, move, collapse and expand, copy the value.
  await row('version').click();
  await expect(tree.locator('.jt-row.is-sel')).toContainText('version');
  await win.keyboard.press('ArrowDown');
  await expect(tree.locator('.jt-row.is-sel')).toContainText('private');
  await win.keyboard.press('Meta+c');
  await expect.poll(() => copied(log).at(-1)).toBe('true');
  await row('server').click();
  await win.keyboard.press('ArrowLeft');
  await expect(row('host')).toHaveCount(0);
  await win.keyboard.press('ArrowRight');
  await expect(row('host')).toBeVisible();
  // The file bar follows the selection; the row's actions.
  await row('cors').click();
  await expect(segs(win)).toHaveText(['server', 'cors']);
  await expect(fv(win).locator('.json-type')).toHaveText('object · 2 keys');
  await row('cors').getByRole('button', { name: 'Copy path' }).click();
  await expect(fv(win).locator('.json-copied')).toHaveText('Copied .server.cors');
  await row('cors').getByRole('button', { name: 'Copy value' }).click();
  await expect.poll(() => copied(log).at(-1)).toBe('{\n  "origins": [\n    "https://app.orbit.dev",\n    "http://localhost:5173"\n  ],\n  "credentials": true\n}');
  await shot(win, '04-tree.png');

  // The context menu: Copy Path As in three formats.
  await row('pool').click({ button: 'right' });
  const menuEl = win.locator('.ctx-menu').first();
  await expect(menuEl.getByRole('menuitem', { name: 'Copy Value as JSON' })).toBeVisible();
  await menuEl.getByRole('menuitem', { name: 'Copy Path As' }).hover();
  const sub = win.locator('.ctx-submenu');
  await expect(sub.locator('.ctx-detail')).toHaveText(['.database.pool', 'data.database.pool', '/database/pool']);
  await shot(win, '05-tree-menu.png');
  await sub.getByRole('menuitem', { name: /JSON Pointer/ }).click();
  await expect.poll(() => copied(log).at(-1)).toBe('/database/pool');

  // ⌥⏎: Show in Source, the cursor on the value.
  await row('pool').click();
  await win.keyboard.press('Alt+Enter');
  await expect(sw(win, 'Source')).toHaveAttribute('aria-checked', 'true');
  await expect(segs(win)).toHaveText(['database', 'pool']);
  // The view is remembered.
  await sw(win, 'Tree').click();
  await win.keyboard.press('Meta+w');
  await open(win, 'config', 'app.json');
  await expect(fv(win).locator('.json-tree')).toBeVisible();
});

test('Split: the tree follows the cursor and the cursor follows the tree; invalid JSON: band, wave, card, quick fix', async () => {
  await open(win, 'config', 'app.json');
  await sw(win, 'Split').click();
  const tree = fv(win).locator('.json-tree');
  await expect(tree).toBeVisible();
  await expect(fv(win).locator('.file-body')).toBeVisible();
  await expect(fv(win).locator('.json-tools')).toHaveCount(0);
  const content = fv(win).locator('.cm-content');
  await line(win, '"idleMs": 30000');
  await expect(tree.locator('.jt-row.is-sel')).toContainText('idleMs');
  await expect(fv(win).getByRole('switch', { name: 'Tree follows the cursor' })).toHaveAttribute('aria-checked', 'true');
  // A row moves the editor's cursor.
  await tree.locator('.jt-row', { hasText: 'logLevel' }).click();
  await expect(fv(win).locator('.cm-activeLine')).toContainText('"logLevel"');

  // A trailing comma: the rose band over the last valid tree, the wave, the dot, the card with its fix.
  await goLine(win, 11);
  await win.keyboard.type(',');
  const band = fv(win).locator('.json-band');
  await expect(band).toContainText('Not valid JSON');
  await expect(band).toContainText('11:32');
  await expect(tree).toHaveClass(/is-stale/);
  await expect(fv(win).locator('.foot-problems')).toHaveText('1 problem');
  await expect(fv(win).locator('.cm-json-error')).toHaveText(',');
  await expect(fv(win).locator('.cm-json-errdot')).toHaveCount(1);
  const card = fv(win).locator('.cm-json-card');
  await expect(card).toContainText('trailing comma before ] (line 11, column 32)');
  await shot(win, '06-split-invalid.png');
  await card.getByRole('button', { name: 'Remove the comma' }).click();
  await expect(band).toHaveCount(0);
  await expect(fv(win).locator('.foot-problems')).toHaveCount(0);
  // While invalid, the tree is the last valid text: its rows still land on the right line of the edited text.
  await goLine(win, 1);
  await win.keyboard.type('\n  "added": ');
  await expect(band).toBeVisible();
  await tree.locator('.jt-row', { hasText: 'logLevel' }).click();
  await expect(fv(win).locator('.cm-activeLine')).toContainText('"logLevel"');
  await goLine(win, 2);
  await win.keyboard.press('Meta+Shift+KeyK');
  await expect(band).toHaveCount(0);
  // Go to error from the band.
  await goLine(win, 13);
  await win.keyboard.type(' x');
  await expect(band).toBeVisible();
  await band.getByRole('button', { name: 'Go to error' }).click();
  await expect(card).toContainText('unexpected x');
});

test('Table: an array of objects with typed, sortable columns, bars, chips that open the tree', async () => {
  await open(win, 'fixtures', 'regions.json');
  await sw(win, 'Tree').click();
  const layout = fv(win).locator('.json-tools .seg');
  await layout.getByRole('radio', { name: 'Table' }).click();
  const table = fv(win).locator('.json-table');
  await expect(table).toBeVisible();
  await expect(table.locator('thead .jtab-sort')).toHaveText(['code', 'name', 'latencyMs', 'active', 'tags', 'limits']);
  await expect(table.locator('thead .jtab-type').last()).toHaveText('object · 9/10');
  await expect(fv(win).locator('.json-meta')).toHaveText('10 rows · 6 columns');
  await expect(table.locator('.jtab-bar')).toHaveCount(10);
  await table.getByRole('button', { name: 'latencyMs' }).click();
  await table.getByRole('button', { name: 'latencyMs' }).click();
  await expect(fv(win).locator('.json-meta')).toHaveText('10 rows · 6 columns · sorted by latencyMs');
  await expect(table.locator('tbody tr').first()).toContainText('ap-southeast-2');
  await table.locator('tbody tr', { hasText: 'Paris' }).click();
  await expect(fv(win).locator('.foot-json')).toHaveText('Row 3 · line 29');
  await shot(win, '07-table.png');
  // A chip opens that value in the tree.
  await table.locator('tbody tr', { hasText: 'Milan' }).locator('.jtab-chip').last().click();
  await expect(fv(win).locator('.json-tree .jt-row.is-sel')).toContainText('limits');
  await expect(segs(win)).toHaveText(['[0]', 'limits']);
});

test('a 2 MB lockfile: the tree in chunks of 100, virtualized rows, the parse chip', async () => {
  await open(win, null, 'package-lock.json');
  await sw(win, 'Tree').click();
  const tree = fv(win).locator('.json-tree');
  await expect(fv(win).locator('.json-stat')).toContainText(/MB · .* nodes · parsed in \d+ ms/);
  const packages = tree.locator('.jt-row', { hasText: 'packages' }).first();
  await expect(packages.locator('.jt-chip')).toHaveText('{9 001}');
  await packages.locator('.jt-chev').click();
  await expect(tree.locator('.jt-range').first()).toHaveText('0 … 99');
  // 91 chunks, only those on screen in the DOM; the last one at the bottom.
  await expect.poll(() => tree.locator('.jt-range').count()).toBeLessThan(91);
  await tree.locator('.jt-row', { hasText: '100 … 199' }).locator('.jt-chev').click();
  await expect(tree.locator('.jt-row', { hasText: 'node_modules/pkg-0099' })).toHaveCount(1);
  await tree.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(tree.locator('.jt-range').last()).toHaveText('9 000 … 9 000');
  await tree.evaluate((el) => { el.scrollTop = 0; });
  // Expand everything: still only the rows on screen in the DOM.
  await fv(win).getByRole('button', { name: 'Expand all' }).click();
  await expect.poll(() => tree.locator('.jt-row').count()).toBeLessThan(150);
  await shot(win, '08-large.png');
});

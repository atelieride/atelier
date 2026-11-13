// Find in Files in an app started with two test-only settings (devEnv, inert in the packaged app):
// - the size limit lowered to 1 KB (ATELIER_TEST_SEARCH_MAX_BYTES): a 2 KB file is not searched, and says so —
//   "· 1 file not searched" in the summary, the file with its reason and size in the list it opens, Reveal in Files
//   showing it in the tree;
// - every file read held back (ATELIER_TEST_FILE_READ_DELAY_MS): a result's file still loading when the palette or a
//   menu opens leaves the keyboard to them once it shows; with nothing opened meanwhile, its editor takes it, and so
//   does a file opened from the palette, or one opened while a panel stays open beside the work.
// A last test starts an app of its own with the result cap, the file cap and the watchdog lowered
// (ATELIER_TEST_SEARCH_MAX_RESULTS, ATELIER_TEST_SEARCH_MAX_FILES, ATELIER_TEST_SEARCH_WATCHDOG_MS): each way a search
// ends short says so below its results.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { e2eEnv } from './env';
import { layoutProblems, NO_PROBLEMS } from './layout';
import { look } from './shots';

let app: ElectronApplication;
let win: Page;
let home: string;
let project: string;

const view = () => win.locator('.sidebar.is-search');
const field = () => view().getByRole('textbox', { name: 'Search files' });
const totals = () => view().locator('.fif-summary .fif-totals');
const matchRow = (rel: string) => view().locator(`.fif-row.is-match[data-rel="${rel}"]`).first();
const fileView = (rel: string) => win.locator(`section.file-view[aria-label="${rel}"]`);

test.beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(project, rel)), { recursive: true });
    writeFileSync(join(project, rel), body);
  };
  write('src/birds.ts', "export const heron = 'grey';\n");
  // 2 KB (2,048 bytes), the word in it: over the limit, so never read.
  write('data/birds.json', `{ "heron": "${'h'.repeat(2048 - 16)}" }\n`);
  for (const name of ['nests', 'ponds', 'reeds']) write(`src/${name}.ts`, `// ${name}\nexport const egret = '${name}';\n`);
  write('notes/marsh.md', 'marsh\n');
  const e = e2eEnv({ ATELIER_TEST_SEARCH_MAX_BYTES: '1024', ATELIER_TEST_FILE_READ_DELAY_MS: '600' });
  home = e.home;
  app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env: e.env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
  await win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
});

test.beforeEach(async () => {
  if (!(await view().isVisible())) await win.locator('.activity-bar .act[aria-label^="Find in Files"]').click();
});

test.afterAll(async () => {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
});

test('a file past the size limit is listed as not searched, with its reason and size; Reveal in Files shows it in the tree', async () => {
  await field().fill('heron');
  await expect(totals()).toHaveText('1 result in 1 file');
  await expect(view().locator('.fif-row.is-file')).toHaveAttribute('data-rel', 'src/birds.ts');
  const link = view().locator('.fif-skipped-link');
  await expect(link).toHaveText('1 file not searched');

  await link.click();
  const pop = view().locator('.fif-skipped');
  await expect(pop.locator('.fif-skipped-rel')).toHaveText(['data/birds.json']);
  await expect(pop.locator('.fif-skipped-why')).toHaveText(/^Too large to search \(over [\d.]+ [KM]?B\) · 2 KB$/);
  // Wrapped or not, the row's parts stay apart and whole, and the size keeps its dot on its line.
  expect(await layoutProblems(pop.locator('.fif-skipped-row'), ['.file-icon', '.fif-skipped-rel', '.fif-skipped-why', '.icon-btn'])).toEqual(NO_PROBLEMS);
  expect(await pop.locator('.fif-skipped-size').evaluate((el) => new Set([...el.getClientRects()].map((r) => Math.round(r.top))).size)).toBe(1);
  await win.mouse.move(640, 790);
  await look(view(), 'test-results/find-in-files-too-large.png', { settle: 200 });

  // Reveal in Files: the Files tree, its folder opened, the file shown.
  await pop.getByRole('button', { name: 'Reveal in Files: data/birds.json' }).click();
  await expect(pop).toHaveCount(0);
  const row = win.locator(`.tree [data-path="${join(project, 'data/birds.json')}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/is-flash/);
});

test('a result whose file is still loading leaves the keyboard to the palette or a menu opened meanwhile; left alone, its editor takes it', async () => {
  await field().fill('egret');
  await expect(totals()).toHaveText('3 results in 3 files');
  // The palette opened right after the click, the file's text still on its way: once the result shows (its text there,
  // the match selected and marked), the palette still has the keyboard.
  await matchRow('src/nests.ts').click();
  await win.keyboard.press('F1');
  const input = win.locator('.palette-input');
  await expect(input).toBeFocused();
  await expect(fileView('src/nests.ts').locator('.cm-fif-hit-strong')).toHaveText('egret');
  await expect(input).toBeFocused();
  await expect(fileView('src/nests.ts').locator('.cm-content')).not.toBeFocused();
  await win.keyboard.press('Escape');
  await expect(input).toHaveCount(0);

  // A row's menu opened meanwhile: the same.
  await matchRow('src/ponds.ts').click();
  await matchRow('src/ponds.ts').click({ button: 'right' });
  const menu = win.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  await expect(fileView('src/ponds.ts').locator('.cm-fif-hit-strong')).toHaveText('egret');
  await expect(menu).toBeVisible();
  await expect(fileView('src/ponds.ts').locator('.cm-content')).not.toBeFocused();
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Nothing opened meanwhile: the row keeps the keyboard while the text loads, then the editor takes it.
  await matchRow('src/reeds.ts').click();
  await expect(matchRow('src/reeds.ts')).toBeFocused();
  await expect(fileView('src/reeds.ts').locator('.cm-fif-hit-strong')).toHaveText('egret');
  await expect(fileView('src/reeds.ts').locator('.cm-content')).toBeFocused();
});

test('a file opened from the palette takes the keyboard once its text comes, the palette long closed', async () => {
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill('birds.ts');
  await win.locator('.palette-item', { hasText: 'birds.ts' }).first().click();
  await expect(win.locator('.palette-input')).toHaveCount(0);
  await expect(fileView('src/birds.ts').locator('.cm-content')).toContainText('heron');
  await expect(fileView('src/birds.ts').locator('.cm-content')).toBeFocused();
  // Typing goes to it.
  await win.keyboard.press('Meta+ArrowDown');
  await win.keyboard.type('// typed');
  await expect(fileView('src/birds.ts').locator('.cm-content')).toContainText('// typed');
  await win.keyboard.press('Meta+z');
  await expect(win.locator('.tab .tab-dirty')).toHaveCount(0);
});

test('a panel left open beside the work (a file\'s compare view, in a tab behind) does not keep a result\'s file from the keyboard', async () => {
  // A file with unsaved edits, changed on disk: its compare view open (a dialog, not modal), the keyboard in it.
  await field().fill('marsh');
  await matchRow('notes/marsh.md').click();
  const marsh = fileView('notes/marsh.md').locator('.cm-content');
  await expect(marsh).toBeFocused();
  await win.keyboard.press('Meta+ArrowDown');
  await win.keyboard.type(' mine');
  await expect(win.locator('.tab .tab-dirty')).toHaveCount(1);
  writeFileSync(join(project, 'notes/marsh.md'), 'marsh, changed on disk\n');
  const band = fileView('notes/marsh.md').locator('.conflict-band');
  await expect(band).toBeVisible({ timeout: 10000 });
  await band.getByRole('button', { name: 'Compare' }).click();
  await expect(win.locator('.compare-layer')).toBeVisible();

  // A result of another file, its text still on its way: once it shows, its editor takes the keyboard.
  await field().fill('egret');
  await expect(totals()).toHaveText('3 results in 3 files');
  await matchRow('src/ponds.ts').click({ position: { x: 40, y: 8 } });
  await expect(fileView('src/ponds.ts').locator('.cm-fif-hit-strong')).toHaveText('egret');
  await expect(fileView('src/ponds.ts').locator('.cm-content')).toBeFocused();
  await expect(win.locator('.compare-layer')).toHaveCount(1);

  // The marsh file back to the disk's text: nothing left unsaved.
  await win.locator('.tab', { hasText: 'marsh.md' }).click();
  await win.locator('.compare-layer').getByRole('button', { name: 'Close' }).click();
  await band.getByRole('button', { name: 'Reload' }).click();
  await expect(win.locator('.tab .tab-dirty')).toHaveCount(0);
});

// An app of its own, with its limits lowered (test-only settings): 5 matches and 4 files per search, a watchdog of 3 s.
test('where a search ends short, it says so below the results: the result cap, the file cap, a regular expression stuck on a line, a stop', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  const put = (rel: string, body: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  put('lim/a.txt', 'kite\n'.repeat(3));
  put('lim/b.txt', 'kite\n'.repeat(3));
  for (const n of [1, 2, 3, 4, 5]) put(`cap/c${n}.txt`, 'owl\n');
  // Forty a's and a b: `(a+)+$` backtracks on it for ever.
  put('stuck/z.txt', `${'a'.repeat(40)}b\n`);
  const e = e2eEnv({ ATELIER_TEST_SEARCH_MAX_RESULTS: '5', ATELIER_TEST_SEARCH_MAX_FILES: '4', ATELIER_TEST_SEARCH_WATCHDOG_MS: '3000' });
  const own = await electron.launch({ args: ['out/main/index.js', `--project=${dir}`], env: e.env });
  try {
    const w = await own.firstWindow();
    await own.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await w.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    await w.locator('.activity-bar .act[aria-label^="Find in Files"]').click();
    const v = w.locator('.sidebar.is-search');
    const query = v.getByRole('textbox', { name: 'Search files' });
    const include = v.getByRole('textbox', { name: 'Files to include' });
    const sum = v.locator('.fif-summary .fif-totals');
    const foot = v.locator('.fif-foot');
    await v.getByRole('button', { name: 'Filters' }).click();

    // The result cap: the first 5 matches, "+", and the notice with the number shown.
    await include.fill('lim/');
    await query.fill('kite');
    await expect(sum).toHaveText('5+ results in 2 files');
    await expect(foot.locator('.fif-notice.is-amber')).toHaveText('Showing the first 5 matches. Narrow the search or add a filter to see the rest.');
    await w.mouse.move(640, 790);
    await look(v, 'test-results/find-in-files-result-cap.png', { settle: 200 });

    // The file cap: the first 4 files listed, the amber line.
    await include.fill('cap/');
    await query.fill('owl');
    await expect(sum).toHaveText('4 results in 4 files');
    await expect(foot.locator('.fif-notice.is-amber')).toHaveText('Searched the first 4 files. Add a filter to search the rest.');
    await look(v, 'test-results/find-in-files-file-cap.png', { settle: 200 });

    // A regular expression stuck on one line: the watchdog stops it, the rose notice names the file, with Refresh.
    await include.fill('stuck/');
    await v.getByRole('button', { name: 'Regular Expression', exact: true }).click();
    await query.fill('(a+)+$');
    const error = foot.locator('.fif-notice.is-error');
    await expect(error).toContainText('The search stopped: a regular expression took too long on stuck/z.txt.', { timeout: 10000 });
    await expect(error.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await look(v, 'test-results/find-in-files-error.png', { settle: 200 });

    // The same line among others, stopped while it is stuck: how many files were searched is said (the files are read
    // together, so the stuck one may be matched before the others are counted), and nothing is an error.
    await include.fill('lim/, stuck/');
    const stop = v.getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(foot.locator('.fif-quiet')).toHaveText(/^Stopped · [0-2] of 3 files searched$/, { timeout: 5000 });
    await expect(error).toHaveCount(0);
    await expect(v.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await look(v, 'test-results/find-in-files-stopped.png', { settle: 200 });
  } finally {
    await own.close();
    try { process.kill((JSON.parse(readFileSync(join(e.home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

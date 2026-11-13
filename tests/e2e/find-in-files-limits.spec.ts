// Find in Files in an app started with two test-only settings (devEnv, inert in the packaged app):
// - the size limit lowered to 1 KB (ATELIER_TEST_SEARCH_MAX_BYTES): a 2 KB file is not searched, and says so —
//   "· 1 file not searched" in the summary, the file with its reason and size in the list it opens, Reveal in Files
//   showing it in the tree;
// - every file read held back (ATELIER_TEST_FILE_READ_DELAY_MS): a result's file still loading when the palette or a
//   menu opens leaves the keyboard to them once it shows; with nothing opened meanwhile, its editor takes it.
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

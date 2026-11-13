// Find in Files and its size limit, lowered for the test to 1 KB (ATELIER_TEST_SEARCH_MAX_BYTES, inert in the packaged
// app): a 2 KB file is not searched, and says so — "· 1 file not searched" in the summary, the file with its reason and
// size in the list it opens, Reveal in Files showing it in the tree.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { e2eEnv } from './env';
import { layoutProblems, NO_PROBLEMS } from './layout';
import { look } from './shots';

test('a file past the size limit is listed as not searched, with its reason and size; Reveal in Files shows it in the tree', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(project, rel)), { recursive: true });
    writeFileSync(join(project, rel), body);
  };
  write('src/birds.ts', "export const heron = 'grey';\n");
  // 2 KB (2,048 bytes), the word in it: over the limit, so never read.
  write('data/birds.json', `{ "heron": "${'h'.repeat(2048 - 16)}" }\n`);
  const { env, home } = e2eEnv({ ATELIER_TEST_SEARCH_MAX_BYTES: '1024' });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await win.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    await win.locator('.activity-bar .act[aria-label^="Find in Files"]').click();
    const view = win.locator('.sidebar.is-search');
    await view.getByRole('textbox', { name: 'Search files' }).fill('heron');
    await expect(view.locator('.fif-summary .fif-totals')).toHaveText('1 result in 1 file');
    await expect(view.locator('.fif-row.is-file')).toHaveAttribute('data-rel', 'src/birds.ts');
    const link = view.locator('.fif-skipped-link');
    await expect(link).toHaveText('1 file not searched');

    await link.click();
    const pop = view.locator('.fif-skipped');
    await expect(pop.locator('.fif-skipped-rel')).toHaveText(['data/birds.json']);
    await expect(pop.locator('.fif-skipped-why')).toHaveText(/^Too large to search \(over [\d.]+ [KM]?B\) · 2 KB$/);
    // Wrapped or not, the row's parts stay apart and whole, and the size keeps its dot on its line.
    expect(await layoutProblems(pop.locator('.fif-skipped-row'), ['.file-icon', '.fif-skipped-rel', '.fif-skipped-why', '.icon-btn'])).toEqual(NO_PROBLEMS);
    expect(await pop.locator('.fif-skipped-size').evaluate((el) => new Set([...el.getClientRects()].map((r) => Math.round(r.top))).size)).toBe(1);
    await win.mouse.move(640, 790);
    await look(view, 'test-results/find-in-files-too-large.png', { settle: 200 });

    // Reveal in Files: the Files tree, its folder opened, the file shown.
    await pop.getByRole('button', { name: 'Reveal in Files: data/birds.json' }).click();
    await expect(pop).toHaveCount(0);
    const row = win.locator(`.tree [data-path="${join(project, 'data/birds.json')}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/is-flash/);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

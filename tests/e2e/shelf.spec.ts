import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// The Shelf: a file tab dropped on the Sessions sidebar stays there after its tab is closed.

const activity = (win: Page, name: RegExp) => win.locator('.activity-bar').getByRole('button', { name });

/** Presses on a tab, moves past the drag threshold, then to the middle of `to` (a locator's box, y at `dy` of it). */
async function dragTabTo(win: Page, name: string | Locator, to: () => Promise<{ x: number; y: number; width: number; height: number }>, dy = 0.5) {
  const box = (await (typeof name === 'string' ? win.locator('.tab', { hasText: name }) : name).boundingBox())!;
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 3 });
  await expect(win.locator('.tab-drag-chip')).toHaveCount(1);
  const target = await to();
  await win.mouse.move(target.x + target.width / 2, target.y + target.height * dy, { steps: 6 });
}

/**
 * A row's chip (`Outside`, `Missing`) sits at the row's end, as a terminal's chips do: its X takes no room until the
 * row is hovered, then shows after the chip.
 */
async function expectChipAtEnd(win: Page, row: Locator, chip: string) {
  const box = (await row.boundingBox())!;
  const rowEnd = box.x + box.width;
  const end = async (sel: string) => { const b = (await row.locator(sel).boundingBox())!; return b.x + b.width; };
  await win.mouse.move(rowEnd + 200, box.y + box.height / 2);
  await expect(row.locator('.row-close')).toBeHidden();
  await expect.poll(async () => rowEnd - (await end(chip))).toBeLessThanOrEqual(8);
  await look(row, `test-results/shelf-row-rest${chip.replace('.shelf', '')}.png`);
  await row.hover();
  await expect(row.locator('.row-close')).toBeVisible();
  const close = (await row.locator('.row-close').boundingBox())!;
  expect(await end(chip)).toBeLessThanOrEqual(close.x);
  expect(rowEnd - (close.x + close.width)).toBeLessThanOrEqual(8);
}

test('shelf: a file tab dropped on the sidebar stays after its tab closes; order, menus, missing, collapse, reload', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  mkdirSync(join(project, 'src'));
  for (const n of ['a', 'b']) writeFileSync(join(project, 'src', `${n}.ts`), `export const ${n} = 1;\n`);
  writeFileSync(join(project, 'notes.md'), '# Notes\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const shelf = win.locator('.shelf');
    const rows = () => win.locator('.shelf-row .shelf-name').allTextContents();
    const shelfRow = (name: string) => win.locator('.shelf-row', { has: win.locator('.shelf-name', { hasText: name }) });
    const tab = (name: string) => win.locator('.tab', { hasText: name });
    const treeRow = (name: string) => win.locator('.tree-row', { hasText: name });

    // A terminal (its tab never lands on the shelf; a shelf row dropped on it types the path), and no shelf yet.
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect(win.locator('.xterm-rows:visible')).toBeVisible({ timeout: 10000 });
    await expect(shelf).toHaveCount(0);

    // Two files open as normal tabs, then back to the Sessions view.
    await activity(win, /^Files/).click();
    await win.locator('.tree-row', { hasText: 'src' }).click();
    await treeRow('a.ts').dblclick();
    await treeRow('notes.md').dblclick();
    await expect(tab('a.ts')).toBeVisible();
    await activity(win, /^Sessions/).click();
    await expect(shelf).toHaveCount(0);

    // Dragging a file tab: the empty shelf appears as a slot; over it, it lights up and says what a drop does.
    await dragTabTo(win, 'a.ts', async () => (await shelf.boundingBox())!);
    await expect(shelf).toHaveClass(/is-accepting/);
    await expect(shelf).toHaveClass(/is-over/);
    await expect(shelf.locator('.shelf-slot')).toHaveText('Drop to keep it here');
    await expect(shelf.locator('.shelf-pill')).toHaveText('Add to shelf');
    await look(win, 'test-results/shelf-drop-empty.png');
    await win.mouse.up();
    await expect.poll(rows).toEqual(['a.ts']);
    await expect(shelf).not.toHaveClass(/is-accepting/);
    // The tab stays open (its row says so); notes.md stays in front, so the row is not the selected one.
    await expect(tab('a.ts')).toBeVisible();
    await expect(shelfRow('a.ts')).toHaveClass(/is-open/);
    await expect(shelfRow('a.ts')).not.toHaveClass(/is-selected/);
    // Nor is the terminal's row: a file is in front.
    await expect(win.locator('.term-row.is-selected')).toHaveCount(0);
    // The name alone; the folder is in the tooltip (2026-11-02).
    await expect(shelfRow('a.ts').locator('.shelf-dir')).toHaveCount(0);
    await expect(shelfRow('a.ts').locator('.row-main')).toHaveAttribute('data-tip', 'src/a.ts');

    // A terminal's tab over the shelf: nothing lights up, nothing lands.
    await dragTabTo(win, win.locator('.tab[data-key^="t:"]'), async () => (await shelf.boundingBox())!);
    await expect(shelf).not.toHaveClass(/is-accepting|is-over/);
    await win.mouse.up();
    expect(await rows()).toEqual(['a.ts']);

    // A second file lands before the first one when dropped on its upper half.
    await dragTabTo(win, 'notes.md', async () => (await shelfRow('a.ts').boundingBox())!, 0.25);
    await expect(shelfRow('a.ts')).toHaveClass(/is-caret/);
    await look(win, 'test-results/shelf-drop-before.png');
    await win.mouse.up();
    await expect.poll(rows).toEqual(['notes.md', 'a.ts']);

    // Closing the tabs leaves the rows; a click opens the file again (the preview tab), in front.
    await tab('a.ts').locator('.tab-close').click();
    await tab('notes.md').locator('.tab-close').click();
    await expect(win.locator('.tab[data-key^="f:"]')).toHaveCount(0);
    expect(await rows()).toEqual(['notes.md', 'a.ts']);
    await shelfRow('a.ts').locator('.row-main').click();
    await expect(tab('a.ts')).toHaveClass(/is-preview/);
    await expect(shelfRow('a.ts')).toHaveClass(/is-selected/);

    // The tab's menu takes it off the shelf; the tree's menu puts a file on it.
    await tab('a.ts').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Remove from Shelf' }).click();
    await expect.poll(rows).toEqual(['notes.md']);
    await activity(win, /^Files/).click();
    await treeRow('b.ts').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Add to Shelf' }).click();
    await activity(win, /^Sessions/).click();
    await expect.poll(rows).toEqual(['notes.md', 'b.ts']);

    // A row dragged onto the upper half of another moves before it (the line shows where).
    await shelfRow('b.ts').dragTo(shelfRow('notes.md'), { targetPosition: { x: 40, y: 4 } });
    await expect.poll(rows).toEqual(['b.ts', 'notes.md']);
    await expect(win.locator('.shelf-row.is-caret')).toHaveCount(0);
    // Dropped on the terminal, a row types its path there, as a row of the tree does.
    await win.locator('.term-row .row-main').click();
    await shelfRow('notes.md').dragTo(win.locator('.terminal-slot:visible'));
    await expect(win.locator('.xterm-rows:visible')).toContainText('notes.md', { timeout: 5000 });
    expect(await rows()).toEqual(['b.ts', 'notes.md']);

    // Deleted from a terminal while Atelier keeps the focus (main's watcher): dimmed with "Missing", kept.
    rmSync(join(project, 'src', 'b.ts'));
    await expect(shelfRow('b.ts')).toHaveClass(/is-missing/, { timeout: 10000 });
    await expect(shelfRow('b.ts').locator('.shelf-missing')).toHaveText('Missing');
    await expectChipAtEnd(win, shelfRow('b.ts'), '.shelf-missing');
    await look(win, 'test-results/shelf-rows.png');

    // Collapsed: only the head and its count; remembered after a reload, like the files.
    await shelf.locator('.shelf-toggle').click();
    await expect(shelf.locator('.shelf-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(win.locator('.shelf-row')).toHaveCount(0);
    await expect(shelf.locator('.count')).toHaveText('2');
    await win.reload();
    await expect(win.locator('.shelf .shelf-toggle')).toHaveAttribute('aria-expanded', 'false');
    await win.locator('.shelf .shelf-toggle').click();
    await expect.poll(rows).toEqual(['b.ts', 'notes.md']);

    // From the keyboard: the row's X removes it (the file is not touched) and the focus goes to the row left.
    const focusedRow = () => win.evaluate(() => (document.activeElement?.closest('.shelf-row') as HTMLElement | null)?.dataset.path ?? null);
    await shelfRow('b.ts').locator('.row-main').focus();
    await win.keyboard.press('Tab');
    await expect(shelfRow('b.ts').getByRole('button', { name: 'Remove b.ts from the shelf' })).toBeFocused();
    await win.keyboard.press('Enter');
    await expect.poll(rows).toEqual(['notes.md']);
    await expect.poll(focusedRow).toBe(join(project, 'notes.md'));
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('# Notes\n');
    // Its menu from the keyboard (Shift+F10) removes the last one: the section goes, the focus stays in the sidebar.
    await win.keyboard.press('Shift+F10');
    await win.getByRole('menuitem', { name: 'Remove from Shelf' }).click();
    await expect(shelf).toHaveCount(0);
    await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('.sidebar'))).toBe(true);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('shelf: a file outside the project goes on it too, marked Outside, and still opens after a relaunch', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-')));
  const dump = join(outside, 'dump.sql');
  writeFileSync(dump, 'select 1;\n');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_PICK_FILES: dump });
  const launch = () => electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);
  let app = await launch();
  try {
    let win = await app.firstWindow();
    // The page listens for opened paths once it is up.
    await expect(win.locator('.sidebar')).toBeVisible({ timeout: 15000 });
    await command(app, 'open-file');
    await expect(win.locator('.tab', { hasText: 'dump.sql' })).toHaveClass(/is-active/, { timeout: 10000 });
    await dragTabTo(win, 'dump.sql', async () => (await win.locator('.shelf').boundingBox())!);
    await expect(win.locator('.shelf')).toHaveClass(/is-over/);
    await win.mouse.up();
    const row = win.locator('.shelf-row', { has: win.locator('.shelf-name', { hasText: 'dump.sql' }) });
    await expect(row.locator('.shelf-outside')).toHaveText('Outside');
    await expect(row.locator('.shelf-dir')).toHaveCount(0);
    await expect(row.locator('.row-main')).toHaveAttribute('data-tip', new RegExp(basename(outside)));
    await expectChipAtEnd(win, row, '.shelf-outside');
    await look(win, 'test-results/shelf-outside.png');
    await win.locator('.tab', { hasText: 'dump.sql' }).locator('.tab-close').click();
    // Saved with the tabs (main keeps it granted), then a relaunch: it comes back, not missing, and opens.
    const savedShelf = () => { try { return Object.values((JSON.parse(readFileSync(join(home, 'tabs.json'), 'utf8')) as { projects: Record<string, { tabs: { shelf?: string[] } }> }).projects).map((e) => e.tabs.shelf); } catch { return []; } };
    await expect.poll(savedShelf).toEqual([[dump]]);
    await app.close();

    app = await launch();
    win = await app.firstWindow();
    const again = win.locator('.shelf-row', { has: win.locator('.shelf-name', { hasText: 'dump.sql' }) });
    await expect(again.locator('.shelf-outside')).toBeVisible({ timeout: 15000 });
    await expect(again).not.toHaveClass(/is-missing/);
    await again.locator('.row-main').click();
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('select 1;');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

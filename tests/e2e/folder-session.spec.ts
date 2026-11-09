import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Test repos isolated from the user's git configuration (global hooks, commit signing, ...).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

function workspace(): string {
  // A folder holding two repos and plain folders, like a multi-repo workspace.
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const files: Record<string, string> = {
    'api/src/main.ts': 'x\n', 'api/.gitignore': 'tmp/\n', 'api/tmp/cache.txt': 'c\n',
    'web/app/page.tsx': 'x\n', 'docs/guide/intro.md': '# x\n', 'node_modules/pkg/index.js': 'x\n', 'README.md': '# w\n'
  };
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(project, rel, '..'), { recursive: true }); writeFileSync(join(project, rel), text); }
  for (const repo of ['api', 'web']) { git(join(project, repo), 'init', '-q', '-b', 'main'); git(join(project, repo), 'add', '.'); git(join(project, repo), 'commit', '-q', '-m', 'first'); }
  const outside = mkdtempSync(join(tmpdir(), 'atl-out-'));
  symlinkSync(outside, join(project, 'escape'));
  return project;
}

type Api = { terminals: {
  list(): Promise<{ title: string; cwd: string; session: unknown }[]>;
  create(o: object): Promise<unknown>;
  createSession(o: object): Promise<unknown>;
} };

const labels = (win: Page) => win.locator('.folder-sheet .folder-label').allTextContents();
const created = (win: Page) => win.evaluate(async () => (await (window as unknown as { atelier: Api }).atelier.terminals.list()).map((x) => ({ title: x.title, cwd: x.cwd, session: !!x.session })));

test('new session or terminal in a subfolder: palette, File menu, tree; the sidebar shows where each one runs', async () => {
  const project = workspace();
  const name = project.split('/').at(-1)!;
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();

    // Palette: the command opens the folder sheet; the project root comes first and is selected, then repos, then folders.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>in folder');
    await expect(win.locator('.palette-item', { hasText: 'New terminal in folder…' })).toBeVisible();
    await win.locator('.palette-item', { hasText: 'New session in folder…' }).click();
    const sheet = win.getByRole('dialog', { name: 'New session in folder' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByPlaceholder('Find a folder…')).toBeFocused();
    await expect.poll(() => labels(win), { timeout: 10000 }).toEqual([name, 'api/', 'web/', 'api/src/', 'docs/', 'docs/guide/', 'web/app/']);
    await expect(sheet.locator('.folder-item.is-active .folder-label')).toHaveText(name);
    await look(sheet, 'test-results/folder-sheet-all.png');
    await expect(sheet.locator('.folder-item').first().locator('.folder-hint')).toHaveText('./');
    await expect(sheet.locator('.folder-item', { hasText: 'api/' }).first().locator('.folder-hint')).toHaveText('main');

    // Arrows wrap like the palette.
    await win.keyboard.press('ArrowUp');
    await expect(sheet.locator('.folder-item.is-active .folder-label')).toHaveText('web/app/');
    await win.keyboard.press('ArrowDown');
    await expect(sheet.locator('.folder-item.is-active .folder-label')).toHaveText(name);

    // Fuzzy filter; Tab moves to the name with the folder as a chip.
    await win.keyboard.type('api');
    await expect(sheet.locator('.folder-item.is-active .folder-label')).toHaveText('api/');
    await look(sheet, 'test-results/folder-sheet.png');
    await win.keyboard.press('Tab');
    await expect(sheet.locator('.folder-chip')).toHaveText('api/');
    await expect(sheet.getByPlaceholder('Session name (optional)')).toBeFocused();
    await look(sheet, 'test-results/folder-sheet-name.png');
    // Shift+Tab goes back to the folder, which is kept.
    await win.keyboard.press('Shift+Tab');
    await expect(sheet.getByPlaceholder('Find a folder…')).toBeFocused();
    await expect(sheet.locator('.folder-item.is-active .folder-label')).toHaveText('api/');
    await win.keyboard.press('Enter');
    await win.keyboard.type('Api work');
    await expect(sheet.getByPlaceholder('Session name (optional)')).toHaveValue('Api work');
    await win.keyboard.press('Enter');
    await expect(sheet).toBeHidden();

    // The session runs in that folder (same Claude command), and its row says where.
    const apiRow = win.locator('.session-row', { hasText: 'Api work' });
    await expect(apiRow).toBeVisible({ timeout: 15000 });
    await expect(apiRow.locator('.cwd-chip')).toHaveText('api/');
    await expect(apiRow.locator('.cwd-chip')).toHaveAttribute('data-tip', join(project, 'api'));
    await expect(win.locator('.xterm-rows')).toContainText(/FAKE-CLAUDE cwd=\S*\/api(?=FAKE-CLAUDE waiting)/, { timeout: 10000 });
    expect((await created(win)).find((x) => x.title === 'Api work')?.cwd).toBe(join(project, 'api'));

    // Esc and a click outside close the sheet without creating anything.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>new session in folder');
    await win.keyboard.press('Enter');
    await expect(win.locator('.folder-sheet')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.locator('.folder-sheet')).toBeHidden();

    // Sessions' "+": its drop-down's Session in Folder… opens the same sheet.
    await win.locator('.sidebar-head', { hasText: 'Sessions' }).getByRole('button', { name: 'New session' }).click();
    await win.getByRole('menuitem', { name: /Session in Folder…/ }).click();
    await expect(sheet).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    // File › New Session in Folder…, whose key is ⌘⌥⇧N (a page keypress never reaches a native accelerator).
    const folderItem = await app.evaluate(({ Menu, BrowserWindow }) => {
      const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) { if (it.label === 'New Session in Folder…') return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
        return undefined;
      };
      const it = walk(Menu.getApplicationMenu()!.items)!;
      it.click(undefined, BrowserWindow.getAllWindows()[0]);
      return { accelerator: it.accelerator };
    });
    expect(folderItem.accelerator).toBe('CmdOrCtrl+Alt+Shift+N');
    await expect(sheet).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // File menu: New Terminal in Folder… → picking the root starts a terminal there, with no chip.
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const it of items) { if (it.label === 'New Terminal in Folder…') return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
        return undefined;
      };
      walk(Menu.getApplicationMenu()!.items)!.click(undefined, BrowserWindow.getAllWindows()[0]);
    });
    const termSheet = win.getByRole('dialog', { name: 'New terminal in folder' });
    await expect(termSheet).toBeVisible();
    await expect(termSheet.locator('.folder-item.is-active .folder-label')).toHaveText(name, { timeout: 10000 });
    await win.keyboard.press('Enter');
    await expect(win.locator('.term-row')).toHaveCount(1, { timeout: 10000 });
    await expect(win.locator('.term-row .cwd-chip')).toHaveCount(0);

    // "+" menu: Terminal in Folder…, then a click outside closes it.
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: /Terminal in Folder…/ }).click();
    await expect(termSheet).toBeVisible();
    await win.mouse.click(5, 300);
    await expect(termSheet).toBeHidden();

    // File tree: New Terminal Here on a folder; New Session Here asks only for the name.
    await win.getByRole('button', { name: /Files/ }).click();
    const treeRow = (n: string) => win.locator('.tree-row', { has: win.locator('.tree-name', { hasText: new RegExp(`^${n}$`) }) });
    await treeRow('web').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'New Terminal Here' }).click();
    await expect.poll(async () => (await created(win)).filter((x) => !x.session).map((x) => x.cwd)).toEqual([project, join(realpathSync(project), 'web')]);
    // (Tree paths are real paths: /var → /private/var; the chip is relative to either form of the root.)
    await treeRow('docs').click();
    await treeRow('guide').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'New Session Here' }).click();
    await expect(win.locator('.folder-sheet .folder-chip')).toHaveText('docs/guide/');
    await win.keyboard.type('Guide pages');
    await win.keyboard.press('Enter');
    // Its tab in front first: the arriving session takes the keyboard, and a menu opened before would lose it (under
    // load the Escape below then reached the terminal and the menu stayed open).
    await expect(win.locator('.tab.is-active')).toContainText('Guide pages', { timeout: 15000 });
    // The tree root (empty area) has the same entries.
    await win.locator('.tree').click({ button: 'right', position: { x: 60, y: 260 } });
    await expect(win.getByRole('menuitem', { name: 'New Session Here' })).toBeVisible();
    await expect(win.getByRole('menuitem', { name: 'New Terminal Here' })).toBeVisible();
    await win.keyboard.press('Escape');

    await win.getByRole('button', { name: /Sessions/ }).first().click();
    const guideRow = win.locator('.session-row', { hasText: 'Guide' });
    await expect(guideRow.locator('.cwd-chip')).toHaveText('docs/guide/', { timeout: 15000 });
    await expect(win.locator('.term-row .cwd-chip')).toHaveText(['web/']);
    await win.mouse.move(600, 400);
    await look(win.locator('.sidebar'), 'test-results/folder-chips-sidebar.png');

    // The main process refuses folders outside the project (including through a symlink) and inside .git.
    const refused = (cwd: string, session: boolean) => win.evaluate(([c, s]) => {
      const t = (window as unknown as { atelier: Api }).atelier.terminals;
      return (s ? t.createSession({ cols: 80, rows: 24, cwd: c }) : t.create({ cols: 80, rows: 24, cwd: c })).then(() => 'created', () => 'refused');
    }, [cwd, session] as const);
    expect(await refused('/', false)).toBe('refused');
    expect(await refused(join(project, 'escape'), false)).toBe('refused');
    expect(await refused(join(project, 'api', '.git'), true)).toBe('refused');
    expect(await refused(join(project, '..'), true)).toBe('refused');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

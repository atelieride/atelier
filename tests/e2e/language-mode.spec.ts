import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

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

/** Highlighted text: the editor's token marks carry their color inline. */
const colored = (win: Page) => win.locator('.file-view:visible .cm-content span[style*="color"]');

test('Change Language Mode: an untitled tab picks Markdown (highlighted while typing, Save as suggests .md); a .txt picks JSON, kept on reopen and reload, Auto undoes it; a Gosu file opens as Gosu, highlighted', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  writeFileSync(join(project, 'data.txt'), '{ "name": "atelier", "count": 3, "ok": true }\n');
  writeFileSync(join(project, 'ClaimHelper.gs'), [
    'package acme.claims', '', 'uses gw.api.util.DateUtil', '', '/** A claim helper. */', '@Export',
    'class ClaimHelper extends AbstractHelper {', '  private var _count : int = 42', '',
    '  property get Count() : int {', '    return _count // the count', '  }', '',
    '  function describe(claim : Claim) : String {', '    if (claim typeis Contact and not claim.Closed) {',
    '      print("Exposure ${claim.DisplayName}")', '    }',
    '    return claim.Exposures.where(\\ e -> e.Amount > 100bd).HasElements ? "big" : "small"', '  }', '}', ''
  ].join('\n'));
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.header')).toBeVisible();
    await win.mouse.move(1, 1);

    // Untitled tab: plain text until a language is picked from the footer label.
    await menu(app, 'CmdOrCtrl+Alt+N');
    const foot = win.locator('.file-view:visible .foot-lang');
    await expect(foot).toHaveText('Plain text');
    await expect(foot).toHaveAttribute('data-tip', 'Change language');
    await foot.click();
    const sheet = win.locator('.language-sheet');
    const input = sheet.locator('input');
    await expect(input).toBeFocused();
    const items = sheet.locator('.palette-item');
    await expect(items.first()).toContainText('Auto (from extension)');
    await expect(items.first()).toHaveClass(/is-current/);
    await expect(items.first()).toHaveClass(/is-active/);
    // Arrows wrap around.
    await input.press('ArrowUp');
    await expect(items.last()).toHaveClass(/is-active/);
    await input.press('ArrowDown');
    await expect(items.first()).toHaveClass(/is-active/);
    await input.fill('markd');
    await expect(items.first()).toContainText('Markdown');
    await expect(items.first()).toHaveClass(/is-active/);
    await input.press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect(foot).toHaveText('Markdown');
    const editor = win.locator('.file-view:visible .cm-content');
    await expect(editor).toBeFocused();
    await win.keyboard.type('# Notes\n\nSome **bold** text and `code`.');
    await expect.poll(() => colored(win).count(), { timeout: 10000 }).toBeGreaterThan(0);

    // Palette command: the current language is marked; Esc closes without changing it.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>language');
    await expect(win.locator('.palette-item.is-active')).toContainText('Change language mode');
    await expect(win.locator('.palette-item.is-active')).toContainText('Markdown');
    await win.keyboard.press('Enter');
    await expect(input).toBeFocused();
    // Opens on the current language.
    await expect(sheet.locator('.palette-item.is-current')).toContainText('Markdown');
    await expect(sheet.locator('.palette-item.is-current')).toHaveClass(/is-active/);
    await look(win, 'test-results/language-sheet.png', { settle: 300, animations: 'disabled' });
    await input.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(foot).toHaveText('Markdown');

    // Save as: the language's extension is suggested (prefilled, the caret before it), never forced.
    await menu(app, 'CmdOrCtrl+S');
    const saveAs = win.locator('.save-as-sheet input');
    await expect(saveAs).toBeFocused();
    await expect(saveAs).toHaveValue('.md');
    await saveAs.pressSequentially('notes');
    await expect(saveAs).toHaveValue('notes.md');
    await saveAs.press('Enter');
    await expect.poll(() => existsSync(join(project, 'notes.md'))).toBe(true);
    await expect(win.locator('.tab', { hasText: 'notes.md' })).toHaveClass(/is-active/);
    await expect(foot).toHaveText('Markdown');

    // A .txt file: plain text; JSON picked → highlighted.
    await win.getByRole('button', { name: /^Files/ }).click();
    await win.locator('.tree-row', { hasText: 'data.txt' }).dblclick();
    await expect(foot).toHaveText('Plain text');
    await expect(win.locator('.file-view:visible .cm-content')).toContainText('atelier');
    await expect(colored(win)).toHaveCount(0);
    await foot.click();
    await input.fill('json');
    await expect(items.first()).toContainText('JSON');
    await input.press('Enter');
    await expect(foot).toHaveText('JSON');
    await expect.poll(() => colored(win).count(), { timeout: 10000 }).toBeGreaterThan(0);

    // Remembered for that path: closing and reopening the tab, and reloading the window.
    await menu(app, 'CmdOrCtrl+W');
    await expect(win.locator('.tab', { hasText: 'data.txt' })).toHaveCount(0);
    await win.locator('.tree-row', { hasText: 'data.txt' }).dblclick();
    await expect(foot).toHaveText('JSON');
    await expect.poll(() => colored(win).count(), { timeout: 10000 }).toBeGreaterThan(0);
    await win.reload();
    await win.getByRole('button', { name: /^Files/ }).click();
    await win.locator('.tree-row', { hasText: 'data.txt' }).dblclick();
    await expect(foot).toHaveText('JSON');
    await expect.poll(() => colored(win).count(), { timeout: 10000 }).toBeGreaterThan(0);

    // Auto: back to what the extension says (plain text), colors gone.
    await foot.click();
    await expect(sheet.locator('.palette-item.is-current')).toContainText('JSON');
    await input.fill('auto');
    await input.press('Enter');
    await expect(foot).toHaveText('Plain text');
    await expect(colored(win)).toHaveCount(0);

    // A Gosu file (.gs): Gosu by its extension, its grammar loaded in the highlighter.
    await win.locator('.tree-row', { hasText: 'ClaimHelper.gs' }).dblclick();
    await expect(foot).toHaveText('Gosu');
    await expect.poll(() => colored(win).count(), { timeout: 10000 }).toBeGreaterThan(10);
    await look(win, 'test-results/gosu-highlight.png', { settle: 300, animations: 'disabled' });
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => { w.webContents.removeAllListeners('will-prevent-unload'); w.webContents.on('will-prevent-unload', (e) => e.preventDefault()); }));
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

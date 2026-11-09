import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { git, gitWritesProject, launchGitApp, write } from './git-writes-fixture';
import { look } from './shots';

// Settings › Source Control: Git actions Read-only hides every write in Changes, the
// sidebar, the Git menu and the palette, brings back the Read-only badge and the old footer line, and main refuses a
// call made anyway; back to On it all returns. Plus Reduce motion: the commit drawer opens without its rise.

const SHOTS = 'test-results';

/** What the Git menu shows now: its visibility, and its visible rows (separators as '-'). */
const gitMenu = (app: ElectronApplication) => app.evaluate(({ Menu }) => {
  const m = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Git');
  return m ? { visible: m.visible, rows: m.submenu!.items.filter((i) => i.visible).map((i) => (i.type === 'separator' ? '-' : i.label)) } : null;
});

/** The palette's rows for a `>` query, then closed. */
async function palette(win: Page, query: string): Promise<string[]> {
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill(`>${query}`);
  await expect(win.locator('.palette-input')).toHaveValue(`>${query}`);
  const labels = await win.locator('.palette-item .palette-label').allTextContents();
  await win.keyboard.press('Escape');
  await expect(win.locator('.palette')).toHaveCount(0);
  return labels;
}

async function gitActions(win: Page, app: ElectronApplication, to: 'On' | 'Read-only', shot?: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'open-settings'));
  const dialog = win.getByRole('dialog', { name: 'Settings' });
  await dialog.locator('.set-nav-item', { hasText: 'Source Control' }).click();
  await expect(dialog.getByRole('heading', { name: 'Source Control' })).toBeVisible();
  const seg = dialog.getByRole('radiogroup', { name: 'Git actions' });
  if (shot) await look(dialog, `${SHOTS}/${shot}`);
  await seg.getByRole('radio', { name: to, exact: true }).click();
  await expect(seg.getByRole('radio', { name: to, exact: true })).toHaveAttribute('aria-checked', 'true');
  // The rows after it follow: disabled in Read-only (their values kept), enabled when on.
  const messages = dialog.getByRole('radiogroup', { name: 'Messages with Claude' }).getByRole('radio', { name: 'Haiku' });
  const coAuthor = dialog.getByRole('switch', { name: 'Co-authored-by Claude' });
  if (to === 'Read-only') {
    await expect(dialog.getByText('Read-only: Atelier only shows and fetches, like before. Commit, push and branches stay in your terminal.')).toBeVisible();
    await expect(messages).toBeDisabled();
    await expect(coAuthor).toBeDisabled();
    await expect(messages).toHaveAttribute('aria-checked', 'true');
    await look(dialog, `${SHOTS}/git-settings-readonly.png`);
  } else {
    await expect(messages).toBeEnabled();
    await expect(coAuthor).toBeEnabled();
  }
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test('Read-only hides every write (Changes, sidebar, Git menu, palette), main refuses a forced call; On brings them back; reduced motion', async () => {
  const p = gitWritesProject(['acme-store', 'billing'], undefined, { remote: true });
  const s = await launchGitApp(p.root);
  const { app, win, panel } = s;
  try {
    await expect(panel).toContainText('All clean · 2 repos', { timeout: 15000 });
    write(join(p.repo('acme-store'), 'src/app.ts'), 'export const app = 2;\n');
    const row = panel.locator('.change-row', { hasText: 'app.ts' });
    await expect(row).toHaveCount(1, { timeout: 8000 });
    await s.command('view-scm');
    await expect(win.locator('.scm-sidebar .sw-card')).toBeVisible({ timeout: 15000 });

    // Git actions on (the default): the commit bar, staging in the row's menu, Sync, no badge, the whole Git menu.
    const bar = panel.locator('.git-bar');
    await expect(bar).toBeVisible();
    await expect(panel.locator('.changes-foot')).toHaveCount(0);
    await expect(win.locator('.git-sync')).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.scm-ro')).toHaveCount(0);
    await row.click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Stage', exact: true })).toBeVisible();
    await win.keyboard.press('Escape');
    const all = ['Commit…', 'Commit All Repositories…', 'Write Commit Message with Claude', 'Undo Last Commit', '-', 'Push', 'Pull', 'Sync', 'Sync All Repositories', '-',
      'Fetch', 'Fetch All Repositories', '-', 'New Branch…', 'Switch to Branch…', 'Stash Changes…'];
    await expect.poll(() => gitMenu(app), { timeout: 10000 }).toEqual({ visible: true, rows: all });
    expect(await palette(win, 'push')).toContain('Push');
    expect(await palette(win, 'stash changes')).toContain('Stash Changes…');

    // Read-only.
    await gitActions(win, app, 'Read-only', 'git-settings.png');
    await expect(bar).toHaveCount(0);
    await expect(panel.locator('.changes-foot')).toHaveText('Read-only. Commit and push stay in your terminal.');
    await expect(win.locator('.git-sync')).toHaveCount(0);
    await expect(win.locator('.scm-ro')).toBeVisible();
    await expect(win.locator('.scm-ro')).toHaveAttribute('data-tip', /Git actions are Read-only/);
    await row.click({ button: 'right' });
    await expect(win.getByRole('menu')).toBeVisible();
    for (const name of ['Stage', 'Unstage', 'Discard Changes…']) await expect(win.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect.poll(() => gitMenu(app), { timeout: 10000 }).toEqual({ visible: true, rows: ['Fetch', 'Fetch All Repositories'] });
    expect(await palette(win, 'push')).not.toContain('Push');
    expect(await palette(win, 'stash changes')).not.toContain('Stash Changes…');
    expect(await palette(win, 'fetch all')).toContain('Fetch All Repositories');
    // ⌥⌘K's command in Read-only: nothing opens.
    await s.command('git-commit');
    await expect(panel.locator('.git-drawer')).toHaveCount(0);
    // A call made anyway, straight through the bridge: main refuses it before git runs.
    const forced = await win.evaluate((root) => (window as unknown as { atelier: { git: { stage(r: string, rels: string[]): Promise<{ outcome: string; message?: string }> } } })
      .atelier.git.stage(root, ['src/app.ts']), p.repo('acme-store'));
    expect(forced.message).toBe('Git actions are read-only');
    await expect(row.locator('.git-dot')).toHaveCount(0);

    // On again: everything is back.
    await gitActions(win, app, 'On');
    await expect(bar).toBeVisible();
    await expect(panel.locator('.changes-foot')).toHaveCount(0);
    await expect(win.locator('.git-sync')).toBeVisible();
    await expect(win.locator('.scm-ro')).toHaveCount(0);
    await expect.poll(() => gitMenu(app), { timeout: 10000 }).toEqual({ visible: true, rows: all });

    // Reduce motion: the drawer rises by default, and opens still with Reduce motion on.
    const drawer = panel.locator('.git-drawer');
    await s.command('git-commit');
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((el) => getComputedStyle(el).animationName)).toBe('atl-rise');
    await win.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'open-settings'));
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.locator('.set-nav-item', { hasText: 'Appearance' }).click();
    await dialog.getByRole('radiogroup', { name: 'Reduce motion' }).getByRole('radio', { name: 'Always' }).click();
    await expect(win.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await win.keyboard.press('Escape');
    await s.command('git-commit');
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');

    // Commit all open when Git actions turn Read-only: it goes (no write stays on screen), and doesn't come back On.
    await win.keyboard.press('Escape');
    git(p.repo('acme-store'), 'add', 'src/app.ts');
    write(join(p.repo('billing'), 'README.md'), '# billing 2\n');
    git(p.repo('billing'), 'add', 'README.md');
    await expect(bar).toContainText('in 2 repositories', { timeout: 8000 });
    await s.command('git-commit-all');
    const sheet = win.locator('.commit-all');
    await expect(sheet).toBeVisible();
    const setGitActions = (v: 'on' | 'read-only') => win.evaluate((x) => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ gitActions: x }), v);
    await setGitActions('read-only');
    await expect(sheet).toHaveCount(0);
    await expect(bar).toHaveCount(0);
    await setGitActions('on');
    await expect(bar).toBeVisible();
    await expect(sheet).toHaveCount(0);
  } finally {
    await s.stop();
  }
});

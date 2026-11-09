// Branches in the Source Control sidebar: switching while a session works in the repository asks
// first (the worktree choice preselected), a new branch made and switched to, an unmerged branch deleted anyway and
// brought back by Undo, a branch opened in a new worktree under .claude/worktrees. The project is one repository in the
// run's temp root, with its own identity (no user config); the fake Claude stays in its turn (no Stop).
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { commit, git } from '../support/git-fixture';
import { write } from './git-writes-fixture';
import { look } from './shots';

const SHOTS = 'test-results';

async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

/** One repository as the project: main with two commits, feat/x off the first one. */
function branchesRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atl-br-e2e-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'feat: first', { 'src/app.ts': 'app 1\n', 'README.md': '# app\n' });
  git(dir, 'branch', 'feat/x');
  commit(dir, 'feat: second', { 'src/cart.ts': 'cart 1\n' });
  return dir;
}

async function launch(project: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page; stop: () => Promise<void> }> {
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
  await menu(app, 'Source Control');
  await expect(win.locator('.scm-sidebar .sw-card')).toBeVisible({ timeout: 15000 });
  return { app, win, stop };
}

const branch = (dir: string) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
const branchRow = (win: Page, name: string) => win.locator(`.scm-section[data-key="branches"] .ref-line:has(.ref-row[data-ref="refs/heads/${name}"])`);

test('switching while a session works in the repository: the sheet, the worktree choice preselected; bring my changes switches', async () => {
  const dir = branchesRepo();
  const { app, win, stop } = await launch(dir, { ATELIER_FAKE_EDIT: 'src/app.ts', ATELIER_FAKE_NO_STOP: '1' });
  try {
    write(join(dir, 'src/app.ts'), 'app 2\n');
    await win.locator('.btn-new').click();
    await win.getByRole('menuitem', { name: 'Claude Session' }).click();
    await win.getByPlaceholder('Session name (optional)').fill('auth-refactor');
    await win.keyboard.press('Enter');
    // The session's edit is attributed: it is in its turn (no Stop).
    await expect(win.locator('.changes .change-row', { hasText: 'app.ts' }).locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
    if (!(await win.locator('.scm-sidebar').isVisible())) await menu(app, 'Source Control');
    // The row's switch icon asks first.
    const row = branchRow(win, 'feat/x');
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.hover();
    await row.getByRole('button', { name: 'Switch to feat/x' }).click();
    const sheet = win.getByRole('dialog', { name: 'Switch to feat/x?' });
    await expect(sheet).toBeVisible({ timeout: 10000 });
    await expect(sheet.getByRole('radio', { name: /Open it in a new worktree/ })).toHaveAttribute('aria-checked', 'true');
    await expect(sheet.getByRole('radio', { name: /Stash my changes and switch/ })).toBeVisible();
    await expect(sheet.getByRole('radio', { name: /Switch and bring my changes/ })).toBeVisible();
    await expect(sheet.locator('.git-notice.is-live')).toContainText('auth-refactor');
    await expect(sheet).toContainText('1 changed file');
    await win.mouse.move(5, 5);
    await look(sheet, `${SHOTS}/git-switch-sheet.png`, { settle: 300 });

    await sheet.getByRole('radio', { name: /Switch and bring my changes/ }).click();
    await sheet.getByRole('button', { name: 'Switch', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => branch(dir), { timeout: 15000 }).toBe('feat/x');
    // The change came along.
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toBe('app 2\n');
    await expect(win.locator('.toast')).toContainText('Switched to feat/x', { timeout: 10000 });
    await expect(branchRow(win, 'feat/x').locator('.ref-head-pill')).toHaveText('HEAD', { timeout: 10000 });
  } finally {
    await stop();
  }
});

test('a clean tree with no session switches directly; New Branch… validates live, creates and switches; Rename… inline', async () => {
  const dir = branchesRepo();
  const { win, stop } = await launch(dir);
  try {
    // Double-click: direct (clean, nobody there), and History doesn't open on the way.
    await branchRow(win, 'feat/x').locator('.ref-row').dblclick();
    await expect.poll(() => branch(dir), { timeout: 15000 }).toBe('feat/x');
    await expect(win.getByRole('dialog')).toHaveCount(0);
    await win.waitForTimeout(400);
    await expect(win.locator('.history-view')).toHaveCount(0);
    // One click: its History.
    await branchRow(win, 'main').locator('.ref-row').click();
    await expect(win.locator('.history-view')).toBeVisible({ timeout: 10000 });

    const branches = win.locator('.scm-section[data-key="branches"]');
    await branches.locator('.scm-section-top').hover();
    await branches.getByRole('button', { name: 'New Branch…' }).click();
    const sheet = win.getByRole('dialog', { name: 'New branch' });
    await expect(sheet).toBeVisible();
    const name = sheet.getByRole('textbox', { name: 'Branch name' });
    await expect(name).toBeFocused();
    await name.fill('bad name..');
    await expect(sheet.locator('.git-field-error')).toHaveText('Not a valid branch name', { timeout: 5000 });
    await expect(sheet.getByRole('button', { name: 'Create Branch' })).toBeDisabled();
    await name.fill('main');
    await expect(sheet.locator('.git-field-error')).toHaveText('A branch named main already exists', { timeout: 5000 });
    await name.fill('feat/new-cart');
    await expect(sheet.locator('.git-field-error')).toHaveCount(0, { timeout: 5000 });
    await expect(sheet.getByRole('checkbox', { name: 'Switch to it' })).toBeChecked();
    await expect(sheet.getByRole('button', { name: 'Create Branch' })).toBeEnabled();
    await look(sheet, `${SHOTS}/git-new-branch.png`, { settle: 300 });
    await name.press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => branch(dir), { timeout: 15000 }).toBe('feat/new-cart');
    // From HEAD (feat/x): the new branch points where feat/x does.
    expect(git(dir, 'rev-parse', 'feat/new-cart').trim()).toBe(git(dir, 'rev-parse', 'feat/x').trim());

    // New Branch from Here…: "From" is a radio group, one Tab stop, arrows move the choice.
    await branchRow(win, 'main').locator('.ref-row').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'New Branch from Here…' }).click();
    const from = win.getByRole('dialog', { name: 'New branch' }).getByRole('radiogroup', { name: 'From' });
    const fromMain = from.getByRole('radio', { name: 'main' });
    const fromHead = from.getByRole('radio', { name: /^HEAD/ });
    await expect(fromMain).toHaveAttribute('aria-checked', 'true');
    await expect(fromMain).toHaveAttribute('tabindex', '0');
    await expect(fromHead).toHaveAttribute('tabindex', '-1');
    await fromMain.focus();
    await win.keyboard.press('ArrowLeft');
    await expect(fromHead).toHaveAttribute('aria-checked', 'true');
    await expect(fromHead).toBeFocused();
    await win.keyboard.press('Tab');
    await expect(win.getByRole('dialog', { name: 'New branch' }).getByRole('checkbox', { name: 'Switch to it' })).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(win.getByRole('dialog')).toHaveCount(0);

    // Rename… in the row: Enter renames.
    await branchRow(win, 'feat/x').locator('.ref-row').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Rename…' }).click();
    const input = win.getByRole('textbox', { name: 'New name for feat/x' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('feat/x');
    await input.fill('feat/renamed');
    await input.press('Enter');
    await expect.poll(() => git(dir, 'branch', '--format=%(refname:short)').trim().split('\n').sort(), { timeout: 15000 }).toEqual(['feat/new-cart', 'feat/renamed', 'main']);
    await expect(branchRow(win, 'feat/renamed')).toBeVisible({ timeout: 10000 });
  } finally {
    await stop();
  }
});

test('Delete Branch… on an unmerged branch: the sheet, Delete Anyway, then Undo brings it back where it was', async () => {
  const dir = branchesRepo();
  git(dir, 'checkout', '-q', '-b', 'feat/unmerged');
  const tip = commit(dir, 'feat: not merged', { 'u.txt': 'u\n' });
  git(dir, 'checkout', '-q', 'main');
  const { win, stop } = await launch(dir);
  try {
    // The current branch has no Delete.
    await branchRow(win, 'main').locator('.ref-row').click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Switch to main' })).toHaveCount(0);
    await expect(win.getByRole('menuitem', { name: 'Delete Branch…' })).toHaveCount(0);
    await win.keyboard.press('Escape');

    await branchRow(win, 'feat/unmerged').locator('.ref-row').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Delete Branch…' }).click();
    const sheet = win.getByRole('dialog', { name: 'Delete feat/unmerged?' });
    await expect(sheet).toBeVisible({ timeout: 10000 });
    await expect(sheet).toContainText(/feat\/unmerged has 1 commit that .* merged anywhere/);
    // Cancel is the default: Enter never deletes by accident.
    await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await sheet.getByRole('button', { name: 'Delete Anyway' }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => git(dir, 'branch', '--list', 'feat/unmerged').trim(), { timeout: 15000 }).toBe('');
    const toast = win.locator('.toast');
    await expect(toast).toContainText('Deleted feat/unmerged');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => { try { return git(dir, 'rev-parse', 'refs/heads/feat/unmerged').trim(); } catch { return null; } }, { timeout: 15000 }).toBe(tip);
    await expect(branchRow(win, 'feat/unmerged')).toBeVisible({ timeout: 10000 });
  } finally {
    await stop();
  }
});

test('Open in New Worktree…: the default folder under .claude/worktrees, the not-ignored warning, created, then a session offered', async () => {
  const dir = branchesRepo();
  const { win, stop } = await launch(dir);
  try {
    await branchRow(win, 'feat/x').locator('.ref-row').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Open in New Worktree…' }).click();
    const sheet = win.getByRole('dialog', { name: 'Open feat/x in a new worktree' });
    await expect(sheet).toBeVisible();
    const folder = sheet.getByRole('textbox', { name: 'Folder' });
    await expect(folder).toHaveValue(join(dir, '.claude/worktrees/feat-x'));
    await expect(sheet.locator('.git-notice.is-warn')).toContainText("isn't ignored", { timeout: 5000 });
    // Outside the project: refused before anything runs.
    await folder.fill(join(tmpdir(), 'elsewhere'));
    await expect(sheet.locator('.git-field-error')).toHaveText('Pick a folder inside the project', { timeout: 5000 });
    await expect(sheet.getByRole('button', { name: 'Create Worktree' })).toBeDisabled();
    await folder.fill(join(dir, '.claude/worktrees/feat-x'));
    await expect(sheet.getByRole('button', { name: 'Create Worktree' })).toBeEnabled({ timeout: 5000 });
    await sheet.getByRole('button', { name: 'Create Worktree' }).click();
    await expect(sheet).toHaveCount(0);
    const wt = join(dir, '.claude/worktrees/feat-x');
    await expect.poll(() => existsSync(join(wt, 'src/app.ts')), { timeout: 15000 }).toBe(true);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/x');
    const toast = win.locator('.toast');
    await expect(toast).toContainText('Worktree ready at .claude/worktrees/feat-x');
    await toast.getByRole('button', { name: 'New Claude Session Here' }).click();
    await expect(win.getByPlaceholder('Session name (optional)')).toBeVisible();
  } finally {
    await stop();
  }
});

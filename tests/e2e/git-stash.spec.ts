// Stashes in the Source Control sidebar: Stash Changes… from the section's +, with its file
// count, then Undo pops that exact stash; Drop without a question and its Undo storing it back; Apply refused upfront
// over a file that is dirty now. One repository as the project, in the run's temp root, with its own identity.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { commit, git, stashList } from '../support/git-fixture';
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

function stashRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'atl-stash-e2e-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'feat: first', { 'src/cart.ts': 'cart 1\n', 'README.md': '# app\n' });
  return dir;
}

async function launch(project: string): Promise<{ win: Page; stop: () => Promise<void> }> {
  const { env, home } = e2eEnv();
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
  await menu(app, 'Source Control');
  await expect(win.locator('.scm-sidebar .sw-card')).toBeVisible({ timeout: 15000 });
  return { win, stop };
}

// Read while the app pops or drops the last stash, the list can be STASH_CHANGING: the polls below try again.
const stashes = stashList;

test('Stash Changes… from the section: the count, new files included; stashed, then Undo pops it back', async () => {
  const dir = stashRepo();
  write(join(dir, 'src/cart.ts'), 'cart 2\n');
  write(join(dir, 'src/new.ts'), 'new\n');
  const { win, stop } = await launch(dir);
  try {
    await expect(win.locator('.changes .change-row')).toHaveCount(2, { timeout: 10000 });
    const section = win.locator('.scm-section[data-key="stashes"]');
    await section.locator('.scm-section-top').hover();
    await section.getByRole('button', { name: 'Stash Changes…' }).click();
    const sheet = win.getByRole('dialog', { name: 'Stash changes' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'Message' })).toBeFocused();
    await expect(sheet.getByRole('checkbox', { name: 'Include new files' })).toBeChecked();
    await expect(sheet.locator('.git-stash-count')).toHaveText('2 files');
    // Without new files: one.
    await sheet.getByRole('checkbox', { name: 'Include new files' }).uncheck();
    await expect(sheet.locator('.git-stash-count')).toHaveText('1 file');
    await sheet.getByRole('checkbox', { name: 'Include new files' }).check();
    await sheet.getByRole('textbox', { name: 'Message' }).fill('wip: cart totals');
    await look(sheet, `${SHOTS}/git-stash-sheet.png`, { settle: 300 });
    await sheet.getByRole('button', { name: 'Stash', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => stashes(dir), { timeout: 15000 }).toMatch(/ On main: wip: cart totals$/);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    await expect(section.locator('.stash-row')).toHaveCount(1, { timeout: 10000 });
    await expect(section.locator('.stash-row')).toContainText('wip: cart totals');

    const toast = win.locator('.toast');
    await expect(toast).toContainText('Stashed your changes');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => stashes(dir), { timeout: 15000 }).toBe('');
    expect(readFileSync(join(dir, 'src/cart.ts'), 'utf8')).toBe('cart 2\n');
    expect(readFileSync(join(dir, 'src/new.ts'), 'utf8')).toBe('new\n');
    await expect(section.locator('.stash-row')).toHaveCount(0, { timeout: 10000 });
  } finally {
    await stop();
  }
});

test('Drop: no question, gone; Undo stores it back with its message', async () => {
  const dir = stashRepo();
  write(join(dir, 'src/cart.ts'), 'cart 3\n');
  git(dir, 'stash', 'push', '-q', '-m', 'keep me');
  const before = stashes(dir);
  const oid = before.split(' ')[0];
  const { win, stop } = await launch(dir);
  try {
    const row = win.locator('.scm-section[data-key="stashes"] .stash-row');
    await expect(row).toHaveCount(1, { timeout: 10000 });
    await row.click({ button: 'right' });
    for (const name of ['Apply', 'Pop', 'Drop', 'Copy Message']) await expect(win.getByRole('menuitem', { name, exact: true })).toBeVisible();
    await win.getByRole('menuitem', { name: 'Drop', exact: true }).click();
    await expect.poll(() => stashes(dir), { timeout: 15000 }).toBe('');
    await expect(row).toHaveCount(0, { timeout: 10000 });
    const toast = win.locator('.toast');
    await expect(toast).toContainText('Dropped');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => stashes(dir).split(' ')[0], { timeout: 15000 }).toBe(oid);
    expect(stashes(dir)).toContain('keep me');
    await expect(row).toHaveCount(1, { timeout: 10000 });
  } finally {
    await stop();
  }
});

test('Apply over a file that is dirty now: refused upfront, the stash kept; on a clean tree it applies', async () => {
  const dir = stashRepo();
  write(join(dir, 'src/cart.ts'), 'cart stashed\n');
  git(dir, 'stash', 'push', '-q', '-m', 'cart work');
  write(join(dir, 'src/cart.ts'), 'cart dirty now\n');
  const { win, stop } = await launch(dir);
  try {
    const row = win.locator('.scm-section[data-key="stashes"] .stash-row');
    await expect(row).toHaveCount(1, { timeout: 10000 });
    await row.hover();
    await row.getByRole('button', { name: 'Apply' }).click();
    await expect(win.locator('.toast')).toContainText('Commit or stash that file first', { timeout: 10000 });
    expect(readFileSync(join(dir, 'src/cart.ts'), 'utf8')).toBe('cart dirty now\n');
    expect(stashes(dir)).toContain('cart work');

    git(dir, 'checkout', '--', 'src/cart.ts');
    await expect(win.locator('.changes .change-row')).toHaveCount(0, { timeout: 10000 });
    await row.hover();
    await row.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => readFileSync(join(dir, 'src/cart.ts'), 'utf8'), { timeout: 15000 }).toBe('cart stashed\n');
    // Apply keeps it.
    expect(stashes(dir)).toContain('cart work');
  } finally {
    await stop();
  }
});

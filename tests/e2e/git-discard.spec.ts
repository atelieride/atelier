import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { git, gitWritesProject, write } from './git-writes-fixture';
import { look } from './shots';
import { ENTER_GRACE_MS } from '../../src/renderer/git/sheet-keys';

// Discard: from a file row and from the file tab, each file goes to the (test) Trash first, then
// the repository matches HEAD for it; a file staged and then changed again is kept and the toast says why; Cancel (the
// focused button, so Enter) does nothing. The sheet names who wrote the lines and the session editing them now.

const OLD = Array.from({ length: 12 }, (_, i) => `export const line${i} = ${i};\n`).join('');
const FILES = { 'src/cart.ts': 'cart 1\n', 'src/totals.ts': 'totals 1\n', 'src/old.ts': OLD, 'src/notes.ts': 'notes 1\n', 'README.md': '# acme\n' };

/**
 * One repository with six changes: cart.ts (edited by a session "auth-refactor" still in its turn), totals.ts and
 * README.md modified, new.ts untracked, old.ts renamed to moved.ts and edited (staged, so git pairs them), notes.ts
 * staged then changed again. The Trash is a folder of the test's own.
 */
async function scene() {
  const p = gitWritesProject(['acme-store'], FILES);
  const repo = p.repo('acme-store');
  const trash = mkdtempSync(join(tmpdir(), 'atl-discard-trash-'));
  const { env, home } = e2eEnv({
    ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude-edit.pl'), ATELIER_FAKE_EDIT: join(repo, 'src/cart.ts'), ATELIER_FAKE_NO_STOP: '1',
    ATELIER_TEST_TRASH_DIR: trash
  });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${p.root}`], env });
  const win = await app.firstWindow();
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  const panel = win.locator('.changes');
  await expect(panel).toBeVisible({ timeout: 10000 });
  write(join(repo, 'src/cart.ts'), 'cart 2\n');
  write(join(repo, 'src/totals.ts'), 'totals 2\n');
  write(join(repo, 'README.md'), '# acme, edited\n');
  write(join(repo, 'src/new.ts'), 'brand new\n');
  git(repo, 'mv', 'src/old.ts', 'src/moved.ts');
  write(join(repo, 'src/moved.ts'), OLD.replace('line3 = 3', 'line3 = 33'));
  git(repo, 'add', 'src/moved.ts');
  write(join(repo, 'src/notes.ts'), 'notes 2\n');
  git(repo, 'add', 'src/notes.ts');
  write(join(repo, 'src/notes.ts'), 'notes 3\n');
  const row = (name: string) => panel.locator('.change-row', { hasText: name });
  await expect(panel.locator('.change-row')).toHaveCount(6, { timeout: 8000 });
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill('auth-refactor');
  await win.keyboard.press('Enter');
  await expect(row('cart.ts').locator('.dot:not(.unknown)')).toHaveCount(1, { timeout: 15000 });
  const read = (rel: string) => readFileSync(join(repo, rel), 'utf8');
  const head = (rel: string) => git(repo, 'show', `HEAD:${rel}`);
  const status = (...rels: string[]) => git(repo, 'status', '--porcelain', '--', ...rels);
  /** The test Trash's entries named after `name` (main prefixes a timestamp). */
  const trashed = (name: string) => readdirSync(trash).filter((n) => n.endsWith(`-${name}`)).map((n) => readFileSync(join(trash, n), 'utf8'));
  return { win, panel, row, repo, trash, read, head, status, trashed, stop };
}

const sheet = (win: Page, title: string) => win.getByRole('dialog', { name: title });
async function discardFrom(win: Page, target: Locator) {
  await target.click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Discard Changes…' }).click();
}

test('the sheet names the file, the Trash, who wrote it and who is editing it now; Cancel (and Enter) does nothing; modified, untracked and renamed files go to the Trash and come back as in HEAD; staged then changed is kept', async () => {
  const s = await scene();
  try {
    await discardFrom(s.win, s.row('cart.ts'));
    const d = sheet(s.win, 'Discard changes to cart.ts?');
    await expect(d).toBeVisible();
    await expect(d).toContainText('Your current version is moved to the Trash, so you can get it back');
    await expect(d.locator('.git-sheet-by')).toHaveText('A');
    await expect(d.locator('.git-notice.is-live')).toContainText('auth-refactor is editing it right now');
    // Cancel has the focus: Enter never discards by accident. Discard is rose.
    await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(d.getByRole('button', { name: 'Discard', exact: true })).toHaveClass(/btn-danger/);
    await s.win.mouse.move(5, 300);
    await d.evaluate((el) => Promise.all(el.closest('.palette-backdrop')!.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
    await look(s.win, 'test-results/git-discard.png');
    // An Enter as the sheet appears is swallowed on purpose (sheet-keys.ts): this one comes once the grace is over.
    await s.win.waitForTimeout(ENTER_GRACE_MS);
    await s.win.keyboard.press('Enter');
    await expect(d).toHaveCount(0);
    await discardFrom(s.win, s.row('cart.ts'));
    await sheet(s.win, 'Discard changes to cart.ts?').getByRole('button', { name: 'Cancel' }).click();
    await expect(d).toHaveCount(0);
    expect(s.read('src/cart.ts')).toBe('cart 2\n');
    expect(readdirSync(s.trash)).toEqual([]);
    await expect(s.panel.locator('.change-row')).toHaveCount(6);

    // A modified file, with ⌘↵ from the sheet.
    await discardFrom(s.win, s.row('totals.ts'));
    await expect(sheet(s.win, 'Discard changes to totals.ts?')).toBeVisible();
    await s.win.keyboard.press('Meta+Enter');
    await expect(s.win.locator('.toast')).toContainText('1 file moved to the Trash', { timeout: 8000 });
    await expect(s.row('totals.ts')).toHaveCount(0, { timeout: 8000 });
    expect(s.trashed('totals.ts')).toEqual(['totals 2\n']);
    expect(s.read('src/totals.ts')).toBe(s.head('src/totals.ts'));
    expect(s.status('src/totals.ts')).toBe('');

    // An untracked file.
    await discardFrom(s.win, s.row('new.ts'));
    await sheet(s.win, 'Discard changes to new.ts?').getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(s.row('new.ts')).toHaveCount(0, { timeout: 8000 });
    expect(s.trashed('new.ts')).toEqual(['brand new\n']);
    expect(s.status('src/new.ts')).toBe('');

    // A rename with an edit: the new path to the Trash, the old one back.
    await discardFrom(s.win, s.row('moved.ts'));
    await sheet(s.win, 'Discard changes to moved.ts?').getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(s.row('moved.ts')).toHaveCount(0, { timeout: 8000 });
    expect(s.trashed('moved.ts')).toEqual([OLD.replace('line3 = 3', 'line3 = 33')]);
    expect(s.read('src/old.ts')).toBe(OLD);
    expect(s.status('src/old.ts', 'src/moved.ts')).toBe('');

    // From the file tab: README.md opened from its row.
    await s.row('README.md').click();
    const tab = s.win.locator('.tab', { hasText: 'README.md' });
    await expect(tab).toBeVisible();
    await discardFrom(s.win, tab);
    await sheet(s.win, 'Discard changes to README.md?').getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(s.row('README.md')).toHaveCount(0, { timeout: 8000 });
    expect(s.trashed('README.md')).toEqual(['# acme, edited\n']);
    expect(s.read('README.md')).toBe(s.head('README.md'));

    // Staged, then changed again: kept, the index and the file untouched, and the toast names it and says why.
    await discardFrom(s.win, s.row('notes.ts'));
    await sheet(s.win, 'Discard changes to notes.ts?').getByRole('button', { name: 'Discard', exact: true }).click();
    const toast = s.win.locator('.toast');
    await expect(toast).toContainText('kept', { timeout: 8000 });
    await expect(toast).toContainText('notes.ts');
    await expect(toast).toContainText('unstage or commit them first');
    expect(s.read('src/notes.ts')).toBe('notes 3\n');
    expect(git(s.repo, 'show', ':src/notes.ts')).toBe('notes 2\n');
    expect(s.trashed('notes.ts')).toEqual([]);
    await expect(s.row('notes.ts')).toHaveCount(1);
    await s.win.mouse.move(5, 300);
    await look(s.win, 'test-results/git-discard-kept.png');
    // Nothing else went: cart.ts is still changed.
    expect(s.read('src/cart.ts')).toBe('cart 2\n');
  } finally {
    await s.stop();
  }
});

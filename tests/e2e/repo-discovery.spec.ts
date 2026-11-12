// Repository discovery end to end: repositories three levels down and inside another repository are found (the nested
// ones marked), Source Control and Files follow clones and renames made from outside Atelier without a reopen, the
// search depth setting applies at once, and a folder scan stopped at its cap says so.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { commit, git } from '../support/git-fixture';
import { look } from './shots';
import { collisions, shownWidth, sidebarByKeys } from './narrow-fixture';

const SHOTS = 'test-results';

function repoAt(dir: string, files: Record<string, string> = { 'a.txt': 'a\n' }): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'feat: first', files);
  return dir;
}

async function menu(app: ElectronApplication, label: string) {
  await app.evaluate(({ Menu, BrowserWindow }, l) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) { if (it.label === l) return it; const sub = it.submenu ? walk(it.submenu.items) : undefined; if (sub) return sub; }
      return undefined;
    };
    walk(Menu.getApplicationMenu()!.items)?.click(undefined, BrowserWindow.getAllWindows()[0]);
  }, label);
}

async function launch(root: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page; stop: () => Promise<void> }> {
  const made = e2eEnv(extra);
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env: made.env });
  const win = await app.firstWindow();
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(made.home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
  return { app, win, stop };
}

/** Source Control's All Repositories view: one block per working tree, named by its folder. */
async function allRepos(app: ElectronApplication, win: Page) {
  await menu(app, 'Source Control');
  const all = win.getByRole('radio', { name: 'All Repositories' });
  await expect(all).toBeVisible({ timeout: 15000 });
  await all.click();
}
const blocks = (win: Page) => win.locator('.scm-all-list > [role="listitem"]');
const block = (win: Page, name: string) => win.getByRole('listitem', { name, exact: true });
const treeRow = (win: Page, name: string) => win.locator('.tree-row', { has: win.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) });

/** Whether the text `leaf` inside a name is drawn whole: its box inside the name's (nothing of it ellipsized away). */
const leafShown = (name: Locator, leaf: string): Promise<boolean> => name.evaluate((el, leaf) => {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null = null;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent === leaf) node = n;
  if (!node) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  const r = range.getBoundingClientRect();
  let right = el.getBoundingClientRect().right;
  for (let p = node.parentElement; p && p !== el.parentElement; p = p.parentElement) right = Math.min(right, p.getBoundingClientRect().right);
  return r.width > 0 && r.right <= right + 0.5;
}, leaf);

function project(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'atl-discovery-')));
}

test('repositories three levels down and inside another repository are found; the nested ones say inside which', async () => {
  const root = project();
  const hub = repoAt(join(root, 'hub'), { '.gitignore': 'guides/\n', 'README.md': '# hub\n' });
  repoAt(join(hub, 'guides'));
  repoAt(join(root, 'g', 's', 'p'));
  const s = await launch(root);
  try {
    await allRepos(s.app, s.win);
    await expect.poll(() => blocks(s.win).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), { timeout: 15000 }).toEqual(['p', 'hub', 'guides']);
    const note = block(s.win, 'guides').locator('.ab-note');
    await expect(note).toHaveText('nested');
    await expect(note).toHaveAttribute('data-tip', 'Inside hub');
    await expect(block(s.win, 'hub').locator('.ab-note')).toHaveCount(0);
    await look(s.win.locator('.sidebar'), `${SHOTS}/discovery-nested.png`);
    // Short of room, the dimmed folder part gives way before the repository's own name.
    const head = block(s.win, 'guides').locator('.ab-head');
    expect(await leafShown(head.locator('.ab-name'), 'guides')).toBe(true);
    // The narrowest sidebar: the name and its note side by side, the name still readable.
    await sidebarByKeys(s.win, 200);
    expect(await collisions(head, '.ab-name, .ab-note, .ab-branch')).toEqual([]);
    expect(await shownWidth(head.locator('.ab-name'))).toBeGreaterThan(24);
    expect(await leafShown(head.locator('.ab-name'), 'guides')).toBe(true);
    await expect(note).toHaveCSS('white-space', /nowrap/);
    await look(s.win.locator('.sidebar'), `${SHOTS}/discovery-nested-200.png`);
    // The switcher's card says the same.
    await s.win.getByRole('radio', { name: 'One Repository' }).click();
    await s.win.locator('.sw-card').click();
    await expect(s.win.locator('.sw-row', { hasText: 'guides' }).locator('.sw-wt')).toHaveText('nested');
  } finally {
    await s.stop();
  }
});

test('a repository cloned from a terminal while the project is open shows in Files, Source Control and Changes', async () => {
  const root = project();
  const hub = repoAt(join(root, 'hub'), { '.gitignore': 'ops/\n', 'README.md': '# hub\n' });
  const s = await launch(root);
  try {
    await s.win.getByRole('button', { name: /^Files/ }).click();
    await treeRow(s.win, 'hub').click();
    await expect(treeRow(s.win, 'hub')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeRow(s.win, 'README.md')).toBeVisible();
    const ops = repoAt(join(hub, 'ops'));
    writeFileSync(join(ops, 'plan.md'), 'draft\n');
    // Files: the new folder under the open one, no collapse and expand needed.
    await expect(treeRow(s.win, 'ops')).toBeVisible({ timeout: 5000 });
    await expect(treeRow(s.win, 'hub')).toHaveAttribute('aria-expanded', 'true');
    // Changes: its file, under its repository.
    await expect(s.win.locator('aside.changes')).toContainText('plan.md', { timeout: 5000 });
    await look(s.win, `${SHOTS}/discovery-clone.png`);
    await allRepos(s.app, s.win);
    await expect(block(s.win, 'ops')).toBeVisible({ timeout: 5000 });
    await expect(block(s.win, 'ops').locator('.ab-note')).toHaveText('nested');
  } finally {
    await s.stop();
  }
});

test('a folder renamed from a terminal: Files and Source Control follow, open folders and a rename in progress stay', async () => {
  const root = project();
  repoAt(join(root, 'old-tools'));
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes', 'today.md'), 'x\n');
  writeFileSync(join(root, 'todo.md'), 'x\n');
  const s = await launch(root);
  try {
    await s.win.getByRole('button', { name: /^Files/ }).click();
    await treeRow(s.win, 'notes').click();
    await expect(treeRow(s.win, 'today.md')).toBeVisible();
    // A rename started on another row, left open.
    await treeRow(s.win, 'todo.md').click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Rename…' }).click();
    const field = s.win.locator('.tree-input');
    await expect(field).toBeVisible();
    renameSync(join(root, 'old-tools'), join(root, 'new-tools'));
    await expect(treeRow(s.win, 'new-tools')).toBeVisible({ timeout: 5000 });
    await expect(treeRow(s.win, 'old-tools')).toHaveCount(0);
    await expect(treeRow(s.win, 'notes')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeRow(s.win, 'today.md')).toBeVisible();
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('todo.md');
    await look(s.win.locator('.sidebar'), `${SHOTS}/discovery-rename.png`);
    await s.win.keyboard.press('Escape');
    // The only repository: Source Control's card names it by its new folder.
    await menu(s.app, 'Source Control');
    await expect(s.win.locator('.sw-card')).toContainText('new-tools', { timeout: 5000 });
    await expect(s.win.locator('.sw-card')).not.toContainText('old-tools');
  } finally {
    await s.stop();
  }
});

test('the search depth setting finds deeper repositories at once', async () => {
  const root = project();
  repoAt(join(root, 'api'));
  repoAt(join(root, 'a', 'b', 'c', 'd'));
  const s = await launch(root);
  try {
    await menu(s.app, 'Source Control');
    await expect(s.win.locator('.sw-card')).toContainText('api', { timeout: 15000 });
    // One repository: no All Repositories switch yet.
    await expect(s.win.getByRole('radio', { name: 'All Repositories' })).toHaveCount(0);
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'open-settings'));
    const dialog = s.win.getByRole('dialog', { name: 'Settings' });
    await dialog.locator('.set-nav-item', { hasText: 'Source Control' }).click();
    const stepper = dialog.getByRole('group', { name: 'Repository search depth' });
    await expect(stepper).toContainText('3 levels');
    await look(dialog, `${SHOTS}/discovery-settings.png`);
    await stepper.getByRole('button', { name: 'Increase Repository search depth' }).click();
    await expect(stepper).toContainText('4 levels');
    await s.win.keyboard.press('Escape');
    await allRepos(s.app, s.win);
    await expect(block(s.win, 'd')).toBeVisible({ timeout: 10000 });
  } finally {
    await s.stop();
  }
});

test('Changes with many repositories: a dozen, then "more", which shows the rest where the focus lands', async () => {
  const root = project();
  const names = Array.from({ length: 14 }, (_, i) => `r${String(i).padStart(2, '0')}`);
  for (const n of names) repoAt(join(root, n));
  const s = await launch(root);
  try {
    const changes = s.win.locator('aside.changes');
    // All clean: a dozen rows, then one that shows the other two.
    const more = changes.getByRole('button', { name: '2 more clean repositories' });
    await expect(more).toBeVisible({ timeout: 15000 });
    await expect(changes.locator('.clean-row')).toHaveCount(12);
    await look(changes, `${SHOTS}/discovery-clean-more.png`);
    await more.click();
    await expect(changes.locator('.clean-row')).toHaveCount(14);
    await expect(changes.locator('.clean-row').nth(12)).toBeFocused();
    // One repository with a change: the others as chips, a dozen of them, then "+1 more".
    writeFileSync(join(root, 'r00', 'a.txt'), 'changed\n');
    const chip = changes.getByRole('button', { name: '+1 more' });
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(changes.locator('.clean .chip-static')).toHaveCount(12);
    await look(changes, `${SHOTS}/discovery-chips-more.png`);
    await chip.click();
    await expect(changes.locator('.clean .chip-static')).toHaveCount(13);
    await expect(changes.locator('.clean .chip-static').nth(12)).toBeFocused();
  } finally {
    await s.stop();
  }
});

test('a folder scan stopped at its cap says so, with the setting one click away', async () => {
  const root = project();
  for (const n of ['a', 'b', 'c', 'd']) mkdirSync(join(root, n, 'inner'), { recursive: true });
  repoAt(join(root, 'api'));
  const s = await launch(root, { ATELIER_TEST_REPO_SEARCH_MAX_FOLDERS: '2' });
  try {
    await menu(s.app, 'Source Control');
    const note = s.win.locator('.scm-capped');
    await expect(note).toContainText('Stopped looking for repositories after 2 folders', { timeout: 15000 });
    await look(s.win.locator('.sidebar'), `${SHOTS}/discovery-capped.png`);
    await note.getByRole('button', { name: 'search depth' }).click();
    const dialog = s.win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('group', { name: 'Repository search depth' })).toBeVisible();
  } finally {
    await s.stop();
  }
});

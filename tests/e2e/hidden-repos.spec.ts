// Hide This Repository end to end: a clone a service keeps inside another repository is hidden from its context menu.
// It and the repositories inside it leave Source Control and Changes at once, a toast offers Undo, it stays hidden
// after a relaunch, and Settings › Source Control lists it with Show, which brings it back.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { e2eEnv } from './env';
import { commit, git } from '../support/git-fixture';
import { look } from './shots';

const SHOTS = 'test-results';

function repoAt(dir: string, files: Record<string, string> = { 'a.txt': 'a\n' }): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'feat: first', files);
  return dir;
}

/**
 * The layout this is for: `agent` ignores the clone it keeps in repo/, which holds a repository of its own (three
 * levels down: the default search depth reaches it).
 */
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-hide-')));
  const agent = repoAt(join(root, 'agent'), { '.gitignore': 'repo/\n', 'README.md': '# agent\n' });
  const clone = repoAt(join(agent, 'repo'));
  repoAt(join(clone, 'inner'));
  repoAt(join(root, 'tools'));
  return root;
}

async function launch(root: string, made = e2eEnv()) {
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${root}`], env: made.env });
  const win = await app.firstWindow();
  const stop = async () => {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(made.home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  };
  await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
  return { app, win, stop, made };
}

async function command(app: ElectronApplication, cmd: string) {
  await app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);
}

/** Source Control's All Repositories view: one block per working tree, named by its folder. */
async function allRepos(app: ElectronApplication, win: Page) {
  await command(app, 'view-scm');
  const all = win.getByRole('radio', { name: 'All Repositories' });
  await expect(all).toBeVisible({ timeout: 15000 });
  await all.click();
}
const blockNames = (win: Page) => win.locator('.scm-all-list > [role="listitem"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')).sort());
const block = (win: Page, name: string) => win.getByRole('listitem', { name, exact: true });
/** Changes' clean list names every repository. */
const inChanges = (win: Page, name: string) => win.locator('aside.changes').getByText(name, { exact: true });

async function hide(win: Page, name: string, shot?: string) {
  await block(win, name).locator('.ab-head').click({ button: 'right' });
  const item = win.getByRole('menuitem', { name: 'Hide This Repository' });
  await expect(item).toBeVisible();
  if (shot) await look(win, shot, { settle: 200 });
  await item.click();
}

test('a repository hidden from its context menu leaves Source Control and Changes with the ones inside it; Undo brings it back', async () => {
  const root = project();
  const s = await launch(root);
  try {
    await allRepos(s.app, s.win);
    await expect.poll(() => blockNames(s.win), { timeout: 15000 }).toEqual(['agent', 'inner', 'repo', 'tools']);
    await expect(inChanges(s.win, 'inner')).toBeVisible();
    await hide(s.win, 'repo', `${SHOTS}/hidden-repos-menu.png`);
    await expect.poll(() => blockNames(s.win), { timeout: 5000 }).toEqual(['agent', 'tools']);
    await expect(inChanges(s.win, 'inner')).toHaveCount(0);
    await expect(inChanges(s.win, 'repo')).toHaveCount(0);
    const toast = s.win.locator('.toast');
    await expect(toast).toContainText('repo hidden from Atelier');
    await expect(toast).toHaveClass(/is-info/);
    await look(s.win, `${SHOTS}/hidden-repos-toast.png`, { settle: 300 });
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => blockNames(s.win), { timeout: 10000 }).toEqual(['agent', 'inner', 'repo', 'tools']);
  } finally {
    await s.stop();
  }
});

test('a hidden repository stays hidden after a relaunch; Settings › Source Control lists it, and Show brings it back', async () => {
  const root = project();
  const first = await launch(root);
  try {
    await allRepos(first.app, first.win);
    await expect.poll(() => blockNames(first.win), { timeout: 15000 }).toEqual(['agent', 'inner', 'repo', 'tools']);
    await hide(first.win, 'repo');
    await expect.poll(() => blockNames(first.win), { timeout: 5000 }).toEqual(['agent', 'tools']);
  } finally {
    await first.stop();
  }
  const s = await launch(root, first.made);
  try {
    await allRepos(s.app, s.win);
    await expect.poll(() => blockNames(s.win), { timeout: 15000 }).toEqual(['agent', 'tools']);
    await expect(inChanges(s.win, 'tools')).toBeVisible();
    await expect(inChanges(s.win, 'repo')).toHaveCount(0);
    await command(s.app, 'open-settings');
    const dialog = s.win.getByRole('dialog', { name: 'Settings' });
    await dialog.locator('.set-nav-item', { hasText: 'Source Control' }).click();
    const list = dialog.getByRole('list', { name: `Hidden repositories in ${basename(root)}` });
    await expect(list.getByRole('listitem')).toHaveText(['agent/repoShow']);
    await look(dialog, `${SHOTS}/hidden-repos-settings.png`);
    await list.getByRole('button', { name: 'Show agent/repo in Source Control again' }).click();
    await expect(list).toHaveCount(0);
    await expect(dialog).toContainText('None. To hide one, right-click it in Source Control and choose Hide This Repository.');
    // Its button gone, the keyboard stays in Settings (on the row it was in), not back on the page.
    await expect.poll(() => s.win.evaluate(() => !!document.activeElement?.closest('.hid-repos'))).toBe(true);
    await s.win.keyboard.press('Escape');
    await expect.poll(() => blockNames(s.win), { timeout: 10000 }).toEqual(['agent', 'inner', 'repo', 'tools']);
  } finally {
    await s.stop();
  }
});

test('every repository hidden: Source Control and Changes say so, and their buttons open the hidden list in Settings', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-hide-')));
  repoAt(join(root, 'solo'));
  const s = await launch(root);
  try {
    await command(s.app, 'view-scm');
    const card = s.win.locator('.sw-card');
    await expect(card).toContainText('solo', { timeout: 15000 });
    await card.click({ button: 'right' });
    await s.win.getByRole('menuitem', { name: 'Hide This Repository' }).click();
    const empty = s.win.locator('.scm-empty');
    await expect(empty).toContainText('Every repository here is hidden');
    await expect(empty).toContainText('Atelier doesn’t look at the 1 repository this project hides.');
    await look(s.win.locator('.sidebar'), `${SHOTS}/hidden-repos-empty.png`, { settle: 300 });
    // Changes, too: not "No git repositories", which would send the user looking for a folder.
    const changes = s.win.locator('aside.changes .changes-body');
    await expect(changes).toContainText('Every repository here is hidden.');
    await expect(changes).not.toContainText('No git repositories');
    await look(s.win.locator('aside.changes'), `${SHOTS}/hidden-repos-changes-empty.png`, { settle: 300 });
    await empty.getByRole('button', { name: 'Hidden Repositories…' }).click();
    const dialog = s.win.getByRole('dialog', { name: 'Settings' });
    const list = dialog.getByRole('list', { name: `Hidden repositories in ${basename(root)}` });
    await expect(list.getByRole('listitem')).toHaveText(['soloShow']);
    await s.win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await changes.getByRole('button', { name: 'Hidden Repositories…' }).click();
    await expect(list.getByRole('listitem')).toHaveText(['soloShow']);
  } finally {
    await s.stop();
  }
});

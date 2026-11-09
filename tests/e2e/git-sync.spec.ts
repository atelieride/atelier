// Sync, Push, Publish in the Source Control sidebar: the split button under the repository
// card, a push rejected after another clone pushed (Pull Then Push), a new branch published, a branch behind brought up
// to date. Remotes are bare repositories in the run's temp root; every repository has its own identity (no user config).
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { commit, git } from '../support/git-fixture';
import { look } from './shots';
import { ENTER_GRACE_MS } from '../../src/renderer/git/sheet-keys';

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

/** A bare remote with one commit, the project cloned from it, another clone that pushes; both with a repo identity. */
function syncProject(): { base: string; project: string; other: string; up: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-sync-e2e-')));
  const seed = join(base, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'feat: first', { 'a.txt': 'a\n' });
  git(base, 'clone', '-q', '--bare', seed, 'up.git');
  for (const name of ['app', 'other']) {
    git(base, 'clone', '-q', join(base, 'up.git'), name);
    const dir = join(base, name);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
  }
  return { base, project: join(base, 'app'), other: join(base, 'other'), up: join(base, 'up.git') };
}

async function launch(project: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page; stop: () => Promise<void> }> {
  const { env, home } = e2eEnv(extra);
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

const subjects = (up: string, ref: string) => git(up, 'log', '--format=%s', ref).trim().split('\n');

test('a push rejected after another clone pushed: the sheet lists the remote commit, Pull Then Push puts both on the remote', async () => {
  const p = syncProject();
  commit(p.other, 'feat: from the other clone', { 'other.txt': 'other\n' });
  git(p.other, 'push', '-q', 'origin', 'main');
  commit(p.project, 'feat: local work', { 'local.txt': 'local\n' });
  const { win, stop } = await launch(p.project);
  try {
    // The view fetch saw the remote commit: diverged.
    const main = win.locator('.git-sync-main');
    await expect(main).toContainText('↓1', { timeout: 15000 });
    await expect(main).toContainText('↑1');
    await win.locator('.git-sync-more').click();
    await win.getByRole('menuitem', { name: 'Push', exact: true }).click();

    const sheet = win.getByRole('dialog', { name: 'origin/main moved on' });
    await expect(sheet).toBeVisible({ timeout: 15000 });
    await expect(sheet.locator('.git-sheet-commit')).toHaveCount(1);
    await expect(sheet.locator('.git-sheet-commit')).toContainText('feat: from the other clone');
    await expect(sheet.getByRole('button', { name: 'Force Push…' })).toBeVisible();
    await look(sheet, `${SHOTS}/git-push-rejected.png`, { settle: 300 });

    await sheet.getByRole('button', { name: 'Pull Then Push' }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => subjects(p.up, 'main'), { timeout: 20000 }).toEqual(['feat: local work', 'feat: from the other clone', 'feat: first']);
    await expect(win.locator('.toast')).toContainText('app is in sync', { timeout: 10000 });
    await expect(main).toHaveClass(/is-quiet/, { timeout: 15000 });
  } finally {
    await stop();
  }
});

test('Force Push…: Cancel has the focus in both sheets (Enter pushes nothing), the second names the commits dropped, Force Push leases what it showed', async () => {
  const p = syncProject();
  for (let i = 1; i <= 4; i++) commit(p.other, `feat: other ${i}`, { [`o${i}.txt`]: `${i}\n` });
  git(p.other, 'push', '-q', 'origin', 'main');
  commit(p.project, 'feat: local work', { 'local.txt': 'local\n' });
  const { win, stop } = await launch(p.project);
  const before = subjects(p.up, 'main');
  const rejected = win.getByRole('dialog', { name: 'origin/main moved on' });
  const pushFromMenu = async () => {
    await win.locator('.git-sync-more').click();
    await win.getByRole('menuitem', { name: 'Push', exact: true }).click();
    await expect(rejected).toBeVisible({ timeout: 15000 });
  };
  try {
    await expect(win.locator('.git-sync-main')).toContainText('↓4', { timeout: 15000 });
    // Opened by git's answer: Cancel has the focus; Enter closes it, nothing pulled or pushed.
    await pushFromMenu();
    await expect(rejected.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(rejected.locator('.git-sheet-commit')).toHaveCount(3);
    await expect(rejected.locator('.git-sheet-more')).toHaveText('and 1 more');
    await expect(rejected).toContainText("It has 4 commits you don't have");
    // An Enter as a sheet appears is swallowed on purpose (sheet-keys.ts): these come once the grace is over.
    await win.waitForTimeout(ENTER_GRACE_MS);
    await win.keyboard.press('Enter');
    await expect(rejected).toHaveCount(0);
    expect(subjects(p.up, 'main')).toEqual(before);
    expect(git(p.project, 'log', '-1', '--format=%s').trim()).toBe('feat: local work');

    // Force Push…: the second sheet names what would be dropped; Cancel has the focus there too.
    await pushFromMenu();
    await rejected.getByRole('button', { name: 'Force Push…' }).click();
    const force = win.getByRole('dialog', { name: 'Force push over origin/main?' });
    await expect(force).toBeVisible();
    await expect(force).toContainText('These 4 commits on origin/main would be dropped:');
    await expect(force.locator('.git-sheet-commit').first()).toContainText('feat: other 4');
    await expect(force.locator('.git-sheet-more')).toHaveText('and 1 more');
    await expect(force.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await look(force, `${SHOTS}/git-force-push.png`, { settle: 300 });
    await win.waitForTimeout(ENTER_GRACE_MS);
    await win.keyboard.press('Enter');
    await expect(force).toHaveCount(0);
    await win.waitForTimeout(500);
    expect(subjects(p.up, 'main')).toEqual(before);

    // Force Push: the lease names the oid shown, so git takes it; the other clone's commits are gone from the remote.
    await pushFromMenu();
    await rejected.getByRole('button', { name: 'Force Push…' }).click();
    await expect(force).toBeVisible();
    await force.getByRole('button', { name: 'Force Push', exact: true }).click();
    await expect.poll(() => subjects(p.up, 'main'), { timeout: 20000 }).toEqual(['feat: local work', 'feat: first']);
    await expect(win.locator('.toast')).toContainText('Pushed to origin/main', { timeout: 10000 });
  } finally {
    await stop();
  }
});

test('a new local branch: "Publish Branch", the sheet with origin preselected, published with its upstream set', async () => {
  const p = syncProject();
  git(p.project, 'checkout', '-q', '-b', 'feat/publish');
  commit(p.project, 'feat: to publish', { 'pub.txt': 'pub\n' });
  const { win, stop } = await launch(p.project);
  try {
    const main = win.locator('.git-sync-main');
    await expect(main).toHaveText('Publish Branch', { timeout: 15000 });
    await main.click();
    const sheet = win.getByRole('dialog', { name: 'Publish feat/publish' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('radio', { name: 'origin' })).toHaveAttribute('aria-checked', 'true');
    await expect(sheet.locator('.git-sheet-target')).toHaveText('origin/feat/publish');
    await look(sheet, `${SHOTS}/git-publish.png`, { settle: 300 });

    await sheet.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => { try { return subjects(p.up, 'feat/publish')[0]; } catch { return null; } }, { timeout: 20000 }).toBe('feat: to publish');
    expect(git(p.project, 'rev-parse', '--abbrev-ref', 'feat/publish@{u}').trim()).toBe('origin/feat/publish');
    await expect(win.locator('.toast')).toContainText('Pushed to origin/feat/publish', { timeout: 10000 });
    await expect(main).toHaveText('Sync', { timeout: 15000 });
  } finally {
    await stop();
  }
});

// A Windows PC took seconds to read the status after a pull, and the button kept "Sync ↓1" meanwhile. Here every read
// is held back that long: the button must say what the sync left as soon as it is done, and never go back to ↓1.
test('status reads as slow as on Windows: the moment Sync is done the button is in sync, and stays so', async () => {
  const DELAY = 2500;
  const p = syncProject();
  commit(p.other, 'feat: pushed meanwhile', { 'b.txt': 'b\n' });
  git(p.other, 'push', '-q', 'origin', 'main');
  const { win, stop } = await launch(p.project, { ATELIER_TEST_STATUS_DELAY_MS: String(DELAY) });
  try {
    const main = win.locator('.git-sync-main');
    await expect(main).toContainText('↓1', { timeout: 30000 });
    // Only commits to pull: the button is Pull, and its toast says so.
    await main.click();
    await expect(win.locator('.toast')).toContainText('Pulled from', { timeout: 20000 });
    // Before any status read from after the pull could come back: the button, and the current branch's row.
    const branchRow = win.locator('.ref-row.is-current');
    await expect(main).toHaveClass(/is-quiet/, { timeout: 500 });
    await expect(branchRow).not.toContainText('↓', { timeout: 500 });
    await look(win.locator('.scm-sidebar'), `${SHOTS}/git-sync-done-slow-status.png`);
    // Through the slow reads that follow (one started during the sync, then the fresh one): never ↓1 again.
    const seen: string[] = [];
    for (const end = Date.now() + DELAY * 2 + 500; Date.now() < end;) {
      seen.push(`${await main.innerText()} | ${await branchRow.innerText()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen.filter((x) => x.includes('↓'))).toEqual([]);
    await expect(main).toHaveText('Sync');
  } finally {
    await stop();
  }
});

test('behind only: "Pull ↓1", Pull brings it up to date and the button dims to Sync; no Read-only badge while Git actions are on', async () => {
  const p = syncProject();
  commit(p.other, 'feat: pushed meanwhile', { 'b.txt': 'b\n' });
  git(p.other, 'push', '-q', 'origin', 'main');
  const { win, stop } = await launch(p.project);
  try {
    await expect(win.locator('.scm-sidebar .scm-ro')).toHaveCount(0);
    const main = win.locator('.git-sync-main');
    await expect(main).toContainText('↓1', { timeout: 15000 });
    await expect(main).not.toContainText('↑');
    // Only commits to pull: the button says Pull (Sync is for both ways).
    await expect(main).toHaveText('Pull↓1');
    await expect(main).not.toHaveClass(/is-quiet/);
    await look(win.locator('.scm-sidebar'), `${SHOTS}/git-sync-button.png`, { settle: 300 });

    // The ▾ menu has the five actions.
    await win.locator('.git-sync-more').click();
    for (const name of ['Pull', 'Push', 'Fetch', 'Sync All Repositories', 'Fetch All Repositories']) await expect(win.getByRole('menuitem', { name, exact: true })).toBeVisible();
    await win.keyboard.press('Escape');

    await main.click();
    await expect.poll(() => git(p.project, 'log', '-1', '--format=%s').trim(), { timeout: 20000 }).toBe('feat: pushed meanwhile');
    await expect(main).toHaveClass(/is-quiet/, { timeout: 15000 });
    await expect(main).toHaveText('Sync');
    expect(git(p.project, 'status', '--porcelain')).toBe('');
  } finally {
    await stop();
  }
});

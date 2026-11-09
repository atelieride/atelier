// Fetch in Source Control: "when viewing" fetches the repository being shown, the History chip and the
// sidebar ↻ fetch by hand, failures say so, Settings › Source Control sets it. Since 2026-11-08 the Changes panel counts
// as viewing too. Remotes are local: a bare repo in the run's temp root, and a
// loopback HTTP server that answers 401. e2eEnv isolates fetch from the user's credentials.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScmFetchState } from '../../src/shared/scm';
import { e2eEnv } from './env';
import { commit, git } from '../support/git-fixture';
import { look } from './shots';

const SHOTS = 'test-results';

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
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

type AppEnv = { env: Record<string, string>; home: string };

/** `reuse`: an earlier launch's environment (its home: saved state, localStorage); `prefs`: preferences.json. */
async function launch(project: string, o: { reuse?: AppEnv; prefs?: object } = {}) {
  const { env, home } = o.reuse ?? e2eEnv();
  if (o.prefs) writeFileSync(join(home, 'preferences.json'), JSON.stringify(o.prefs));
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  return { app, win, home };
}

const command = (app: ElectronApplication, cmd: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', c), cmd);

/**
 * An environment whose app starts with Changes hidden: a first launch on an empty folder hides it, and the window's
 * localStorage (in the e2e home) keeps it for the next launch.
 */
async function changesHiddenEnv(): Promise<AppEnv> {
  const appEnv = e2eEnv();
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'atl-fetch-empty-')));
  const { app, win, home } = await launch(empty, { reuse: appEnv });
  try {
    await expect(win.locator('.changes')).toBeVisible({ timeout: 15000 });
    await command(app, 'toggle-changes');
    await expect(win.locator('.changes')).toHaveCount(0);
    await expect.poll(() => win.evaluate(() => localStorage.getItem('atelier.showChanges'))).toBe('0');
  } finally {
    await stop(app, home);
  }
  return appEnv;
}

const fetchStates = (win: Page) => win.evaluate(() => (window as unknown as { atelier: { scm: { fetchStates(): Promise<ScmFetchState[]> } } }).atelier.scm.fetchStates());
const focus = (win: Page) => win.evaluate(() => window.dispatchEvent(new Event('focus')));

/** A bare remote with one commit, the project cloned from it (never fetched: a clone writes no FETCH_HEAD), another clone. */
function clonedProject(): { project: string; other: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-fetch-e2e-')));
  const seed = join(base, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'feat: first', { 'a.txt': 'a\n' });
  git(base, 'clone', '-q', '--bare', seed, 'up.git');
  git(base, 'clone', '-q', join(base, 'up.git'), 'app');
  git(base, 'clone', '-q', join(base, 'up.git'), 'other');
  return { project: join(base, 'app'), other: join(base, 'other') };
}

function push(other: string, msg: string) {
  commit(other, msg, { [`${msg.length}-${Date.now()}.txt`]: msg });
  git(other, 'push', '-q', 'origin', 'main');
}

const fetchHead = (project: string) => { try { return statSync(join(project, '.git', 'FETCH_HEAD')).mtimeMs; } catch { return null; } };
const openScm = async (app: ElectronApplication, win: Page) => {
  await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
  await menu(app, 'Source Control');
  await expect(win.locator('.scm-sidebar')).toBeVisible();
};

test('when viewing: opening Source Control fetches a never-fetched repo once; the chip and ↻ fetch by hand', async () => {
  const { project, other } = clonedProject();
  push(other, 'feat: pushed before opening');
  // Changes hidden: it doesn't count as viewing, so the first fetch is Source Control's own (next test).
  const { app, win, home } = await launch(project, { reuse: await changesHiddenEnv() });
  try {
    await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.changes')).toHaveCount(0);
    expect(fetchHead(project)).toBeNull();
    await openScm(app, win);
    // The view fetch brought the pushed commit: the branch is now one behind.
    await expect(win.locator('.sw-card .sw-branch')).toHaveText('main · ↓1', { timeout: 15000 });
    expect(fetchHead(project)).not.toBeNull();
    const first = fetchHead(project);

    // Shown again (another activity and back, and a window focus): within 10 minutes, no new fetch (the gate itself:
    // src/main/fetch-scheduler.test.ts; checked once History has opened and shows its chip).
    await menu(app, 'Sessions');
    await openScm(app, win);
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));

    // The History chip: the age, then a manual fetch brings the next commit.
    await win.getByRole('button', { name: 'Show History' }).click();
    const chip = win.locator('.history-view .hv-fetch');
    await expect(chip).toHaveText('origin fetched just now');
    await expect(chip).toHaveClass(/is-fresh/);
    expect(fetchHead(project)).toBe(first);
    push(other, 'feat: pushed later');
    await chip.click();
    await expect(win.locator('.sw-card .sw-branch')).toHaveText('main · ↓2', { timeout: 15000 });
    await expect(win.locator('.history-view .hv-row', { hasText: 'feat: pushed later' })).toBeVisible({ timeout: 10000 });
    await look(win.locator('.history-view .hv-bar'), `${SHOTS}/fetch-chip.png`);

    // The sidebar ↻ and View › Fetch: manual too.
    push(other, 'feat: third');
    await win.locator('.scm-fetch-btn').click();
    await expect(win.locator('.sw-card .sw-branch')).toHaveText('main · ↓3', { timeout: 15000 });
    push(other, 'feat: fourth');
    await menu(app, 'Fetch');
    await expect(win.locator('.sw-card .sw-branch')).toHaveText('main · ↓4', { timeout: 15000 });
    await look(win.locator('.scm-sidebar .sidebar-head'), `${SHOTS}/fetch-sidebar.png`);

    // The palette has both commands; Fetch All says how many.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>fetch');
    await expect(win.locator('.palette-item', { hasText: 'Fetch All Repositories' })).toBeVisible();
    await win.locator('.palette-item', { hasText: 'Fetch All Repositories' }).click();
    await expect(win.locator('.toast')).toContainText('Fetched 1 repository', { timeout: 15000 });

    // The repo's context menu (switcher card) offers Fetch.
    await win.locator('.sw-card').click({ button: 'right' });
    await expect(win.getByRole('menuitem', { name: 'Fetch' })).toBeVisible();
    await win.keyboard.press('Escape');

    // Branches and files never changed: still on the first commit, nothing to commit.
    expect(git(project, 'log', '-1', '--format=%s', 'main').trim()).toBe('feat: first');
    expect(git(project, 'status', '--porcelain')).toBe('');
  } finally {
    await stop(app, home);
  }
});

/** A view fetch of our own: 'ok' only when it was the first to ask (no fetch running, none in the last 10 minutes). */
const probe = (win: Page, root: string) => win.evaluate((r) => (window as unknown as { atelier: { scm: { fetchRepo(r: string, why: 'view'): Promise<{ outcome: string | null }> } } }).atelier.scm.fetchRepo(r, 'view'), root);

test('Changes hidden: it asks nothing, at launch or on focus — a view fetch of our own is the first', async () => {
  const { project, other } = clonedProject();
  push(other, 'feat: pushed before opening');
  const { app, win, home } = await launch(project, { reuse: await changesHiddenEnv() });
  try {
    await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15000 });
    await expect(win.locator('.changes')).toHaveCount(0);
    await focus(win);
    await focus(win);
    // Main answers asks in order: had Changes asked (at launch or on these focuses), ours would join its fetch or meet
    // the 10-minute gate, and come back null.
    expect((await probe(win, project)).outcome).toBe('ok');
    expect(fetchHead(project)).not.toBeNull();
  } finally {
    await stop(app, home);
  }
});

test('Changes counts as viewing: a never-fetched repo is fetched without opening Source Control, ↓ next to its name; a focus within 10 minutes fetches nothing', async () => {
  const { project, other } = clonedProject();
  push(other, 'feat: pushed before opening');
  const { app, win, home } = await launch(project);
  try {
    const counts = win.locator('.changes .clean-row .sync-counts');
    await expect(counts).toHaveText('↓1', { timeout: 15000 });
    await expect(counts).toHaveAttribute('data-tip', '1 to pull from origin/main');
    await expect(win.locator('.scm-sidebar')).toHaveCount(0);
    await expect(win.locator('.toast')).toHaveCount(0);
    const first = fetchHead(project);
    expect(first).not.toBeNull();
    // Back to the front within 10 minutes: Changes asks again, main's gate says no (src/main/fetch-scheduler.test.ts).
    const before = await fetchStates(win);
    await focus(win);
    expect((await probe(win, project)).outcome).toBeNull();
    expect(await fetchStates(win)).toEqual(before);
    expect(fetchHead(project)).toBe(first);
    await look(win.locator('.changes'), `${SHOTS}/fetch-changes-viewing.png`);
  } finally {
    await stop(app, home);
  }
});

test('Auto-fetch Off: Changes shown fetches nothing; back to When viewing, its next ask (the window back in front) fetches', async () => {
  const { project, other } = clonedProject();
  push(other, 'feat: pushed before opening');
  const { app, win, home } = await launch(project, { prefs: { autoFetch: 'off' } });
  try {
    await expect(win.locator('.changes .clean-row')).toBeVisible({ timeout: 15000 });
    await focus(win);
    await focus(win);
    // Later, Source Control shown (its view fetch is refused too) and its card read: still never fetched.
    await openScm(app, win);
    await expect(win.locator('.sw-card .sw-branch')).toHaveText('main · synced');
    expect((await fetchStates(win)).map((x) => [x.running, x.last])).toEqual([[false, null]]);
    expect(fetchHead(project)).toBeNull();
    await expect(win.locator('.toast')).toHaveCount(0);
    // When viewing again, Source Control's sidebar closed (it would ask too): the window back to the front, Changes
    // (shown all along: Source Control is a sidebar of the Sessions space) asks again, and this time it fetches.
    await menu(app, 'Sessions');
    await expect(win.locator('.scm-sidebar')).toHaveCount(0);
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({ autoFetch: 'viewing' }));
    await focus(win);
    await expect(win.locator('.changes .clean-row .sync-counts')).toHaveText('↓1', { timeout: 15000 });
    expect(fetchHead(project)).not.toBeNull();
  } finally {
    await stop(app, home);
  }
});

let server: Server | null = null;
test.afterAll(() => { server?.close(); });

test('a remote that asks for credentials: "Fetch needs sign-in", a toast on a manual try, never a prompt; Settings › Source Control', async () => {
  server = createServer((_req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); res.end(); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x.git`;
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-fetch-auth-')));
  git(project, 'init', '-q', '-b', 'main');
  commit(project, 'feat: local', { 'a.txt': 'a\n' });
  git(project, 'remote', 'add', 'origin', url);
  const { app, win, home } = await launch(project);
  try {
    // Changes (shown) asks first: its view fetch meets the 401 and says nothing — no toast, no arrows; Source Control
    // shows the failure when opened.
    await expect(win.locator('.changes .clean-row')).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await fetchStates(win)).map((x) => x.last?.outcome ?? null), { timeout: 15000 }).toEqual(['auth']);
    await expect(win.locator('.toast')).toHaveCount(0);
    await expect(win.locator('.changes .sync-counts')).toHaveCount(0);
    await openScm(app, win);
    await expect(win.locator('.scm-fetch-btn')).toHaveClass(/is-failed/, { timeout: 15000 });
    await expect(win.locator('.scm-fetch-btn .scm-fetch-dot')).toHaveCount(1);
    await win.getByRole('button', { name: 'Show History' }).click();
    const chip = win.locator('.history-view .hv-fetch');
    await expect(chip).toHaveText('Fetch needs sign-in');
    await expect(chip).toHaveAttribute('data-tip', /Click to try again$/);
    await look(win.locator('.history-view .hv-bar'), `${SHOTS}/fetch-sign-in.png`);
    await chip.click();
    await expect(win.locator('.toast')).toContainText('Fetch needs sign-in', { timeout: 15000 });
    await expect(win.locator('.toast')).toContainText('Try Again');

    // Settings › Source Control: Auto-fetch, "When viewing" by default; Off is kept.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'open-settings'));
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.locator('.set-nav-item', { hasText: 'Source Control' }).click();
    await expect(dialog.getByRole('heading', { name: 'Source Control' })).toBeVisible();
    const seg = dialog.getByRole('radiogroup', { name: 'Auto-fetch' });
    await expect(seg.getByRole('radio', { name: 'When viewing' })).toHaveAttribute('aria-checked', 'true');
    await look(dialog, `${SHOTS}/fetch-settings.png`);
    await seg.getByRole('radio', { name: 'Off' }).click();
    await expect.poll(() => win.evaluate(() => (window as unknown as { atelier: { settings: { get(): Promise<{ autoFetch: string }> } } }).atelier.settings.get().then((s) => s.autoFetch))).toBe('off');
  } finally {
    await stop(app, home);
  }
});

test('a repo without a remote: no chip, no ↻, no Fetch commands', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-fetch-none-')));
  git(project, 'init', '-q', '-b', 'main');
  commit(project, 'feat: local', { 'a.txt': 'a\n' });
  const { app, win, home } = await launch(project);
  try {
    await openScm(app, win);
    await expect(win.locator('.sw-card .sw-branch')).toHaveText('main · local');
    await expect(win.locator('.scm-fetch-btn')).toHaveCount(0);
    await win.getByRole('button', { name: 'Show History' }).click();
    await expect(win.locator('.history-view .hv-row').first()).toBeVisible();
    await expect(win.locator('.history-view .hv-fetch')).toHaveCount(0);
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill('>fetch');
    await expect(win.locator('.palette-item', { hasText: 'Fetch' })).toHaveCount(0);
  } finally {
    await stop(app, home);
  }
});

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { adhocRequirement, makeApp, makeRelease, releaseRoutes, serve, testKey } from '../fixtures/update-fixture';
import { look } from './shots';

// The in-app updater against a local feed on 127.0.0.1 (ATELIER_TEST_UPDATE, devEnv): a release laid out like GitHub's,
// signed with a throwaway key, carrying a tiny ad-hoc signed app. Never the real GitHub, never the user's apps.

const servers: { close(): void }[] = [];
const cleanups: (() => void)[] = [];
test.afterAll(() => { for (const s of servers) s.close(); for (const c of cleanups) c(); });

async function fixture(o: { tamper?: boolean; readOnlyOwn?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atl-e2e-upd-'));
  const own = makeApp(join(dir, 'own'), { version: '0.1.0', builtAt: 1, sign: false });
  // The "running app" in a folder this user cannot write: it could never be replaced by an update.
  if (o.readOnlyOwn) { chmodSync(join(dir, 'own'), 0o555); cleanups.push(() => chmodSync(join(dir, 'own'), 0o755)); }
  // Always newer than the running build, whatever version the dev app reports.
  const next = makeApp(join(dir, 'next'), { version: '999.0.0', builtAt: 2 });
  const key = testKey();
  const rel = makeRelease({ version: '999.0.0', app: next, dir, key: key.privateKey, notes: '### Added\n- Updates inside the app\n- A "What\'s new" notice after restarting' });
  const routes = releaseRoutes(rel, o.tamper ? { yml: rel.yml.replace('Updates inside', 'Malware inside') } : {});
  const srv = await serve(routes);
  servers.push(srv.server);
  return { flag: JSON.stringify({ feed: srv.base, app: own, requirement: adhocRequirement(next), publicKey: key.publicKey, channel: 'stable' }), hits: srv.hits };
}

async function launch(extra: Record<string, string>): Promise<{ app: ElectronApplication; home: string }> {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ...extra });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { app, home };
}

async function stop(app: ElectronApplication, home: string) {
  await app.close();
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

test('Check for Updates… (app menu) opens About and stages a signed release: "ready", with its notes', async () => {
  const f = await fixture();
  const { app, home } = await launch({ ATELIER_TEST_UPDATE: f.flag });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('check-for-updates');
      if (item?.label !== 'Check for Updates…') throw new Error('no Check for Updates… in the app menu');
      item.click(undefined, BrowserWindow.getAllWindows()[0]);
    });
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('heading', { name: 'About' })).toBeVisible();
    // "Auto" (the default) names the build's channel (from the stamp, here the test flag).
    await expect(dialog.getByRole('radio', { name: 'Auto (Stable)' })).toHaveAttribute('aria-checked', 'true');
    const card = dialog.getByRole('status', { name: 'Updates' });
    await expect(card).toContainText('Atelier 999.0.0 is ready', { timeout: 30000 });
    await expect(card).toContainText('your sessions keep running');
    await expect(dialog.getByRole('region', { name: "What's new in 999.0.0" })).toContainText('Updates inside the app');
    await expect(dialog).toContainText('Just now');
    // What the check sends, said where the channel is chosen, with the full page one click away (not clicked here:
    // it would open the user's browser).
    await expect(dialog.getByText('Update checks send the app version and an anonymous daily ping. Off sends nothing.')).toBeVisible();
    const privacy = dialog.getByRole('button', { name: 'Privacy' });
    await expect(privacy).toBeVisible();
    // Never flat: the link answers the pointer.
    const color = () => privacy.evaluate((e) => getComputedStyle(e).color);
    const rest = await color();
    await privacy.hover();
    await expect.poll(color).not.toBe(rest);
    expect(existsSync(join(home, 'updates/Atelier.app/Contents/Info.plist'))).toBe(true);
    expect(f.hits.some((u) => u.startsWith('/cdn/'))).toBe(true);
    // The first check of the day, week and month says so: active installs are counted from it.
    expect(f.hits.find((u) => u.startsWith('/updates/releases'))).toBe('/updates/releases?a=dwm');
    await look(win, 'test-results/updates-about-ready.png');
    // Switching the channel is saved like any setting.
    const saved = () => (JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8')) as { updateChannel: string }).updateChannel;
    await dialog.getByRole('radio', { name: 'Beta' }).click();
    await expect(dialog.getByRole('radio', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(saved).toBe('beta');
    // And back to following the build.
    await dialog.getByRole('radio', { name: 'Auto (Stable)' }).click();
    await expect(dialog.getByRole('radio', { name: 'Auto (Stable)' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(saved).toBe('auto');
  } finally {
    await stop(app, home);
  }
});

test('Check Now with a tampered feed: a clear error, nothing downloaded or staged', async () => {
  const f = await fixture({ tamper: true });
  const { app, home } = await launch({ ATELIER_TEST_UPDATE: f.flag });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'About' }).click();
    await dialog.getByRole('button', { name: 'Check Now' }).click();
    const card = dialog.getByRole('status', { name: 'Updates' });
    await expect(card).toContainText('Update failed', { timeout: 30000 });
    await expect(card).toContainText("wasn't signed with Atelier's release key");
    expect(f.hits.some((u) => u.includes('.zip') || u.startsWith('/cdn/'))).toBe(false);
    expect(existsSync(join(home, 'updates/Atelier.app'))).toBe(false);
    await expect.poll(() => { try { return readFileSync(join(home, 'logs/app.log'), 'utf8'); } catch { return ''; } }).toMatch(/\[main:update\].*signature/);
    await look(win, 'test-results/updates-about-error.png');
  } finally {
    await stop(app, home);
  }
});

test('an app that cannot replace itself: "Move Atelier to your Applications folder", nothing downloaded, Finder on Applications', async () => {
  const f = await fixture({ readOnlyOwn: true });
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-e2e-url-')), 'urls.log');
  const { app, home } = await launch({ ATELIER_TEST_UPDATE: f.flag, ATELIER_TEST_URL_LOG: urlLog });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Settings' }).click();
    const dialog = win.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'About' }).click();
    await dialog.getByRole('button', { name: 'Check Now' }).click();
    const card = dialog.getByRole('status', { name: 'Updates' });
    await expect(card).toContainText('Move Atelier to your Applications folder to get updates', { timeout: 30000 });
    await expect(card).toContainText('Atelier 999.0.0 is available');
    expect(f.hits.some((u) => u.includes('.zip') || u.startsWith('/cdn/'))).toBe(false);
    expect(existsSync(join(home, 'updates/Atelier.app'))).toBe(false);
    await look(win, 'test-results/updates-about-location.png');
    await card.getByRole('button', { name: 'Open Applications' }).click();
    await expect.poll(() => { try { return readFileSync(urlLog, 'utf8'); } catch { return ''; } }).toContain('finder:/Applications');
    // The footer says so too, quietly.
    await expect(win.locator('.foot-update.is-quiet')).toContainText('Update available');
  } finally {
    await stop(app, home);
  }
});

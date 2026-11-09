import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// The Microsoft Store's updates inside Atelier: the dev app on Windows with
// the Store scripted through ATELIER_TEST_STORE (devEnv, inert when packaged; src/main/store-exec.ts › fakeRunner), the
// relaunch recorded in ATELIER_TEST_RELAUNCH_LOG instead of done, links in ATELIER_TEST_URL_LOG. Run on the test PC:
//   npx playwright test --config playwright.manual.config.ts tests/e2e/store-updates-win.manual.ts

test.skip(process.platform !== 'win32', 'the Store updates the Windows app');
// A click that can't happen fails with its locator instead of hanging until the test's timeout.
test.use({ actionTimeout: 15_000 });

const FAMILY = 'FrancescoMusso.AtelierIDE_q82zjjpjsmf54';
const check = (o: { registered: string; updates: number; silent: 0 | 1 }) => `family ${FAMILY}\nregistered ${o.registered}\nupdates ${o.updates}\nsilent ${o.silent}\n`;

interface Run { app: ElectronApplication; win: Page; home: string; dir: string; closed?: boolean }

async function launch(script: object | null, extra: Record<string, string> = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'atl-store-'));
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const vars: Record<string, string> = { ATELIER_TEST_URL_LOG: join(dir, 'urls.log'), ATELIER_TEST_RELAUNCH_LOG: join(dir, 'relaunch.log'), ...extra };
  if (script) { writeFileSync(join(dir, 'store.json'), JSON.stringify(script)); vars.ATELIER_TEST_STORE = join(dir, 'store.json'); }
  const { env, home } = e2eEnv(vars);
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  await expect(win.locator('.footer')).toBeVisible({ timeout: 30000 });
  return { app, win, home, dir };
}

function stopDaemon(home: string): void {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* already stopped */ }
}

/**
 * Closes the app, then its atelierd (as packaged-win.manual.ts): atelierd holds the stdio pipes Playwright gave the app,
 * and Playwright's close waits for them; so the app's process ends first, then the daemon, then the close returns.
 */
async function close(r: Run): Promise<void> {
  if (r.closed) return;
  r.closed = true;
  const proc = r.app.process();
  const exited = new Promise<void>((done) => { if (proc.exitCode !== null) done(); else proc.once('exit', () => done()); });
  const closing = r.app.close().catch(() => {});
  await exited;
  stopDaemon(r.home);
  await closing;
}

/** Help › <item> through the header's folded menu, as a user clicks it. */
async function help(win: Page, item: string): Promise<void> {
  await win.locator('.menubar-toggle').click();
  await win.locator('.menubar-title', { hasText: 'Help' }).click();
  await win.getByRole('menuitem', { name: item }).click();
}

const readLog = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

test('Help › Check for Updates… asks the Store, installs in the background, then Restart relaunches the registered version', async () => {
  test.setTimeout(120_000);
  const r = await launch({
    // What the packaged run showed: after the install nothing newer is registered yet (Windows staged it until Atelier
    // closes) and the Store lists nothing more. (A version already registered: store-updates.test.ts.)
    checks: [check({ registered: '0.2.21.0', updates: 1, silent: 1 }), check({ registered: '0.2.21.0', updates: 0, silent: 1 })],
    update: { lines: ['progress 0.250', 'progress 0.500', 'progress 0.750', 'progress 1.000', 'done completed'], intervalMs: 2000 }
  }, { ATELIER_TEST_STORE_DELAY_MS: '3600000' });
  try {
    await help(r.win, 'Check for Updates…');
    const dialog = r.win.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('heading', { name: 'About' })).toBeVisible();
    const card = dialog.getByRole('status', { name: 'Updates' });
    await expect(card).toContainText('Installing the update · 50%', { timeout: 15000 });
    await look(dialog, 'test-results/store-updates/installing.png');
    // Nothing of macOS's updater: no channel, no privacy note about our site.
    await expect(dialog.getByRole('radiogroup', { name: 'Channel' })).toHaveCount(0);
    await expect(dialog).toContainText('Updates come from the Microsoft Store.');
    await expect(card).toContainText('The update is ready', { timeout: 20000 });
    await expect(card).toContainText('your sessions keep running');
    await expect(card.getByRole('button', { name: "What's New" })).toBeVisible();
    await look(dialog, 'test-results/store-updates/ready.png');
    await r.win.keyboard.press('Escape');
    const pill = r.win.locator('.foot-update');
    await expect(pill).toContainText('Update ready');
    await expect(pill).toContainText('Restart');
    await look(r.win, 'test-results/store-updates/pill.png');
    // Restart: the app quits and asks Windows for the package's app (the registered version), once.
    const exited = new Promise<void>((done) => r.app.process().once('exit', () => done()));
    await pill.click();
    await exited;
    expect(readLog(join(r.dir, 'relaunch.log'))).toBe(`shell:AppsFolder\\${FAMILY}!Atelier\n`);
  } finally {
    await close(r);
  }
});

test('a Store update Atelier does not install itself: a quiet "Update available", then Open Microsoft Store', async () => {
  const r = await launch({ checks: [check({ registered: '0.2.21.0', updates: 1, silent: 0 })] }, { ATELIER_TEST_STORE_DELAY_MS: '500' });
  try {
    const pill = r.win.locator('.foot-update.is-quiet');
    await expect(pill).toContainText('Update available', { timeout: 15000 });
    await expect(pill).toHaveAttribute('data-tip', /Microsoft Store/);
    await pill.click();
    const dialog = r.win.getByRole('dialog', { name: 'Settings' });
    const card = dialog.getByRole('status', { name: 'Updates' });
    await expect(card).toContainText('An update is in the Microsoft Store');
    await expect(card).toContainText('Automatic app updates are off');
    await look(dialog, 'test-results/store-updates/in-store.png');
    await card.getByRole('button', { name: 'Open Microsoft Store' }).click();
    await expect.poll(() => readLog(join(r.dir, 'urls.log'))).toBe('ms-windows-store://pdp/?ProductId=9N9FX0BQ20HF\n');
    // Never a relaunch without a Restart.
    await close(r);
    expect(readLog(join(r.dir, 'relaunch.log'))).toBe('');
  } finally {
    await close(r);
  }
});

test('a check that fails is amber and retried; Check Now gets the answer', async () => {
  const r = await launch({ checks: ['error 803f6101 ', check({ registered: '0.2.21.0', updates: 0, silent: 1 })] }, { ATELIER_TEST_STORE_DELAY_MS: '500' });
  try {
    await help(r.win, 'About Atelier');
    const dialog = r.win.getByRole('dialog', { name: 'Settings' });
    const card = dialog.getByRole('status', { name: 'Updates' });
    await expect(card).toContainText("Couldn't check the Microsoft Store", { timeout: 15000 });
    await expect(r.win.locator('.foot-update')).toHaveCount(0);
    await look(dialog, 'test-results/store-updates/check-failed.png');
    await dialog.getByRole('button', { name: 'Check Now' }).click();
    await expect(card).toContainText('Atelier is up to date');
  } finally {
    await close(r);
  }
});

test('a dev run (no package): where updates come from, no Check Now, no pill', async () => {
  const r = await launch(null);
  try {
    await help(r.win, 'Check for Updates…');
    const dialog = r.win.getByRole('dialog', { name: 'Settings' });
    const card = dialog.getByRole('status', { name: 'Updates' });
    await expect(card).toContainText('Updates come from the Microsoft Store');
    await expect(dialog.getByRole('button', { name: 'Check Now' })).toHaveCount(0);
    await expect(r.win.locator('.foot-update')).toHaveCount(0);
  } finally {
    await close(r);
  }
});

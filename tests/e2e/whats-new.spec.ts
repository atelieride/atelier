import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareSemver } from '../../src/shared/update-feed';
import { e2eEnv } from './env';
import { look } from './shots';

// What's new after an update: the previous launch's version is older than the running
// one (written into the test home's updater state, as an update leaves it), so the sheet opens once with the CHANGELOG
// sections in between, newest open (a long gap's cap of six and its count: src/shared/whats-new.test.ts); Atelier ›
// What's New… (here from the palette) shows the running version alone.

/** Looked at by hand (git-ignored). */
const SHOTS = resolve('e2e-shots/small-asks');
const VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
/** Releases in CHANGELOG.md up to the running version: a release being cut adds its section before package.json is
 *  bumped, and the app never lists a version newer than itself. */
const VERSIONS = [...readFileSync('CHANGELOG.md', 'utf8').matchAll(/^## (\d\S*)/gm)].map((m) => m[1] ?? '').filter((v) => compareSemver(v, VERSION) <= 0);
/** The previous launch: four releases back, so the sheet lists four (under the cap of six) whatever gets released next. */
const SINCE = VERSIONS[4]!;
/** The oldest release the sheet lists, collapsed. */
const COLLAPSED = VERSIONS[3]!;
const daemonPid = (home: string) => (JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid;
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

function lastRun(home: string, version: string) {
  mkdirSync(join(home, 'updates'), { recursive: true });
  writeFileSync(join(home, 'updates', 'state.json'), JSON.stringify({ lastRunVersion: version }));
}

test('What\'s new opens once after an update, with every release since the previous launch', async () => {
  test.setTimeout(90_000);
  mkdirSync(SHOTS, { recursive: true });
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const urlLog = join(mkdtempSync(join(tmpdir(), 'atl-url-')), 'urls.txt');
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl'), ATELIER_TEST_URL_LOG: urlLog });
  const launch = async (): Promise<{ app: ElectronApplication; win: Page }> => {
    // The app folder (not the script): app.getVersion() is then Atelier's version, as in the packaged app.
    const app = await electron.launch({ args: ['.', `--project=${project}`], env });
    const win = await app.firstWindow();
    await expect(win.locator('.footer')).toBeVisible({ timeout: 15000 });
    return { app, win };
  };
  lastRun(home, SINCE);
  let { app, win } = await launch();
  try {
    const sheet = win.getByRole('dialog', { name: "What's new" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('h2')).toHaveText("What's new in Atelier");
    await expect(sheet.locator('.wn-from')).toHaveText(`Updated from ${SINCE}`);
    await expect(sheet.locator('.wn-version')).toHaveText(VERSION);
    // Newest first, the newest open; SINCE itself was already seen.
    const rels = sheet.locator('.wn-rel-version');
    await expect(rels.first()).toHaveText(VERSION);
    await expect(rels).not.toContainText([SINCE]);
    await expect(rels).toHaveCount(4);
    await expect(sheet.locator('.wn-rel.is-open')).toHaveCount(1);
    await expect(sheet.locator('.wn-rel').first()).toHaveClass(/is-open/);
    await expect(sheet.locator('.wn-latest')).toHaveCount(1);
    // Bold lead-ins are elements, never raw asterisks; a wrapped bullet stays one item.
    await expect(sheet.locator('.wn-notes strong').first()).toBeVisible();
    await expect(sheet.locator('.wn-notes')).not.toContainText('**');
    // The keyboard is on "Got it".
    await expect(sheet.getByRole('button', { name: 'Got it' })).toBeFocused();
    await look(win, join(SHOTS, 'whats-new.png'), { settle: 400 });

    // A collapsed version says how much it holds; it opens on click.
    await expect(sheet.locator('.wn-rel-head').filter({ has: win.getByText(COLLAPSED, { exact: true }) }).locator('.wn-count')).toHaveText(/^\d+ changes?$/);
    await sheet.locator('.wn-rel-head').filter({ has: win.getByText(COLLAPSED, { exact: true }) }).click();
    await expect(sheet.locator('.wn-rel.is-open')).toHaveCount(2);
    // Full changelog: the website, in the browser (logged in tests).
    await sheet.locator('.wn-foot .link-btn').click();
    await expect.poll(() => lines(urlLog)).toContain('https://useatelier.dev/changelog');
    await sheet.getByRole('button', { name: 'Got it' }).click();
    await expect(sheet).toHaveCount(0);
    // No toast any more: the sheet replaced it.
    await expect(win.locator('.toast', { hasText: 'Atelier updated to' })).toHaveCount(0);

    // A relaunch on the same version: nothing. The window asks main for the one-shot as it opens; asked again after it,
    // main has nothing, and the window's own answer came first (replies come in order).
    await app.close();
    ({ app, win } = await launch());
    expect(await win.evaluate(() => (window as unknown as { atelier: { update: { whatsNew(): Promise<unknown> } } }).atelier.update.whatsNew())).toBeNull();
    await expect(win.locator('.wn')).toHaveCount(0);

    // From the palette: the running version's notes alone, no "Updated from"; Escape closes.
    await win.keyboard.press('F1');
    await win.locator('.palette-input').fill(">what's new");
    await win.keyboard.press('Enter');
    await expect(win.locator('.wn .wn-rel-version')).toHaveText([VERSION]);
    await expect(win.locator('.wn-from')).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(win.locator('.wn')).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('What\'s new also shows on the Welcome window (it takes the one-shot from main)', async () => {
  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  lastRun(home, SINCE);
  const app = await electron.launch({ args: ['.'], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.welcome')).toBeVisible({ timeout: 15000 });
    await expect(win.getByRole('dialog', { name: "What's new" })).toBeVisible();
    await look(win, join(SHOTS, 'whats-new-welcome.png'), { settle: 500 });
    await win.keyboard.press('Escape');
    await expect(win.locator('.wn')).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill(daemonPid(home), 'SIGTERM'); } catch { /* already stopped */ }
  }
});

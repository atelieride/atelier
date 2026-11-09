import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { makeDemoProject } from './site-shots/demo-project';
import { SENSITIVE, SHOTS_ONLY, findBanned } from '../support/banned-strings';
import { FakeDocker } from '../support/fake-docker';
import { stageDocker } from './docker-fixture';
import { FakeRedis } from '../support/fake-redis';
import { acmeStore } from '../support/redis-fixtures';
import { SCENARIOS, type ScenarioName } from '../../src/demo/world/scenarios';
import { claudeAccountsAt, scenarioAccount } from '../../src/demo/world/accounts';
import { AUTHOR } from '../../src/demo/world/project';

// Microsoft Store screenshots: the Windows app (dev build in out/, `npm run build`) with its own frame, the website's
// fictional project and scripted sessions (tests/e2e/fake-claude-demo.mjs), nothing of the PC. The window is shown
// and captured with PrintWindow (the caption buttons are not part of the page), so this runs in the logged-on user's
// session, not over SSH:
//   npx playwright test --config playwright.manual.config.ts tests/e2e/store-shots-win.manual.ts
// (STORE_SHOTS_X=1920: on a second display to the right, so the primary one stays free.) The PNGs go to
// ATELIER_STORE_SHOTS_DIR, test-results/store-shots by default.
// The project is staged at C:\code\acme-store (the header shows its path) and removed at the end. Every PNG is looked
// at before it is used.
test.skip(process.platform !== 'win32', 'the Store shots are taken on Windows');

const OUT = resolve(process.env.ATELIER_STORE_SHOTS_DIR || 'test-results/store-shots');
const WINDOW = { width: 1920, height: 1080 };
const PROJECT_PARENT = 'C:\\';
const COMMIT_MESSAGE = 'Greet returning customers by name';
const SESSIONS = Object.keys(SCENARIOS) as ScenarioName[];
// Nothing of the PC either: its user, its name, its user folders and temp folders.
const BANNED = [...SENSITIVE, ...SHOTS_ONLY, new RegExp(userInfo().username, 'i'), new RegExp(`\\b${hostname()}\\b`), /AppData/i, /\\Users\\/i, /\\Temp\\/i];

// PrintWindow renders the window itself, caption buttons included, whatever covers it; the crop is the window's visible
// frame (DWM's bounds, without the invisible resize borders). `-Measure` only prints that frame.
const CAPTURE_PS1 = String.raw`param([long] $Hwnd, [string] $Out, [switch] $Measure)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class StoreShot {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int size);
}
'@
$h = [IntPtr]$Hwnd
$w = New-Object StoreShot+R; [void][StoreShot]::GetWindowRect($h, [ref]$w)
$f = New-Object StoreShot+R; [void][StoreShot]::DwmGetWindowAttribute($h, 9, [ref]$f, 16)
if ($Measure) { "$($f.L) $($f.T) $($f.Ri - $f.L) $($f.B - $f.T)"; return }
# The real pointer rests on the title bar's empty drag area: no hover, no tooltip.
[void][StoreShot]::SetCursorPos($f.L + 1100, $f.T + 12)
$bmp = New-Object System.Drawing.Bitmap ($w.Ri - $w.L), ($w.B - $w.T), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
$ok = [StoreShot]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
$crop = $bmp.Clone((New-Object System.Drawing.Rectangle ($f.L - $w.L), ($f.T - $w.T), ($f.Ri - $f.L), ($f.B - $f.T)), $bmp.PixelFormat)
$crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"$ok $($crop.Width)x$($crop.Height)"
`;

/** The world's accounts (world/accounts.ts) with Windows separators. */
function winAccounts(home: string) {
  const a = claudeAccountsAt(home);
  return { ...a, list: a.list.map((x) => ({ ...x, dir: x.dir.replace(/\//g, '\\') })) };
}

let capture = '';
let hwnd = '';

function ps(...args: string[]): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', capture, '-Hwnd', hwnd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

/** Puts the window's visible frame at the screen's corner, exactly WINDOW wide and high: the primary screen's, or the
 * one starting at STORE_SHOTS_X (a second display, so the primary one stays free). */
async function fitWindow(app: ElectronApplication) {
  hwnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readBigUInt64LE(0).toString());
  const x0 = Number(process.env.STORE_SHOTS_X ?? 0);
  let bounds = { x: x0, y: 0, ...WINDOW };
  for (let i = 0; i < 3; i++) {
    await app.evaluate(({ BrowserWindow }, b) => { const w = BrowserWindow.getAllWindows()[0]!; w.unmaximize(); w.setBounds(b); w.focus(); }, bounds);
    await new Promise((r) => setTimeout(r, 500));
    const [x, y, width, height] = ps('-Measure').split(' ').map(Number) as [number, number, number, number];
    if (x === x0 && y === 0 && width === WINDOW.width && height === WINDOW.height) return;
    bounds = { x: bounds.x + x0 - x, y: bounds.y - y, width: bounds.width + WINDOW.width - width, height: bounds.height + WINDOW.height - height };
  }
  throw new Error(`the window's frame is not ${WINDOW.width}×${WINDOW.height} at ${x0},0: ${ps('-Measure')}`);
}

// The app folder, not out/main/index.js: the footer shows the app's version (package.json), not Electron's.
async function launch(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: ['--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', '.', `--project=${project}`], env });
  const win = await app.firstWindow();
  await fitWindow(app);
  return { app, win };
}

/** A command from the title bar's menu, as a click there would run it. */
async function menu(win: Page, top: string, label: string) {
  await win.locator('.menubar-toggle').click();
  await win.locator('.menubar-title', { hasText: new RegExp(`^${top}$`) }).click();
  await win.locator('.ctx-item').filter({ has: win.locator('.ctx-label').getByText(label, { exact: true }) }).first().click();
}

async function newSession(win: Page, name: string) {
  await win.locator('.btn-new').click();
  await win.getByRole('menuitem', { name: 'Claude Session' }).click();
  await win.getByPlaceholder('Session name (optional)').fill(name);
  if (scenarioAccount(SCENARIOS[name as ScenarioName]).id === 'work') {
    await win.keyboard.press('Tab');
    await expect(win.locator('.acct-card.is-on')).toContainText('Work');
  }
  await win.keyboard.press('Enter');
  await expect(win.locator('.session-row', { hasText: name })).toBeVisible({ timeout: 20000 });
}

/** Opens a file from the palette (F1), in the focused pane or, with `side`, in a new pane on the right. */
async function openFile(win: Page, query: string, file: string, side = false) {
  await win.keyboard.press('F1');
  await win.locator('.palette-input').fill(query);
  await win.locator('.palette-item', { hasText: file }).first().click(side ? { modifiers: ['Alt'] } : undefined);
}

/**
 * Takes one shot into `shots` (written only when every shot passed). As the website's (site-shots.manual.ts): the
 * staged UI is on screen and drawn, no unread bell, no caret, no hover or tooltip, animations at rest, no real text.
 */
async function shot(win: Page, shots: Map<string, Buffer>, name: string, staged: Locator) {
  await expect(staged, `"${name}": the staged UI is on screen`).toBeVisible({ timeout: 20000 });
  if (await win.locator('.bell-count').count()) {
    await win.locator('.bell-btn').click();
    await win.getByRole('button', { name: 'Mark all as read' }).click();
    await win.locator('.bell-btn').click();
    await expect(win.locator('.bell-count')).toHaveCount(0);
  }
  await win.evaluate(() => {
    if (!document.getElementById('shots-no-caret')) {
      const style = Object.assign(document.createElement('style'), { id: 'shots-no-caret', textContent: '.cm-cursorLayer { display: none !important; } input, textarea { caret-color: transparent !important; }' });
      document.head.append(style);
    }
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.tagName === 'BUTTON') a.blur();
  });
  await win.mouse.move(1100, 12);
  await win.waitForTimeout(800);
  await win.evaluate(() => document.dispatchEvent(new WheelEvent('wheel')));
  await expect(win.locator('.tooltip'), `"${name}": no tooltip in the shot`).toHaveCount(0);
  await win.evaluate(() => document.getAnimations().forEach((a) => {
    if (a.effect?.getTiming().iterations === Infinity) { a.pause(); a.currentTime = 0; } else a.finish();
  }));
  const text = await win.evaluate(() => [
    document.body.innerText,
    ...[...document.querySelectorAll('.xterm-rows')].map((e) => e.textContent ?? ''),
    ...[...document.querySelectorAll('[title],[aria-label]')].map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`),
    ...[...document.querySelectorAll('input,textarea')].map((e) => (e as HTMLInputElement).value)
  ].join(' '));
  const hits = findBanned(text, BANNED);
  expect(hits, `banned text in shot "${name}": ${hits.map((h) => text.slice(Math.max(0, text.indexOf(h) - 80), text.indexOf(h) + 60)).join(' | ')}`).toEqual([]);
  // Each shot also lands in test-results as it is taken, to look at when a later one fails.
  mkdirSync(resolve('test-results/store-shots'), { recursive: true });
  const file = resolve('test-results/store-shots', `${name}.png`);
  const out = ps('-Out', file);
  expect(out, `"${name}": PrintWindow, ${WINDOW.width}×${WINDOW.height}`).toBe(`True ${WINDOW.width}x${WINDOW.height}`);
  const png = readFileSync(file);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([WINDOW.width, WINDOW.height]);
  shots.set(`${name}.png`, png);
  await win.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
}

test('Microsoft Store screenshots', async () => {
  test.setTimeout(420000);
  const project = join(PROJECT_PARENT, 'code', 'acme-store');
  const madeParent = !existsSync(join(PROJECT_PARENT, 'code'));
  // The fictional user's home beside it (Claude's config dirs, the Work account's shows in its launch command).
  const fakeHome = join(PROJECT_PARENT, 'code', 'home');
  for (const p of [project, fakeHome]) expect(existsSync(p), `${p} already exists: never overwritten`).toBe(false);
  mkdirSync(fakeHome, { recursive: true });
  capture = join(mkdtempSync(join(tmpdir(), 'atl-store-ps-')), 'capture.ps1');
  writeFileSync(capture, CAPTURE_PS1);
  makeDemoProject(PROJECT_PARENT);
  for (const k of ['name', 'email'] as const) execFileSync('git', ['config', `user.${k}`, AUTHOR[k]], { cwd: project });
  // The demo Claude (fake-claude-demo.mjs, through a .cmd: PowerShell runs a script, not a module) reads the world's
  // scenarios as JSON, each with its account's limits.
  const scenarios = join(mkdtempSync(join(tmpdir(), 'atl-shots-scenarios-')), 'scenarios.json');
  writeFileSync(scenarios, JSON.stringify(Object.fromEntries(SESSIONS.map((n) => {
    const { limits } = scenarioAccount(SCENARIOS[n]);
    return [n, { ...SCENARIOS[n], limits: [limits.fiveHour, limits.sevenDay] }];
  }))));
  const claudeCmd = join(mkdtempSync(join(tmpdir(), 'atl-shots-claude-')), 'claude.cmd');
  writeFileSync(claudeCmd, `@"${process.execPath}" "${resolve('tests/e2e/fake-claude-demo.mjs')}" %*\r\n`);
  const redis = await FakeRedis.start({ version: '8.4.0' });
  acmeStore(redis);
  redis.db(0).delete('bull:email-queue:failed');
  const dockerPipe = `\\\\.\\pipe\\atl-store-docker-${process.pid}`;
  const { env, home } = e2eEnv({
    ATELIER_TEST_CLAUDE_HOME: fakeHome,
    ATELIER_CLAUDE_BIN: claudeCmd,
    ATELIER_DEMO_SCENARIOS: scenarios,
    ATELIER_TEST_DOCKER_SOCKET: dockerPipe,
    ATELIER_TEST_DOCKER_PROBE_MS: '500',
    ATELIER_TEST_REDIS_PORTS: String(redis.port),
    ATELIER_TEST_REDIS_PROBE_MS: '500'
  });
  // Shown, unlike every other e2e: PrintWindow draws only what the window paints.
  delete env.ATELIER_TEST_BACKGROUND;
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ claudeAccounts: winAccounts(fakeHome) }));
  mkdirSync(env.ATELIER_TEST_CLAUDE_TMP!, { recursive: true });
  mkdirSync(env.ATELIER_TEST_CLAUDE_PROJECTS!, { recursive: true });

  const shots = new Map<string, Buffer>();
  const docker = await FakeDocker.start(dockerPipe);
  // The engine a Windows user runs (the fake answers as macOS's OrbStack by default).
  docker.version = { ...docker.version, Arch: 'amd64', Platform: { Name: 'Docker Desktop 4.48.0 (207573)' } };
  docker.info = { ...docker.info, OperatingSystem: 'Docker Desktop', Name: 'docker-desktop', Architecture: 'x86_64' };
  stageDocker(docker, project, Date.now(), { healthy: true });
  const { app, win } = await launch(env, project);
  try {
    await expect(win.locator('.activity-bar .act-docker')).toBeVisible({ timeout: 20000 });
    for (const name of SESSIONS) await newSession(win, name);
    const stateOf = (title: string) => win.evaluate(async (t) => (await (window as unknown as { atelier: { terminals: { list(): Promise<{ title: string; session?: { state: string } | null }[]> } } }).atelier.terminals.list()).find((x) => x.title === t)?.session?.state, title);
    await expect.poll(() => stateOf('onboarding-copy'), { timeout: 20000 }).toBe('done');
    await win.locator('.session-row', { hasText: 'onboarding-copy' }).click();
    await win.locator('.session-row', { hasText: 'auth-refactor' }).click();
    await expect(win.locator('.inbox-head.is-review')).toHaveCount(0, { timeout: 10000 });
    await expect(win.locator('.changes-body')).toContainText('4 files', { timeout: 90000 });

    // 1. The sessions by state, the one waiting for permission in front, Changes coloured by session.
    await shot(win, shots, '01-overview', win.locator('.inbox-head.is-needs'));

    // 2. The session beside the file it edits (its lines marked in its colour).
    await openFile(win, 'session', 'session.ts', true);
    await shot(win, shots, '02-session-and-file', win.locator('.cm-content', { hasText: 'SKEW_MS' }));
    await menu(win, 'View', 'Unsplit All');
    await expect(win.locator('.pane-divider')).toHaveCount(0);

    // 3. Source Control: onboarding-copy's welcome.tsx staged, its diff beside the session, the commit drawer open.
    {
      // onboarding-copy on the left, a pane opened beside it that its diff then takes.
      await win.locator('.session-row', { hasText: 'onboarding-copy' }).click();
      await openFile(win, 'invoice', 'invoice.ts', true);
      const panel = win.locator('.changes');
      const row = panel.locator('.change-row', { hasText: 'welcome.tsx' });
      await expect(row).toBeVisible({ timeout: 90000 });
      await row.click();
      await expect(win.locator('.cm-content', { hasText: 'Good to see you' })).toBeVisible({ timeout: 20000 });
      await row.click({ button: 'right' });
      await win.getByRole('menuitem', { name: 'Stage', exact: true }).click();
      await menu(win, 'Git', 'Commit…');
      const box = panel.getByRole('textbox', { name: 'Commit message' });
      await box.fill(COMMIT_MESSAGE);
      await shot(win, shots, '03-source-control', panel.locator('.git-drawer'));
      await box.fill('');
      await win.keyboard.press('Escape');
      await menu(win, 'View', 'Unsplit All');
    }

    // 4. Background work: billing-tests' agents and its test run, opened beside the session.
    {
      await win.locator('.session-row', { hasText: 'billing-tests' }).click();
      const chip = win.locator('.session-bar .work-chip');
      await expect(chip).toContainText('2 agents · 1 shell', { timeout: 20000 });
      await chip.click();
      await win.getByRole('dialog', { name: 'Background' }).locator('.bgp-row', { hasText: 'Run billing tests' }).click();
      const bgv = win.locator('.bgv');
      await expect(bgv.locator('.bgv-log')).toContainText('rounds half up on x.xx5', { timeout: 20000 });
      await shot(win, shots, '04-background', bgv.locator('.bgv-list'));
      await bgv.locator('.bgv-head').click();
      await menu(win, 'File', 'Close Tab');
      await menu(win, 'View', 'Unsplit All');
    }

    // 5. Docker: the api's logs beside auth-refactor, two errors picked for the session.
    {
      await win.locator('.session-row', { hasText: 'auth-refactor' }).click();
      await win.locator('.activity-bar .act-docker').click();
      await win.locator('.dk-row', { hasText: 'api' }).first().click();
      await win.locator('.tab', { hasText: 'Docker · api' }).click({ modifiers: ['Alt'] });
      // The left pane shows auth-refactor (⌥-click moved Docker to its own pane; the left strip kept the rest).
      await win.locator('.pane-strip[data-pane="0"] .tab', { hasText: 'auth-refactor' }).click();
      await expect(win.locator('.pane-strip[data-pane="0"] .tab.is-active')).toContainText('auth-refactor');
      await expect(win.locator('.workspace-body > .session-bar')).toBeVisible();
      const last = win.locator('.dk-ln', { hasText: 'mail send failed' });
      await expect(last).toBeVisible({ timeout: 20000 });
      await expect(win.locator('.dk-stat').first().locator('.dk-stat-v')).toHaveText(/%$/, { timeout: 20000 });
      await win.waitForTimeout(6000); // a few seconds of stats for the sparklines
      await win.locator('.dk-ln', { hasText: 'unhandled rejection' }).click({ position: { x: 40, y: 8 } });
      await last.click({ position: { x: 40, y: 8 }, modifiers: ['Control'] });
      await expect(win.locator('.dk-selbar')).toContainText('Send to auth-refactor');
      await shot(win, shots, '05-docker', win.locator('.dk-selbar'));
      await win.keyboard.press('Escape');
      await menu(win, 'File', 'Close Tab');
      await menu(win, 'View', 'Unsplit All');
      await win.locator('.activity-bar .act').first().click();
    }

    // 6. Settings › Keyboard: the Windows shortcuts.
    {
      await menu(win, 'File', 'Settings…');
      const sheet = win.locator('.settings');
      await sheet.getByRole('button', { name: 'Keyboard' }).click();
      await expect(sheet.locator('.set-content')).toContainText('Ctrl');
      await shot(win, shots, '06-keyboard', sheet.locator('.set-nav-item.is-active', { hasText: 'Keyboard' }));
    }

    mkdirSync(OUT, { recursive: true });
    for (const [file, data] of shots) writeFileSync(join(OUT, file), data);
  } finally {
    const proc = app.process();
    const exited = new Promise<void>((done) => { if (proc.exitCode !== null) done(); else proc.once('exit', () => done()); });
    const closing = app.close();
    await exited;
    try {
      const { pid } = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* already stopped */ }
    await closing;
    await docker.close();
    await redis.stop();
    for (const p of madeParent ? [join(PROJECT_PARENT, 'code')] : [project, fakeHome]) rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});

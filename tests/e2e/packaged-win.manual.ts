import { _electron as electron, type ElectronApplication, expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { PROTOCOL_VERSION } from '../../src/shared/version';
import { e2eEnv } from './env';

// The packaged Windows app: release/win-unpacked, the folder
// scripts/win/pack-msix.mjs packs (npx electron-builder --win dir --x64 first, or ATELIER_WIN_APP pointing to another
// one). Run on Windows: the release's check-win job, the test PC.
//   npx playwright test --config playwright.manual.config.ts tests/e2e/packaged-win.manual.ts
test.skip(process.platform !== 'win32', 'the Windows app runs on Windows');

const appDir = resolve(process.env.ATELIER_WIN_APP ?? 'release/win-unpacked');
const resources = join(appDir, 'resources');

/**
 * The packaged app ignores the test-only port lists (devEnv is inert there): Redis and Databases off, so it never probes
 * the machine's own 6379 or 5432.
 */
function noProbes(home: string): void {
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ showRedis: 'never', showDatabases: 'never', autoFetch: 'off' }));
}

/** The atelierd of a test home and its terminals end with it (a daemon outlives the app on purpose). */
function stopDaemon(home: string): void {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* already stopped */ }
}

/**
 * Closes the app, then its atelierd. Windows hands a process's inheritable handles down to what it starts: atelierd
 * and its shells hold the stdio pipes Playwright gave the app (never the case when Windows starts it), and
 * Playwright's close waits for those pipes. So: the app's process ends first, then the daemon, then the close returns.
 */
async function closeApp(app: ElectronApplication, home: string): Promise<void> {
  const proc = app.process();
  const exited = new Promise<void>((done) => { if (proc.exitCode !== null) done(); else proc.once('exit', () => done()); });
  const closing = app.close();
  await exited;
  stopDaemon(home);
  await closing;
}

test('Atelier.exe: the fuses in the shipped binary are the ones electron-builder.yml asks for', () => {
  // Electron's fuse wire: a sentinel, a version byte, a length byte, then one byte per fuse ('0' off, '1' on).
  const bin = readFileSync(join(appDir, 'Atelier.exe'));
  const at = bin.indexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  expect(at).toBeGreaterThan(-1);
  const start = at + 32;
  const wire = bin.subarray(start + 2, start + 2 + bin[start + 1]!).toString('latin1');
  const fuse = (i: number) => wire[i];
  expect({ runAsNode: fuse(0), cookieEncryption: fuse(1), nodeOptions: fuse(2), nodeCliInspect: fuse(3), asarIntegrity: fuse(4), onlyFromAsar: fuse(5) })
    .toEqual({ runAsNode: '1', cookieEncryption: '1', nodeOptions: '0', nodeCliInspect: '1', asarIntegrity: '1', onlyFromAsar: '1' });
});

test('Atelier.exe: the build stamp declares the protocol and the release channel it was built for', () => {
  const stamp = JSON.parse(readFileSync(join(resources, 'atelier-build.json'), 'utf8')) as { protocol: number; channel?: string };
  expect(stamp.protocol).toBe(PROTOCOL_VERSION);
  // The same variable the build read (after-pack.cjs): a release build carries its channel, a local one none.
  expect(stamp.channel).toBe(process.env.ATELIER_RELEASE_CHANNEL || undefined);
});

test('Atelier.exe: the bridge, atelier-procs, atelier-whisper, atelier-git and atelier-store ship in resources/bin and run', () => {
  const bin = join(resources, 'bin');
  // macOS-only resources are left out (after-pack.cjs): the `atelier` shell command, the Dock's icon images.
  for (const f of [join(bin, 'atelier'), join(resources, 'app-icon-docsy.png'), join(resources, 'app-icon-aurora.png')]) expect(existsSync(f), f).toBe(false);
  for (const exe of ['atelier-bridge.exe', 'atelier-procs.exe', 'atelier-whisper.exe', 'atelier-git.exe', 'atelier-store.exe']) {
    expect(readFileSync(join(bin, exe)).subarray(0, 2).toString('latin1'), exe).toBe('MZ');
  }
  // Each answers on its own: procs reads this very process's command line, whisper says it has no model.
  const procs = spawnSync(join(bin, 'atelier-procs.exe'), ['args', String(process.pid)], { encoding: 'utf8', windowsHide: true });
  expect(procs.status).toBe(0);
  expect(procs.stdout).toMatch(new RegExp(`^${process.pid} \\S`));
  const whisper = spawnSync(join(bin, 'atelier-whisper.exe'), ['--model', 'C:\\nonexistent\\model.bin'], { encoding: 'utf8', windowsHide: true });
  expect(whisper.status).toBe(1);
  expect(whisper.stdout.trim()).toBe('{"error":"cannot load model"}');
  // atelier-store needs the package's identity: run from here it says it has none.
  const store = spawnSync(join(bin, 'atelier-store.exe'), ['check'], { encoding: 'utf8', windowsHide: true });
  expect(store.status).toBe(1);
  expect(store.stdout).toMatch(/^error 80073d54 /);
});

test('Atelier.exe: a window, atelierd from its runtime copy, a PowerShell terminal that echoes', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv();
  noProbes(home);
  const app = await electron.launch({ executablePath: join(appDir, 'Atelier.exe'), args: [`--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await win.waitForTimeout(2000);
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type('Write-Output ("PKG" + "-WIN-" + $PSVersionTable.PSEdition)\n');
    await expect(win.locator('.xterm-rows')).toContainText(/PKG-WIN-(Core|Desktop)/, { timeout: 15000 });
    await win.screenshot({ path: 'test-results/packaged-win.png' });
    // A packaged app runs atelierd from a copy outside the app folder: ATELIER_HOME\runtime.
    const { pid } = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
    const exe = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).Path`], { encoding: 'utf8', windowsHide: true }).trim();
    // Long names on both sides (CI's TEMP is a short 8.3 path).
    const runtime = realpathSync.native(join(home, 'runtime')).toLowerCase() + sep;
    const real = realpathSync.native(exe).toLowerCase();
    expect(real.startsWith(runtime), `${real} under ${runtime}`).toBe(true);
    expect(basename(real)).toBe('atelier.exe');
  } finally {
    await closeApp(app, home);
  }
});

test('Atelier.exe: one bar — the header holds the hamburger, its veil and titles, the chip\'s +; caption buttons over its end', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv();
  noProbes(home);
  const app = await electron.launch({ executablePath: join(appDir, 'Atelier.exe'), args: [`--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    const header = win.locator('.header');
    const toggle = header.locator('.menubar-toggle');
    await expect(toggle).toBeVisible({ timeout: 20000 });
    // One-bar header: no title bar row, the header is the window's top row and 46 px tall.
    await expect(win.locator('.titlebar')).toHaveCount(0);
    const h = (await header.boundingBox())!;
    expect(Math.round(h.y)).toBe(0);
    expect(Math.round(h.height)).toBe(46);
    expect(Math.round((await toggle.boundingBox())!.x)).toBe(8);
    await expect(header.locator('.project-chip .btn-new')).toBeVisible();

    await toggle.click();
    const veil = header.locator('.menubar-veil');
    await expect(veil).toBeVisible();
    await expect(veil.locator('.menubar-title').first()).toHaveText('File');
    // The veil runs from the hamburger to the caption buttons, which the system draws over the bar's end.
    const v = (await veil.boundingBox())!;
    const bell = (await header.locator('.bell-btn').boundingBox())!;
    const vw = await win.evaluate(() => innerWidth);
    expect(Math.round(v.x)).toBe(48);
    expect(v.x + v.width).toBeGreaterThanOrEqual(bell.x + bell.width);
    expect(v.x + v.width).toBeLessThan(vw - 90);
    await win.screenshot({ path: 'test-results/packaged-win-veil.png' });

    await veil.locator('.menubar-title').first().click();
    const menu = win.locator('.ctx-menu');
    await expect(menu).toBeVisible();
    expect(Math.round((await menu.boundingBox())!.y)).toBe(50);
    // Esc closes the drop-down; the pointer still on the titles keeps them, a second Esc folds them and the veil.
    await win.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(veil).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(veil).toBeHidden();
  } finally {
    await closeApp(app, home);
  }
});

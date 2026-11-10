import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
import { e2eEnv } from './env';

/**
 * The packaged app ignores the test-only port lists (devEnv is inert there): Redis and Databases off, so it never probes
 * the Mac's own 6379 or 5432. Auto-fetch off: it ignores ATELIER_TEST_FETCH_ISOLATED too, and Changes
 * would fetch a real repository's remotes (this one) with the user's credentials.
 */
function noProbes(home: string): void {
  // No session icon in the real menu bar either: the packaged app ignores ATELIER_TEST_TRAY_LOG.
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ showRedis: 'never', showDatabases: 'never', trayIcons: false, autoFetch: 'off' }));
}
import { PROTOCOL_VERSION } from '../../src/shared/version';

// The packaged app, launched as from the Finder (minimal PATH). Requires `npm run dist` first
// (or ATELIER_APP_PATH pointing to another Atelier.app).
const appPath = resolve(process.env.ATELIER_APP_PATH ?? 'release/mac-arm64/Atelier.app');

/** Ad-hoc signed (a branch dry run of the release workflow): no certificate identity. */
const adhoc = (() => {
  // A codesign error is not "ad-hoc": the signed-only checks then run and fail loudly.
  try { return /designated => cdhash/.test(execFileSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch { return false; }
})();

test('Atelier.app: the fuses in the shipped binary are the ones electron-builder.yml asks for', () => {
  // Electron's fuse wire: a sentinel, a version byte, a length byte, then one byte per fuse ('0' off, '1' on).
  const bin = readFileSync(join(appPath, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'));
  const at = bin.indexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  expect(at).toBeGreaterThan(-1);
  const start = at + 32;
  const wire = bin.subarray(start + 2, start + 2 + bin[start + 1]!).toString('latin1');
  const fuse = (i: number) => wire[i];
  expect({ runAsNode: fuse(0), cookieEncryption: fuse(1), nodeOptions: fuse(2), nodeCliInspect: fuse(3), asarIntegrity: fuse(4), onlyFromAsar: fuse(5) })
    .toEqual({ runAsNode: '1', cookieEncryption: '1', nodeOptions: '0', nodeCliInspect: '1', asarIntegrity: '1', onlyFromAsar: '1' });
});

test('Atelier.app: valid signature, Developer ID or ad-hoc (without it, macOS does not register the app: no icon, no Spotlight)', () => {
  expect(() => execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' })).not.toThrow();
});

// macOS 26 shrinks a plain icns into a gray tile; Finder draws PNG-in-icp4/icp5 small sizes garbled.
test('Atelier.app: Icon Composer icon (Assets.car, CFBundleIconName) and an icns with ARGB small sizes for older macOS', () => {
  const res = join(appPath, 'Contents/Resources');
  expect(readFileSync(join(res, 'Assets.car')).length).toBeGreaterThan(1000);
  const plist = (key: string) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  expect(plist('CFBundleIconName')).toBe('Icon');
  const icns = readFileSync(join(res, plist('CFBundleIconFile')));
  const types: string[] = [];
  for (let o = 8; o < icns.length; o += icns.readUInt32BE(o + 4)) types.push(icns.toString('latin1', o, o + 4));
  expect(types).not.toContain('icp4');
  expect(types).not.toContain('icp5');
  // actool's own selection of sizes (16, 128 and their @2x), the small one as ARGB.
  expect(types).toEqual(expect.arrayContaining(['ic04', 'ic07']));
});

test('Atelier.app: declares the protocol version (auto-update compares it with the installed one)', () => {
  const stamp = JSON.parse(readFileSync(join(appPath, 'Contents/Resources/atelier-build.json'), 'utf8')) as { protocol: number };
  expect(stamp.protocol).toBe(PROTOCOL_VERSION);
});

test('Atelier.app: service from the asar, terminal with the login PATH, working spawn-helper', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  noProbes(home);
  const app = await electron.launch({ executablePath: join(appPath, 'Contents/MacOS/Atelier'), args: [`--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await win.waitForTimeout(2000);
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type('echo "P=$PATH"\n');
    // The login shell's path_helper adds the /etc/paths entries (e.g. /usr/local/bin).
    await expect(win.locator('.xterm-rows')).toContainText('/usr/local/bin', { timeout: 10000 });
    await win.screenshot({ path: 'test-results/packaged.png' });
    const info = JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number };
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(info.pid)], { encoding: 'utf8' });
    expect(cmd).toContain('app.asar/out/main/daemon.js');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('Atelier.app: the output triggers worker is in the asar, referenced by the renderer, and runs (highlight)', async () => {
  const asar = join(appPath, 'Contents/Resources/app.asar');
  const files = listPackage(asar, { isPack: false }).map((f) => f.replace(/^\/+/, ''));
  const worker = files.find((f) => /^out\/renderer\/assets\/triggers\.worker-[\w-]+\.js$/.test(f));
  expect(worker, 'triggers worker in app.asar').toBeTruthy();
  const name = worker!.split('/').pop()!;
  const chunks = files.filter((f) => /^out\/renderer\/assets\/[^/]+\.js$/.test(f) && f !== worker);
  expect(chunks.some((f) => extractFile(asar, f).toString('utf8').includes(name)), 'the renderer loads that very file').toBe(true);

  // And it really starts from the packaged app: a highlight rule lights up new output, no "Triggers are paused".
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  noProbes(home);
  const app = await electron.launch({ executablePath: join(appPath, 'Contents/MacOS/Atelier'), args: [`--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await win.evaluate(() => (window as unknown as { atelier: { settings: { set(p: object): Promise<unknown> } } }).atelier.settings.set({
      triggers: [{ id: 'pkg', pattern: 'PKGHIT', action: 'highlight', scope: 'all', enabled: true }]
    }));
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await win.waitForTimeout(2000);
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type('echo PKG""HIT\n');
    await expect(win.locator('.trg-hit')).not.toHaveCount(0, { timeout: 10000 });
    // No toast at all is the normal case: count the pause notice instead of asserting on a toast that may not exist.
    await expect(win.locator('.toast', { hasText: 'Triggers are paused' })).toHaveCount(0);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('Atelier.app: a newer build set aside shows up in the footer as "Update ready"', async () => {
  // The app never offers an update without a certificate identity to compare it with (updates.ts): signed builds only.
  test.skip(adhoc, 'ad-hoc build (release dry run): updates need a certificate identity');
  const project = mkdtempSync(join(tmpdir(), 'atl-prj-'));
  const { env, home } = e2eEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  noProbes(home);
  // Only the stamp: enough to offer the update; it is not applied (it would really swap the app).
  const res = join(home, 'updates', 'Atelier.app', 'Contents', 'Resources');
  mkdirSync(res, { recursive: true });
  writeFileSync(join(res, 'atelier-build.json'), JSON.stringify({ protocol: PROTOCOL_VERSION, builtAt: Date.now() + 86_400_000 }));
  // Same spawn-helper as node-pty (atelierd runs it from the bundle): without it, the update is not offered.
  const helper = 'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
  mkdirSync(join(res, helper, '..'), { recursive: true });
  copyFileSync(join(appPath, 'Contents/Resources', helper), join(res, helper));
  const app = await electron.launch({ executablePath: join(appPath, 'Contents/MacOS/Atelier'), args: [`--project=${project}`], env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.foot-update')).toContainText('Update ready', { timeout: 10000 });
    await win.screenshot({ path: 'test-results/packaged-update.png' });
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('Atelier.app: atelier-whisper included, executable, answers even without a model; permissions: microphone only', () => {
  const bin = join(appPath, 'Contents/Resources/bin/atelier-whisper');
  const r = spawnSync(bin, ['--model', '/nonexistent/model.bin'], { encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stdout.trim()).toBe('{"error":"cannot load model"}');
  const plist = readFileSync(join(appPath, 'Contents/Info.plist'), 'utf8');
  expect(plist).toContain('Atelier uses the microphone only while you dictate to Claude.');
  expect(plist).not.toContain('NSCameraUsageDescription');
  expect(plist).not.toContain('NSBluetoothAlwaysUsageDescription');
});

// Open any file: offered by Finder's Open With, never the default; the shell command shipped.
test('Atelier.app: document types for Open With (rank Alternate), the atelier command executable', () => {
  const info = join(appPath, 'Contents/Info.plist');
  const read = (k: string) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${k}`, info], { encoding: 'utf8' }).trim();
  const types = [0, 1, 2].map((i) => ({ rank: read(`:CFBundleDocumentTypes:${i}:LSHandlerRank`), utis: read(`:CFBundleDocumentTypes:${i}:LSItemContentTypes`) }));
  expect(types.every((t) => t.rank === 'Alternate')).toBe(true);
  for (const uti of ['public.text', 'public.source-code', 'public.image', 'public.folder']) expect(types.some((t) => t.utis.includes(uti))).toBe(true);
  const cli = join(appPath, 'Contents/Resources/bin/atelier');
  expect(statSync(cli).mode & 0o111).toBe(0o111);
  expect(readFileSync(cli, 'utf8')).toContain('open -a');
});

// A binary built without a deployment target requires the build machine's macOS (a macOS 26 runner → 26.0).
test('Atelier.app: atelier-whisper runs on every macOS the app supports', () => {
  const minApp = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const load = execFileSync('/usr/bin/otool', ['-l', join(appPath, 'Contents/Resources/bin/atelier-whisper')], { encoding: 'utf8' });
  const minos = /LC_BUILD_VERSION[\s\S]*?minos (\d+(?:\.\d+)*)/.exec(load)?.[1];
  const num = (v: string) => v.split('.').map(Number).reduce((a, n, i) => a + n / 100 ** i, 0);
  expect(minos).toBeDefined();
  expect(num(minos!), `atelier-whisper needs macOS ${minos}, the app ${minApp}`).toBeLessThanOrEqual(num(minApp));
});

// Session coalitions: the native PTY host ships signed with the app, and runs on
// every macOS the app supports.
test('Atelier.app: atelier-pty-host included, signed like the app, runs on every supported macOS', () => {
  const bin = join(appPath, 'Contents/Resources/bin/atelier-pty-host');
  expect(statSync(bin).mode & 0o111).toBe(0o111);
  expect(execFileSync(bin, ['--coalition', String(process.pid)], { encoding: 'utf8' })).toMatch(/^\d+ \d+\n$/);
  execFileSync('codesign', ['--verify', '--strict', bin]);
  if (!adhoc) {
    // codesign -dv prints to stderr.
    const team = (p: string) => /TeamIdentifier=(\S+)/.exec(spawnSync('codesign', ['-dv', p], { encoding: 'utf8' }).stderr)?.[1];
    expect(team(bin)).toBe(team(appPath));
  }
  const minApp = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const minos = /LC_BUILD_VERSION[\s\S]*?minos (\d+(?:\.\d+)*)/.exec(execFileSync('/usr/bin/otool', ['-l', bin], { encoding: 'utf8' }))?.[1];
  const num = (v: string) => v.split('.').map(Number).reduce((a, n, i) => a + n / 100 ** i, 0);
  expect(minos).toBeDefined();
  expect(num(minos!)).toBeLessThanOrEqual(num(minApp));
});

// The terminal's launchd job starts as Atelier's executable, so macOS still attributes its file accesses to Atelier:
// a session in this repo, which sits under ~/Documents, reads it with Atelier's grant. It lists `src`, a folder every
// clone has (the release runs this on a fresh one). Developer ID only: an ad-hoc build is another identity, and macOS
// would ask.
test('Atelier.app: a terminal runs in its own launchd job and keeps Atelier\'s privacy grants', async () => {
  test.skip(adhoc, 'ad-hoc build: a different identity than the installed app');
  const { env, home } = e2eEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  noProbes(home);
  const repo = resolve('.');
  const app = await electron.launch({ executablePath: join(appPath, 'Contents/MacOS/Atelier'), args: [`--project=${repo}`], env });
  try {
    const win = await app.firstWindow();
    await win.getByRole('button', { name: 'Open a terminal' }).click();
    await expect.poll(() => { try { return readFileSync(join(home, 'logs', 'atelierd.log'), 'utf8'); } catch { return ''; } }, { timeout: 15000 })
      .toMatch(/shell \d+ started in launchd job/);
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type('ls src >/dev/null && echo "GRANT-$((40+2))" || echo "DENIED-$((40+2))"\n');
    await expect(win.locator('.xterm-rows')).toContainText(/GRANT-42|DENIED-42/, { timeout: 10000 });
    await expect(win.locator('.xterm-rows')).toContainText('GRANT-42');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

// The app icon of Docsy's themes: only the app installed in /Applications or ~/Applications
// wears a custom icon. A build here, on Docsy, keeps its bundle as signed: no
// Icon\r, no Finder flag, no marker, the strict signature intact. Last in the file: every launch above has run.
test('Atelier.app: on a Docsy theme, the built bundle gets no custom icon (only the installed app may wear one)', async () => {
  test.skip(/^(\/Applications|\/Users\/[^/]+\/Applications)\/[^/]+\.app$/.test(appPath), 'the installed app: Docsy would rightly give it the icon');
  const { env, home } = e2eEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  writeFileSync(join(home, 'preferences.json'), JSON.stringify({ showRedis: 'never', showDatabases: 'never', trayIcons: false, theme: 'docsy', autoFetch: 'off' }));
  const app = await electron.launch({ executablePath: join(appPath, 'Contents/MacOS/Atelier'), env });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'docsy');
    // The bundle's turn, once the app is ready: not installed, so a notice and no write (a build taken for the installed
    // app would write instead, and never log this). The app log shortens the path itself ("….app"): match the rest.
    await expect.poll(() => { try { return readFileSync(join(home, 'logs', 'app.log'), 'utf8'); } catch { return ''; } }, { timeout: 15000 })
      .toMatch(/\[main:app-icon\] app icon: .*\.app is not in \/Applications or ~\/Applications/);
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  // The Dock's images ship inside the seal: Docsy's, and Aurora's for a run that comes back from Docsy.
  for (const png of ['app-icon-docsy.png', 'app-icon-aurora.png']) expect(existsSync(join(appPath, 'Contents/Resources', png)), png).toBe(true);
  expect(existsSync(join(appPath, 'Icon\r'))).toBe(false);
  expect(execFileSync('/usr/bin/xattr', [appPath], { encoding: 'utf8' })).not.toContain('com.apple.FinderInfo');
  expect(existsSync(join(home, 'app-icon.json'))).toBe(false);
  expect(() => execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' })).not.toThrow();
});

// After packaging: node-pty's spawn-helper must be executable inside app.asar.unpacked too,
// and the app declares its atelierd protocol version (scripts/update-app.mjs compares it with the installed one).
const { execFileSync } = require('node:child_process');
const { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * atelier-build.json: the atelierd protocol, the build time and, for CI release builds only, the update channel
 * (ATELIER_RELEASE_CHANNEL=stable|beta). Without a channel (dev, stage-update) the in-app updater stays idle unless
 * the user opts in from Settings › About.
 */
function buildStamp({ protocol, now, channel }) {
  if (channel && channel !== 'stable' && channel !== 'beta') throw new Error(`ATELIER_RELEASE_CHANNEL must be stable or beta, not ${channel}`);
  return { protocol, builtAt: now, ...(channel ? { channel } : {}) };
}
exports.buildStamp = buildStamp;

/**
 * node-pty ships prebuilds for every platform; Atelier is macOS arm64 only. The others are dead weight, and unsigned
 * Mach-O files (darwin-x64) would fail notarization.
 */
function pruneForeignPrebuilds(base, arch) {
  for (const dir of readdirSync(base)) if (dir !== `darwin-${arch}`) rmSync(join(base, dir), { recursive: true, force: true });
}
exports.pruneForeignPrebuilds = pruneForeignPrebuilds;

/** Windows x64: node-pty's win32-x64 prebuilds only, without their debug symbols (.pdb). */
function pruneForWindows(base) {
  for (const dir of readdirSync(base)) if (dir !== 'win32-x64') rmSync(join(base, dir), { recursive: true, force: true });
  const drop = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) drop(p); else if (e.name.endsWith('.pdb')) rmSync(p, { force: true });
    }
  };
  drop(join(base, 'win32-x64'));
}
exports.pruneForWindows = pruneForWindows;

/**
 * Windows: node-pty at run time is its package.json, lib/ and the prebuilds; its sources, winpty's, the ConPTY copies
 * of every architecture (third_party, build), its scripts, tests and source maps are dead weight that WACK's
 * Blocked executables test reads as code starting processes.
 */
function pruneNodePtyForWindows(dir) {
  for (const d of ['deps', 'src', 'scripts', 'third_party', 'build']) rmSync(join(dir, d), { recursive: true, force: true });
  const drop = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) drop(p); else if (/\.test\.js$|\.js\.map$/.test(e.name)) rmSync(p, { force: true });
    }
  };
  drop(join(dir, 'lib'));
}
exports.pruneNodePtyForWindows = pruneNodePtyForWindows;

/**
 * Windows: the top-level extraResources only macOS uses — the `atelier` shell command, and the Dock's icon images of
 * Docsy's themes and Aurora (app.dock does not exist on Windows).
 */
function pruneMacOnlyResources(resources) {
  for (const f of [join('bin', 'atelier'), 'app-icon-docsy.png', 'app-icon-aurora.png']) rmSync(join(resources, f), { force: true });
}
exports.pruneMacOnlyResources = pruneMacOnlyResources;

function protocolVersion() {
  const src = readFileSync(join(__dirname, '..', 'src', 'shared', 'version.ts'), 'utf8');
  const m = /PROTOCOL_VERSION = (\d+);/.exec(src);
  if (!m) throw new Error('PROTOCOL_VERSION not found in src/shared/version.ts');
  return Number(m[1]);
}

/** Windows: the prebuilds, the bridge atelierd installs for Claude's hooks, the build stamp. */
function afterPackWindows(context) {
  const resources = join(context.appOutDir, 'resources');
  const base = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(base)) throw new Error(`node-pty not found in ${base}`);
  pruneForWindows(base);
  pruneNodePtyForWindows(join(base, '..'));
  pruneMacOnlyResources(resources);
  // The bridge for Claude's hooks, and atelier-store for the Store's updates.
  for (const exe of ['atelier-bridge.exe', 'atelier-store.exe']) {
    if (!existsSync(join(resources, 'bin', exe))) throw new Error(`${exe} missing from resources/bin: run npm run build on Windows`);
  }
  const stamp = buildStamp({ protocol: protocolVersion(), now: Date.now(), channel: process.env.ATELIER_RELEASE_CHANNEL });
  writeFileSync(join(resources, 'atelier-build.json'), JSON.stringify(stamp) + '\n');
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') { afterPackWindows(context); return; }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const base = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(base)) throw new Error(`node-pty not found in ${base}`);
  pruneForeignPrebuilds(base, 'arm64');
  for (const dir of readdirSync(base)) {
    const helper = join(base, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
  // Drop the permission descriptions Atelier doesn't use (Electron adds them on its own): only the microphone stays.
  const plist = join(app, 'Contents', 'Info.plist');
  for (const key of ['NSCameraUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSAudioCaptureUsageDescription']) {
    try { execFileSync('/usr/bin/plutil', ['-remove', key, plist], { stdio: 'ignore' }); } catch { /* key absent */ }
  }
  const whisper = join(app, 'Contents', 'Resources', 'bin', 'atelier-whisper');
  if (existsSync(whisper)) chmodSync(whisper, 0o755);
  const src = readFileSync(join(__dirname, '..', 'src', 'shared', 'version.ts'), 'utf8');
  const m = /PROTOCOL_VERSION = (\d+);/.exec(src);
  if (!m) throw new Error('PROTOCOL_VERSION not found in src/shared/version.ts');
  const stamp = buildStamp({ protocol: Number(m[1]), now: Date.now(), channel: process.env.ATELIER_RELEASE_CHANNEL });
  writeFileSync(join(app, 'Contents', 'Resources', 'atelier-build.json'), JSON.stringify(stamp) + '\n');
};

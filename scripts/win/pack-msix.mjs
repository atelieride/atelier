// Packs the Windows app into the MSIX the Store receives:
//   node scripts/win/pack-msix.mjs --version <semver> --out <dir> [--sign <pfx> --password-env <NAME>]
// release/win-unpacked (npx electron-builder --win dir --x64) + build/appx's manifest and logos are staged in a private
// temp folder, makepri indexes the logos' qualifiers, makeappx packs <dir>/Atelier-<semver>-x64.msix: unsigned, the
// Store signs it. With --sign, a copy <dir>/Atelier-<semver>-x64-test.msix is signed with that pfx (a throwaway
// certificate whose subject is the Store publisher, scripts/win/test-cert.ps1) to install on a test PC or in CI.
// The pfx password is read from the named variable, never from our own arguments, and handed to signtool only (never
// printed: a failure shows the tool's output, not its command line). Windows only, Node built-ins
// only (it runs in the release jobs that install nothing); the SDK tools come from the newest Windows Kits.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { msixVersion } from './msix-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = ['makepri.exe', 'makeappx.exe', 'signtool.exe'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `--version <semver> --out <dir> [--sign <pfx> --password-env <NAME>]`; throws on anything else. */
export function parseArgs(argv) {
  const opts = { version: null, out: null, sign: null, passwordEnv: null };
  const keys = { '--version': 'version', '--out': 'out', '--sign': 'sign', '--password-env': 'passwordEnv' };
  for (let i = 0; i < argv.length; i++) {
    const key = keys[argv[i]];
    if (!key) throw new Error(`unknown argument ${argv[i]}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i - 1]} needs a value`);
    opts[key] = value;
  }
  if (!opts.version) throw new Error('--version <semver> is required');
  if (!opts.out) throw new Error('--out <dir> is required');
  msixVersion(opts.version);
  if (opts.sign && !opts.passwordEnv) throw new Error('--sign needs --password-env <NAME> (the variable holding the pfx password)');
  if (opts.passwordEnv && !opts.sign) throw new Error('--password-env only goes with --sign <pfx>');
  if (opts.passwordEnv && !ENV_NAME.test(opts.passwordEnv)) throw new Error(`--password-env takes a variable name: ${opts.passwordEnv}`);
  return opts;
}

/** The Store upload and its signed test copy in `out`. */
export function packagePaths(out, version) {
  return { msix: join(out, `Atelier-${version}-x64.msix`), test: join(out, `Atelier-${version}-x64-test.msix`) };
}

/** build/appx/AppxManifest.xml with the MSIX version in place of __VERSION__; nothing else changes. */
export function fillManifest(template, version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error(`an MSIX version is four numbers: ${version}`);
  if (!template.includes('Version="__VERSION__"')) throw new Error('the manifest has no Version="__VERSION__" to fill');
  return template.replace('Version="__VERSION__"', `Version="${version}"`);
}

/**
 * makepri's configuration: the project folder indexed from its root, file names carrying the qualifiers
 * (Square44x44Logo.targetsize-16_altform-unplated.png), one resources.pri for one package. makepri names a resource by
 * its path from the index root (startIndexAt would rebase it: Files/X.png, which the manifest's assets\X.png never
 * finds), so the project it indexes is a folder holding only assets/ (the logos), never Electron's own files.
 */
export function priConfig() {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources targetOsVersion="10.0.0" majorVersion="1">
  <index root="\\" startIndexAt="\\">
    <default>
      <qualifier name="Language" value="en-US"/>
      <qualifier name="Contrast" value="standard"/>
      <qualifier name="Scale" value="100"/>
      <qualifier name="HomeRegion" value="001"/>
      <qualifier name="TargetSize" value="256"/>
      <qualifier name="LayoutDirection" value="LTR"/>
      <qualifier name="Theme" value="dark"/>
      <qualifier name="AlternateForm" value=""/>
      <qualifier name="DXFeatureLevel" value="DX9"/>
      <qualifier name="Configuration" value=""/>
      <qualifier name="DeviceFamily" value="Universal"/>
      <qualifier name="Custom" value=""/>
    </default>
    <indexer-config type="folder" foldernameAsQualifier="true" filenameAsQualifier="true" qualifierDelimiter="."/>
  </index>
</resources>
`;
}

const versionKey = (v) => v.split('.').map(Number);
const newerFirst = (a, b) => {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

/** `<kits>\<newest version>\x64` among `dirs` that holds every tool, or null. */
export function findSdkBin(kits, dirs, exists) {
  for (const v of dirs.filter((d) => /^\d+(\.\d+)+$/.test(d)).sort(newerFirst)) {
    const bin = join(kits, v, 'x64');
    if (TOOLS.every((t) => exists(join(bin, t)))) return bin;
  }
  return null;
}

/** The three tools' argv (fixed shapes; signtool's password comes from the named variable). */
export function toolArgs({ work, stage, msix, test, pfx, password }) {
  return {
    makepri: ['new', '/pr', join(work, 'pri'), '/cf', join(work, 'priconfig.xml'), '/mn', join(stage, 'AppxManifest.xml'), '/of', join(stage, 'resources.pri'), '/o'],
    makeappx: ['pack', '/o', '/d', stage, '/p', msix],
    signtool: ['sign', '/fd', 'SHA256', '/f', pfx, '/p', password, test]
  };
}

/** Runs one SDK tool; on failure its own output, never its command line (signtool's holds the password). */
function run(bin, tool, args) {
  try {
    execFileSync(join(bin, tool), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split(/\r?\n/).slice(-15).join('\n');
    throw new Error(`${tool} failed (exit ${e.status ?? '?'})${out ? `:\n${out}` : ''}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32') throw new Error('pack-msix runs on Windows (makepri, makeappx and signtool come with the Windows SDK)');
  const version = msixVersion(opts.version);
  const app = join(ROOT, 'release', 'win-unpacked');
  if (!existsSync(join(app, 'Atelier.exe'))) throw new Error(`no packed app in ${app}: run npx electron-builder --win dir --x64 first`);
  const password = opts.sign ? process.env[opts.passwordEnv] : null;
  if (opts.sign && !password) throw new Error(`${opts.passwordEnv} is empty: it must hold the pfx password`);
  if (opts.sign && !existsSync(opts.sign)) throw new Error(`no pfx at ${opts.sign}`);
  const kits = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const bin = findSdkBin(kits, existsSync(kits) ? readdirSync(kits) : [], existsSync);
  if (!bin) throw new Error(`makepri, makeappx and signtool not found under ${kits}: install the Windows SDK`);

  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const paths = packagePaths(out, opts.version);
  const work = mkdtempSync(join(tmpdir(), 'atl-msix-'));
  const stage = join(work, 'pkg');
  const args = toolArgs({ work, stage, msix: paths.msix, test: paths.test, pfx: opts.sign && resolve(opts.sign), password });
  const written = [];
  try {
    cpSync(app, stage, { recursive: true });
    // The logos in the package and, alone, in the folder makepri indexes (the same relative paths).
    const assets = join(ROOT, 'build', 'appx', 'assets');
    for (const dir of [stage, join(work, 'pri')]) {
      mkdirSync(join(dir, 'assets'), { recursive: true });
      for (const f of readdirSync(assets)) if (f.endsWith('.png')) copyFileSync(join(assets, f), join(dir, 'assets', f));
    }
    writeFileSync(join(stage, 'AppxManifest.xml'), fillManifest(readFileSync(join(ROOT, 'build', 'appx', 'AppxManifest.xml'), 'utf8'), version));
    writeFileSync(join(work, 'priconfig.xml'), priConfig());
    run(bin, 'makepri.exe', args.makepri);
    written.push(paths.msix);
    run(bin, 'makeappx.exe', args.makeappx);
    if (opts.sign) {
      written.push(paths.test);
      copyFileSync(paths.msix, paths.test);
      run(bin, 'signtool.exe', args.signtool);
    }
  } catch (e) {
    // A failed run leaves no half package for a later step to pick up.
    for (const f of written) rmSync(f, { force: true });
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  for (const f of written) console.log(`${f} (${Math.round(statSync(f).size / 1048576)} MB, version ${version})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(`pack-msix: ${e.message}`); process.exit(1); }
}

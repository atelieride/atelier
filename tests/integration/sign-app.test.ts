import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error -- plain ESM script, Node built-ins only (it runs in the CI job that installs nothing).
import { codesignArgs, isMachO, pickIdentity, signApp, signingPlan } from '../../scripts/sign-app.mjs';

const { pruneForeignPrebuilds } = require('../../scripts/after-pack.cjs') as { pruneForeignPrebuilds(base: string, arch: string): void };

// Our own inside-out signer (no npm package next to the Developer ID key).
const root = join(__dirname, '../..');
const TEAM = 'AFMH6BSX52';

test('Mach-O by magic bytes: thin 64/32-bit, universal; not scripts, text or Java classes', () => {
  const b = (hex: string) => Buffer.from(hex.padEnd(16, '0'), 'hex');
  expect(isMachO(b('cffaedfe0c000001'))).toBe(true);
  expect(isMachO(b('cefaedfe07000000'))).toBe(true);
  expect(isMachO(b('cafebabe00000002'))).toBe(true);
  expect(isMachO(b('cafebabf00000002'))).toBe(true);
  // A Java class file starts with cafebabe too, followed by its version (≥ 45), not an arch count.
  expect(isMachO(b('cafebabe00000034'))).toBe(false);
  expect(isMachO(Buffer.from('#!/bin/sh\necho'))).toBe(false);
  expect(isMachO(Buffer.from('{}'))).toBe(false);
  expect(isMachO(Buffer.alloc(2))).toBe(false);
});

/** A bundle shaped like Electron's: helpers, a versioned framework with a dylib and a helper tool, loose binaries. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sign-'));
  const app = join(dir, 'Atelier.app');
  const bin = (p: string) => { mkdirSync(join(p, '..'), { recursive: true }); copyFileSync('/usr/bin/true', p); chmodSync(p, 0o755); };
  const plist = (p: string, exe: string, type: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.atelier.test.${exe.replace(/\W/g, '')}</string><key>CFBundleExecutable</key><string>${exe}</string><key>CFBundlePackageType</key><string>${type}</string></dict></plist>\n`); };
  plist(join(app, 'Contents/Info.plist'), 'Atelier', 'APPL');
  bin(join(app, 'Contents/MacOS/Atelier'));
  const helper = join(app, 'Contents/Frameworks/Atelier Helper (Renderer).app');
  plist(join(helper, 'Contents/Info.plist'), 'Atelier Helper (Renderer)', 'APPL');
  bin(join(helper, 'Contents/MacOS/Atelier Helper (Renderer)'));
  const fw = join(app, 'Contents/Frameworks/Electron Framework.framework');
  plist(join(fw, 'Versions/A/Resources/Info.plist'), 'Electron Framework', 'FMWK');
  bin(join(fw, 'Versions/A/Electron Framework'));
  bin(join(fw, 'Versions/A/Libraries/libffmpeg.dylib'));
  bin(join(fw, 'Versions/A/Helpers/chrome_crashpad_handler'));
  symlinkSync('A', join(fw, 'Versions/Current'));
  symlinkSync('Versions/Current/Electron Framework', join(fw, 'Electron Framework'));
  symlinkSync('Versions/Current/Resources', join(fw, 'Resources'));
  symlinkSync('Versions/Current/Libraries', join(fw, 'Libraries'));
  symlinkSync('Versions/Current/Helpers', join(fw, 'Helpers'));
  bin(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'));
  bin(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node'));
  bin(join(app, 'Contents/Resources/bin/atelier-whisper'));
  mkdirSync(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/lib'), { recursive: true });
  writeFileSync(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/lib/index.js'), 'module.exports = 1;\n');
  writeFileSync(join(app, 'Contents/Resources/run.sh'), '#!/bin/sh\n');
  return app;
}

test('inside-out: every nested binary before its bundle, bundles before the app, the app last; entitlements by role', () => {
  const app = fixture();
  const plan = (signingPlan(app) as { path: string; kind: string; entitlements: string | null }[]).map((s) => ({ ...s, path: s.path.slice(app.length + 1) || '.' }));
  const at = (p: string) => plan.findIndex((s) => s.path === p);
  const fw = 'Contents/Frameworks/Electron Framework.framework';
  // Loose binaries are signed as files, bundles as bundles; a bundle's own executable comes with the bundle.
  expect(plan.map((s) => `${s.kind} ${s.path}`).sort()).toEqual([
    'bundle .',
    'bundle Contents/Frameworks/Atelier Helper (Renderer).app',
    `bundle ${fw}`,
    `file ${fw}/Versions/A/Helpers/chrome_crashpad_handler`,
    `file ${fw}/Versions/A/Libraries/libffmpeg.dylib`,
    'file Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    'file Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    'file Contents/Resources/bin/atelier-whisper'
  ].sort());
  expect(at(`${fw}/Versions/A/Libraries/libffmpeg.dylib`)).toBeLessThan(at(fw));
  expect(at(`${fw}/Versions/A/Helpers/chrome_crashpad_handler`)).toBeLessThan(at(fw));
  expect(plan.at(-1)!.path).toBe('.');
  expect(plan.find((s) => s.path === '.')!.entitlements).toBe('main');
  expect(plan.find((s) => s.path.endsWith('Helper (Renderer).app'))!.entitlements).toBe('helper');
  for (const s of plan.filter((p) => p.kind === 'file' || p.path === fw)) expect(s.entitlements, s.path).toBeNull();
});

test('a Developer ID signs with a secure timestamp and the hardened runtime; other identities without either', () => {
  const dev = `Developer ID Application: Francesco Musso (${TEAM})`;
  const main = { path: '/x/Atelier.app', kind: 'bundle', entitlements: 'main' };
  const lib = { path: '/x/a.dylib', kind: 'file', entitlements: null };
  expect(codesignArgs(main, { identity: dev, developerId: true, entitlementsDir: '/e' })).toEqual(
    ['--force', '--sign', dev, '--timestamp', '--options', 'runtime', '--entitlements', '/e/entitlements.mac.plist', '/x/Atelier.app']);
  expect(codesignArgs(lib, { identity: dev, developerId: true, entitlementsDir: '/e' })).toEqual(['--force', '--sign', dev, '--timestamp', '--options', 'runtime', '/x/a.dylib']);
  expect(codesignArgs({ ...main, entitlements: 'helper' }, { identity: dev, developerId: true, entitlementsDir: '/e' })).toContain('/e/entitlements.helper.plist');
  // Ad-hoc and the old self-signed identity: no timestamp server, no runtime (library validation needs a Team ID).
  expect(codesignArgs(main, { identity: '-', developerId: false, entitlementsDir: '/e' })).toEqual(['--force', '--sign', '-', '/x/Atelier.app']);
});

test('the identity: our valid Developer ID (this team only), by hash so a renewed duplicate is never ambiguous; else ad-hoc', () => {
  // `security find-identity -v -p codesigning`: valid identities only (expired and revoked ones are not listed).
  const out = (...ids: [string, string][]) => ids.map(([h, n], i) => `  ${i + 1}) ${h} "${n}"`).join('\n') + `\n     ${ids.length} valid identities found\n`;
  const dev = `Developer ID Application: Francesco Musso (${TEAM})`;
  const h1 = 'A'.repeat(40); const h2 = 'B'.repeat(40);
  expect(pickIdentity(out([h1, dev], [h2, dev]))).toEqual({ identity: h1, name: dev, developerId: true });
  expect(pickIdentity(out([h1, 'Developer ID Application: Someone Else (ZZZZZZZZZZ)'], [h2, 'Apple Development: Francesco Musso (ABCDE12345)']))).toEqual({ identity: '-', name: 'ad-hoc', developerId: false });
  expect(pickIdentity('     0 valid identities found\n')).toEqual({ identity: '-', name: 'ad-hoc', developerId: false });
});

test('the CLI asks for valid identities only and still runs when started through a symlinked path', () => {
  const src = readFileSync(join(root, 'scripts/sign-app.mjs'), 'utf8');
  expect(src).toMatch(/\['find-identity', '-v', '-p', 'codesigning'\]/);
  expect(src).toMatch(/realpathSync\(process\.argv\[1\]\)/);
});

test('ad-hoc signing a whole Electron-shaped bundle passes codesign --verify --deep --strict', () => {
  const app = fixture();
  signApp(app, { identity: '-', developerId: false, entitlementsDir: join(root, 'build') });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  // The nested helper carries its own valid signature.
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', join(app, 'Contents/Frameworks/Atelier Helper (Renderer).app')], { stdio: 'pipe' });
});

test('minimal entitlements: JIT and the microphone for the app, JIT for helpers, nothing else', () => {
  const keys = (f: string) => [...readFileSync(join(root, 'build', f), 'utf8').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]).sort();
  expect(keys('entitlements.mac.plist')).toEqual(['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input']);
  expect(keys('entitlements.helper.plist')).toEqual(['com.apple.security.cs.allow-jit']);
});

test('after packing, only the arm64 macOS prebuilds of node-pty stay (no unsigned foreign binaries to notarize)', () => {
  const base = join(mkdtempSync(join(tmpdir(), 'prebuilds-')), 'prebuilds');
  for (const d of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']) { mkdirSync(join(base, d), { recursive: true }); writeFileSync(join(base, d, 'pty.node'), 'x'); }
  pruneForeignPrebuilds(base, 'arm64');
  expect(execFileSync('/bin/ls', [base], { encoding: 'utf8' }).trim().split('\n')).toEqual(['darwin-arm64']);
});

test('electron-builder: fuses flipped at package time, no signing hook of its own (sign-app.mjs signs)', () => {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  expect(yml).not.toMatch(/^afterSign:/m);
  const fuses = yml.slice(yml.indexOf('electronFuses:'));
  expect(fuses).toMatch(/^ {2}runAsNode: true$/m);
  expect(fuses).toMatch(/^ {2}enableNodeOptionsEnvironmentVariable: false$/m);
  // On while runAsNode is on: off would block the packaged checks (Playwright attaches with --inspect) and protect
  // nothing, since ELECTRON_RUN_AS_NODE already runs code as Atelier.
  expect(fuses).toMatch(/^ {2}enableNodeCliInspectArguments: true$/m);
  expect(fuses).toMatch(/^ {2}enableEmbeddedAsarIntegrityValidation: true$/m);
  expect(fuses).toMatch(/^ {2}onlyLoadAppFromAsar: true$/m);
  expect(fuses).toMatch(/^ {2}enableCookieEncryption: true$/m);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(pkg.scripts['dist']).toMatch(/node scripts\/sign-app\.mjs --auto release\/mac-arm64\/Atelier\.app$/);
});

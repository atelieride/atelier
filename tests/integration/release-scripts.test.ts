import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';
import { parseFeed } from '../../src/shared/update-feed';
import { rawPublicKey, verifyFeedSignature } from '../../src/shared/update-sign.node';
import { helperCodeHash } from '../../src/shared/helper-hash.node';
import { macho } from '../support/macho';
// @ts-expect-error: .mjs script without types
import { changelogSection, channelOf, feedYaml, makeFeed } from '../../scripts/make-feed.mjs';
// @ts-expect-error: .mjs script without types
import { publicKeyOf, signFeed } from '../../scripts/sign-feed.mjs';

const { buildStamp } = require('../../scripts/after-pack.cjs') as { buildStamp(o: { protocol: number; now: number; channel?: string }): Record<string, unknown> };

const SHA = Buffer.alloc(64, 1).toString('base64');

test('the build stamp carries the release channel only for CI release builds (ATELIER_RELEASE_CHANNEL)', () => {
  expect(buildStamp({ protocol: 1, now: 5 })).toEqual({ protocol: 1, builtAt: 5 });
  expect(buildStamp({ protocol: 1, now: 5, channel: '' })).toEqual({ protocol: 1, builtAt: 5 });
  expect(buildStamp({ protocol: 1, now: 5, channel: 'beta' })).toEqual({ protocol: 1, builtAt: 5, channel: 'beta' });
  expect(() => buildStamp({ protocol: 1, now: 5, channel: 'nightly' })).toThrow(/ATELIER_RELEASE_CHANNEL/);
});
test('Windows packages keep only node-pty’s win32-x64 prebuilds, without debug symbols', () => {
  const { pruneForWindows } = require('../../scripts/after-pack.cjs') as { pruneForWindows(base: string): void };
  const base = mkdtempSync(join(tmpdir(), 'atl-pb-'));
  for (const d of ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-x64']) mkdirSync(join(base, d));
  writeFileSync(join(base, 'win32-x64', 'pty.node'), 'x');
  writeFileSync(join(base, 'win32-x64', 'pty.pdb'), 'x');
  mkdirSync(join(base, 'win32-x64', 'conpty'));
  writeFileSync(join(base, 'win32-x64', 'conpty', 'conpty.dll'), 'x');
  writeFileSync(join(base, 'win32-x64', 'conpty', 'conpty.pdb'), 'x');
  pruneForWindows(base);
  expect(existsSync(join(base, 'darwin-arm64')) || existsSync(join(base, 'win32-arm64'))).toBe(false);
  expect(existsSync(join(base, 'win32-x64', 'pty.node')) && existsSync(join(base, 'win32-x64', 'conpty', 'conpty.dll'))).toBe(true);
  expect(existsSync(join(base, 'win32-x64', 'pty.pdb')) || existsSync(join(base, 'win32-x64', 'conpty', 'conpty.pdb'))).toBe(false);
});

test('Windows packages ship node-pty\'s runtime only: no sources, winpty or ConPTY copies, tests or source maps', () => {
  // WACK's Blocked executables test flagged the build scripts and sources (2026-10-18), and they are dead weight.
  const { pruneNodePtyForWindows } = require('../../scripts/after-pack.cjs') as { pruneNodePtyForWindows(dir: string): void };
  const dir = mkdtempSync(join(tmpdir(), 'atl-np-'));
  const files = ['package.json', 'LICENSE', 'lib/index.js', 'lib/windowsPtyAgent.js', 'lib/worker/conoutSocketWorker.js', 'lib/index.js.map',
    'lib/terminal.test.js', 'lib/terminal.test.js.map', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty/OpenConsole.exe',
    'deps/winpty/misc/Spew.py', 'src/index.ts', 'scripts/post-install.js', 'third_party/conpty/1/win10-arm64/conpty.dll',
    'build/Release/conpty/conpty.dll'];
  for (const f of files) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), 'x'); }
  pruneNodePtyForWindows(dir);
  expect(files.filter((f) => existsSync(join(dir, f)))).toEqual(['package.json', 'LICENSE', 'lib/index.js', 'lib/windowsPtyAgent.js',
    'lib/worker/conoutSocketWorker.js', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty/OpenConsole.exe']);
  for (const d of ['deps', 'src', 'scripts', 'third_party', 'build']) expect(existsSync(join(dir, d)), d).toBe(false);
});

test('Windows packages leave out the macOS-only resources: the `atelier` shell command and the Dock\'s icon images', () => {
  // app.dock does not exist on Windows: the two PNGs would be 1.1 MB of dead weight in the MSIX.
  const { pruneMacOnlyResources } = require('../../scripts/after-pack.cjs') as { pruneMacOnlyResources(resources: string): void };
  const resources = mkdtempSync(join(tmpdir(), 'atl-res-'));
  const files = ['bin/atelier', 'bin/atelier-bridge.exe', 'app-icon-docsy.png', 'app-icon-aurora.png', 'licenses/OFL.txt', 'atelier-build.json'];
  for (const f of files) { mkdirSync(join(resources, f, '..'), { recursive: true }); writeFileSync(join(resources, f), 'x'); }
  pruneMacOnlyResources(resources);
  expect(files.filter((f) => existsSync(join(resources, f)))).toEqual(['bin/atelier-bridge.exe', 'licenses/OFL.txt', 'atelier-build.json']);
});

const root = resolve(__dirname, '../..');

test('the feed make-feed writes is the feed the app parses, notes included', () => {
  const feed = {
    version: '0.2.0-beta.1', path: 'Atelier-0.2.0-beta.1-arm64.zip', sha512: SHA, size: 42, releaseDate: '2026-10-11T10:00:00.000Z',
    channel: 'beta', minimumSystemVersion: '12.0', protocol: 1, spawnHelper: 'b'.repeat(64),
    notes: '### Added\n- "Quotes", back\\slashes, accents: perché — and a colon: here # not a comment'
  };
  const r = parseFeed(feedYaml(feed));
  expect(r).toEqual({ ok: true, feed });
});

test('release notes come from the CHANGELOG section of the version', () => {
  const log = '# Changelog\n\n## [0.2.0] - 2026-10-20\n- Stable\n\n## 0.2.0-beta.1 — 2026-10-12\n\n- First beta\n- Updater\n\n## 0.1.0\n- Old\n';
  expect(changelogSection(log, '0.2.0-beta.1')).toBe('- First beta\n- Updater');
  expect(changelogSection(log, '0.2.0')).toBe('- Stable');
  // 0.2.0 must not match the 0.2.0-beta.1 heading, nor a missing version anything.
  expect(changelogSection('## 0.2.0-beta.1\n- x\n', '0.2.0')).toBeNull();
  expect(changelogSection(log, '0.3.0')).toBeNull();
  expect(changelogSection('## 0.3.0\n\n## 0.2.0\n- x\n', '0.3.0')).toBeNull();
});

test('the channel follows the version: X.Y.Z stable, X.Y.Z-beta.N beta, anything else refused', () => {
  expect(channelOf('0.2.0')).toBe('stable');
  expect(channelOf('0.2.0-beta.3')).toBe('beta');
  expect(() => channelOf('0.2.0-rc.1')).toThrow();
});

function fixtureApp(dir: string, version: string, helper: string | Buffer = 'helper-bytes'): string {
  const app = join(dir, 'Atelier.app');
  const helperDir = join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64');
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, 'spawn-helper'), helper);
  writeFileSync(join(app, 'Contents/Resources/atelier-build.json'), JSON.stringify({ protocol: 3, builtAt: 1 }));
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleShortVersionString</key>\n<string>${version}</string>
<key>LSMinimumSystemVersion</key>\n<string>12.0</string></dict></plist>`);
  return app;
}

test('make-feed: sha512 and size of the ZIP, protocol and spawn-helper of the built app, notes from the CHANGELOG', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-feed-'));
  const app = fixtureApp(dir, '0.2.0-beta.1');
  const zip = join(dir, 'Atelier-0.2.0-beta.1-arm64.zip');
  writeFileSync(zip, 'zip-bytes');
  const changelog = join(dir, 'CHANGELOG.md');
  writeFileSync(changelog, '## 0.2.0-beta.1\n- First beta\n');
  const { yml } = makeFeed({ zip, app, version: '0.2.0-beta.1', changelog, releaseDate: '2026-10-11T00:00:00.000Z' });
  const r = parseFeed(yml);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.feed).toMatchObject({
    version: '0.2.0-beta.1', channel: 'beta', path: 'Atelier-0.2.0-beta.1-arm64.zip', size: 9, protocol: 3, minimumSystemVersion: '12.0',
    sha512: createHash('sha512').update('zip-bytes').digest('base64'),
    spawnHelper: createHash('sha256').update('helper-bytes').digest('hex'),
    notes: '- First beta'
  });
  // The built app must be the version being released, and the release must have notes.
  expect(() => makeFeed({ zip, app, version: '0.2.0', changelog })).toThrow(/version/i);
  writeFileSync(changelog, '## 0.1.0\n- old\n');
  expect(() => makeFeed({ zip, app, version: '0.2.0-beta.1', changelog })).toThrow(/CHANGELOG/);
});

test('make-feed: spawnHelper is the helper\'s code hash, the one the app computes, whatever machine signed it', () => {
  const feedOf = (signature: number, code = 'helper-code') => {
    const dir = mkdtempSync(join(tmpdir(), 'atl-feed-'));
    const app = fixtureApp(dir, '0.2.0-beta.1', macho(code, signature));
    const zip = join(dir, 'Atelier-0.2.0-beta.1-arm64.zip');
    writeFileSync(zip, 'zip-bytes');
    const changelog = join(dir, 'CHANGELOG.md');
    writeFileSync(changelog, '## 0.2.0-beta.1\n- First beta\n');
    return makeFeed({ zip, app, version: '0.2.0-beta.1', changelog }).feed.spawnHelper as string;
  };
  expect(feedOf(19600)).toBe(feedOf(19312));
  expect(feedOf(19312)).toBe(helperCodeHash(macho('helper-code', 19312)));
  expect(feedOf(19312, 'other-code')).not.toBe(feedOf(19312));
});

test('sign-feed signs the exact bytes with the key from the environment, checks it is the embedded one, never prints it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-sign-'));
  const yml = join(dir, 'latest-mac.yml');
  writeFileSync(yml, 'version: 0.2.0\n');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const raw = rawPublicKey(publicKey);
  expect(publicKeyOf(pem)).toBe(raw);
  expect(verifyFeedSignature(readFileSync(yml), signFeed(readFileSync(yml), pem), raw)).toBe(true);

  const run = (args: string[], key: string | undefined) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    if (key !== undefined) env.UPDATE_SIGNING_KEY = key;
    return spawnSync(process.execPath, [join(root, 'scripts/sign-feed.mjs'), ...args], { env, encoding: 'utf8' });
  };
  const body = pem.split('\n')[1]!;
  const ok = run([yml, '--public-key', raw], pem);
  expect(ok.status).toBe(0);
  expect(`${ok.stdout}${ok.stderr}`).not.toContain(body);
  expect(verifyFeedSignature(readFileSync(yml), readFileSync(`${yml}.sig`, 'utf8'), raw)).toBe(true);

  // Default expectation: the key embedded in the app. A test key is not it: refused, no .sig written.
  const other = join(dir, 'other.yml');
  writeFileSync(other, 'version: 0.2.0\n');
  const wrong = run([other], pem);
  expect(wrong.status).not.toBe(0);
  expect(`${wrong.stdout}${wrong.stderr}`).toMatch(/embedded/i);
  expect(`${wrong.stdout}${wrong.stderr}`).not.toContain(body);
  expect(existsSync(`${other}.sig`)).toBe(false);

  expect(run([other], undefined).status).not.toBe(0);
  const junk = run([other, '--public-key', raw], 'not a key');
  expect(junk.status).not.toBe(0);
  expect(`${junk.stdout}${junk.stderr}`).not.toContain('not a key');
});

test('a list of embedded keys (a successor key can ship before it signs): sign-feed accepts only a listed key', async () => {
  // @ts-expect-error: .mjs script without types
  const { assertListedKey, embeddedKeys, embeddedKeysIn } = await import('../../scripts/sign-feed.mjs');
  const a = generateKeyPairSync('ed25519');
  const b = generateKeyPairSync('ed25519');
  const pem = a.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const rawA = rawPublicKey(a.publicKey);
  const rawB = rawPublicKey(b.publicKey);
  const src = `export const UPDATE_PUBLIC_KEYS: readonly string[] = [\n  '${rawB}',\n  '${rawA}'\n];\n`;
  expect(embeddedKeysIn(src)).toEqual([rawB, rawA]);
  expect(() => embeddedKeysIn('export const OTHER = 1;')).toThrow(/UPDATE_PUBLIC_KEYS/);
  expect(() => assertListedKey(pem, [rawB, rawA])).not.toThrow();
  expect(() => assertListedKey(pem, [rawB])).toThrow(/embedded/);
  // The app's own list: valid raw keys, and the app verifies with any of them.
  const keys: string[] = embeddedKeys();
  expect(keys.length).toBeGreaterThan(0);
  for (const k of keys) expect(Buffer.from(k, 'base64')).toHaveLength(32);
  const yml = Buffer.from('version: 0.2.0\n');
  expect(verifyFeedSignature(yml, signFeed(yml, pem), [rawB, rawA])).toBe(true);
  expect(verifyFeedSignature(yml, signFeed(yml, pem), [rawB])).toBe(false);
});

test('the publish job runs the release scripts without npm ci: they import Node built-ins only', () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)) {
      const spec = m[1]!;
      if (spec.startsWith('./') || spec.startsWith('../')) visit(resolve(file, '..', spec));
      else expect(spec, `${file} imports ${spec}`).toMatch(/^node:/);
    }
    expect(src, `${file} uses require or a dynamic import`).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
  };
  for (const s of ['make-feed.mjs', 'sign-feed.mjs', 'release-ci.mjs', 'sign-app.mjs']) visit(join(root, 'scripts', s));
  expect([...seen].map((f) => posixRel(root, f)).sort()).toEqual([
    'scripts/helper-hash.mjs', 'scripts/make-feed.mjs', 'scripts/msix-file.mjs', 'scripts/release-ci.mjs', 'scripts/release.mjs',
    'scripts/sign-app.mjs', 'scripts/sign-feed.mjs', 'scripts/win/msix-version.mjs'
  ]);
});

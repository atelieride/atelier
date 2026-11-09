// Writes the update feed (latest-mac.yml) for a release, next to the update ZIP (CI).
// electron-builder's shape (version, files[url, sha512, size], path, sha512, releaseDate) plus our fields: channel,
// minimumSystemVersion, protocol (atelierd), spawnHelper (sha256 of node-pty's spawn-helper code, helper-hash.mjs) and notes
// (the version's CHANGELOG.md section, required). The app parses exactly this subset (src/shared/update-feed.ts).
//
//   node scripts/make-feed.mjs --zip release/Atelier-0.2.0-arm64.zip --app release/mac-arm64/Atelier.app \
//     [--version 0.2.0] [--changelog CHANGELOG.md] [--out release/latest-mac.yml]
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { helperCodeHash } from './helper-hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/;

// The app's semver rules (src/shared/update-feed.ts parseSemver): numbers without leading zeros, at most 9 digits. A
// release outside them would be built and published, then ignored by every installed app.
const N = '(0|[1-9]\\d{0,8})';
const XYZ = `${N}\\.${N}\\.${N}`;
/** X.Y.Z (stable) or X.Y.Z-beta.N (beta): groups major, minor, patch, beta number. */
export const RELEASE_VERSION = new RegExp(`^${XYZ}(?:-beta\\.${N})?$`);
/** X.Y.Z only. */
export const CORE_VERSION = new RegExp(`^${XYZ}$`);

/** 'stable' for X.Y.Z, 'beta' for X.Y.Z-beta.N; other prereleases are not a channel. */
export function channelOf(version) {
  const m = RELEASE_VERSION.exec(version);
  if (m && m[4] === undefined) return 'stable';
  if (m) return 'beta';
  throw new Error(`Version ${version} is neither X.Y.Z (stable) nor X.Y.Z-beta.N (beta).`);
}

/** The body under `## 0.2.0` or `## [0.2.0] - date` up to the next `## ` heading; null if missing or empty. */
export function changelogSection(text, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?${esc}\\]?(?=\\s|$)`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  return body || null;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The YAML text: plain scalars where they are safe, quoted otherwise; notes as a JSON (= YAML double-quoted) string. */
export function feedYaml(f) {
  return [
    `version: ${f.version}`,
    'files:',
    `  - url: ${f.path}`,
    `    sha512: ${f.sha512}`,
    `    size: ${f.size}`,
    `path: ${f.path}`,
    `sha512: ${f.sha512}`,
    `releaseDate: ${q(f.releaseDate)}`,
    `channel: ${f.channel}`,
    `minimumSystemVersion: ${q(f.minimumSystemVersion)}`,
    `protocol: ${f.protocol}`,
    `spawnHelper: ${f.spawnHelper}`,
    `notes: ${JSON.stringify(f.notes)}`
  ].join('\n') + '\n';
}

function plistString(plist, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return m ? m[1] : null;
}

export function makeFeed({ zip, app, version, channel, changelog = join(ROOT, 'CHANGELOG.md'), releaseDate = new Date().toISOString() }) {
  const ch = channel ?? channelOf(version);
  if (ch !== channelOf(version)) throw new Error(`Version ${version} does not belong to the ${ch} channel.`);
  const name = basename(zip);
  if (!ZIP_NAME.test(name)) throw new Error(`Unexpected ZIP name: ${name}`);
  const plist = readFileSync(join(app, 'Contents/Info.plist'), 'utf8');
  const appVersion = plistString(plist, 'CFBundleShortVersionString');
  if (appVersion !== version) throw new Error(`The built app is version ${appVersion}, the release is ${version}.`);
  const minimumSystemVersion = plistString(plist, 'LSMinimumSystemVersion');
  if (!minimumSystemVersion) throw new Error('LSMinimumSystemVersion missing from the app Info.plist.');
  const stamp = JSON.parse(readFileSync(join(app, 'Contents/Resources/atelier-build.json'), 'utf8'));
  if (!Number.isInteger(stamp.protocol)) throw new Error('atelier-build.json without a protocol: rebuild with npm run dist.');
  // The same hash the app computes (src/main/updates.ts ptyHelperHash) on Apple Silicon: the helper's code, not its
  // signature (helper-hash.mjs).
  const helper = readFileSync(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'));
  const notes = changelogSection(readFileSync(changelog, 'utf8'), version);
  if (!notes) throw new Error(`CHANGELOG has no section for ${version}: add "## ${version}" with the release notes.`);
  const bytes = readFileSync(zip);
  const feed = {
    version, path: name, sha512: createHash('sha512').update(bytes).digest('base64'), size: statSync(zip).size, releaseDate,
    channel: ch, minimumSystemVersion, protocol: stamp.protocol, spawnHelper: helperCodeHash(helper), notes
  };
  return { feed, yml: feedYaml(feed) };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const zip = arg('zip'); const app = arg('app');
    if (!zip || !app) throw new Error('Usage: make-feed.mjs --zip <zip> --app <Atelier.app> [--version X] [--channel stable|beta] [--changelog file] [--out file]');
    const version = arg('version') ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    const { yml, feed } = makeFeed({ zip, app, version, channel: arg('channel'), changelog: arg('changelog') });
    const out = arg('out') ?? join(dirname(zip), 'latest-mac.yml');
    writeFileSync(out, yml);
    console.log(`${out}: ${feed.version} (${feed.channel}), ${feed.size} bytes, protocol ${feed.protocol}`);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}

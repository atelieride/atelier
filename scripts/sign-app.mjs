// Signs Atelier.app inside-out.
// Node built-ins and /usr/bin/codesign only: in CI it runs in the job that holds the Developer ID key and installs no
// npm package.
//
//   node scripts/sign-app.mjs --auto <Atelier.app>               our valid Developer ID if the keychain has it, else
//                                                               ad-hoc
//   node scripts/sign-app.mjs --identity "<name>" <Atelier.app>  that identity ("-" = ad-hoc)
//
// Every Mach-O file (found by its magic bytes) is signed before the bundle that holds it, nested bundles (.app,
// .framework) before the app, the app last. With a Developer ID: secure timestamp, hardened runtime, and entitlements
// for the app (build/entitlements.mac.plist) and its helper apps (build/entitlements.helper.plist).
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEAM_ID = 'AFMH6BSX52';
const ENTITLEMENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');

/** Thin (either endianness) or universal Mach-O. A universal header holds a small arch count; a Java class, a version. */
export function isMachO(buf) {
  if (buf.length < 8) return false;
  const magic = buf.readUInt32BE(0);
  if ([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magic)) return true;
  if (magic === 0xcafebabe || magic === 0xcafebabf) { const n = buf.readUInt32BE(4); return n > 0 && n < 30; }
  return false;
}

function head(path) {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(8); return b.subarray(0, readSync(fd, b, 0, 8, 0)); } finally { closeSync(fd); }
}

const isBundle = (name) => name.endsWith('.app') || name.endsWith('.framework');

/** The executable a bundle signature covers: X.app/Contents/MacOS/*, X.framework/Versions/<v>/X. */
function bundleExecutable(path) {
  const parts = path.split(sep);
  const n = parts.length;
  if (n >= 3 && parts[n - 2] === 'MacOS' && parts[n - 3] === 'Contents' && parts[n - 4]?.endsWith('.app')) return true;
  return n >= 4 && parts[n - 3] === 'Versions' && parts[n - 4] === `${parts[n - 1]}.framework`;
}

/** What to sign, in order: [{ path, kind: 'file' | 'bundle', entitlements: 'main' | 'helper' | null }]. */
export function signingPlan(app) {
  const items = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink() || name === '_CodeSignature') continue;
      if (st.isDirectory()) {
        walk(p);
        if (isBundle(name)) items.push({ path: p, kind: 'bundle', entitlements: name.endsWith('.app') ? 'helper' : null });
      } else if (st.isFile() && !bundleExecutable(p) && isMachO(head(p))) {
        items.push({ path: p, kind: 'file', entitlements: null });
      }
    }
  };
  walk(app);
  const depth = (p) => p.split(sep).length;
  // Deepest first: whatever a bundle contains is signed before the bundle itself.
  items.sort((a, b) => depth(b.path) - depth(a.path));
  return [...items, { path: app, kind: 'bundle', entitlements: 'main' }];
}

export function codesignArgs(item, o) {
  const args = ['--force', '--sign', o.identity];
  // Timestamp and runtime need an Apple-issued certificate: with an ad-hoc or self-signed one the hardened runtime's
  // library validation rejects Electron's frameworks (no Team ID).
  if (o.developerId) {
    args.push('--timestamp', '--options', 'runtime');
    if (item.entitlements) args.push('--entitlements', join(o.entitlementsDir, `entitlements.${item.entitlements === 'main' ? 'mac' : 'helper'}.plist`));
  }
  args.push(item.path);
  return args;
}

/**
 * From `security find-identity -v -p codesigning` (valid identities only): our Developer ID, by its SHA-1 so a renewed
 * certificate next to the old one is never ambiguous; else ad-hoc.
 */
export function pickIdentity(out) {
  for (const m of out.matchAll(/^\s*\d+\) ([0-9A-F]{40}) "([^"]+)"$/gm)) {
    if (m[2].startsWith('Developer ID Application: ') && m[2].endsWith(`(${TEAM_ID})`)) return { identity: m[1], name: m[2], developerId: true };
  }
  return { identity: '-', name: 'ad-hoc', developerId: false };
}

export function signApp(app, o, run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })) {
  const entitlementsDir = o.entitlementsDir ?? ENTITLEMENTS;
  for (const item of signingPlan(app)) run('/usr/bin/codesign', codesignArgs(item, { ...o, entitlementsDir }));
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const app = args.at(-1);
  if (!app || !app.endsWith('.app')) { console.error('usage: sign-app.mjs (--auto | --identity <name>) <Atelier.app>'); process.exit(2); }
  let o;
  if (args[0] === '--auto') o = pickIdentity(execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }));
  else if (args[0] === '--identity' && args.length === 3) o = { identity: args[1], name: args[1], developerId: args[1].startsWith('Developer ID Application: ') };
  else { console.error('usage: sign-app.mjs (--auto | --identity <name>) <Atelier.app>'); process.exit(2); }
  signApp(app, o);
  console.log(`Signed ${basename(app)} with ${o.identity === '-' ? 'an ad-hoc signature' : `"${o.name}"`}${o.developerId ? ' (hardened runtime, timestamp)' : ''}.`);
}

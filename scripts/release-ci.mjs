// Helpers for .github/workflows/release.yml. Never prints secrets.
//
//   node scripts/release-ci.mjs meta --tag <vX.Y.Z[-beta.N] or ''> [--dry-run] --notes-out <file> --changelog-out <file>
//     Checks the tag against package.json and CHANGELOG.md, writes the release body and the changelog make-feed reads,
//     and sets the step outputs (version, tag, channel, prerelease, zip, dmg, changelog, notes).
//   node scripts/release-ci.mjs throwaway-key --out <pem file>
//     A fresh Ed25519 key for the build job's checks (private key to the file, 0600; step output public-key).
//   node scripts/release-ci.mjs check-app --app <Atelier.app> --version <v> --channel <stable|beta>
//   node scripts/release-ci.mjs package --app <Atelier.app> --zip <file> --dmg <file> [--tool diskutil|hdiutil]
//     The update ZIP and the DMG; the disk image tool is diskutil where macOS has it.
//   node scripts/release-ci.mjs verify --dir release --version <v> --channel <c> --zip <name> --dmg <name> [--public-key <raw>]
//     The signed feed matches the ZIP; the app in the ZIP and in the DMG is the release identity, version and channel.
//   node scripts/release-ci.mjs check-msix --file <Atelier-<v>-x64.msix> --version <v>
//     The MSIX carries the Store identity of build/appx/AppxManifest.xml, msixVersion(v) and x64.
//   node scripts/release-ci.mjs wack --report <xml> --version <v>
//     The Windows App Certification Kit's verdict: every required test passed, the whole kit ran, on this version.
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASE_VERSION, changelogSection, channelOf } from './make-feed.mjs';
import { msixProblems } from './msix-file.mjs';
import { isUneditedStub } from './release.mjs';
import { embeddedKeys, verifyFeed } from './sign-feed.mjs';
import { msixVersion } from './win/msix-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The repository whose releases ship the app (its README is the project page). */
const REPO = 'atelieride/atelier';
/** v + a release version, with the app's semver rules (no leading zeros): what the updater accepts as a tag. */
const TAG = new RegExp(`^v(${RELEASE_VERSION.source.slice(1, -1)})$`);

/**
 * The designated requirement of every published build: the maintainer's Developer ID (team AFMH6BSX52). Installed apps
 * accept an update only when it satisfies their own requirement
 * (src/main/auto-update.ts), so a build signed with any other certificate must never be published. Tied to the team,
 * not to one certificate: a renewed Developer ID certificate keeps it.
 */
export const RELEASE_REQUIREMENT = 'identifier "app.atelier.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = AFMH6BSX52';

/** What the workflow builds for a tag (or, for a dry run without a tag, for package.json's version). */
export function releaseMeta({ tag, pkgVersion, changelog, dryRun = false }) {
  let version;
  if (tag) {
    const m = TAG.exec(tag);
    if (!m) throw new Error(`Invalid tag "${tag}": expected vX.Y.Z or vX.Y.Z-beta.N.`);
    version = m[1];
    if (version !== pkgVersion) throw new Error(`Tag ${tag} does not match package.json version ${pkgVersion}: bump with npm run release.`);
  } else {
    if (!dryRun) throw new Error('A release needs a tag (vX.Y.Z or vX.Y.Z-beta.N): only dry runs build without one.');
    version = pkgVersion;
  }
  const channel = channelOf(version);
  let notes = changelogSection(changelog, version);
  if (notes && isUneditedStub(notes)) throw new Error(`The "## ${version}" section of CHANGELOG.md is still the unedited stub from npm run release.`);
  const placeholderNotes = !notes;
  if (!notes) {
    if (!dryRun) throw new Error(`CHANGELOG.md has no "## ${version}" section: add the release notes first.`);
    notes = `Dry run build of ${version} (no CHANGELOG.md section).`;
  }
  return {
    version, tag: `v${version}`, channel, prerelease: channel === 'beta', notes, placeholderNotes,
    zip: `Atelier-${version}-arm64.zip`, dmg: `Atelier-${version}-arm64.dmg`,
    // The Windows package: unsigned, the Store signs it. Never in the Mac feed, never behind the
    // site's update endpoints: it goes to the Microsoft Store from the published release.
    msix: `Atelier-${version}-x64.msix`
  };
}

/**
 * A fresh Ed25519 pair for the build job: it signs the feed so that `verify` checks the whole release (feed ↔ ZIP, app
 * in the ZIP and the DMG) before anything is published, without UPDATE_SIGNING_KEY. No installed app trusts it.
 */
export function throwawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64')
  };
}

/** Problems between the feed text (as make-feed writes it) and the release it must describe; [] when it matches. */
export function checkFeed(text, { version, channel, zipName, zip }) {
  const top = {};
  for (const m of text.matchAll(/^([A-Za-z][A-Za-z0-9]*): (.*)$/gm)) top[m[1]] = m[2];
  const url = /^ {2}- url: (.*)$/m.exec(text)?.[1];
  const fileSha = /^ {4}sha512: (.*)$/m.exec(text)?.[1];
  const fileSize = /^ {4}size: (.*)$/m.exec(text)?.[1];
  const sha512 = createHash('sha512').update(zip).digest('base64');
  const problems = [];
  if (top.version !== version) problems.push(`feed version ${top.version}, expected ${version}`);
  if (top.channel !== channel) problems.push(`feed channel ${top.channel}, expected ${channel}`);
  if (top.path !== zipName || url !== zipName) problems.push(`feed path/url ${top.path}/${url}, expected ${zipName}`);
  if (top.sha512 !== sha512 || fileSha !== sha512) problems.push('feed sha512 does not match the ZIP');
  if (Number(fileSize) !== zip.length) problems.push(`feed size ${fileSize}, the ZIP has ${zip.length} bytes`);
  return problems;
}

/** null when `codesign -d -r-` output shows the release identity, otherwise why not. */
export function requirementProblem(codesignOutput) {
  const dr = /^designated => (.+)$/m.exec(codesignOutput)?.[1]?.trim();
  if (!dr) return 'No designated requirement in the codesign output.';
  if (dr.startsWith('cdhash')) return 'The app is ad-hoc signed: the Developer ID identity was not found in the keychain.';
  if (dr !== RELEASE_REQUIREMENT) return `Wrong signing identity: ${dr} (expected ${RELEASE_REQUIREMENT}).`;
  return null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * null when `spctl --assess -vv` accepted the file as notarized. Only an explicit "Notarized Developer ID" source counts:
 * with Gatekeeper turned off (some CI images) spctl accepts everything ("override=security disabled").
 */
export function gatekeeperProblem({ ok, out }) {
  if (!ok) return `Gatekeeper rejects it: ${out.trim()}`;
  if (/override=security disabled/.test(out)) return 'Gatekeeper is disabled on this machine: its verdict proves nothing.';
  if (!/source=Notarized Developer ID/.test(out)) return `Gatekeeper accepts it, but it is not notarized: ${out.trim()}`;
  return null;
}

/**
 * Signature, identity, version and channel of a built Atelier.app. `unsigned`: a branch dry run (no signing secrets),
 * only a valid seal is required. `notarized`: the stapled ticket and Gatekeeper's verdict too.
 */
export function checkApp(app, { version, channel, unsigned = false, notarized = false }) {
  if (!existsSync(join(app, 'Contents/Info.plist'))) return [`No app at ${app}`];
  const problems = [];
  const verify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (!verify.ok) problems.push(`codesign --verify failed: ${verify.out.trim()}`);
  if (!unsigned) {
    const req = requirementProblem(run('/usr/bin/codesign', ['-d', '-r-', app]).out);
    if (req) problems.push(req);
    else if (!run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${RELEASE_REQUIREMENT}`, app]).ok) {
      problems.push('The app does not satisfy the release requirement.');
    }
  }
  if (notarized) {
    const st = run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    if (!st.ok) problems.push(`No valid notarization ticket stapled: ${st.out.trim()}`);
    const gk = gatekeeperProblem(run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app]));
    if (gk) problems.push(`App: ${gk}`);
  }
  const plist = readFileSync(join(app, 'Contents/Info.plist'), 'utf8');
  const appVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  if (appVersion !== version) problems.push(`App version ${appVersion}, expected ${version}`);
  let stamp = {};
  try { stamp = JSON.parse(readFileSync(join(app, 'Contents/Resources/atelier-build.json'), 'utf8')); } catch { problems.push('No atelier-build.json in the app'); }
  if (stamp.channel !== channel) problems.push(`Build channel ${stamp.channel ?? '(none)'}, expected ${channel}: set ATELIER_RELEASE_CHANNEL for electron-builder.`);
  if (!Number.isInteger(stamp.protocol)) problems.push('atelier-build.json has no protocol');
  return problems;
}

function verifyRelease({ dir, version, channel, zipName, dmgName, publicKeys, unsigned = false, notarized = false }) {
  const opts = { version, channel, unsigned, notarized };
  const problems = [];
  const yml = readFileSync(join(dir, 'latest-mac.yml'));
  const sig = readFileSync(join(dir, 'latest-mac.yml.sig'), 'utf8');
  if (!verifyFeed(yml, sig, publicKeys)) problems.push('latest-mac.yml.sig does not verify with a public key embedded in the app');
  const zipPath = join(dir, zipName);
  problems.push(...checkFeed(yml.toString('utf8'), { version, channel, zipName, zip: readFileSync(zipPath) }));

  // The app exactly as the updater will see it: extracted from the ZIP with ditto.
  const unzip = mkdtempSync(join(tmpdir(), 'atl-verify-zip-'));
  try {
    const x = run('/usr/bin/ditto', ['-x', '-k', zipPath, unzip]);
    if (!x.ok) problems.push(`ditto could not extract the ZIP: ${x.out.trim()}`);
    else problems.push(...checkApp(join(unzip, 'Atelier.app'), opts).map((p) => `ZIP: ${p}`));
  } finally { rmSync(unzip, { recursive: true, force: true }); }

  // And as a user installs it: from the DMG, next to an Applications link.
  if (dmgName) {
    if (notarized) {
      const st = run('/usr/bin/xcrun', ['stapler', 'validate', join(dir, dmgName)]);
      if (!st.ok) problems.push(`DMG: no valid notarization ticket stapled: ${st.out.trim()}`);
      const gk = gatekeeperProblem(run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', join(dir, dmgName)]));
      if (gk) problems.push(`DMG: ${gk}`);
    }
    const mnt = mkdtempSync(join(tmpdir(), 'atl-verify-dmg-'));
    let stillAttached = false;
    try {
      withAttachedDmg(join(dir, dmgName), { readOnly: true, mountPoint: mnt }, (mount) => {
        problems.push(...checkApp(join(mount, 'Atelier.app'), opts).map((p) => `DMG: ${p}`));
        if (!run('/bin/test', ['-L', join(mount, 'Applications')]).ok) problems.push('DMG: no Applications link');
        problems.push(...dmgLayoutProblems(mount));
      });
    } catch (e) {
      stillAttached = e?.stillAttached === true;
      problems.push(`DMG: ${e.message}`);
    } finally {
      if (!stillAttached) rmSync(mnt, { recursive: true, force: true });
    }
  }
  return problems;
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[key] = true;
    else { o[key] = next; i++; }
  }
  return o;
}

function setOutputs(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  else console.log(lines);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// Workflow commands: a message may not span lines nor contain %, CR, LF unescaped.
const annotate = (kind, msg) => console.log(`::${kind}::${String(msg).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);

export const RELEASE_NOTES_FOOTER = `\n\n---\n\n**First install:** on a Mac, download the DMG below and drag Atelier to Applications; later versions install themselves from inside the app. On Windows, get Atelier from the [Microsoft Store](https://apps.microsoft.com/detail/9N9FX0BQ20HF), which keeps it up to date (the \`.msix\` below is the package sent to the Store). Details: [README](https://github.com/${REPO}#readme).\n`;

/**
 * stdout and stderr apart: notarytool's JSON answer is on stdout, its progress on stderr. The key stays out of the
 * children's environment: they read the 0600 file.
 */
function runApart(cmd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NOTARY_')));
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * Notarizes a ZIP or DMG with an App Store Connect API key and staples the ticket to `staple` (the app inside the ZIP,
 * or the DMG itself). The key only ever exists as a 0600 file in a private temp folder, removed at the end; on any
 * verdict but Accepted, Apple's log goes into the error.
 */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function notarize({ file, staple, key, keyId, issuer }, exec = runApart, sleep = sleepSync) {
  const dir = mkdtempSync(join(tmpdir(), 'atl-notary-'));
  const keyPath = join(dir, 'AuthKey.p8');
  try {
    writeFileSync(keyPath, key, { mode: 0o600 });
    const auth = ['--key', keyPath, '--key-id', keyId, '--issuer', issuer];
    const sub = exec('/usr/bin/xcrun', ['notarytool', 'submit', file, ...auth, '--wait', '--timeout', '1h', '--output-format', 'json']);
    let res = {};
    try { res = JSON.parse(sub.out.slice(sub.out.indexOf('{'))); } catch { /* reported below */ }
    if (res.status !== 'Accepted') {
      const log = res.id ? exec('/usr/bin/xcrun', ['notarytool', 'log', res.id, ...auth]).out : '';
      throw new Error(`Notarization of ${basename(file)}: ${res.status ?? 'no verdict'} (${res.message ?? `${sub.out}${sub.err ?? ''}`.trim()})\n${log}`);
    }
    // Right after "Accepted" the ticket may not be published yet ("Could not find base64 encoded ticket").
    for (let attempt = 1; ; attempt++) {
      const r = exec('/usr/bin/xcrun', ['stapler', 'staple', staple]);
      if (r.ok) break;
      if (attempt === 3) throw new Error(`stapler staple ${staple}: ${`${r.out}${r.err ?? ''}`.trim()}`);
      sleep(20_000);
    }
    const v = exec('/usr/bin/xcrun', ['stapler', 'validate', staple]);
    if (!v.ok) throw new Error(`stapler validate ${staple}: ${`${v.out}${v.err ?? ''}`.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The DMG window: content size in points, icon and label size, icon centers.
 * build/dmg/background.html draws for these values; scripts/dmg-layout.mjs hands them to Finder.
 */
export const DMG_WINDOW = { width: 660, height: 400, iconSize: 128, textSize: 13, icons: { 'Atelier.app': [170, 206], Applications: [490, 206] } };
/**
 * Where the window opens: its bottom-left corner in Cocoa screen points, as Finder saves it. About centered on a
 * 1470 × 956 MacBook Air screen, so it opens inside a laptop's screen as well as on a large display.
 */
export const DMG_WINDOW_ORIGIN = [400, 260];
/** The volume name: the committed .DS_Store finds its background through it, so it never changes. */
export const DMG_VOLUME = 'Atelier';
const DMG_LAYOUT = join(ROOT, 'build/dmg');
/** com.apple.FinderInfo of a folder with kHasCustomIcon (0x0400) set in its Finder flags (bytes 8–9). */
const CUSTOM_ICON_FINDER_INFO = `${'00'.repeat(8)}0400${'00'.repeat(22)}`;

/** The app's icon (Info.plist's CFBundleIconFile), which the DMG's volume shows. */
function appIcon(app) {
  let name = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(app, 'Contents/Info.plist'), 'utf8'))?.[1] ?? 'icon.icns';
  if (!name.endsWith('.icns')) name += '.icns';
  const file = join(app, 'Contents/Resources', name);
  if (!existsSync(file)) throw new Error(`${app} has no Contents/Resources/${name}: the DMG's volume icon comes from the app.`);
  return file;
}

/**
 * Fills `root` with what the DMG shows: the app, the Applications link and, hidden, the window's background and the
 * volume icon (`volumeIcon`, when given). Shared with dmg-layout.mjs. The Finder layout goes in once the image is
 * mounted: `diskutil image create from` leaves .DS_Store files out of a folder.
 */
export function stageDmg({ root, app, layout = DMG_LAYOUT, volumeIcon }) {
  const c = run('/usr/bin/ditto', [app, join(root, basename(app))]);
  if (!c.ok) throw new Error(`ditto could not stage the DMG: ${c.out.trim()}`);
  symlinkSync('/Applications', join(root, 'Applications'));
  mkdirSync(join(root, '.background'));
  copyFileSync(join(layout, 'background.tiff'), join(root, '.background/background.tiff'));
  if (volumeIcon) copyFileSync(volumeIcon, join(root, '.VolumeIcon.icns'));
}

/** Runs a disk image command, retried: hdiutil now and then fails on hosted runners ("Resource busy"). */
function retried(cmd, args, what, sleep = sleepSync) {
  for (let attempt = 1; ; attempt++) {
    const h = run(cmd, args);
    if (h.ok) return h;
    if (attempt === 3) throw new Error(`${what} failed 3 times: ${h.out.trim()}`);
    sleep(15_000);
  }
}

/** Whether this macOS has `diskutil image` (it replaces hdiutil, which macOS 27 deprecates). */
export function hasDiskutilImage() {
  return run('/usr/sbin/diskutil', ['image', 'info', '-h']).ok;
}

/** `diskutil` where macOS has `diskutil image`, `hdiutil` before (the macOS 26 runners may not). */
export function defaultDiskImageTool() {
  return hasDiskutilImage() ? 'diskutil' : 'hdiutil';
}

/**
 * The few disk image operations the DMG needs, with either tool. Both make the same image: an APFS volume named
 * Atelier (`diskutil image` makes only APFS from a folder, so hdiutil is pinned to it), read-write while it is being
 * finished, UDZO when shipped.
 */
const DISK_IMAGE_TOOLS = {
  diskutil: {
    create: (root, out) => ['/usr/sbin/diskutil', ['image', 'create', 'from', '--format', 'RAW', '--volumeName', DMG_VOLUME, root, out]],
    attach: (image, { readOnly, browse, mountPoint }) => ['/usr/sbin/diskutil', ['image', 'attach', '--plist', ...(readOnly ? ['--readOnly'] : []), ...(browse ? [] : ['--nobrowse']), ...(mountPoint ? ['--mountPoint', mountPoint] : []), image]],
    detach: (mount) => [['/usr/sbin/diskutil', ['eject', mount]]],
    compress: (rw, out) => ['/usr/sbin/diskutil', ['image', 'create', 'from', '--format', 'UDZO', rw, out]],
    format: (image) => ['/usr/sbin/diskutil', ['image', 'info', image]]
  },
  hdiutil: {
    create: (root, out) => ['/usr/bin/hdiutil', ['create', '-volname', DMG_VOLUME, '-fs', 'APFS', '-srcfolder', root, '-ov', '-format', 'UDRW', out]],
    attach: (image, { readOnly, browse, mountPoint }) => ['/usr/bin/hdiutil', ['attach', '-plist', '-noautoopen', readOnly ? '-readonly' : '-readwrite', ...(browse ? [] : ['-nobrowse']), ...(mountPoint ? ['-mountpoint', mountPoint] : []), image]],
    detach: (mount) => [['/usr/bin/hdiutil', ['detach', mount]], ['/usr/bin/hdiutil', ['detach', '-force', mount]]],
    compress: (rw, out) => ['/usr/bin/hdiutil', ['convert', rw, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', '-o', out]],
    format: (image) => ['/usr/bin/hdiutil', ['imageinfo', image]]
  }
};

function diskImageTool(name) {
  const tool = DISK_IMAGE_TOOLS[name];
  if (!tool) throw new Error(`Unknown disk image tool "${name}" (diskutil or hdiutil).`);
  return tool;
}

/**
 * The attach command for `tool`. Mounts are hidden from Finder (nobrowse) unless `browse`: only dmg-layout.mjs needs
 * Finder to see the disk; tests and verify must never put an "Atelier" disk on the Desktop.
 */
export function attachCommand(tool, image, opts = {}) {
  return diskImageTool(tool).attach(image, opts);
}

/** A read-write image of `root`, its volume named Atelier. */
export function createDmg(root, out, tool = defaultDiskImageTool()) {
  const [cmd, args] = diskImageTool(tool).create(root, out);
  retried(cmd, args, `${tool}: creating ${basename(out)}`);
}

/** The image's format (UDZO, UDRW, RAW…), from either tool's report. */
export function diskImageFormat(image, tool = defaultDiskImageTool()) {
  const [cmd, args] = diskImageTool(tool).format(image);
  return /^(?:Image )?Format: (\w+)$/m.exec(run(cmd, args).out)?.[1] ?? null;
}

/**
 * Attaches `image` ({ readOnly, browse, mountPoint }), runs `fn` with the mount point the tool reports, detaches.
 * When the detach fails too, the error names both failures and carries `stillAttached`: the image's folder must not be
 * removed under a mounted volume (that would delete its contents and hide the real error).
 */
export function withAttachedDmg(image, opts, fn, tool = defaultDiskImageTool()) {
  const t = diskImageTool(tool);
  const [cmd, args] = attachCommand(tool, image, opts);
  const out = retried(cmd, args, `${tool}: attaching ${basename(image)}`).out;
  const mount = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(out)?.[1];
  // Attached, but where? Nothing to detach by: the caller must not remove the image's folder either.
  if (!mount) throw Object.assign(new Error(`${tool} attached ${image} but reported no mount point: detach it by hand (diskutil list).`), { stillAttached: true });
  let failure = null;
  let result;
  try { result = fn(mount); } catch (e) { failure = e; }
  const [first, ...rest] = t.detach(mount);
  if (!run(...first).ok) {
    try {
      const [lastCmd, lastArgs] = rest.at(-1) ?? first;
      retried(lastCmd, lastArgs, `${tool}: detaching ${mount}`);
    } catch (e) {
      throw Object.assign(new Error(`${failure ? `${failure.message}; then ` : ''}${e.message} (still attached at ${mount})`), { stillAttached: true });
    }
  }
  if (failure) throw failure;
  return result;
}

/**
 * The update ZIP (`ditto -c -k --keepParent`, what the updater extracts) and the DMG: the app, an Applications link
 * and the DMG window's layout. Only ditto, diskutil (or hdiutil) and xattr: the sign job installs nothing.
 */
export function packageRelease({ app, zip, dmg, layout = DMG_LAYOUT, tool = defaultDiskImageTool() }) {
  diskImageTool(tool);
  const volumeIcon = appIcon(app);
  const dsStore = join(layout, 'DS_Store');
  if (!existsSync(dsStore)) throw new Error(`${dsStore} is missing: run node scripts/dmg-layout.mjs once and commit it.`);
  mkdirSync(dirname(zip), { recursive: true });
  mkdirSync(dirname(dmg), { recursive: true });
  const z = run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  if (!z.ok) throw new Error(`ditto could not make ${zip}: ${z.out.trim()}`);
  const work = mkdtempSync(join(tmpdir(), 'atl-dmg-'));
  let stillAttached = false;
  try {
    const root = join(work, 'root');
    mkdirSync(root);
    stageDmg({ root, app, layout, volumeIcon });
    const rw = join(work, 'rw.dmg');
    createDmg(root, rw, tool);
    // Finished on the mounted volume: the layout, and the custom-icon flag on the volume's root folder (neither tool
    // carries the staged folder's flags over).
    const mnt = join(work, 'mnt');
    mkdirSync(mnt);
    withAttachedDmg(rw, { mountPoint: mnt }, (mount) => {
      copyFileSync(dsStore, join(mount, '.DS_Store'));
      const x = run('/usr/bin/xattr', ['-wx', 'com.apple.FinderInfo', CUSTOM_ICON_FINDER_INFO, mount]);
      if (!x.ok) throw new Error(`xattr could not flag the volume icon: ${x.out.trim()}`);
      // A read-write mount may get fsevents' folder: the DMG holds only what was staged.
      rmSync(join(mount, '.fseventsd'), { recursive: true, force: true });
    }, tool);
    const [cmd, args] = diskImageTool(tool).compress(rw, dmg);
    retried(cmd, args, `${tool}: compressing ${basename(dmg)}`);
  } catch (e) {
    stillAttached = e?.stillAttached === true;
    throw e;
  } finally {
    if (!stillAttached) rmSync(work, { recursive: true, force: true });
  }
}

/** What a mounted DMG misses of its window: `verify` runs it on the DMG that ships. */
export function dmgLayoutProblems(mount) {
  const want = [['.background/background.tiff', 'the window background'], ['.DS_Store', 'the window layout'], ['.VolumeIcon.icns', 'the volume icon']];
  const problems = want.filter(([f]) => !existsSync(join(mount, f))).map(([f, what]) => `DMG: no ${f} (${what})`);
  const info = run('/usr/bin/xattr', ['-px', 'com.apple.FinderInfo', mount]);
  const flags = info.ok ? Buffer.from(info.out.replace(/\s+/g, ''), 'hex') : Buffer.alloc(0);
  if (flags.length !== 32 || !(flags.readUInt16BE(8) & 0x0400)) problems.push('DMG: the volume root lacks the custom-icon flag (Finder ignores .VolumeIcon.icns)');
  return problems;
}

/** The report as text: appcert may write UTF-16 (byte order mark) or UTF-8. */
function reportText(xml) {
  if (typeof xml === 'string') return xml.replace(/^\uFEFF/, '');
  if (xml[0] === 0xff && xml[1] === 0xfe) return xml.subarray(2).toString('utf16le');
  return xml.toString('utf8').replace(/^\uFEFF/, '');
}

const xmlAttrs = (s) => Object.fromEntries([...s.matchAll(/([A-Za-z_][\w.-]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The verdict on a Windows App Certification Kit report (appcert test -reportoutputpath): problems block the release,
 * warnings don't. Required = a TEST (or its REQUIREMENT) not marked OPTIONAL="TRUE". The test PC's verdict on the
 * real app was overall WARNING: every required test passed, the optional "Blocked executables" failed (the app starts
 * shells, so it isn't offered in Windows S mode).
 */
export function wackReport(xml, { version }) {
  const text = reportText(xml);
  const head = /<REPORT\b([^>]*)>/.exec(text);
  if (!head) return { problems: ['The file is not a WACK report (no <REPORT>).'], warnings: [], tests: 0 };
  const report = xmlAttrs(head[1]);
  const problems = [];
  const warnings = [];
  let tests = 0;
  for (const req of text.matchAll(/<REQUIREMENT\b([^>]*)>([\s\S]*?)<\/REQUIREMENT>/g)) {
    const reqOptional = xmlAttrs(req[1]).OPTIONAL === 'TRUE';
    for (const t of req[2].matchAll(/<TEST\b([^>]*)>([\s\S]*?)<\/TEST>/g)) {
      tests++;
      const a = xmlAttrs(t[1]);
      const result = /<RESULT>\s*(?:<!\[CDATA\[)?\s*([A-Za-z]+)/.exec(t[2])?.[1]?.toUpperCase() ?? '(none)';
      if (result !== 'FAIL') continue;
      const why = [...t[2].matchAll(/<MESSAGE\b[^>]*\bTEXT="([^"]*)"/g)].slice(0, 3).map((m) => unescapeXml(m[1])).join(' / ');
      const line = `[${a.INDEX ?? '?'}] ${unescapeXml(a.NAME ?? '(unnamed)')} failed${why ? `: ${why}` : ''}`;
      if (reqOptional || a.OPTIONAL === 'TRUE') warnings.push(`Optional WACK test ${line}`);
      else problems.push(`Required WACK test ${line}`);
    }
  }
  const overall = report.OVERALL_RESULT;
  if (!['PASS', 'WARNING', 'FAIL'].includes(overall)) problems.push(`WACK overall result ${overall ?? '(none)'}: expected PASS or WARNING.`);
  else if (overall === 'FAIL') problems.unshift('WACK overall result FAIL.');
  if (report.PARTIAL_RUN === 'TRUE') problems.push('WACK ran only part of its tests (PARTIAL_RUN): the verdict is incomplete.');
  const want = msixVersion(version);
  if (report.APP_VERSION && report.APP_VERSION !== want) problems.push(`WACK tested version ${report.APP_VERSION}, expected ${want}.`);
  if (tests === 0) problems.push('The WACK report holds no test.');
  return { problems, warnings, tests, overall };
}

function meta(o) {
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const changelogPath = join(ROOT, 'CHANGELOG.md');
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  const m = releaseMeta({ tag: typeof o.tag === 'string' ? o.tag : '', pkgVersion, changelog, dryRun: o['dry-run'] === true });
  if (!o['notes-out'] || !o['changelog-out']) throw new Error('meta needs --notes-out and --changelog-out');
  writeFileSync(o['notes-out'], `${m.notes}${RELEASE_NOTES_FOOTER}`);
  // make-feed reads the notes from a changelog file: the real one, or one holding the dry-run placeholder.
  const changelogFile = m.placeholderNotes ? o['changelog-out'] : changelogPath;
  if (m.placeholderNotes) writeFileSync(changelogFile, `## ${m.version}\n\n${m.notes}\n`);
  setOutputs({ version: m.version, tag: m.tag, channel: m.channel, prerelease: m.prerelease, zip: m.zip, dmg: m.dmg, msix: m.msix, changelog: changelogFile, notes: o['notes-out'] });
  console.log(`Release ${m.tag}: ${m.channel} channel${m.placeholderNotes ? ' (dry run, placeholder notes)' : ''}.`);
}

function report(problems, ok) {
  if (problems.length) {
    for (const p of problems) annotate('error', p);
    throw new Error(`${problems.length} problem(s) found.`);
  }
  console.log(ok);
}

async function main() {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'meta') return meta(o);
  if (cmd === 'throwaway-key') {
    if (typeof o.out !== 'string') throw new Error('throwaway-key needs --out <file>');
    const k = throwawayKey();
    writeFileSync(o.out, k.pem, { mode: 0o600 });
    setOutputs({ 'public-key': k.publicKey });
    return;
  }
  if (cmd === 'check-app') {
    if (!o.app || !o.version || !o.channel) throw new Error('check-app needs --app, --version and --channel');
    const unsigned = o.unsigned === true;
    return report(checkApp(o.app, { version: o.version, channel: o.channel, unsigned, notarized: o.notarized === true }), `${o.app}: ${unsigned ? 'not signed (dry run)' : 'release identity'}, version ${o.version}, ${o.channel} channel.`);
  }
  if (cmd === 'verify') {
    if (!o.dir || !o.version || !o.channel || !o.zip) throw new Error('verify needs --dir, --version, --channel and --zip');
    const publicKeys = typeof o['public-key'] === 'string' ? [o['public-key']] : embeddedKeys();
    const unsigned = o.unsigned === true;
    const notarized = o.notarized === true;
    const problems = verifyRelease({ dir: o.dir, version: o.version, channel: o.channel, zipName: o.zip, dmgName: typeof o.dmg === 'string' ? o.dmg : undefined, publicKeys, unsigned, notarized });
    return report(problems, `Release verified: signed feed, ZIP and DMG carry ${o.version} (${o.channel}) ${unsigned ? 'unsigned (dry run)' : `with the release identity${notarized ? ', notarized and stapled' : ''}`}.`);
  }
  if (cmd === 'check-msix') {
    if (!o.file || !o.version) throw new Error('check-msix needs --file and --version');
    return report(msixProblems(o.file, { version: o.version }), `${o.file}: Store identity, version ${msixVersion(o.version)}, x64.`);
  }
  if (cmd === 'wack') {
    if (!o.report || !o.version) throw new Error('wack needs --report and --version');
    const r = wackReport(readFileSync(o.report), { version: o.version });
    for (const w of r.warnings) annotate('warning', w);
    summary(`### Windows App Certification Kit\n\nOverall ${r.overall ?? '(none)'}, ${r.tests} tests, ${r.problems.length} blocking, ${r.warnings.length} optional failed.\n`);
    return report(r.problems, `WACK: ${r.overall}, every required test passed (${r.tests} tests, ${r.warnings.length} optional failed).`);
  }
  if (cmd === 'package') {
    if (!o.app || !o.zip || !o.dmg) throw new Error('package needs --app, --zip and --dmg');
    // --tool diskutil|hdiutil overrides the choice (a runner whose diskutil image misbehaves).
    const tool = typeof o.tool === 'string' ? o.tool : defaultDiskImageTool();
    packageRelease({ app: o.app, zip: o.zip, dmg: o.dmg, tool });
    return console.log(`Packaged ${o.zip} and ${o.dmg} (disk images by ${tool}).`);
  }
  if (cmd === 'notarize') {
    // The key from the environment (a secret), never from the command line.
    const { NOTARY_KEY: key, NOTARY_KEY_ID: keyId, NOTARY_ISSUER: issuer } = process.env;
    if (!o.file || !o.staple || !key || !keyId || !issuer) throw new Error('notarize needs --file, --staple and NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER in the environment');
    notarize({ file: o.file, staple: o.staple, key, keyId, issuer });
    return console.log(`${o.file}: notarized; ticket stapled to ${o.staple}.`);
  }
  throw new Error('Usage: release-ci.mjs meta|check-app|verify|check-msix|wack|package|notarize …');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}

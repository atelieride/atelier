// Updates /Applications/Atelier.app with the build in release/ without touching sessions (npm run update-app).
// With --stage (npm run stage-update) it only sets it aside in ATELIER_HOME/updates: the app shows "Update ready".
// Sessions live in atelierd, which stays running: only the window is closed, the app is swapped, then reopened.
// If the new build speaks a different protocol with atelierd we stop: that restart closes sessions and the user decides.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { helperCodeHash } from './helper-hash.mjs';

const APP = '/Applications/Atelier.app';
const STAGED = '/Applications/.Atelier-update.app';
const PREVIOUS = '/Applications/.Atelier-previous.app';
const BUNDLE_ID = 'app.atelier.desktop';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** Why the update can't happen without restarting atelierd, or null. installed null = app from before the stamp (protocol 1). */
export function updateBlocker({ installed, next, helperInstalled = null, helperNext = null }) {
  const current = installed ?? 1;
  if (current !== next) return `The new build speaks atelierd protocol ${next}, the installed app ${current}: atelierd must be restarted (sessions close). Update by hand.`;
  // atelierd stays running with its node-pty and runs the spawn-helper from the bundle for every new terminal.
  if (helperInstalled && helperInstalled !== helperNext) return 'The new build has a different node-pty spawn-helper: atelierd must be restarted (sessions close). Update by hand.';
  return null;
}

/** Signing requirement from `codesign -d -r-`; null with an ad-hoc signature (tied to the build's hash). */
export function requirementOf(out) {
  const m = /^designated => (.+)$/m.exec(out);
  const req = m?.[1]?.trim();
  return req && !req.startsWith('cdhash') ? req : null;
}

function ptyHelperHash(appPath) {
  try {
    const p = join(appPath, `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`);
    return helperCodeHash(readFileSync(p));
  } catch {
    return null;
  }
}

/** The pids of the Atelier window (main process of the app at appPath): not atelierd, not the helpers, not other copies. */
export function guiPids(psOutput, appPath) {
  const exe = `${appPath}/Contents/MacOS/Atelier`;
  return psOutput.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) return [];
    const cmd = m[2];
    if (cmd !== exe && !cmd.startsWith(`${exe} --`)) return [];
    return [Number(m[1])];
  });
}

function stamp(app) {
  try { return JSON.parse(readFileSync(join(app, 'Contents/Resources/atelier-build.json'), 'utf8')).protocol; } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = () => guiPids(execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }), APP);

async function main() {
  const next = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'release/mac-arm64/Atelier.app');
  if (!existsSync(next)) throw new Error(`No build in ${next}: run npm run dist first.`);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', next], { stdio: 'inherit' });
  const nextProtocol = stamp(next);
  if (nextProtocol === null) throw new Error('The build has no atelier-build.json: rebuild with npm run dist.');
  const blocker = existsSync(APP) ? updateBlocker({ installed: stamp(APP), next: nextProtocol, helperInstalled: ptyHelperHash(APP), helperNext: ptyHelperHash(next) }) : null;
  if (blocker) throw new Error(blocker);
  // Installed app signed with a certificate: the new build must have the same identity, otherwise macOS
  // would ask for permissions again (Documents) and "Update ready" would stop working.
  let installedReq = null;
  // An installed app without a signature (codesign exits with an error) counts as ad-hoc: no identity to compare.
  try { if (existsSync(APP)) installedReq = requirementOf(execFileSync('/usr/bin/codesign', ['-d', '-r-', APP], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch { installedReq = null; }
  if (installedReq) {
    try {
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${installedReq}`, next], { stdio: 'ignore' });
    } catch {
      throw new Error('The new build is not signed like the installed app (another signing identity): install it once by hand, e.g. from the release DMG.');
    }
  }

  if (process.argv.includes('--stage')) {
    const home = process.env.ATELIER_HOME ?? join(homedir(), 'Library', 'Application Support', 'Atelier');
    const dir = join(home, 'updates');
    const tmp = join(dir, '.Atelier-staging.app');
    const target = join(dir, 'Atelier.app');
    execFileSync('/bin/mkdir', ['-p', '-m', '700', dir]);
    rmSync(tmp, { recursive: true, force: true });
    execFileSync('/usr/bin/ditto', [next, tmp]);
    rmSync(target, { recursive: true, force: true });
    // A single rename: the app sees the complete build appear, never a partial one.
    renameSync(tmp, target);
    console.log(`Update staged in ${target}: Atelier shows "Update ready".`);
    return;
  }

  if (running().length > 0) {
    console.log('Quitting Atelier (sessions keep running in atelierd)…');
    execFileSync('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`]);
    // With unsaved files Atelier asks what to do: wait for the answer, then give up without touching anything.
    const deadline = Date.now() + 120_000;
    while (running().length > 0) {
      if (Date.now() > deadline) throw new Error('Atelier did not quit (unsaved files?): nothing was changed.');
      await sleep(500);
    }
  }

  rmSync(STAGED, { recursive: true, force: true });
  rmSync(PREVIOUS, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', [next, STAGED]);
  const hadApp = existsSync(APP);
  if (hadApp) renameSync(APP, PREVIOUS);
  try {
    renameSync(STAGED, APP);
  } catch (err) {
    if (hadApp) renameSync(PREVIOUS, APP);
    throw err;
  }
  // atelierd keeps going from the files it already opened; new terminals use the new copy's spawn-helper, which is identical.
  rmSync(PREVIOUS, { recursive: true, force: true });
  execFileSync(LSREGISTER, ['-f', APP]);
  execFileSync('/usr/bin/open', [APP]);
  console.log(`Atelier updated (protocol ${nextProtocol}) and reopened.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(String(err instanceof Error ? err.message : err)); process.exit(1); });
}

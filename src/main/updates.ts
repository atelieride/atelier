import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppLocationProblem } from '@shared/update-feed';
import { helperCodeHash } from '@shared/helper-hash.node';

// In-app update ("Update ready · Restart"): a build set aside with `npm run stage-update` in
// ATELIER_HOME/updates/Atelier.app. It is accepted only if it is newer, speaks the same protocol with atelierd (so
// sessions stay alive) and is signed with the same identity as the running app (never with an ad-hoc signature).
// The swap is done by a detached helper: it waits for the app to quit, replaces the bundle, registers it and reopens it.

export interface BuildStamp { protocol: number; builtAt: number }

export function readStamp(appPath: string): BuildStamp | null {
  try {
    const raw = JSON.parse(readFileSync(join(appPath, 'Contents/Resources/atelier-build.json'), 'utf8')) as Partial<BuildStamp>;
    if (typeof raw.protocol !== 'number') return null;
    return { protocol: raw.protocol, builtAt: typeof raw.builtAt === 'number' ? raw.builtAt : 0 };
  } catch {
    return null;
  }
}

/**
 * Hash of node-pty's spawn-helper in the bundle. atelierd stays up during the update with its node-pty
 * already loaded, but for every new terminal it runs the spawn-helper from the bundle path: its code must stay the
 * same (its signature may not: each build machine's codesign wraps it differently).
 */
export function ptyHelperHash(appPath: string): string | null {
  try {
    const p = join(appPath, `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`);
    return helperCodeHash(readFileSync(p));
  } catch {
    return null;
  }
}

/** /Applications/Atelier.app/Contents/MacOS/Atelier → /Applications/Atelier.app (null if it is not a bundle). */
export function appBundleOf(execPath: string): string | null {
  const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1]! : null;
}

export function updateUsable(o: { own: BuildStamp | null; staged: BuildStamp | null; protocol: number }): boolean {
  if (!o.staged || o.staged.protocol !== o.protocol) return false;
  return o.staged.builtAt > (o.own?.builtAt ?? 0);
}

/**
 * The signing requirement from the output of `codesign -d -r-`; null for an ad-hoc signature (tied to a build's hash)
 * and, as defense in depth, for one that names no certificate or anchor (an identifier alone is only a claim).
 */
export function designatedRequirement(codesignOutput: string): string | null {
  const m = /^designated => (.+)$/m.exec(codesignOutput);
  const req = m?.[1]?.trim();
  if (!req || req.startsWith('cdhash')) return null;
  return /\b(certificate|anchor)\b/.test(req) ? req : null;
}

const PREVIOUS_APP = '.Atelier-previous.app';

/**
 * SWAP_SCRIPT keeps the replaced app next to the new one (`.Atelier-previous.app`, for a manual rollback: quit,
 * move it back in place of the new one) until the new version has started once: from the launch after that (the last
 * run was already this version) it can go. Returns the folder to remove, or null.
 */
export function previousAppToDrop(appPath: string, lastRunVersion: string | null, version: string): string | null {
  if (lastRunVersion !== version) return null;
  const prev = join(dirname(appPath), PREVIOUS_APP);
  try { return lstatSync(prev).isDirectory() ? prev : null; } catch { return null; }
}

/**
 * Can the running bundle be replaced by an update? Not when it runs from a disk image (/Volumes), from App
 * Translocation (a quarantined app opened where it was downloaded: macOS runs a read-only copy), or when the bundle or
 * its folder is not writable for this user. The fix is the same: move Atelier to the Applications folder.
 */
export function appLocationProblem(appPath: string, canWrite: (path: string) => boolean): AppLocationProblem | null {
  if (appPath.startsWith('/Volumes/')) return 'disk-image';
  if (appPath.includes('/AppTranslocation/')) return 'translocated';
  if (!canWrite(dirname(appPath)) || !canWrite(appPath)) return 'read-only';
  return null;
}

/**
 * $1 app pid, $2 staged build, $3 installed app, $4 lsregister, $5 open, $6 maximum wait in seconds.
 * If the app does not quit (quit cancelled) it touches nothing; if the swap fails it restores the old one and reopens it.
 * After a swap the old app stays as .Atelier-previous.app (rollback) until the new version has started once.
 */
export const SWAP_SCRIPT = `
pid="$1"; staged="$2"; app="$3"; reg="$4"; opener="$5"; wait="\${6:-120}"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt $((wait*5)) ] && exit 1
  sleep 0.2
done
prev="$(dirname "$app")/.Atelier-previous.app"
rm -rf "$prev"
if ! mv "$app" "$prev"; then "$opener" "$app"; exit 1; fi
if ! mv "$staged" "$app"; then mv "$prev" "$app"; "$opener" "$app"; exit 1; fi
"$reg" -f "$app"
"$opener" "$app"
`;

export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export interface UpdateDeps {
  appPath: string;
  stagedPath: string;
  protocol: number;
  /** Runs a command and returns stdout and stderr together; rejects if it exits with an error. */
  exec(cmd: string, args: string[]): Promise<string>;
  spawnHelper(args: string[]): void;
  quit(): void;
  /** Can we write here (app folder and app)? Otherwise the swap would fail after the app has quit. */
  canWrite(path: string): boolean;
}

export class UpdateWatcher {
  private applying = false;
  /** Signing requirement of the installed app: undefined until read, null with an ad-hoc signature (never updatable). */
  private req: string | null | undefined;

  constructor(private readonly o: UpdateDeps) {}

  /** Reads the signing requirement once: with an ad-hoc signature "Update ready" never shows (the click would always fail). */
  async init(): Promise<void> {
    try { this.req = designatedRequirement(await this.o.exec('/usr/bin/codesign', ['-d', '-r-', this.o.appPath])); } catch { this.req = null; }
  }

  ready(): boolean {
    // Before init has read the signature (or if it is ad-hoc) the update is not offered.
    if (this.req == null) return false;
    if (!updateUsable({ own: readStamp(this.o.appPath), staged: readStamp(this.o.stagedPath), protocol: this.o.protocol })) return false;
    const helper = ptyHelperHash(this.o.appPath);
    return helper !== null && helper === ptyHelperHash(this.o.stagedPath);
  }

  /** Checks signature and protocol, launches the helper and quits the app; false if the update cannot be applied. */
  async apply(): Promise<boolean> {
    // Only one helper even with multiple clicks (signature verification takes a few seconds).
    if (this.applying) return false;
    this.applying = true;
    try {
      if (this.req === undefined) await this.init();
      const req = this.req;
      if (!req || !this.ready() || !this.o.canWrite(dirname(this.o.appPath)) || !this.o.canWrite(this.o.appPath)) {
        this.applying = false;
        return false;
      }
      await this.o.exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${req}`, this.o.stagedPath]);
    } catch {
      this.applying = false;
      return false;
    }
    this.o.spawnHelper([String(process.pid), this.o.stagedPath, this.o.appPath, LSREGISTER, '/usr/bin/open', '120']);
    this.o.quit();
    return true;
  }

  get updatesDir(): string { return dirname(this.o.stagedPath); }
}

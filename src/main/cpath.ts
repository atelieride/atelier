import { realpath, realpathSync } from 'node:fs';
import { realpath as realpathAsync } from 'node:fs/promises';
import path from 'node:path';
import { toCanonical } from '@shared/paths';
import { pathStyle } from '@shared/platform';

// Path operations for the paths main hands to the renderer (main converts at its edges). On
// Windows each result is canonical (C:/…, forward slashes, upper-case drive), the form IPC carries, which fs takes as
// it is; on macOS each is node:path's own function, so nothing changes there. Modules that build paths only for the OS
// (spawn, the daemon, logs) keep node:path (tests/integration/main-paths.test.ts keeps the list).

const win = () => pathStyle() === 'win32';
const out = (p: string) => toCanonical(p, 'win32');

/** A path from the OS (realpath, homedir, a dialog, argv) in the form the renderer uses. */
export const toOut = (p: string): string => (win() ? out(p) : p);

// The machine's separator, for `rel.split(sep).join('/')`: a canonical result has no `\` to split, a native one does.
export const sep = path.sep;
export const join = (...p: string[]): string => (win() ? out(path.win32.join(...p)) : path.join(...p));
export const resolve = (...p: string[]): string => (win() ? out(path.win32.resolve(...p)) : path.resolve(...p));
export const relative = (from: string, to: string): string => (win() ? out(path.win32.relative(from, to)) : path.relative(from, to));
export const normalize = (p: string): string => (win() ? out(path.win32.normalize(p)) : path.normalize(p));
export const dirname = (p: string): string => (win() ? out(path.win32.dirname(p)) : path.dirname(p));
export const basename = (p: string, ext?: string): string => (win() ? path.win32.basename(p, ext) : path.basename(p, ext));
export const extname = (p: string): string => (win() ? path.win32.extname(p) : path.extname(p));
export const isAbsolute = (p: string): boolean => (win() ? path.win32.isAbsolute(p) : path.isAbsolute(p));

const driveOf = (p: string) => /^([A-Z]):\//.exec(p)?.[1] ?? null;

/**
 * The real path of `p` (it throws as realpath does), in the form the renderer uses. macOS: the native realpath, which
 * gives APFS's real spelling (".git", not ".GIT"). Windows: the native one too (the real case: one file, one grant)
 * while it stays on the drive the path was spelled with; a mapped network drive comes back from it as
 * \\server\share\…, which no IPC path schema takes, and a subst drive as the folder behind it, so there node's own
 * realpath keeps the drive, as fs/files.ts sees the same path.
 */
export function realOut(p: string, fns: { native: (p: string) => string; js: (p: string) => string } = { native: realpathSync.native, js: realpathSync }): string {
  if (!win()) return fns.native(p);
  const real = out(fns.native(p));
  const drive = driveOf(real);
  return drive !== null && drive === driveOf(out(path.win32.resolve(p))) ? real : out(fns.js(p));
}

/**
 * realOut without blocking the main process (a network volume that stopped answering): the same rule, through the
 * async native realpath and node's own.
 */
export async function realOutAsync(p: string, fns: { native: (p: string) => Promise<string>; js: (p: string) => Promise<string> } = { native: (x) => realpathAsync(x), js: (x) => realpathJs(x) }): Promise<string> {
  if (!win()) return fns.native(p);
  const real = out(await fns.native(p));
  const drive = driveOf(real);
  return drive !== null && drive === driveOf(out(path.win32.resolve(p))) ? real : out(await fns.js(p));
}

/** node's own realpath (the JS one, as realpathSync), async. */
const realpathJs = (p: string) => new Promise<string>((done, fail) => { realpath(p, (e, r) => (e ? fail(e) : done(r))); });

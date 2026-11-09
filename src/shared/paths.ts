// Path checks for both platforms. Each helper takes the path style, by default the running
// platform's (shared/platform.ts). The POSIX branch is exactly the check it replaces (paths.test.ts runs the old code
// as the oracle), so macOS behaves as before; the win32 branch adds drive letters, backslashes, case-insensitive
// names and the names NTFS reserves or aliases. Pure: no node:path (the renderer uses it too).
import { pathStyle, type PathStyle } from './platform';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const WIN32_BAD_CHAR = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/;
const WIN32_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
const WIN32_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const MAX = 4096;

const style0 = (s?: PathStyle): PathStyle => s ?? pathStyle();
/** win32 form for comparisons: one separator, one case. */
const fold = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Why a single name can't be a Windows file or folder name, or null when it can. '.' and '..' are the caller's. */
export function win32NameProblem(seg: string): 'character' | 'reserved' | 'trailing' | null {
  if (WIN32_BAD_CHAR.test(seg)) return 'character';
  if (WIN32_RESERVED.test(seg)) return 'reserved';
  if (/[. ]$/.test(seg)) return 'trailing';
  return null;
}

/** An absolute path: `/…` on POSIX; a drive letter and a separator on Windows (no UNC, no `\\?\`, no `C:x`). */
export function isAbsPath(p: string, style?: PathStyle): boolean {
  return style0(style) === 'win32' ? WIN32_DRIVE_ROOT.test(p) : p.startsWith('/');
}

/**
 * An absolute path with no empty, `.` or `..` segment and no control character (C0, DEL, C1: such a path may be typed
 * into a terminal, where U+009B is a CSI), at most 4096 long, not the root itself. On Windows also: a drive root,
 * either separator, and every name a valid Windows name.
 */
export function isCleanAbsPath(p: unknown, style?: PathStyle): p is string {
  if (typeof p !== 'string' || p.length > MAX) return false;
  if (style0(style) === 'win32') {
    if (!WIN32_DRIVE_ROOT.test(p) || CONTROL.test(p)) return false;
    return p.slice(3).split(/[\\/]/).every((s) => s !== '' && s !== '.' && s !== '..' && win32NameProblem(s) === null);
  }
  if (!p.startsWith('/')) return false;
  if (CONTROL.test(p)) return false;
  return !p.split('/').slice(1).some((s) => s === '' || s === '.' || s === '..');
}

/** `p` strictly below `root` (`root + '/'` prefix). Windows: either separator, any case. Trailing separators are the caller's. */
export function isBelow(root: string, p: string, style?: PathStyle): boolean {
  if (style0(style) === 'win32') return fold(p).startsWith(`${fold(root)}/`);
  return p.startsWith(root + '/');
}

/** `p` is `root` or below it. */
export function isInside(root: string, p: string, style?: PathStyle): boolean {
  return samePath(root, p, style) || isBelow(root, p, style);
}

/** The same path: `===` on POSIX; any case and either separator on Windows. */
export function samePath(a: string, b: string, style?: PathStyle): boolean {
  return style0(style) === 'win32' ? fold(a) === fold(b) : a === b;
}

/**
 * A relative path that stays inside its root: `/`-separated (git's form, on Windows too), no empty, `.` or `..`
 * segment, no NUL, not absolute. On Windows also no backslash, drive or reserved name.
 */
export function isSafeRel(r: string, style?: PathStyle): boolean {
  if (r.includes('\0') || r.startsWith('/')) return false;
  const win = style0(style) === 'win32';
  if (win && r.includes('\\')) return false;
  return r.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && (!win || win32NameProblem(s) === null));
}

/**
 * A path inside a repository as git prints it, safe to hand back to git (`git show <rev>:<rel>`): not empty, not
 * absolute, no `..` segment, no NUL; on Windows also no backslash or colon (a drive, `..\`).
 */
export function isRepoRel(r: string, style?: PathStyle): boolean {
  if (!r || r.startsWith('/') || r.split('/').includes('..') || r.includes('\0')) return false;
  return style0(style) !== 'win32' || (!r.includes('\\') && !r.includes(':'));
}

/** A name that is (or, on NTFS, resolves to) the `.git` folder: any case, NFC; Windows adds trailing dots/spaces and `GIT~1`. */
export function isGitDirName(seg: string, style?: PathStyle): boolean {
  const s = seg.normalize('NFC').toLowerCase();
  if (s === '.git') return true;
  return style0(style) === 'win32' && (s.replace(/[. ]+$/, '') === '.git' || s === 'git~1');
}

/** The form the renderer and IPC use: identity on POSIX; forward slashes and an upper-case drive on Windows. */
export function toCanonical(p: string, style?: PathStyle): string {
  if (style0(style) !== 'win32') return p;
  const s = p.replace(/\\/g, '/');
  return /^[a-z]:/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The form the OS uses: identity on POSIX; backslashes on Windows. */
export function toNative(p: string, style?: PathStyle): string {
  return style0(style) === 'win32' ? p.replace(/\//g, '\\') : p;
}

/** The segments of a path: split on `/`, and on `\` too on Windows. */
export function splitPath(p: string, style?: PathStyle): string[] {
  return style0(style) === 'win32' ? p.split(/[\\/]/) : p.split('/');
}

/**
 * Drops one trailing separator: a root that may end in its separator, as `root.endsWith('/') ? root : root + '/'`
 * saw it (`/p//` stays `/p/`). `trimTrailingSep` drops them all.
 */
export function trimOneSep(p: string, style?: PathStyle): string {
  return p.replace(style0(style) === 'win32' ? /[\\/]$/ : /\/$/, '');
}

/** Drops trailing separators (`/` on POSIX, `/` and `\` on Windows). */
export function trimTrailingSep(p: string, style?: PathStyle): string {
  return p.replace(style0(style) === 'win32' ? /[\\/]+$/ : /\/+$/, '');
}

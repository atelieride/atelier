import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, toOut } from '../cpath';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isUtf8 } from 'node:buffer';

import { homeLabel, imageMime, MAX_FILE_BYTES, MAX_LARGE_FILE_BYTES, type DirEntry, type FileContent, type ImageContent } from '@shared/files';
import { isGitDirName, isInside, splitPath } from '@shared/paths';
import { pathStyle } from '@shared/platform';

export type { DirEntry, FileContent };

export { MAX_FILE_BYTES };
export const DEFAULT_HIDDEN: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'coverage', '.turbo', '.cache', '.DS_Store']);

function real(p: string): string | null {
  try { return toOut(realpathSync(p)); } catch { return null; }
}

/** The real path if it lies inside the project's real root (symlinks included), otherwise null. */
export function insideProject(root: string, p: string): string | null {
  const r = real(root);
  const f = real(resolve(p));
  if (!r || !f) return null;
  return isInside(r, f) ? f : null;
}

/**
 * Folder where a new terminal starts: an existing folder inside the project's real root (symlinks resolved), never
 * inside .git. Returned as spelled by the caller (normalized), so a project opened through a link keeps its paths.
 */
export function terminalCwd(root: string, cwd: string): string | null {
  const abs = resolve(cwd);
  const f = insideProject(root, abs);
  const r = real(root);
  if (!f || !r) return null;
  if (splitPath(relative(r, f)).some((c) => isGitDirName(c))) return null;
  try { return statSync(f).isDirectory() ? abs : null; } catch { return null; }
}

/** A path inside the project as the tree names it: relative to the real root, `/`-separated. */
export const relOf = (root: string, p: string) => relative(real(root) ?? root, p).split(sep).join('/');

const utf16Bom = (b: Buffer) => (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);

/** UTF-16 with its byte order mark (Windows PowerShell 5.1's `>`): its text, else null. */
export function utf16Text(buf: Buffer): string | null {
  if (!utf16Bom(buf)) return null;
  const le = buf[0] === 0xff;
  const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
  return (le ? body : body.swap16()).toString('utf16le');
}

export function looksBinary(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    // UTF-16 text is full of NULs: its BOM says it is text.
    return !utf16Bom(buf.subarray(0, n)) && buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** The real path of a file outside the project the user opened (fs/grants.ts), or null. */
export type Granted = (p: string) => string | null;
const NONE: Granted = () => null;

const isGitName = (c: string) => isGitDirName(c);

/**
 * What a read reaches: a project file (rel from the root), a granted file outside it (rel = its path with ~, marked
 * external), or nothing.
 */
function reach(root: string, p: string, granted: Granted, home: string): { f: string; rel: string; ext: { external?: true }; git: boolean } | FileContent {
  const abs = resolve(p);
  const r = real(root) ?? root;
  if (!real(abs)) {
    // A granted file deleted on disk keeps its label: its tab says it is gone, not a path climbing out of the root.
    return granted(abs) ? { kind: 'missing', path: abs, rel: homeLabel(abs, home), external: true } : { kind: 'missing', path: abs, rel: relative(r, abs) };
  }
  const f = insideProject(root, abs);
  if (f) {
    const rel = relOf(root, f);
    return { f, rel, ext: {}, git: rel.split('/').some(isGitName) };
  }
  const g = granted(abs);
  if (!g) return { kind: 'outside', path: abs, rel: relative(r, abs) };
  return { f: g, rel: homeLabel(g, home), ext: { external: true }, git: splitPath(g).some(isGitName) };
}

export { MAX_LARGE_FILE_BYTES };

/**
 * What `p` reaches now, as every read here checks it: a project file, a granted one outside (marked external), or why
 * not (missing, outside). The media tokens check it at every request (media-protocol.ts).
 */
export function reachFile(root: string, p: string, granted: Granted = NONE, home = toOut(homedir())): { f: string; rel: string; ext: { external?: true } } | { kind: 'missing' | 'outside'; path: string; rel: string; external?: true } {
  const at = reach(root, p, granted, home);
  if (!('kind' in at)) return at;
  return { kind: at.kind === 'missing' ? 'missing' : 'outside', path: at.path, rel: at.rel, ...(at.external ? { external: true as const } : {}) };
}

/** Open Anyway: text up to 50 MB, plain UTF-8 past 5 MB marked read-only 'large'. */
export function readLargeProjectFile(root: string, p: string, granted: Granted = NONE, home = toOut(homedir())): FileContent {
  return readProjectFile(root, p, granted, home, MAX_LARGE_FILE_BYTES);
}

export function readProjectFile(root: string, p: string, granted: Granted = NONE, home = toOut(homedir()), max = MAX_FILE_BYTES): FileContent {
  const at = reach(root, p, granted, home);
  if ('kind' in at) return at;
  const { f, rel, ext } = at;
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(f);
    if (!st.isFile()) return { kind: 'missing', path: f, rel, ...ext };
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { kind: 'missing', path: f, rel, ...ext };
  }
  try {
    // Binary first: a 20 MB video is a binary file, not a text too large to show.
    if (looksBinary(f)) return { kind: 'binary', path: f, rel, size, ...ext };
    if (size > max) return { kind: 'too-large', path: f, rel, size, ...ext };
    const buf = readFileSync(f);
    const hash = createHash('sha256').update(buf).digest('hex');
    // UTF-16 (BOM first): its text, read-only as any file that is not UTF-8 (a save would write UTF-8 over it).
    const wide = utf16Text(buf);
    if (wide !== null) return { kind: 'text', path: f, rel, text: wide, size: buf.length, mtimeMs, hash, readOnly: 'not-utf8', ...ext };
    // Not UTF-8 (e.g. Latin-1): shown faithfully but read-only, because saving it would corrupt it.
    if (!isUtf8(buf)) return { kind: 'text', path: f, rel, text: buf.toString('latin1'), size: buf.length, mtimeMs, hash, readOnly: 'not-utf8', ...ext };
    // Inside .git (even of a nested repo) Atelier never writes: shown read-only instead of letting the save fail.
    if (at.git) return { kind: 'text', path: f, rel, text: buf.toString('utf8'), size: buf.length, mtimeMs, hash, readOnly: 'git-internal', ...ext };
    return { kind: 'text', path: f, rel, text: buf.toString('utf8'), size: buf.length, mtimeMs, hash, ...(buf.length > MAX_FILE_BYTES ? { readOnly: 'large' as const } : {}), ...ext };
  } catch {
    // Missing permissions, or file gone between stat and read.
    return { kind: 'unreadable', path: f, rel, ...ext };
  }
}

/** Images open in a tab up to this size (a screenshot is a few MB). */
export const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;

/** An image for its tab: only files whose extension is an image type, inside the root or granted. */
export function readProjectImage(root: string, p: string, granted: Granted = NONE, home = toOut(homedir())): ImageContent {
  const at = reach(root, p, granted, home);
  if ('kind' in at) return at as ImageContent;
  const { f, rel, ext } = at;
  const mime = imageMime(f);
  try {
    const st = statSync(f);
    if (!st.isFile()) return { kind: 'missing', path: f, rel, ...ext };
    if (!mime) return { kind: 'unreadable', path: f, rel, ...ext };
    if (st.size > MAX_IMAGE_FILE_BYTES) return { kind: 'too-large', path: f, rel, size: st.size, ...ext };
    const buf = readFileSync(f);
    return { kind: 'image', path: f, rel, mime, data: buf.toString('base64'), size: buf.length, mtimeMs: st.mtimeMs, ...ext };
  } catch {
    return { kind: 'unreadable', path: f, rel, ...ext };
  }
}

export function listDir(root: string, dir: string, showHidden: boolean): DirEntry[] {
  const d = insideProject(root, dir);
  if (!d) return [];
  let names: string[];
  try { names = readdirSync(d); } catch { return []; }
  const entries: DirEntry[] = [];
  for (const name of names) {
    const path = join(d, name);
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); } catch { /* broken symlink: shown as a file */ }
    const hidden = DEFAULT_HIDDEN.has(name);
    if (hidden && !showHidden) continue;
    entries.push({ name, path, rel: relOf(root, path), dir: isDir, hidden });
  }
  return entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
}

/**
 * Where a quoted path may be, in order. On Windows a Git Bash path (/c/Users/…) is its drive's path (C:/Users/…) first;
 * Windows itself would read it as a folder c on the current drive, still tried after.
 */
export function candidateTries(path: string, cwd: string, root: string, platform: string = pathStyle()): string[] {
  if (!isAbsolute(path)) return [join(cwd, path), join(root, path)];
  const bash = platform === 'win32' ? /^\/([A-Za-z])(\/.*)?$/.exec(path) : null;
  return bash ? [`${bash[1]!.toUpperCase()}:${bash[2] ?? '/'}`, path] : [path];
}

/** A path quoted in the terminal: relative to the session folder, then to the root, absolute or in the home (~/). */
export function resolveCandidate(root: string, cwd: string, candidate: string, home = toOut(homedir())): { path: string; rel: string } | null {
  const path = candidate.startsWith('~/') ? join(home, candidate.slice(2)) : candidate;
  // Asked at every hover: a path written outside the project (as spelled or by its real path) never touches the disk,
  // or output naming ~/Desktop would raise a privacy prompt. A link from outside
  // into the project opens on ⌘-click instead (checkOutsideFile).
  const realRoot = real(root);
  const near = (t: string) => isInside(root, t) || (realRoot !== null && isInside(realRoot, t));
  for (const t of candidateTries(path, cwd, root)) {
    if (!near(t)) continue;
    const f = insideProject(root, t);
    if (!f) continue;
    try { if (!statSync(f).isFile()) continue; } catch { continue; }
    return { path: f, rel: relOf(root, f) };
  }
  return null;
}

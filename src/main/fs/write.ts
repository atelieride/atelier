import { isUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, closeSync, constants, copyFileSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, realOut, resolve, toOut } from '../cpath';
import { isAbsPath, isGitDirName, isInside, splitPath, win32NameProblem } from '@shared/paths';
import { pathStyle } from '@shared/platform';
import { devEnv } from '../dev-env';
import { renameWithRetry } from '../../daemon/fsutil';

export { renameWithRetry };

// The only module that writes into the project. Every operation stems from an explicit user action.

export type { Stamp } from '@shared/files';
import type { Stamp } from '@shared/files';
export type SaveResult = { kind: 'saved'; stamp: Stamp } | { kind: 'conflict'; disk: string; stamp: Stamp } | { kind: 'error'; reason: string };
type Err = { error: string };

/** The largest file a save writes (UTF-8 bytes). */
export const MAX_BYTES = 5 * 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function stampOf(p: string): Stamp {
  const buf = readFileSync(p);
  return { mtimeMs: statSync(p).mtimeMs, size: buf.length, hash: sha(buf) };
}

// Native realpath: on APFS (which is case-insensitive) it returns the real name, ".git" and not ".GIT" (on Windows a
// mapped drive stays that drive: realOut).
const realpath = (p: string) => realOut(p);
function realRoot(root: string): string | null {
  try { return realpath(root); } catch { return null; }
}
const inside = (r: string, p: string) => isInside(r, p);
/**
 * ".git" in any form: different capitalization or non-normalized Unicode are the same name on APFS; on NTFS also
 * trailing dots or spaces and the short name GIT~1.
 */
const isGitName = (c: string) => isGitDirName(c);
const inGit = (r: string, p: string) => p !== r && splitPath(p.slice(r.length + 1)).some(isGitName);

/**
 * Name of a new file or folder: no separators, NUL, "." "..", ".git", nor names that are too long; on Windows also
 * no drive, reserved device name, forbidden character or trailing dot or space.
 */
export function validName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 || /[/\0]/.test(name) || name === '.' || name === '..' || isGitName(name)) return false;
  return pathStyle() !== 'win32' || win32NameProblem(name) === null;
}

/**
 * An entry's own name, which locate never resolves: on Windows one NTFS reads as something else is refused (a stream,
 * `.git::$INDEX_ALLOCATION` being the .git folder itself, CVE-2019-1352; a device; a trailing dot or space).
 */
export function entryNameOk(name: string, style = pathStyle()): boolean {
  return style !== 'win32' || win32NameProblem(name) === null;
}

/**
 * Location of a project entry without following the last component: the folder containing it is resolved
 * (symlinks included) and must lie inside the real root, outside .git. The root itself is not an entry.
 */
function locate(root: string, p: string): { r: string; path: string; parent: string } | null {
  const r = realRoot(root);
  if (!r) return null;
  const abs = resolve(p);
  let parent: string;
  try { parent = realpath(dirname(abs)); } catch { return null; }
  if (!inside(r, parent)) return null;
  const path = join(parent, basename(abs));
  if (path === r || inGit(r, path) || !entryNameOk(basename(abs))) return null;
  return { r, path, parent };
}

function exists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/**
 * Atomic save: temp file in the same folder with the original mode, fsync, rename.
 * Does not create new files, except with `create` (file deleted on disk while open with edits), and then only while the
 * name is still free: a file that reappeared meanwhile is a conflict, never overwritten. Never skips the conflict check:
 * Keep Mine saves against the stamp of the version it was shown, so a newer one is a conflict again.
 * Does not write to read-only files nor to files that are not UTF-8 (they would be corrupted).
 */
export function saveFile(root: string, p: string, text: string, base: Stamp | null, eol: 'lf' | 'crlf', create = false): SaveResult {
  try {
    return saveInner(root, p, text, base, eol, create);
  } catch (e) {
    return { kind: 'error', reason: (e as NodeJS.ErrnoException).code ?? 'failed' };
  }
}

function conflictOf(target: string, cur: Buffer): SaveResult {
  return { kind: 'conflict', disk: cur.toString('utf8'), stamp: { mtimeMs: statSync(target).mtimeMs, size: cur.length, hash: sha(cur) } };
}

function saveInner(root: string, p: string, text: string, base: Stamp | null, eol: 'lf' | 'crlf', create: boolean): SaveResult {
  const loc = locate(root, p);
  if (!loc) return { kind: 'error', reason: 'outside' };
  let target = loc.path;
  let present = true;
  try {
    if (lstatSync(target).isSymbolicLink()) {
      // A link is followed only if it leads to a file of the same project (outside .git).
      const real = realpath(target);
      if (!inside(loc.r, real) || inGit(loc.r, real)) return { kind: 'error', reason: 'outside' };
      target = real;
    }
    if (!statSync(target).isFile()) return { kind: 'error', reason: 'not-a-file' };
  } catch {
    present = false;
  }
  return writeAtomic(target, present, text, base, eol, create);
}

/**
 * Save of a file outside the project the user opened: `granted` is its real path at grant time.
 * Same conflicts and read-only rules as a project file; never inside a .git folder, never through a symlink or a parent
 * folder swapped in after the grant. Written in place, not atomically: a temp file next to it would be a new file in
 * its folder (`~/Downloads`), which macOS answers with a privacy prompt for the whole folder.
 */
export function saveGrantedFile(granted: string, text: string, base: Stamp | null, eol: 'lf' | 'crlf', create = false): SaveResult {
  try {
    if (!isAbsolute(granted) || resolve(granted) !== granted) return { kind: 'error', reason: 'outside' };
    if (splitPath(granted).some(isGitName)) return { kind: 'error', reason: 'git-internal' };
    let parent: string;
    try { parent = realpath(dirname(granted)); } catch { return { kind: 'error', reason: 'missing' }; }
    if (parent !== dirname(granted)) return { kind: 'error', reason: 'outside' };
    let present = true;
    try {
      const st = lstatSync(granted);
      if (st.isSymbolicLink()) return { kind: 'error', reason: 'outside' };
      if (!st.isFile()) return { kind: 'error', reason: 'not-a-file' };
    } catch {
      present = false;
    }
    return writeInPlace(granted, present, text, base, eol, create);
  } catch (e) {
    return { kind: 'error', reason: (e as NodeJS.ErrnoException).code ?? 'failed' };
  }
}

/** Rewrites the file through one descriptor (no link followed): checked, written, truncated, synced. */
function writeInPlace(target: string, present: boolean, text: string, base: Stamp | null, eol: 'lf' | 'crlf', create: boolean): SaveResult {
  if (!present && !create) return { kind: 'error', reason: 'missing' };
  const data = Buffer.from(eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8');
  if (data.length > MAX_BYTES) return { kind: 'error', reason: 'too-large' };
  let fd: number | null = null;
  let mtimeMs = 0;
  try {
    if (present) {
      try { fd = openSync(target, constants.O_RDWR | constants.O_NOFOLLOW); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return { kind: 'error', reason: code === 'EACCES' || code === 'EPERM' ? 'read-only' : code === 'ELOOP' ? 'outside' : code ?? 'write-failed' };
      }
      const st = fstatSync(fd);
      if (!st.isFile()) return { kind: 'error', reason: 'not-a-file' };
      if (st.size > MAX_BYTES) return { kind: 'error', reason: 'too-large' };
      // What is on disk right now, through the descriptor we write to: the conflict check sees the very file.
      const cur = Buffer.alloc(st.size);
      let got = 0;
      while (got < cur.length) { const n = readSync(fd, cur, got, cur.length - got, got); if (!n) break; got += n; }
      const disk = cur.subarray(0, got);
      if (!isUtf8(disk)) return { kind: 'error', reason: 'not-utf8' };
      if (base ? sha(disk) !== base.hash : create) return conflictOf(target, disk);
    } else {
      try { fd = openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); } catch (e) {
        // It came back between the check and the create: someone else's file, a conflict.
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return reappeared(target);
        throw e;
      }
    }
    let put = 0;
    while (put < data.length) put += writeSync(fd, data, put, data.length - put, put);
    ftruncateSync(fd, data.length);
    fsyncSync(fd);
    mtimeMs = fstatSync(fd).mtimeMs;
  } catch (e) {
    return { kind: 'error', reason: (e as NodeJS.ErrnoException).code ?? 'write-failed' };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
  return { kind: 'saved', stamp: writtenStamp(data, mtimeMs) };
}

/**
 * The stamp of what a save wrote, from its own bytes (stampOf's format): a file read back after the rename could
 * already be someone else's write, which would then pass for the base of the next save. Conflicts compare the hash
 * only; mtimeMs is the written file's (a recreate without hard links: the temporary copy's, close enough).
 */
const writtenStamp = (data: Buffer, mtimeMs: number): Stamp => ({ mtimeMs, size: data.length, hash: sha(data) });

function writeAtomic(target: string, present: boolean, text: string, base: Stamp | null, eol: 'lf' | 'crlf', create: boolean): SaveResult {
  if (!present && !create) return { kind: 'error', reason: 'missing' };
  const data = Buffer.from(eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8');
  if (data.length > MAX_BYTES) return { kind: 'error', reason: 'too-large' };
  let mode = 0o644;
  if (present) {
    try { accessSync(target, constants.W_OK); } catch { return { kind: 'error', reason: 'read-only' }; }
    const cur = readFileSync(target);
    if (!isUtf8(cur)) return { kind: 'error', reason: 'not-utf8' };
    // A conflict is about content: a changed mtime with the same text is not one. Recreating a file that is back (with
    // nothing to compare it to) is one.
    if (base ? sha(cur) !== base.hash : create) return conflictOf(target, cur);
    mode = statSync(target).mode & 0o7777;
  }
  const tmp = join(dirname(target), `.${basename(target)}.atelier-${randomBytes(4).toString('hex')}`);
  let fd: number | null = null;
  let mtimeMs = 0;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeSync(fd, data);
    fsyncSync(fd);
    // The rename keeps the file's mtime (chmod changes only its ctime).
    mtimeMs = fstatSync(fd).mtimeMs;
    closeSync(fd);
    fd = null;
    chmodSync(tmp, mode);
    // Claude may have written just now: one last check right before replacing the file.
    if (present && base) {
      const again = readFileSync(target);
      if (sha(again) !== base.hash) { unlinkSync(tmp); return conflictOf(target, again); }
    }
    if (present) renameWithRetry(tmp, target);
    // Recreated only while the name is free: a hard link (or, without them, an exclusive create) never replaces a file
    // that came back meanwhile.
    else if (!createOnly(tmp, target, data)) { unlinkSync(tmp); return reappeared(target); }
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* never created or already removed */ }
    return { kind: 'error', reason: (e as NodeJS.ErrnoException).code ?? 'write-failed' };
  }
  return { kind: 'saved', stamp: writtenStamp(data, mtimeMs) };
}

/** A file that is back where a save meant to create it: its content as a conflict (an error if it can't be read). */
function reappeared(target: string): SaveResult {
  try {
    const cur = readFileSync(target);
    return isUtf8(cur) ? conflictOf(target, cur) : { kind: 'error', reason: 'not-utf8' };
  } catch (e) {
    return { kind: 'error', reason: (e as NodeJS.ErrnoException).code ?? 'exists' };
  }
}

/**
 * Puts the temp file at `target` only if nothing is there: false when the name was taken meanwhile. The temp file is
 * removed when linked; left to the caller otherwise.
 */
export function createOnly(tmp: string, target: string, data: Buffer, link: (from: string, to: string) => void = linkSync): boolean {
  try {
    link(tmp, target);
    try { unlinkSync(tmp); } catch { /* the file is in place either way */ }
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') return false;
    if (!NO_HARD_LINKS.has(code)) throw e;
  }
  let fd: number;
  try { fd = openSync(target, 'wx', statSync(tmp).mode & 0o7777); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try { writeAll(fd, data); } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    // Only the file this call created (and failed to fill) is removed: never someone else's.
    try { unlinkSync(target); } catch { /* already gone */ }
    throw e;
  }
  closeSync(fd);
  try { unlinkSync(tmp); } catch { /* the file is in place either way */ }
  return true;
}

/** New empty file or new folder in a project folder. */
export function createEntry(root: string, dir: string, name: string, kind: 'file' | 'folder'): { path: string } | Err {
  if (!validName(name)) return { error: 'invalid-name' };
  const r = realRoot(root);
  let d: string;
  try { d = realpath(dir); } catch { return { error: 'missing' }; }
  if (!r || !inside(r, d) || inGit(r, d) || !statSync(d).isDirectory()) return { error: 'outside' };
  const target = join(d, name);
  if (exists(target)) return { error: 'exists' };
  try {
    if (kind === 'folder') mkdirSync(target);
    else closeSync(openSync(target, 'wx', 0o644));
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code ?? 'failed' };
  }
  return { path: target };
}

/** Errno codes of a volume that cannot make hard links (exFAT, FAT, some network shares). */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EXDEV']);
/** Save as reports only codes the sheet knows how to explain. */
function saveAsError(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EEXIST') return 'exists';
  if (code === 'ENAMETOOLONG') return 'invalid-name';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'EACCES';
  return 'failed';
}

/** Writes a whole buffer to an open descriptor and flushes it to disk. */
function writeAll(fd: number, data: Buffer) {
  for (let off = 0; off < data.length;) off += writeSync(fd, data, off, data.length - off);
  fsyncSync(fd);
}

/**
 * "Save as" of an untitled tab: a new file with its text at a path relative to the project root, in an existing
 * folder (resolved, links included, inside the real root and outside .git). Never replaces anything: written to a
 * temp file, fsynced, then hard-linked into place (link() fails if the name was taken meanwhile).
 * Volumes without hard links fall back to an exclusive create (still never an overwrite).
 */
export function createFileWithContent(root: string, rel: string, text: string, link: (from: string, to: string) => void = linkSync): { path: string } | Err {
  const parts = splitPath(rel);
  if (rel.startsWith('/') || isAbsPath(rel)) return { error: 'absolute' };
  if (parts.includes('..')) return { error: 'outside' };
  if (parts.some((c) => c === '' || c === '.')) return { error: 'invalid-name' };
  if (parts.some(isGitName)) return { error: 'in-git' };
  if (!parts.every(validName)) return { error: 'invalid-name' };
  const r = realRoot(root);
  if (!r) return { error: 'outside' };
  let d: string;
  try { d = realpath(join(r, ...parts.slice(0, -1))); } catch { return { error: 'missing-folder' }; }
  if (!inside(r, d)) return { error: 'outside' };
  if (inGit(r, d)) return { error: 'in-git' };
  if (!statSync(d).isDirectory()) return { error: 'not-a-folder' };
  const name = parts.at(-1)!;
  const target = join(d, name);
  if (exists(target)) return { error: 'exists' };
  const data = Buffer.from(text, 'utf8');
  if (data.length > MAX_BYTES) return { error: 'too-large' };
  const tmp = join(d, `.${name}.atelier-${randomBytes(4).toString('hex')}`);
  let fd: number | null = null;
  let linked = true;
  try {
    fd = openSync(tmp, 'wx', 0o644);
    writeAll(fd, data);
    closeSync(fd);
    fd = null;
    try { link(tmp, target); } catch (e) {
      if (!NO_HARD_LINKS.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      linked = false;
    }
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    return { error: saveAsError(e) };
  } finally {
    try { unlinkSync(tmp); } catch { /* never created */ }
  }
  if (linked) return { path: target };
  // No hard links on this volume: an exclusive create still refuses an existing name (never an overwrite).
  let created = false;
  try {
    fd = openSync(target, 'wx', 0o644);
    created = true;
    writeAll(fd, data);
    closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    // Only a file this call created (and failed to fill) is removed: never someone else's.
    if (created) try { unlinkSync(target); } catch { /* already gone */ }
    return { error: saveAsError(e) };
  }
  return { path: target };
}

/**
 * Save As outside the project: a new file at the path the user chose in main's save
 * panel (never one the page names). Absolute and normalized, no .git component (before or after its folder is
 * resolved), a valid name, its folder resolved (links included) and existing. Something already at that path — the panel
 * asked "Replace?" — goes to the Trash first, never deleted, and only a regular file: a link or a folder is refused.
 * Created through one exclusive, no-follow descriptor and written in place: a temp file next to it would be a new file
 * in its folder (`~/Downloads`), which macOS answers with a privacy prompt for the whole folder.
 */
export async function createOutsideFile(path: string, text: string, trash: (p: string) => Promise<void>): Promise<{ path: string } | Err> {
  if (!isAbsolute(path) || resolve(path) !== path) return { error: 'outside' };
  if (splitPath(path).some(isGitName)) return { error: 'in-git' };
  const name = basename(path);
  if (!validName(name)) return { error: 'invalid-name' };
  const data = Buffer.from(text, 'utf8');
  if (data.length > MAX_BYTES) return { error: 'too-large' };
  let d: string;
  try { d = realpath(dirname(path)); } catch { return { error: 'missing-folder' }; }
  if (splitPath(d).some(isGitName)) return { error: 'in-git' };
  if (!statSync(d).isDirectory()) return { error: 'not-a-folder' };
  const target = join(d, name);
  let there: 'file' | 'other' | null = null;
  try { const st = lstatSync(target); there = st.isFile() ? 'file' : 'other'; } catch { there = null; }
  if (there === 'other') return { error: 'not-a-file' };
  if (there === 'file') {
    try { await trash(target); } catch { return { error: 'trash-failed' }; }
  }
  let fd: number | null = null;
  let created = false;
  try {
    // Exclusive: a file that came back between the Trash and now is someone else's, never overwritten.
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    created = true;
    writeAll(fd, data);
    closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    // Only a file this call created (and failed to fill) is removed: never someone else's.
    if (created) try { unlinkSync(target); } catch { /* already gone */ }
    return { error: saveAsError(e) };
  }
  return { path: target };
}

function sameInode(a: string, b: string): boolean {
  try { const x = lstatSync(a); const y = lstatSync(b); return x.ino === y.ino && x.dev === y.dev; } catch { return false; }
}

/** Renames within the same folder; a symlink is renamed as a link. */
export function renameEntry(root: string, p: string, name: string): { path: string } | Err {
  if (!validName(name)) return { error: 'invalid-name' };
  const loc = locate(root, p);
  if (!loc || !exists(loc.path)) return { error: 'outside' };
  const dest = join(loc.parent, name);
  if (dest === loc.path) return { path: dest };
  // Capitalization-only change (a.ts → A.ts): on APFS "A.ts" appears to exist because it is the same file. Rename if
  // it really is the same (same inode), otherwise it is another file and the destination is taken.
  const sameFile = dest.toLowerCase() === loc.path.toLowerCase() && sameInode(dest, loc.path);
  if (!sameFile && exists(dest)) return { error: 'exists' };
  try { renameWithRetry(loc.path, dest); } catch (e) { return { error: (e as NodeJS.ErrnoException).code ?? 'failed' }; }
  return { path: dest };
}

/** Copy of a file next to the original: "name copy.ext", "name copy 2.ext"… (real files only, not links). */
export function duplicateEntry(root: string, p: string): { path: string } | Err {
  const loc = locate(root, p);
  if (!loc) return { error: 'outside' };
  try { if (!lstatSync(loc.path).isFile()) return { error: 'not-a-file' }; } catch { return { error: 'missing' }; }
  const name = basename(loc.path);
  const ext = name.startsWith('.') && name.indexOf('.', 1) === -1 ? '' : extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const dest = join(loc.parent, `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`);
    if (exists(dest)) continue;
    try { copyFileSync(loc.path, dest, constants.COPYFILE_EXCL); } catch (e) { return { error: (e as NodeJS.ErrnoException).code ?? 'failed' }; }
    return { path: dest };
  }
  return { error: 'too-many-copies' };
}

/** To the macOS Trash (never permanent deletion): project entries only, never the root or .git. */
export async function trashEntry(root: string, p: string, trash: (path: string) => Promise<void>): Promise<{ ok: true } | Err> {
  const loc = locate(root, p);
  if (!loc || !exists(loc.path)) return { error: 'outside' };
  try { await trash(loc.path); } catch (e) { return { error: (e as Error).message || 'failed' }; }
  return { ok: true };
}

/** For the trash confirmation: file or folder, and how many files it contains (up to 10000). */
export function entryInfo(root: string, p: string): { kind: 'file' | 'folder'; files: number } | Err {
  const loc = locate(root, p);
  if (!loc) return { error: 'outside' };
  let st;
  try { st = lstatSync(loc.path); } catch { return { error: 'missing' }; }
  if (!st.isDirectory()) return { kind: 'file', files: 1 };
  let files = 0;
  const walk = (d: string) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (files >= 10000) return;
      const q = join(d, n);
      let s;
      try { s = lstatSync(q); } catch { continue; }
      if (s.isDirectory()) walk(q); else files++;
    }
  };
  walk(loc.path);
  return { kind: 'folder', files };
}

/** The system Trash (shell.trashItem), loaded only in the Electron process. */
export async function systemTrash(): Promise<(p: string) => Promise<void>> {
  // In tests (dev only) the "trash" is a temporary folder: the user's real Trash is never touched.
  const testTrash = devEnv('ATELIER_TEST_TRASH_DIR');
  if (testTrash) return async (x) => { renameSync(x, join(testTrash, `${Date.now()}-${basename(x)}`)); };
  const { shell } = await import('electron');
  return (x) => shell.trashItem(x);
}

export async function moveToTrash(root: string, p: string): Promise<{ ok: true } | Err> {
  return trashEntry(root, p, await systemTrash());
}

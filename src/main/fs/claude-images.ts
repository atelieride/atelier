import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, toOut } from '../cpath';
import { isBelow, isGitDirName, splitPath, trimTrailingSep } from '@shared/paths';
import { currentPlatform } from '@shared/platform';
import { MAX_PATH_BYTES } from './grants';

/**
 * The files Claude Code keeps in its temp folder (`/tmp/claude-<uid>`: screenshots, drafts, scratch files) open from
 * terminal links without a gesture, read-only. Only the one path asked for is resolved
 * and stat'ed: nothing lists the folder.
 */

/**
 * The real path of Claude's temp root when it can be trusted: a folder owned by the app's user that nobody else can
 * write to (it sits in the shared /tmp, where anyone could create `claude-<our uid>` first). Otherwise null.
 */
export function claudeTempRoot(tmp: string, uid: number | null): string | null {
  try {
    const real = claudeTempPath(tmp);
    if (!real) return null;
    const st = lstatSync(real);
    if (!st.isDirectory()) return null;
    // Windows: it sits in the user's own %TEMP% (no shared /tmp to plant it in); there is no uid, and libuv reports
    // every writable folder as 0o666, so the mode bits say nothing.
    if (currentPlatform() === 'win32') return real;
    if (uid !== null && st.uid !== uid) return null;
    return (st.mode & 0o022) === 0 ? real : null;
  } catch {
    return null;
  }
}

/**
 * Where the temp root is, trusted or not: links in the parent followed (macOS /tmp is /private/tmp), the root's own
 * name kept, because the root itself must not be a link (anyone can put a `claude-<uid>` link in /tmp).
 */
export function claudeTempPath(tmp: string): string | null {
  try { return join(toOut(realpathSync.native(dirname(tmp))), basename(tmp)); } catch { return null; }
}

/**
 * Whether a path is written under the temp root (as configured, or with its parent resolved): checked before anything
 * touches the disk, so the folders and files of terminal output elsewhere (Desktop, Downloads…) are never resolved,
 * which macOS would answer with privacy prompts. A link elsewhere leading into the root doesn't count, nor
 * does a `.` or `..` part: written under the root, `…/scratchpad/../../../../Users/me/Desktop/x` leads out.
 */
export function writtenUnder(tmp: string, path: string): boolean {
  if (splitPath(path).some((c) => c === '.' || c === '..')) return false;
  const as = trimTrailingSep(tmp);
  if (isBelow(as, path)) return true;
  const real = claudeTempPath(tmp);
  return !!real && isBelow(real, path);
}

/** Whether a real path lies under the temp root's place, whether or not the root passes its checks now. */
export function underClaudeTemp(tmp: string, real: string): boolean {
  const root = claudeTempPath(tmp);
  return !!root && isBelow(root, real);
}

/** A tab's label for a file in the temp root: from `scratchpad/` on, else from inside the session folder. */
export function claudeTempLabel(real: string, root: string): string {
  const parts = splitPath(relative(root, real));
  const i = parts.lastIndexOf('scratchpad');
  if (i >= 0) return parts.slice(i).join('/');
  // <project slug>/<session id>/…
  return (parts.length > 2 ? parts.slice(2) : parts.slice(-1)).join('/');
}

/**
 * The real path and label of a folder inside Claude's temp root (not the root itself), or null: what a folder link
 * opens in Finder. Nothing is listed.
 */
export function checkClaudeFolder(tmp: string, path: string, uid: number | null): { path: string; rel: string } | null {
  if (!isAbsolute(path) || Buffer.byteLength(path) > MAX_PATH_BYTES || !writtenUnder(tmp, path)) return null;
  const root = claudeTempRoot(tmp, uid);
  if (!root) return null;
  try {
    const real = toOut(realpathSync.native(path));
    if (!isBelow(root, real)) return null;
    if (splitPath(relative(root, real)).some((c) => isGitDirName(c))) return null;
    return statSync(real).isDirectory() ? { path: real, rel: claudeTempLabel(real, root) } : null;
  } catch {
    return null;
  }
}

/**
 * The real path and label of a regular file in Claude's temp root, of any kind (a draft, a log, an image), or
 * null. The size is its tab's business: a file too large to show still opens, saying so.
 */
export function checkClaudeFile(tmp: string, path: string, uid: number | null): { path: string; rel: string } | null {
  if (!isAbsolute(path) || Buffer.byteLength(path) > MAX_PATH_BYTES || !writtenUnder(tmp, path)) return null;
  const root = claudeTempRoot(tmp, uid);
  if (!root) return null;
  try {
    // Native realpath: links resolved (one inside pointing out is caught below), APFS spelling kept.
    const real = toOut(realpathSync.native(path));
    if (!isBelow(root, real)) return null;
    if (splitPath(relative(root, real)).some((c) => isGitDirName(c))) return null;
    // Never a folder, socket or FIFO (reading one would block).
    if (!statSync(real).isFile()) return null;
    return { path: real, rel: claudeTempLabel(real, root) };
  } catch {
    return null;
  }
}

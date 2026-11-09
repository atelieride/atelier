import { stat } from 'node:fs/promises';
import { realOutAsync } from '../cpath';
import { homeLabel } from '@shared/files';
import { isCleanAbsPath, isGitDirName, splitPath, trimTrailingSep } from '@shared/paths';
import { insideProject, relOf } from './files';
import { MAX_PATH_BYTES } from './grants';

/**
 * Any file a terminal link names outside the project and Claude's temp folder opens read-only on ⌘-click:
 * the checks main makes at a ⌘-hover and again at the click. Async, so a network volume that no
 * longer answers can't freeze the main process. Only the one path asked for is resolved and stat'ed.
 */

/**
 * `~/…` under the home folder (the page sends the canonical form: `~/` on Windows too), the rest as written: the
 * clean-path check must still see a `..`.
 */
export function expandHome(p: string, home: string): string {
  return p.startsWith('~/') ? `${trimTrailingSep(home)}/${p.slice(2)}` : p;
}

/**
 * The real path and label of a regular file outside the project, or null: a clean absolute path (once `~` is
 * expanded) of at most 4096 bytes, no `.git` part as written or once links are followed, never a folder, socket or
 * FIFO (reading one would block). A file of the project (a link from outside into it: the project resolver never
 * touches a path written outside) is answered as the project's, `project: true`, to open with no grant.
 */
export async function checkOutsideFile(root: string, path: string, home: string): Promise<{ path: string; rel: string; project?: true } | null> {
  const abs = expandHome(path, home);
  if (!isCleanAbsPath(abs) || Buffer.byteLength(abs) > MAX_PATH_BYTES) return null;
  const git = (p: string) => splitPath(p).some((c) => isGitDirName(c));
  if (git(abs)) return null;
  try {
    // The native realpath: links resolved, APFS spelling kept (one file is one grant); a Windows mapped drive kept.
    const real = await realOutAsync(abs);
    if (git(real) || !(await stat(real)).isFile()) return null;
    const inside = insideProject(root, real);
    if (inside !== null) return { path: inside, rel: relOf(root, inside), project: true };
    return { path: real, rel: homeLabel(real, home) };
  } catch {
    return null;
  }
}

import { isUntitled } from './untitled';
import { isBelow } from '@shared/paths';

/**
 * A file tab outside the project: opened by a drop, Open File… or from macOS. Tabs hold real
 * paths, so the project's real root decides.
 */
/** The folders a tab's breadcrumb shows before its name (an outside file's absolute path has no empty first step). */
export function crumbDirs(rel: string): string[] {
  return rel.split('/').slice(0, -1).filter(Boolean);
}

export function isExternal(path: string, realRoot: string | null): boolean {
  if (!realRoot || isUntitled(path)) return false;
  const root = realRoot.replace(/\/$/, '');
  return path !== root && !isBelow(root, path);
}

/** An outside file's tab hint: the folder holding it, from its `~` label. */
export function outsideDir(rel: string): string {
  const dirs = rel.split('/').slice(0, -1);
  return dirs.at(-1) || '/';
}

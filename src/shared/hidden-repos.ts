// Repositories the user hid from Atelier, per project: each named by its path inside the project's real root,
// '/'-separated ('agent/data/repo'). The folder scan doesn't enter them, their watcher events are dropped, and
// Source Control, Changes and fetches never see them, nor the repositories inside them.
import { samePath } from './paths';
import type { PathStyle } from './platform';

export const HIDDEN_REPOS_MAX_PER_PROJECT = 200;
export const HIDDEN_REPOS_MAX_PROJECTS = 500;
const MAX_LENGTH = 1024;

/** A path a project may hide: relative, '/'-separated, no empty, '.' or '..' segment, no backslash or NUL. */
export function isHiddenRel(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_LENGTH || /[\\\0]/.test(s)) return false;
  return s.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Whether `rel` (relative to the project's root, either separator: the watcher reports Windows' own) is one of the
 * hidden folders or below one, segment by segment.
 */
export function underHidden(rel: string, hidden: readonly string[], style?: PathStyle): boolean {
  if (hidden.length === 0) return false;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return hidden.some((h) => {
    const n = h.split('/').length;
    return parts.length >= n && samePath(parts.slice(0, n).join('/'), h, style);
  });
}

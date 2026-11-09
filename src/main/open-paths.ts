import { relative, sep } from './cpath';
import { homeLabel } from '@shared/files';
import { isBelow, samePath, trimOneSep } from '@shared/paths';

// One router for every way a path reaches Atelier: Finder drop, Open File…, Open With, `open -a`, the `atelier` command.
//Pure: the disk comes in through OpenDeps.

/** Files opened by one gesture; the rest is reported. */
export const MAX_OPEN_FILES = 20;

export interface OpenDeps {
  kind(path: string): 'file' | 'dir' | 'other' | 'missing';
  /** The real path if it lies inside the project's real root (symlinks resolved), else null. */
  inside(root: string, path: string): string | null;
  /** Grants a file outside the project: its real path, or null. */
  grant(root: string, path: string): string | null;
  home: string;
}

export interface OpenFileEntry { path: string; rel: string; external: boolean }

/**
 * reveal: a folder of the project to show in the Files tree. project: a folder outside it, to open as a project.
 * skipped: paths that open nothing (missing, not a file or folder, folders after the first). capped: how many files
 * there were, when more than MAX_OPEN_FILES. needsProject: files dropped on a window without a project (Welcome).
 */
export interface OpenPlan { files: OpenFileEntry[]; reveal: string | null; project: string | null; skipped: number; capped: number | null; needsProject: number }

export function planOpen(root: string | null, paths: string[], deps: OpenDeps): OpenPlan {
  const plan: OpenPlan = { files: [], reveal: null, project: null, skipped: 0, capped: null, needsProject: 0 };
  let folderTaken = false;
  let fileCount = 0;
  const seen = new Set<string>();
  for (const p of paths) {
    const kind = deps.kind(p);
    if (kind === 'dir') {
      if (folderTaken) { plan.skipped++; continue; }
      folderTaken = true;
      const inProject = root ? deps.inside(root, p) : null;
      if (inProject) plan.reveal = inProject;
      else plan.project = p;
      continue;
    }
    if (kind !== 'file') { plan.skipped++; continue; }
    if (!root) { plan.needsProject++; continue; }
    // Past the cap a file is only counted: granting it would push out the grants of files that are open.
    if (plan.files.length >= MAX_OPEN_FILES) {
      if (!seen.has(p)) { seen.add(p); fileCount++; }
      continue;
    }
    const inProject = deps.inside(root, p);
    const entry: OpenFileEntry | null = inProject
      ? { path: inProject, rel: relative(root, inProject).split(sep).join('/'), external: false }
      : (() => { const g = deps.grant(root, p); return g ? { path: g, rel: homeLabel(g, deps.home), external: true } : null; })();
    if (!entry) { plan.skipped++; continue; }
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    fileCount++;
    plan.files.push(entry);
  }
  if (fileCount > MAX_OPEN_FILES) plan.capped = fileCount;
  return plan;
}

export interface TargetWindow { id: number; root: string | null; focusedAt: number }
export type Target = { kind: 'window'; id: number } | { kind: 'open-project'; root: string } | { kind: 'welcome' };

export const holds = (root: string, path: string) => samePath(root, path) || isBelow(trimOneSep(root), path);

/** Where a file from macOS (no window of its own) goes. Roots and path are real paths. */
export function pickTarget(path: string, windows: TargetWindow[], recent: string[]): Target {
  const projects = windows.filter((w): w is TargetWindow & { root: string } => w.root !== null);
  const byFocus = (a: TargetWindow, b: TargetWindow) => b.focusedAt - a.focusedAt;
  const holding = projects.filter((w) => holds(w.root, path)).sort((a, b) => b.root.length - a.root.length || byFocus(a, b));
  if (holding[0]) return { kind: 'window', id: holding[0].id };
  const last = [...projects].sort(byFocus)[0];
  if (last) return { kind: 'window', id: last.id };
  const recentHolding = recent.filter((r) => holds(r, path)).sort((a, b) => b.length - a.length)[0];
  const root = recentHolding ?? recent[0];
  return root ? { kind: 'open-project', root } : { kind: 'welcome' };
}

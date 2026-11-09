// The commit drawer's repository picker as data: the project's working trees in groups — Staged
// (with the count), Changed, Committed just now (this window's session, with the short sha), then the clean ones,
// which amend can still reword — each in Changes' order; a filter from 6 repositories. Pure.
import type { RepoStatus } from '@shared/git';
import { trackedCounts } from '@shared/git-write';
import { branchLabel } from '../worktrees';
import type { GitResultEntry } from './slice';
import { stagedCount } from './target';
import { isBelow } from '@shared/paths';

export type PickerRepo = Pick<RepoStatus, 'root' | 'name' | 'changes' | 'branch' | 'detached' | 'oid' | 'ahead' | 'upstream' | 'upstreamGone'> & Partial<Pick<RepoStatus, 'behind'>>;

/** From this many repositories the picker shows its filter field (typing filters at any count). */
export const FILTER_FROM = 6;

export interface PickerRow {
  root: string;
  /** The path inside the project: its folder (dimmed, with the trailing slash) and its name. */
  dir: string;
  name: string;
  /** "main", "main ↑2", "detached f0d6c52". */
  branch: string;
  staged: number;
  /** A draft is saved for it (the pink dot). */
  draft: boolean;
  /** The short sha of its commit in this window's session, null without one. */
  committed: string | null;
  /** The filter's match in `dir + name`, null without a query. */
  match: [number, number] | null;
}

export interface PickerGroups { staged: PickerRow[]; changed: PickerRow[]; committed: PickerRow[]; clean: PickerRow[]; total: number; filter: boolean }

/** `project`: its root as opened and as resolved (links), whichever the repositories' roots start with. */
function label(r: PickerRepo, project: readonly string[]): { dir: string; name: string } {
  const p = project.find((x) => isBelow(x, r.root));
  const rel = p ? r.root.slice(p.length + 1) : r.name;
  const i = rel.lastIndexOf('/');
  return i >= 0 ? { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) } : { dir: '', name: rel };
}

export function pickerGroups(o: { repos: readonly PickerRepo[]; project: readonly string[]; drafts: Readonly<Record<string, string>>; results: Readonly<Record<string, GitResultEntry>>; query: string }): PickerGroups {
  const q = o.query.trim().toLowerCase();
  const g: PickerGroups = { staged: [], changed: [], committed: [], clean: [], total: o.repos.length, filter: o.repos.length >= FILTER_FROM };
  for (const r of o.repos) {
    const { dir, name } = label(r, o.project);
    let match: [number, number] | null = null;
    if (q) {
      const at = (dir + name).toLowerCase().indexOf(q);
      if (at < 0) continue;
      match = [at, at + q.length];
    }
    const result = o.results[r.root];
    const ahead = trackedCounts({ ...r, behind: r.behind ?? 0 }).ahead;
    const row: PickerRow = {
      root: r.root, dir, name, match,
      branch: `${branchLabel(r as RepoStatus)}${ahead > 0 ? ` ↑${ahead}` : ''}`,
      staged: stagedCount(r),
      draft: !!o.drafts[r.root]?.trim(),
      committed: result && 'sha' in result ? result.sha.slice(0, 7) : null
    };
    (row.staged > 0 ? g.staged : row.committed ? g.committed : r.changes.length > 0 ? g.changed : g.clean).push(row);
  }
  return g;
}

/** The rows in the order shown, which the arrows follow. */
export function pickerRows(g: PickerGroups): PickerRow[] {
  return [...g.staged, ...g.changed, ...g.committed, ...g.clean];
}

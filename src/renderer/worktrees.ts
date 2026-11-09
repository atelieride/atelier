// Worktrees in Changes: which working tree
// is where, how linked worktrees nest under their repo, and files two branches both change. Pure functions.
import type { RepoStatus } from '@shared/git';
import { inSessionOrder, sureBy, type ChangeBy, type ChangeRow } from './changes';
import { isBelow } from '@shared/paths';

export type WtState = 'files' | 'merge' | 'idle';
/** A linked worktree as Changes shows it: its rows, or one line with what it has to merge, or a chip when idle. */
export interface WtView { status: RepoStatus; name: string; rows: ChangeRow[]; state: WtState }
/** A repo with its linked worktrees. */
export interface Family { repo: RepoStatus; rows: ChangeRow[]; worktrees: WtView[] }

export const isWorktree = (s: RepoStatus | null | undefined): boolean => !!s?.worktreeOf;
/** A working tree's branch, or "detached" with its short commit id (two detached worktrees stay apart). */
export const branchLabel = (s: RepoStatus): string => (s.detached ? (s.oid ? `detached ${s.oid.slice(0, 7)}` : 'detached') : s.branch ?? '—');
const nameOf = (s: RepoStatus): string => s.root.split('/').at(-1) ?? s.root;
const inside = (root: string, p: string) => p === root || isBelow(root, p);
/** Commits a working tree still has to merge: none once its branch was squash or rebase merged. */
export const toMerge = (s: RepoStatus): number => (s.merge && !s.merge.merged ? s.merge.commits : 0);

/** A main repo's untracked entry that is a shown working tree's folder is that tree's group, not a file. */
export function hideWorktreeFolders(repos: RepoStatus[]): RepoStatus[] {
  const roots = new Set(repos.map((r) => r.root));
  return repos.map((r) => {
    const keep = r.changes.filter((c) => !(c.kind === '?' && roots.has(c.path.replace(/\/+$/, ''))));
    return keep.length === r.changes.length ? r : { ...r, changes: keep };
  });
}

/** Repos in order, each with its linked worktrees by name; a family shows when it has rows or a worktree with something. */
export function nestWorktrees(repos: RepoStatus[], rows: ChangeRow[]): { families: Family[]; idle: WtView[] } {
  const rowsOf = (root: string) => rows.filter((x) => x.repo === root);
  const known = new Set(repos.map((r) => r.root));
  const views = repos.filter((r) => r.worktreeOf && known.has(r.worktreeOf)).map((s): WtView => {
    const own = rowsOf(s.root);
    return { status: s, name: nameOf(s), rows: own, state: own.length ? 'files' : toMerge(s) > 0 ? 'merge' : 'idle' };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const families: Family[] = [];
  for (const repo of repos) {
    if (repo.worktreeOf && known.has(repo.worktreeOf)) continue;
    const worktrees = views.filter((w) => w.status.worktreeOf === repo.root && w.state !== 'idle');
    const own = rowsOf(repo.root);
    if (own.length || worktrees.length) families.push({ repo, rows: own, worktrees });
  }
  return { families, idle: views.filter((w) => w.state === 'idle') };
}

/** The deepest working tree containing a path. */
export function treeOf(repos: readonly RepoStatus[], path: string): RepoStatus | null {
  let best: RepoStatus | null = null;
  for (const r of repos) if (inside(r.root, path) && (!best || r.root.length > best.root.length)) best = r;
  return best;
}

/** A path under the project as it was opened, with the real root git and the statuses use (/var → /private/var). */
export function realPath(p: string, project: { root: string; realRoot?: string | null } | null): string {
  if (!project?.realRoot || project.realRoot === project.root || !inside(project.root, p)) return p;
  return project.realRoot + p.slice(project.root.length);
}

/** A working tree's footprint: what it changes now, plus what its commits to merge change. */
function footprint(s: RepoStatus): Set<string> {
  return new Set([...s.changes.map((c) => c.rel), ...(s.merge?.files ?? [])]);
}

export interface MeetSide { root: string; branch: string; names: string[] }

/**
 * Files two or more working trees of one repo, on different branches, both change: one group per set of working
 * trees, the main checkout first then by name, each side with the sessions surely attributed there.
 */
export function meetGroups(repos: RepoStatus[], rows: ChangeRow[], order: readonly string[]): { key: string; sides: MeetSide[]; files: string[] }[] {
  const families = new Map<string, RepoStatus[]>();
  for (const r of repos) {
    const key = r.worktreeOf ?? r.root;
    families.set(key, [...(families.get(key) ?? []), r]);
  }
  const groups = new Map<string, { trees: RepoStatus[]; files: string[] }>();
  for (const trees of families.values()) {
    if (trees.length < 2) continue;
    const ordered = [...trees].sort((a, b) => (a.worktreeOf ? 1 : 0) - (b.worktreeOf ? 1 : 0) || nameOf(a).localeCompare(nameOf(b)));
    const prints = ordered.map((t) => ({ t, rels: footprint(t) }));
    const all = [...new Set(prints.flatMap((x) => [...x.rels]))].sort();
    for (const rel of all) {
      const on = prints.filter((x) => x.rels.has(rel)).map((x) => x.t);
      // Two working trees can't have the same branch checked out: any two of them are on different branches.
      if (on.length < 2) continue;
      const key = on.map((t) => t.root).sort().join('|');
      const g = groups.get(key) ?? { trees: on, files: [] };
      g.files.push(rel);
      groups.set(key, g);
    }
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    files: g.files,
    sides: g.trees.map((t) => {
      const by: ChangeBy[] = rows.filter((x) => x.repo === t.root && g.files.includes(x.rel)).flatMap((x) => sureBy(x.by));
      return { root: t.root, branch: branchLabel(t), names: inSessionOrder(by, order).map((b) => b.title) };
    })
  }));
}

/** Where a session works: the working tree of its cwd, else the one all its rows are in. */
export function locationOf(cwd: string | null, rows: ChangeRow[], repos: RepoStatus[]): RepoStatus | null {
  const here = cwd ? treeOf(repos, cwd) : null;
  if (here) return here;
  const roots = new Set(rows.map((x) => x.repo));
  return roots.size === 1 ? repos.find((r) => r.root === [...roots][0]) ?? null : null;
}

/**
 * Location pills only when the sessions shown are not all in the same working tree and one of them is a linked
 * worktree: in a multi-repo project without worktrees they would only repeat each repo's branch.
 */
export function showLocations(locs: (RepoStatus | null)[]): boolean {
  const shown = locs.filter((x): x is RepoStatus => !!x);
  return new Set(shown.map((x) => x.root)).size >= 2 && shown.some(isWorktree);
}

/** The linked worktree a path lies in (a tab, a session's folder): its root, its folder name and the path inside it. */
export function worktreeAt(repos: readonly RepoStatus[], path: string): { root: string; name: string; rel: string } | null {
  const tree = treeOf(repos, path);
  if (!tree || !isWorktree(tree)) return null;
  return { root: tree.root, name: nameOf(tree), rel: path === tree.root ? '' : path.slice(tree.root.length + 1) };
}

export type WtCommand = { key: string; kind: 'review'; name: string; branch: string; scope: string } | { key: string; kind: 'compare'; name: string; branch: string; scope: string; base: string };

/** The palette's worktree commands, the same as each worktree's menu: Review, and Compare when it has commits to merge. */
export function worktreeCommands(repos: readonly RepoStatus[]): WtCommand[] {
  return repos.filter(isWorktree).flatMap((w): WtCommand[] => {
    const common = { name: nameOf(w), branch: branchLabel(w), scope: `repo:${w.root}` };
    const review: WtCommand = { key: `review-wt-${w.root}`, kind: 'review', ...common };
    return w.merge && toMerge(w) > 0 ? [review, { key: `compare-wt-${w.root}`, kind: 'compare', ...common, base: w.merge.base }] : [review];
  });
}

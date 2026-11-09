// The commit drawer's target: the one working tree it commits to, chosen on opening and
// moved on after a commit. Repositories come in Changes' order.
import type { RepoStatus } from '@shared/git';
import { isBelow } from '@shared/paths';

type Repo = Pick<RepoStatus, 'root' | 'changes'>;

/** The deepest of `roots` holding `path` (nested repositories and worktrees inside the project), null for none. */
export function rootOf(path: string | null, roots: readonly string[]): string | null {
  if (!path) return null;
  let best: string | null = null;
  for (const r of roots) if ((path === r || isBelow(r, path)) && (!best || r.length > best.length)) best = r;
  return best;
}

/** Files with something in the index (all or part of them). */
export const stagedCount = (r: Repo): number => r.changes.filter((c) => c.stage !== 'none').length;

/**
 * On opening: the repository it was opened for, else that of the last file staged in this window, else the one
 * with the most staged files, else the active tab's, else the first with changes. Past that list, with nothing
 * changed anywhere (amend can still reword): the active tab's repository, else the first one.
 */
export function defaultTarget(o: { openedFor: string | null; lastStaged: string | null; repos: readonly Repo[]; activeFile: string | null }): string | null {
  const { repos } = o;
  const roots = repos.map((r) => r.root);
  const changed = (root: string | null) => (root ? repos.find((r) => r.root === root && r.changes.length > 0)?.root ?? null : null);
  if (o.openedFor && roots.includes(o.openedFor)) return o.openedFor;
  const last = changed(rootOf(o.lastStaged, roots));
  if (last) return last;
  let most: Repo | null = null;
  for (const r of repos) if (stagedCount(r) > (most ? stagedCount(most) : 0)) most = r;
  if (most) return most.root;
  const active = rootOf(o.activeFile, roots);
  return changed(active) ?? repos.find((r) => r.changes.length > 0)?.root ?? active ?? roots[0] ?? null;
}

/**
 * What Git › Undo Last Commit undoes: the target's commit while main offers its Undo, else the latest commit
 * of this project's repositories (`roots`) main still offers one for (the drawer may have moved on). Null: none.
 */
export function undoTarget(o: {
  target: string | null; roots: readonly string[];
  facts: Readonly<Record<string, { undo: { oid: string } | null }>>;
  results: Readonly<Record<string, { sha: string; at: number } | object>>;
}): { root: string; oid: string } | null {
  const offered = (root: string | null) => (root && o.roots.includes(root) ? o.facts[root]?.undo ?? null : null);
  const mine = offered(o.target);
  if (o.target && mine) return { root: o.target, oid: mine.oid };
  let best: { root: string; oid: string; at: number } | null = null;
  for (const root of o.roots) {
    const u = offered(root);
    if (!u) continue;
    const r = o.results[root];
    const at = r && 'sha' in r && r.sha === u.oid ? r.at : 0;
    if (!best || at > best.at) best = { root, oid: u.oid, at };
  }
  return best && { root: best.root, oid: best.oid };
}

/** After a commit: the next repository in list order with staged files (wrapping around), never `current`. */
export function nextTarget(repos: readonly Repo[], current: string): string | null {
  const i = repos.findIndex((r) => r.root === current);
  const order = i < 0 ? repos : [...repos.slice(i + 1), ...repos.slice(0, i)];
  return order.find((r) => stagedCount(r) > 0)?.root ?? null;
}

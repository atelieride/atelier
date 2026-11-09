// Folding while the drawer is open: 10–20 repositories stay readable in 304 px because every
// group but the one being committed folds to its header line. Keys are the panel's group keys (a root by repository, a
// terminal id by session); an unfold by hand lasts until the drawer closes (the store clears `unfolded` then).

export interface FoldState { open: boolean; unfolded: readonly string[] }

/** Whether a group folds because the drawer is open: every one but `keep`, unless unfolded by hand. */
export function foldsWhileOpen(key: string, keep: string | null, s: FoldState): boolean {
  return s.open && key !== keep && !s.unfolded.includes(key);
}

/** A chevron click on a group while the drawer is open: unfolds it, or folds it back. */
export function toggleUnfold(unfolded: readonly string[], key: string): string[] {
  return unfolded.includes(key) ? unfolded.filter((k) => k !== key) : [...unfolded, key];
}

/**
 * Whether a group's rows show (`collapsed`: the groups the user collapsed). Drawer closed, or the kept group: as the
 * user left it. Any other group while the drawer is open: only when unfolded by hand (`unfoldable`: its header click
 * unfolds or folds it back instead of collapsing it), even if the user had collapsed it before.
 */
export function groupShown(key: string, keep: string | null, s: FoldState, collapsed: readonly string[]): { open: boolean; unfoldable: boolean } {
  const unfoldable = s.open && key !== keep;
  return { open: unfoldable ? s.unfolded.includes(key) : !collapsed.includes(key), unfoldable };
}

/** By repository, the repository whose group stays open: the target's, or the one a target worktree belongs to. */
export function keptFamily(target: string | null, families: readonly { root: string; worktrees: readonly string[] }[]): string | null {
  if (!target) return null;
  return families.find((f) => f.root === target || f.worktrees.includes(target))?.root ?? null;
}

/**
 * By session, the session that stays open: the one the drawer was opened for ("Commit <name>'s Work…"), else the one
 * holding the last file staged in this window; none otherwise (all fold).
 */
export function keptSession(o: { openedFor: string | null; lastStaged: string | null; sessions: readonly { key: string; paths: readonly string[] }[] }): string | null {
  if (o.openedFor && o.sessions.some((s) => s.key === o.openedFor)) return o.openedFor;
  const last = o.lastStaged;
  return last ? o.sessions.find((s) => s.paths.includes(last))?.key ?? null : null;
}

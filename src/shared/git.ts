export type ChangeKind = 'M' | 'A' | 'D' | 'R' | 'U' | '?';

export interface FileChange {
  /** Absolute path. */
  path: string;
  /** Relative to the repo root. */
  rel: string;
  origRel?: string;
  kind: ChangeKind;
  /**
   * What the index holds of it (porcelain v2's XY): all of it (staged, nothing more in the work tree), part of it
   * (staged, then changed again), or none (also untracked and unmerged files).
   */
  stage: 'none' | 'all' | 'partial';
  /** A submodule entry (porcelain v2's `sub` field starts with S): not stageable from Atelier. */
  submodule?: true;
  added: number | null;
  removed: number | null;
}

/**
 * A repo compared with its default branch (review "Against main"): every file the branch changes since
 * it diverged (commits + working tree + untracked), or why the comparison isn't offered.
 */
export type RepoCompare =
  | { root: string; ok: true; base: string; ref: string; mergeBase: string; commits: number; changes: FileChange[] }
  | { root: string; ok: false; reason: 'on-default' | 'no-default' | 'no-head' | 'error' };

/**
 * A branch against the repo's default branch: the commits it adds, and the files they change that still differ from the
 * default branch (capped). merged: commits ahead, yet nothing left to merge (squash or rebase merged).
 */
export interface MergeInfo { base: string; commits: number; files: string[]; truncated: number; merged: boolean }

export interface RepoStatus {
  root: string;
  name: string;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  /** The branch's upstream (origin/main), null without one; absent from older readers. */
  upstream?: string | null;
  /** The upstream's remote branch is gone (deleted, then pruned): ahead and behind are 0 without meaning. */
  upstreamGone?: boolean;
  changes: FileChange[];
  /** Commit of HEAD (null without commits): changes after commit, checkout, pull. */
  oid: string | null;
  /** Start of the status read (ms). */
  checkedAt: number;
  /** Files not shown because they are over the limit (e.g. thousands of untracked). */
  truncated: number;
  error?: string;
  /** The main working tree's root when this is a linked worktree inside the project (worktrees in Changes). */
  worktreeOf?: string | null;
  /** What its branch has to merge into the default branch; null when on it, unknown, or not needed. */
  merge?: MergeInfo | null;
}

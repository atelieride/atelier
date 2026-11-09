// Git colors in the file tree: the kind of each changed file and, for folders, the strongest kind underneath.
import type { ChangeKind, RepoStatus } from '@shared/git';

export type TreeGit = 'conflict' | 'modified' | 'added' | 'untracked' | 'renamed';

/** Letter at the right of the row (U is untracked; a conflict is "!"). */
export const TREE_GIT_LETTER: Record<TreeGit, string> = { modified: 'M', added: 'A', untracked: 'U', renamed: 'R', conflict: '!' };

const FROM_GIT: Partial<Record<ChangeKind, TreeGit>> = { M: 'modified', A: 'added', '?': 'untracked', R: 'renamed', U: 'conflict' };
const RANK: Record<TreeGit, number> = { conflict: 4, modified: 3, added: 2, untracked: 2, renamed: 1 };

const stronger = (cur: TreeGit | undefined, next: TreeGit) => (!cur || RANK[next] > RANK[cur] ? next : cur);

/**
 * Computed once per status update: both maps are keyed by the real paths the tree lists (those of git too).
 * Folders stop at `root` (the project's real root), which has no dot of its own.
 */
export function treeGitMap(repos: RepoStatus[], root: string): { files: Map<string, TreeGit>; dirs: Map<string, TreeGit> } {
  const files = new Map<string, TreeGit>();
  const dirs = new Map<string, TreeGit>();
  const base = root.replace(/\/$/, '') + '/';
  for (const r of repos) {
    for (const c of r.changes) {
      const kind = FROM_GIT[c.kind];
      if (!kind) continue;
      const path = c.path.replace(/\/$/, '');
      files.set(path, stronger(files.get(path), kind));
      // Same color for added and untracked: the folder shows a single "added" dot.
      const dirKind: TreeGit = kind === 'untracked' ? 'added' : kind;
      if (!path.startsWith(base)) continue;
      for (let i = path.lastIndexOf('/'); i >= base.length; i = path.lastIndexOf('/', i - 1)) {
        const dir = path.slice(0, i);
        const cur = dirs.get(dir);
        const next = stronger(cur, dirKind);
        // Ancestors already at least as strong stay as they are, and so do theirs.
        if (next === cur) break;
        dirs.set(dir, next);
      }
    }
  }
  return { files, dirs };
}

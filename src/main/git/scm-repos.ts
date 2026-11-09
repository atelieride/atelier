// The repository switcher's entries: working trees, not object stores. The project's repos
// as Changes discovers them, each followed by its linked worktrees that live inside the project in a hidden folder
// (`.worktrees/v2.2`), which discovery skips.
import { basename, relative } from '../cpath';
import type { ScmRepoEntry } from '@shared/scm';
import { listWorkingTrees, type WorkingTree } from './repos';

/** The entries for working trees Changes already listed (GitHub's). */
export function scmEntries(root: string, trees: readonly WorkingTree[]): ScmRepoEntry[] {
  return trees.map((w) => {
    const rel = w.root === root ? '' : relative(root, w.root);
    // A visible linked worktree is a repo of its own in the switcher; only the ones discovery missed show their owner.
    return { root: w.root, rel, name: rel ? basename(w.root) : basename(root), worktreeOf: w.hidden ? w.worktreeOf : null, common: w.common, status: null };
  });
}

export async function listScmRepos(root: string, repos: string[]): Promise<ScmRepoEntry[]> {
  return scmEntries(root, await listWorkingTrees(root, repos));
}

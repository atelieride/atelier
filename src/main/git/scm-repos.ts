// The repository switcher's entries: working trees, not object stores. The project's repos
// as Changes discovers them, each followed by its linked worktrees that live inside the project in a hidden folder
// (`.worktrees/v2.2`), which discovery skips.
import { basename, isAbsolute, relative, sep } from '../cpath';
import type { ScmRepoEntry } from '@shared/scm';
import { isBelow } from '@shared/paths';
import { isHiddenRel } from '@shared/hidden-repos';
import { listWorkingTrees, type WorkingTree } from './repos';

/** The entries for working trees Changes already listed (GitHub's). */
export function scmEntries(root: string, trees: readonly WorkingTree[]): ScmRepoEntry[] {
  return trees.map((w) => {
    const rel = w.root === root ? '' : relative(root, w.root);
    // A linked worktree is its repository's own checkout, never "nested"; a repository is nested in the deepest other
    // working tree around it (a clone kept inside another repository).
    let nestedIn: string | null = null;
    if (!w.worktreeOf) for (const t of trees) if (t.root !== w.root && isBelow(t.root, w.root) && (!nestedIn || t.root.length > nestedIn.length)) nestedIn = t.root;
    // A visible linked worktree is a repo of its own in the switcher; only the ones discovery missed show their owner.
    const linked = w.worktreeOf !== null || (w.gitDir !== null && w.gitDir !== w.common);
    // Kept by its path inside the project, '/'-separated: not one outside it ('..', or another drive's absolute path),
    // nor a backslash in a macOS folder name, which can't be kept so. The path from the project tells, whichever
    // separators the roots were spelled with.
    const hideable = rel !== '' && !linked && !isAbsolute(rel) && isHiddenRel(rel.split(sep).join('/'));
    return { root: w.root, rel, name: rel ? basename(w.root) : basename(root), worktreeOf: w.hidden ? w.worktreeOf : null, nestedIn, common: w.common, status: null, ...(hideable ? { hideable: true as const } : {}) };
  });
}

export async function listScmRepos(root: string, repos: string[]): Promise<ScmRepoEntry[]> {
  return scmEntries(root, await listWorkingTrees(root, repos));
}

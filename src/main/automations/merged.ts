// "Merged by you": read-only, through runGit's closed list. A run's branch is merged when it
// moved past its base commit and its tip is reachable from its base: the ref it started from, or the local branch of
// the same name (a merge not pushed yet).
import { runGit } from '../git/exec';

const quiet = (p: Promise<string>) => p.then((s) => s.trim(), () => null);

export async function branchMerged(root: string, run: { branch: string; base: string; baseOid: string }): Promise<boolean> {
  const tip = await quiet(runGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${run.branch}`]));
  if (!tip || tip === run.baseOid) return false;
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(run.base)?.[1];
  for (const target of remote ? [run.base, `refs/heads/${remote}`] : [run.base]) {
    if ((await quiet(runGit(root, ['merge-base', '--is-ancestor', tip, target]))) !== null) return true;
  }
  return false;
}

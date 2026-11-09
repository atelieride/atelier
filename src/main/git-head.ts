import { insideProject } from './fs/files';
import { repoOf } from './git/watch';

/** Repo and relative path to read in HEAD for a project file (real path: a symlink leads to the actual file). */
export function headTarget(root: string, repos: string[], path: string): { repo: string; rel: string } | null {
  const real = insideProject(root, path);
  if (!real) return null;
  const repo = repoOf(repos, real);
  if (!repo) return null;
  return { repo, rel: real.slice(repo.length + 1) };
}

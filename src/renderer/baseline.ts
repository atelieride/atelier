import type { RepoStatus } from '@shared/git';
import { isBelow } from '@shared/paths';

/** What to compare an open file against, according to git state (not according to content). */
export type Baseline =
  | { kind: 'none' }   // outside any repo
  | { kind: 'clean' }  // in the repo, unmodified per git (or ignored): no marker
  | { kind: 'new' }    // untracked or just added: everything added
  | { kind: 'head'; headPath: string; oid: string | null };

export function baselineFor(path: string, repos: RepoStatus[]): Baseline {
  // The deepest repo that contains the file (nested repos have their own state).
  let repo: RepoStatus | null = null;
  for (const r of repos) if (isBelow(r.root, path) && (!repo || r.root.length > repo.root.length)) repo = r;
  if (!repo) return { kind: 'none' };
  const row = repo.changes.find((c) => c.path === path);
  if (!row) return { kind: 'clean' };
  if (row.kind === '?' || row.kind === 'A') return { kind: 'new' };
  const headPath = row.kind === 'R' && row.origRel ? `${repo.root}/${row.origRel}` : path;
  return { kind: 'head', headPath, oid: repo.oid };
}

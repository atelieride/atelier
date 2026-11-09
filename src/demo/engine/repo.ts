// The demo's `git status`: the in-memory working tree against HEAD, and what the
// visitor staged (the fictional index), in the shape main's git reader sends
// (RepoStatus). Pure and Node-free; recomputed after every change to the filesystem or the index.
import { diffLines } from 'diff';
import type { FileChange, RepoStatus } from '@shared/git';

const lines = (s: string) => { const l = s.split('\n'); if (l.at(-1) === '') l.pop(); return l.length; };

/** git's numstat for one file: lines added and removed. */
export function numstat(before: string, after: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const p of diffLines(before, after)) {
    if (p.added) added += lines(p.value);
    else if (p.removed) removed += lines(p.value);
  }
  return { added, removed };
}

/**
 * Where a change stands in the index: staged as the work tree has it now → all, staged and changed
 * again since → partial, not staged → none. `index`: rel → the text staged (null: a deletion staged).
 */
function stageOf(index: Readonly<Record<string, string | null>>, rel: string, now: string | undefined): FileChange['stage'] {
  if (!(rel in index)) return 'none';
  return index[rel] === (now ?? null) ? 'all' : 'partial';
}

export function repoStatus(o: { root: string; name: string; head: Record<string, string>; files: Record<string, string>; index?: Readonly<Record<string, string | null>>; oid: string; now: number }): RepoStatus {
  const changes: FileChange[] = [];
  const index = o.index ?? {};
  const rels = [...new Set([...Object.keys(o.head), ...Object.keys(o.files)])].sort();
  for (const rel of rels) {
    const before = o.head[rel];
    const after = o.files[rel];
    if (before === after) continue;
    const base = { path: `${o.root}/${rel}`, rel, stage: stageOf(index, rel, after) };
    if (before === undefined) changes.push({ ...base, kind: '?', added: null, removed: null });
    else if (after === undefined) changes.push({ ...base, kind: 'D', added: 0, removed: lines(before) });
    else changes.push({ ...base, kind: 'M', ...numstat(before, after) });
  }
  return { root: o.root, name: o.name, branch: 'main', detached: false, ahead: 0, behind: 0, upstream: null, changes, oid: o.oid, checkedAt: o.now, truncated: 0, worktreeOf: null, merge: null };
}

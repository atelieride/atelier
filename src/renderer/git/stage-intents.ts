// A checkbox shows its click at once. The box, the dot, the counts and the drawer read the
// statuses; a stage or unstage only shows there once git add ran and a status read came back (seconds on a Windows
// PC). Meanwhile the click is an intent laid over the statuses, until a status read that started once git was done
// (`at`, main's clock: GitOpResult.at) comes in. A failed op drops it: the box is as git has it again. Pure.
import type { FileChange, RepoStatus } from '@shared/git';
import type { StageTarget } from '@shared/git-write';

export interface StageIntent {
  id: number;
  root: string;
  /** The paths staged or unstaged (both sides of a rename), or the whole repository. */
  rels: StageTarget;
  to: 'all' | 'none';
  /** When git was done; null while the op is queued or running. */
  at: number | null;
}

/** Whether a click changes this row: as main does, never a conflict, a submodule or a nested repository's folder. */
function covers(i: StageIntent, c: FileChange): boolean {
  if (c.kind === 'U' || c.submodule) return false;
  if (i.rels === 'all') return !c.rel.endsWith('/');
  return i.rels.includes(c.rel) || (c.origRel !== undefined && i.rels.includes(c.origRel));
}

/** The statuses as the clicks will leave them (the later click wins); untouched repositories and rows kept as they are. */
export function applyIntents(repos: RepoStatus[], intents: readonly StageIntent[]): RepoStatus[] {
  if (intents.length === 0) return repos;
  return repos.map((r) => {
    const mine = intents.filter((i) => i.root === r.root);
    if (mine.length === 0) return r;
    let changed = false;
    const changes = r.changes.map((c) => {
      let stage: FileChange['stage'] = c.stage;
      for (const i of mine) if (covers(i, c)) stage = i.to;
      if (stage === c.stage) return c;
      changed = true;
      return { ...c, stage };
    });
    return changed ? { ...r, changes } : r;
  });
}

/**
 * The intents still to show: running ones, and done ones no read since shows yet. A repository gone takes its own.
 * Main sends the read it asks for after an op even when equal to the last snapshot (git-hub.ts requestStatus), so the
 * read that shows an op always comes; any later read settles it too.
 */
export function settleIntents(intents: readonly StageIntent[], repos: readonly RepoStatus[]): StageIntent[] {
  if (intents.length === 0) return intents as StageIntent[];
  const checked = new Map(repos.map((r) => [r.root, r.checkedAt]));
  return intents.filter((i) => {
    const at = checked.get(i.root);
    return at !== undefined && (i.at === null || at < i.at);
  });
}

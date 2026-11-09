// What "stage everything" means for the drawer's target: Commit with nothing staged
// asks to stage it and commit, and the drawer's "Nothing staged · Stage All" line stages it. Pure.
import type { FileChange, RepoStatus } from '@shared/git';

/** The most paths one stage takes (the IPC schema's limit, `relsSchema` in main). */
export const MAX_STAGE_RELS = 100_000;

/** what: main's Stage All for the whole repository, or these paths (This workspace). newFiles: untracked ones. */
export interface StageAllPlan { what: 'all' | string[]; changes: number; newFiles: number }

export type StageAllOffer =
  | { offered: true; plan: StageAllPlan }
  | { offered: false; why: 'writes' | 'staged' | 'nothing' | 'conflicts' | 'too-many' };

/** A row Atelier can stage: never a conflict (staging resolves it), a submodule or a nested repository's folder. */
const stageable = (c: FileChange) => c.kind !== 'U' && !c.submodule && !c.rel.endsWith('/');

/**
 * `shown`: the rows Changes shows (This workspace), any repository's; null when it shows the whole project. Offered
 * only with Git actions on, nothing staged in the repository, something stageable shown and no unmerged file at all
 * (main's Stage All refuses the whole repository then).
 */
export function stageAllPlan(o: { repo: Pick<RepoStatus, 'root' | 'changes'>; shown: readonly { repo: string; rel: string }[] | null; writes: boolean }): StageAllOffer {
  if (!o.writes) return { offered: false, why: 'writes' };
  const all = o.repo.changes;
  if (all.some((c) => c.stage !== 'none')) return { offered: false, why: 'staged' };
  if (all.some((c) => c.kind === 'U')) return { offered: false, why: 'conflicts' };
  const mine = o.shown === null ? null : new Set(o.shown.filter((r) => r.repo === o.repo.root).map((r) => r.rel));
  const rows = all.filter((c) => stageable(c) && (mine === null || mine.has(c.rel)));
  if (rows.length === 0) return { offered: false, why: 'nothing' };
  const counts = { changes: rows.length, newFiles: rows.filter((c) => c.kind === '?').length };
  if (mine === null) return { offered: true, plan: { what: 'all', ...counts } };
  const rels = rows.flatMap((c) => (c.origRel !== undefined ? [c.origRel, c.rel] : [c.rel]));
  if (rels.length > MAX_STAGE_RELS) return { offered: false, why: 'too-many' };
  return { offered: true, plan: { what: rels, ...counts } };
}

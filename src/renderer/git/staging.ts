// Staging in Changes: a row's index state, its group's checkbox, and what a click on either
// stages or unstages. Pure: the actions run the answer.
import type { FileChange } from '@shared/git';
import { t } from '../i18n/en';

/** What staging needs of a Changes row (ChangeRow has it all). `repo`: the working tree's root. */
export type StageRow = Pick<FileChange, 'rel' | 'origRel' | 'kind' | 'stage' | 'submodule'> & { repo: string };

/** Unmerged files and submodule entries can't be staged; the disabled checkbox's tooltip says why. */
export function stageable(row: StageRow): { ok: true } | { ok: false; reason: string } {
  if (row.kind === 'U') return { ok: false, reason: t.git.unmergedTip };
  if (row.submodule) return { ok: false, reason: t.git.submoduleTip };
  return { ok: true };
}

const canStage = (row: StageRow) => stageable(row).ok;

/** The row's checkbox: all checked, partial indeterminate, none empty (never anything for a row that can't stage). */
export function rowStage(row: StageRow): FileChange['stage'] {
  return canStage(row) ? row.stage : 'none';
}

/** The paths a row stages or unstages: a rename's both (the old path's deletion goes with it). */
export function relsOf(row: StageRow): string[] {
  return row.origRel ? [row.rel, row.origRel] : [row.rel];
}

/** A group's checkbox (repository, session, worktree): all when every stageable row is fully staged. */
export function groupCheck(rows: readonly StageRow[]): 'none' | 'some' | 'all' {
  const states = rows.filter(canStage).map(rowStage);
  if (states.length === 0 || states.every((s) => s === 'none')) return 'none';
  return states.every((s) => s === 'all') ? 'all' : 'some';
}

export type StageStep = { root: string; stage: string[] } | { root: string; unstage: string[] };

/**
 * A click on a group's (or a row's) checkbox: checked → unstage every row; empty or indeterminate → stage the rest
 * (partial rows included). Decided once for the whole group, then one step per root, in the rows' order.
 */
export function toggleRows(rows: readonly StageRow[]): StageStep[] {
  const usable = rows.filter(canStage);
  const unstage = groupCheck(usable) === 'all';
  const byRoot = new Map<string, string[]>();
  for (const r of usable) {
    if (!unstage && r.stage === 'all') continue;
    const rels = byRoot.get(r.repo) ?? [];
    for (const rel of relsOf(r)) if (!rels.includes(rel)) rels.push(rel);
    byRoot.set(r.repo, rels);
  }
  return [...byRoot].map(([root, rels]) => (unstage ? { root, unstage: rels } : { root, stage: rels }));
}

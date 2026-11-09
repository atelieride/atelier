// What Changes rows and headers show of the index: the staged dot on a file's icon, the
// header's count, the checkbox column's states (only while the drawer is open), the by-session folder line. Pure.
import type { FileChange } from '@shared/git';
import { groupCheck, rowStage, stageable, type StageRow } from './staging';
import { isBelow } from '@shared/paths';

type Staged = Pick<FileChange, 'stage'>;

/** The dot on the file icon: what git's index holds of the file, exactly as git sees it. */
export function stagedDot(row: Staged): 'all' | 'partial' | null {
  return row.stage === 'none' ? null : row.stage;
}

export type HeadCount = { kind: 'files'; n: number } | { kind: 'staged' | 'of'; staged: number; n: number };

/**
 * A header's count: "4 files"; with files staged, "3 staged · 4" while the drawer is closed and "2 of 3" next to the
 * checkboxes while it is open. `n`: the header's own count when it isn't `rows.length`.
 */
export function headCount(rows: readonly Staged[], drawerOpen: boolean, n = rows.length): HeadCount {
  const staged = rows.filter((r) => r.stage !== 'none').length;
  if (staged === 0) return { kind: 'files', n };
  return { kind: drawerOpen ? 'of' : 'staged', staged, n };
}

export interface CheckBox<S> { state: S; disabled: string | null }

/** A row's checkbox: checked, indeterminate (partial) or empty; disabled with the reason when it can't stage. */
export function rowBox(row: StageRow): CheckBox<FileChange['stage']> {
  const ok = stageable(row);
  return { state: rowStage(row), disabled: ok.ok ? null : ok.reason };
}

/** A group's checkbox (repository, session, worktree); null when the group lists no row (nothing to check). */
export function groupBox(rows: readonly StageRow[]): CheckBox<'none' | 'some' | 'all'> | null {
  if (rows.length === 0) return null;
  const blocked = rows.map(stageable).find((s): s is { ok: false; reason: string } => !s.ok);
  const any = rows.some((r) => stageable(r).ok);
  return { state: groupCheck(rows), disabled: any ? null : blocked?.reason ?? null };
}

const base = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;

/** A working tree's path in the project (`plugins/payments`), its folder name when it is the project or outside it. */
export function repoPathOf(root: string, projectRoot: string | null): string {
  const prj = projectRoot?.replace(/\/+$/, '') ?? null;
  if (prj && isBelow(prj, root)) return root.slice(prj.length + 1);
  return base(root);
}

/**
 * The folder line by session: with several repositories, the repository's path then the folder,
 * `plugins/payments › src` (the path alone at the repository's root); with one, today's `name · dir`.
 */
export function folderParts(dir: string, repo: { label: string; multi: boolean } | null): { repo: string | null; sep: string; dir: string | null } {
  if (!repo) return { repo: null, sep: '', dir };
  if (!repo.multi) return { repo: repo.label, sep: ' · ', dir };
  return dir === '.' ? { repo: repo.label, sep: '', dir: null } : { repo: repo.label, sep: ' › ', dir };
}

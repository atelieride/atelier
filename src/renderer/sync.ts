// Sync arrows in Changes: what to pull and push, counted against the branch's
// own upstream (Source Control's rule, trackedCounts), as of the last fetch. Display only: nothing here acts.
import type { RepoStatus } from '@shared/git';
import { trackedCounts } from '@shared/git-write';
import { t } from './i18n/en';
import type { WtView } from './worktrees';

/** A working tree's ↓ to pull and ↑ to push, and the upstream they count against (short: origin/main). */
export interface SyncView { behind: number; ahead: number; upstream: string }

const short = (upstream: string) => upstream.replace(/^refs\/remotes\//, '');

/**
 * The arrows a working tree shows, or null for none: a status git couldn't read, a branch without an upstream of its
 * own name (none, another name, gone, detached HEAD), or nothing either way.
 */
export function syncOf(s: Pick<RepoStatus, 'branch' | 'upstream' | 'upstreamGone' | 'ahead' | 'behind' | 'error'>): SyncView | null {
  if (s.error || !s.upstream) return null;
  const upstream = short(s.upstream);
  const { ahead, behind } = trackedCounts({ ...s, upstream });
  return ahead + behind > 0 ? { behind, ahead, upstream } : null;
}

export const syncTip = (v: SyncView): string => t.syncTip(v.behind, v.ahead, v.upstream);

/** What a screen reader says: the non-zero parts, as Source Control's All Repositories names them. */
export function syncLabel(v: SyncView): string {
  return [v.behind > 0 ? t.scm.all.toPull(v.behind) : null, v.ahead > 0 ? t.scm.all.toPush(v.ahead) : null].filter(Boolean).join(', ');
}

/** One chip of "To sync": a main repository, or a linked worktree (its arrows only, never what it has to merge). */
export type SyncItem = { kind: 'repo'; status: RepoStatus } | { kind: 'wt'; view: WtView };

/**
 * "To sync", grouped by session: the working trees whose arrows would have no place there otherwise — main
 * repositories with changes Changes shows (`shown`: its rows; one This workspace hides entirely is hidden, arrows too)
 * and something to sync, in their order, then worktrees with their own upstream's counts, clean or not, by name.
 * Clean main repositories carry theirs in "Clean".
 */
export function toSyncOf(mains: RepoStatus[], shown: readonly { repo: string }[], worktrees: WtView[]): SyncItem[] {
  const withRows = new Set(shown.map((r) => r.repo));
  const repos = mains.filter((r) => withRows.has(r.root) && syncOf(r)).map((status): SyncItem => ({ kind: 'repo', status }));
  const wts = worktrees.filter((w) => syncOf(w.status)).sort((a, b) => a.name.localeCompare(b.name)).map((view): SyncItem => ({ kind: 'wt', view }));
  return [...repos, ...wts];
}

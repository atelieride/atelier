// Sync arrows in Changes: what to pull and push, counted against the branch's
// own upstream (Source Control's rule, trackedCounts), as of the last fetch. Display only: nothing here acts.
import type { RepoStatus } from '@shared/git';
import { trackedCounts } from '@shared/git-write';
import { isBelow } from '@shared/paths';
import { t } from './i18n/en';
import { isWorktree, type WtView } from './worktrees';

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

/** A working tree with commits to pull, for Source Control's dot: its name and its ↓. */
export interface PullItem { name: string; behind: number }

/**
 * Source Control's dot: every working tree (main repositories and worktrees, clean or not) whose arrows show a ↓, by
 * name. The arrows' own rule decides (syncOf), so the dot never says more than Changes and Source Control do. Named as
 * Source Control names them: a worktree as "repository › worktree", and repositories sharing a name by their path
 * under one of `roots` (the window's root and its real path), so two "api" folders never read the same.
 */
export function toPull(repos: readonly RepoStatus[], roots: readonly string[]): PullItem[] {
  const mains = repos.filter((r) => !isWorktree(r)).map((r) => r.name);
  const shared = new Set(mains.filter((n, i) => mains.indexOf(n) !== i));
  const inProject = (root: string) => { const p = roots.find((x) => isBelow(x, root)); return p ? root.slice(p.length + 1) : null; };
  const nameOf = (r: RepoStatus) => {
    if (r.worktreeOf) return `${r.worktreeOf.split('/').at(-1) ?? r.worktreeOf} › ${r.name}`;
    return shared.has(r.name) ? inProject(r.root) ?? r.name : r.name;
  };
  return repos.flatMap((r) => { const v = syncOf(r); return v && v.behind > 0 ? [{ name: nameOf(r), behind: v.behind }] : []; })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Names past this many give way to "and N more", in the label and the tooltip alike. */
const PULL_NAMES_MAX = 5;

function capped<T>(items: readonly T[]): { shown: readonly T[]; more: number } {
  if (items.length <= PULL_NAMES_MAX) return { shown: items, more: 0 };
  return { shown: items.slice(0, PULL_NAMES_MAX - 1), more: items.length - (PULL_NAMES_MAX - 1) };
}

/** What a screen reader hears after the item's name: "To pull: api, web". */
export function pullLabel(items: readonly PullItem[]): string {
  const { shown, more } = capped(items);
  const names = shown.map((i) => i.name).join(', ');
  return t.activity.toPull(more ? `${names} ${t.activity.more(more)}` : names);
}

/** The tooltip's lines under the item's name: one per working tree with its count, then "and N more". */
export function pullTipLines(items: readonly PullItem[]): string[] {
  const { shown, more } = capped(items);
  return [...shown.map((i) => t.activity.pullLine(i.name, i.behind)), ...(more ? [t.activity.more(more)] : [])];
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

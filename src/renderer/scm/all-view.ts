// Source Control's All Repositories view: the blocks' order, what each header
// marks and the one button each block shows. Every block has the same parts whatever its state, so nothing here moves
// one: a state only changes what a part says. Pure.
import type { RepoStatus } from '@shared/git';
import { type GitOp, syncAction, trackedCounts, upstreamKind } from '@shared/git-write';
import type { ScmRepoEntry } from '@shared/scm';
import { t } from '../i18n/en';
import { repoLabel } from './view';

/** `note` and `tip`: what the header says next to the name (a repository inside another one), if anything. */
export interface AllRow { root: string; name: string; dir: string; worktree: boolean; status: RepoStatus; note: string | null; tip: string | null }

/**
 * Changes' working trees as blocks: repositories by their label (the folder part, then the name), each followed by its
 * linked worktrees by name. A worktree whose repository isn't listed sorts as a repository.
 */
export function allRows(repos: readonly RepoStatus[], entries: readonly ScmRepoEntry[] | null): AllRow[] {
  const known = new Set(repos.map((r) => r.root));
  const entryOf = new Map((entries ?? []).map((e) => [e.root, e]));
  const row = (s: RepoStatus, worktree: boolean): AllRow => {
    const e = entryOf.get(s.root);
    // A worktree sits right under its repository: its own name says enough.
    const label = e && !worktree ? repoLabel({ ...e, worktreeOf: null }) : { dir: '', name: e?.name ?? s.name, note: null, tip: null };
    return { root: s.root, name: label.name, dir: label.dir, worktree, status: s, note: label.note, tip: label.tip };
  };
  const byLabel = (a: AllRow, b: AllRow) => (a.dir + a.name).localeCompare(b.dir + b.name);
  const isWorktree = (s: RepoStatus) => !!s.worktreeOf && known.has(s.worktreeOf);
  const out: AllRow[] = [];
  for (const repo of repos.filter((s) => !isWorktree(s)).map((s) => row(s, false)).sort(byLabel)) {
    out.push(repo, ...repos.filter((s) => isWorktree(s) && s.worktreeOf === repo.root).map((s) => row(s, true)).sort(byLabel));
  }
  return out;
}

/**
 * How a block watches for the screen before reading its facts: inside the list that scrolls (the viewport's margin
 * never reaches past the list's clip), 200 px ahead so the facts are there when the block shows.
 */
export function nearScreen(block: Pick<Element, 'closest'>): IntersectionObserverInit {
  return { root: block.closest('.scm-all-list'), rootMargin: '200px' };
}

export type BlockButton =
  | { kind: 'running'; op: GitOp }
  | { kind: 'commit'; staged: number; block: string | null }
  | { kind: 'sync'; action: 'pull' | 'push' | 'sync' }
  | { kind: 'publish' }
  | { kind: 'idle' };

/** `countsOn`: where the ↓↑ counts show, once — on the button while it pulls, pushes or syncs, else on the header. */
export interface BlockView { changes: number; ahead: number; behind: number; clean: boolean; error: string | null; button: BlockButton; countsOn: 'head' | 'button' }

const SYNC_OPS: ReadonlySet<GitOp> = new Set(['pull', 'push', 'sync']);

/**
 * A block's marks and its button (spec, "A block"): an op running; else Commit when a commit is possible (files staged,
 * or `offered`: nothing staged and the setting would stage everything); else Pull, Push or Sync (syncAction) with
 * something to pull or push; else Publish Branch without an upstream of its own and with a remote; else an idle,
 * disabled Commit.
 */
export function blockView(o: { status: RepoStatus; running: GitOp | null; hasRemote: boolean; commit: { staged: number; offered: boolean; block: string | null } }): BlockView {
  const s = o.status;
  if (s.error) return { changes: 0, ahead: 0, behind: 0, clean: false, error: s.error, button: o.running ? { kind: 'running', op: o.running } : { kind: 'idle' }, countsOn: 'head' };
  const changes = s.changes.length + s.truncated;
  const { ahead, behind } = trackedCounts(s);
  const view = { changes, ahead, behind, clean: changes === 0 && ahead === 0 && behind === 0, error: null };
  if (o.running) return { ...view, button: { kind: 'running', op: o.running }, countsOn: SYNC_OPS.has(o.running) ? 'button' : 'head' };
  if (o.commit.staged > 0 || (changes > 0 && o.commit.offered)) return { ...view, button: { kind: 'commit', staged: o.commit.staged, block: o.commit.block }, countsOn: 'head' };
  if (ahead > 0 || behind > 0) return { ...view, button: { kind: 'sync', action: syncAction({ ahead, behind }) }, countsOn: 'button' };
  const up = upstreamKind(s.branch, s.upstream, s.upstreamGone);
  if (!s.detached && s.branch && up !== 'own' && o.hasRemote) return { ...view, button: { kind: 'publish' }, countsOn: 'head' };
  return { ...view, button: { kind: 'idle' }, countsOn: 'head' };
}

/** What Sync All would move: the counts against upstreams of their own name; a diverged branch is main's to skip. */
export function syncTotals(repos: readonly RepoStatus[]): { ahead: number; behind: number } {
  let ahead = 0;
  let behind = 0;
  for (const r of repos) {
    if (r.error) continue;
    const c = trackedCounts(r);
    if (c.ahead > 0 && c.behind > 0) continue;
    ahead += c.ahead;
    behind += c.behind;
  }
  return { ahead, behind };
}

/**
 * The block's field is one line: it shows the draft's subject and writes it back over the subject, so a body (✦'s, or
 * one written in the drawer) is kept, never joined into the line.
 */
export const firstLine = (draft: string): string => draft.split('\n', 1)[0] ?? '';
export const withFirstLine = (draft: string, line: string): string => { const i = draft.indexOf('\n'); return i < 0 ? line : line + draft.slice(i); };
export const hasBody = (draft: string): boolean => { const i = draft.indexOf('\n'); return i >= 0 && draft.slice(i).trim() !== ''; };

/** The idle button's tooltip: what git said when it couldn't read the status, else "in sync", else why Commit waits. */
export function idleTip(v: BlockView, block: string | null): string | null {
  if (v.error) return t.scm.all.unreadable(v.error);
  if (v.clean) return t.scm.all.inSync;
  return block;
}

/** A busy block's words: the sync button's for pull, push and sync, "Committing…", else the op's name. */
export function runningLabel(op: GitOp): string {
  if (op === 'commit') return t.scm.all.committing;
  return t.git.sync.running[op] ?? `${t.git.ops[op]}…`;
}

/** Why Pull, Push and Fetch can't run in that working tree (null: they can). */
export function syncAbility(s: Pick<RepoStatus, 'branch' | 'detached'>, hasRemote: boolean): { pull: string | null; push: string | null; fetch: string | null } {
  const a = t.scm.all;
  if (!hasRemote) return { pull: a.noRemote, push: a.noRemote, fetch: a.noRemote };
  if (s.detached || !s.branch) return { pull: a.notOnBranch, push: a.notOnBranch, fetch: null };
  return { pull: null, push: null, fetch: null };
}

/** The palette's command for the other view; none with a single repository (the switch isn't shown then either). */
export function viewCommand(view: 'one' | 'all', repositories: number): { key: 'scm-view-all' | 'scm-view-one'; to: 'one' | 'all' } | null {
  if (repositories < 2) return null;
  return view === 'all' ? { key: 'scm-view-one', to: 'one' } : { key: 'scm-view-all', to: 'all' };
}

/** Worktrees start folded to their header, repositories open; a fold by hand wins. */
export function foldedOf(row: AllRow, folds: Readonly<Record<string, boolean>>): boolean {
  return folds[row.root] ?? row.worktree;
}

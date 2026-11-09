// The Source Control sidebar's sync: what the split button says, the GitHub compare page a
// published branch opens, the incoming files a live session is changing, and the Pull and Sync flows that ask first
// (a diverged branch: rebase?; a live session's files: pull anyway?). Main checks and runs everything.
import { type GitOpResult, type SyncAllRow, upstreamKind } from '@shared/git-write';
export { syncAction } from '@shared/git-write';
import type { ScmRepoStatus } from '@shared/scm';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { fetchRepo } from '../scm/actions';
import { failText, pull, push, sync } from './actions';
import { saveGitPrefs } from './drafts';
import { liveFiles, overlapFiles } from './live';

const st = () => useApp.getState();
const on = () => st().settings.gitActions === 'on';

export type SyncView =
  | { kind: 'none' }
  | { kind: 'publish'; branch: string; reason?: { kind: 'gone' | 'other'; upstream: string } }
  | { kind: 'sync'; ahead: number; behind: number; upstream: string };

/**
 * The split button's main part: nothing on a detached HEAD; Publish Branch without an upstream, with one gone
 * from the remote (never a quiet "in sync") or with one of another name (main refuses to push there); else Sync.
 */
export function syncView(s: Pick<ScmRepoStatus, 'branch' | 'detached' | 'ahead' | 'behind' | 'upstream' | 'upstreamGone'> | null | undefined, hasRemote: boolean): SyncView {
  if (!s || s.detached || !s.branch) return { kind: 'none' };
  const up = upstreamKind(s.branch, s.upstream, s.upstreamGone);
  if (up === 'own') return { kind: 'sync', ahead: s.ahead, behind: s.behind, upstream: s.upstream! };
  if (!hasRemote) return { kind: 'none' };
  return up === 'none' ? { kind: 'publish', branch: s.branch } : { kind: 'publish', branch: s.branch, reason: { kind: up, upstream: s.upstream! } };
}

// Main's compare base (facts.githubRepos): checked again here, it becomes a URL the browser opens.
const BASE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** GitHub's compare page for a branch from main's `https://github.com/<owner>/<repo>`; null for anything else. */
export function githubCompareUrl(base: string | null | undefined, branch: string): string | null {
  const m = BASE.exec(base ?? '');
  if (!m || /^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!)) return null;
  return `${base}/compare/${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`;
}

export { overlapFiles };

/**
 * A sheet's sentence that starts with the upstream: "The remote moved on" when it isn't known (its stand-in, "the
 * remote"); a ref name stays as git spells it.
 */
export function sentence(text: string): string {
  const stand = t.git.sync.theRemote;
  return text.startsWith(stand) ? stand[0]!.toUpperCase() + text.slice(1) : text;
}

/** How many of the remote's commits a sheet lists; "and N more" counts from main's total, past what it sent. */
export const COMMITS_SHOWN = 3;
export function commitsShown<C>(commits: readonly C[], total: number | undefined): { shown: C[]; more: number } {
  const shown = commits.slice(0, COMMITS_SHOWN);
  return { shown, more: Math.max(0, Math.max(total ?? 0, commits.length) - shown.length) };
}

/**
 * A row of Sync All's list: done; or what it needs — a diverged branch (Show selects it, where Sync asks to
 * rebase), a live session on files the pull changes (Pull…, the guarded pull, which asks first), a failure in git's words.
 */
export function syncAllRow(r: SyncAllRow): { ok: boolean; text: string; action: 'show' | 'pull' | null } {
  const s = t.git.sync;
  if (r.needsYou === 'live') return { ok: false, text: s.rowLive, action: 'pull' };
  if (r.needsYou === 'diverged') return { ok: false, text: s.rowDiverged, action: 'show' };
  if (r.needsYou === 'no-upstream') return { ok: false, text: s.rowNoUpstream, action: 'show' };
  if (!r.result || r.result.outcome === 'ok') return { ok: true, text: s.rowOk, action: null };
  return { ok: false, text: failText('sync', r.root, r.result), action: 'show' };
}

/** The live files now (the sheets name the sessions from the same read). */
export const liveNow = () => liveFiles(st().terminals, st().attributions);

/** A working tree's status as Source Control shows it (Changes' own when the switcher hasn't listed it). */
function statusOf(root: string): Pick<ScmRepoStatus, 'ahead' | 'behind' | 'branch' | 'detached' | 'upstream' | 'upstreamGone'> | null {
  const s = st().scmRepos?.find((e) => e.root === root)?.status ?? st().repos.find((r) => r.root === root) ?? null;
  return s ? { ...s, upstream: s.upstream ?? null } : null;
}

/**
 * No upstream, one gone from the remote or one of another name: the split button offers Publish there, and the palette
 * and menus do the same — Sync opens Publish, Pull says why it is off. True when it answered.
 */
function publishInstead(root: string, sync: boolean): boolean {
  const s = statusOf(root);
  const remotes = st().gitFacts[root]?.remotes;
  const hasRemote = st().scmRefs[root]?.hasRemote ?? (remotes ? remotes.length > 0 : !!s?.upstream);
  const view = syncView(s, hasRemote);
  if (view.kind !== 'publish') return false;
  if (sync) st().setGitSheet({ kind: 'publish', root });
  else if (!view.reason) st().showToast(t.git.sync.noUpstreamTip);
  else st().showToast(view.reason.kind === 'gone' ? t.git.sync.tipPublishGone(view.branch, view.reason.upstream) : t.git.sync.tipPublishOther(view.branch, view.reason.upstream));
  return true;
}

/** Runs the pull or the sync, past every question. */
export function runPull(root: string, o: { rebase: boolean; sync: boolean; quiet?: boolean }): Promise<GitOpResult | null> {
  return o.sync ? sync(root, { rebase: o.rebase }) : pull(root, { rebase: o.rebase, ...(o.quiet ? { quiet: true } : {}) });
}

/**
 * Before a pull that changes files: the incoming paths against the live sessions' files; overlap asks (null:
 * asked, or off). `quiet`: no toast when it went through (Pull All says it once).
 */
export async function guardedPull(root: string, o: { rebase: boolean; sync: boolean; quiet?: boolean }): Promise<GitOpResult | null> {
  if (!on()) return null;
  let incoming: string[] = [];
  try { incoming = await window.atelier.git.incoming(root); } catch { /* none known: a terminal pull wouldn't ask either */ }
  const { files } = overlapFiles(root, incoming, liveNow());
  if (files.length) { st().setGitSheet({ kind: 'pullOverlap', root, files, rebase: o.rebase, sync: o.sync }); return null; }
  return runPull(root, o);
}

/** Pull (`sync`: Sync): a diverged branch asks to rebase first; a fast-forward goes through the live check. */
export async function startPull(root: string, syncToo = false): Promise<void> {
  if (!on() || publishInstead(root, syncToo)) return;
  const s = statusOf(root);
  if (s && s.ahead > 0 && s.behind > 0) { st().setGitSheet({ kind: 'pullRebase', root, sync: syncToo }); return; }
  await guardedPull(root, { rebase: false, sync: syncToo });
}

/** The split button's Sync: in sync as far as Atelier knows, it asks the remote first (a failed fetch says why and stops). */
export async function startSync(root: string): Promise<void> {
  if (!on() || publishInstead(root, true)) return;
  const s = statusOf(root);
  if (s && s.ahead === 0 && s.behind === 0) {
    const out = await fetchRepo(root, 'manual');
    if (out !== null && out !== 'ok') return;
  }
  await startPull(root, true);
}

/** The rejected sheet's Pull Then Push: the remote has commits HEAD lacks, so the sync rebases. */
export async function pullThenPush(root: string): Promise<void> {
  await guardedPull(root, { rebase: true, sync: true });
}

/** The compare page publishing `remote` would open, null when it isn't a github.com remote (the toggle hides then). */
export function compareUrlFor(root: string, remote: string | null): string | null {
  const facts = st().gitFacts[root];
  return remote && facts?.branch ? githubCompareUrl(facts.githubRepos?.[remote], facts.branch) : null;
}

/**
 * Publish: push --set-upstream; then GitHub's compare page when asked and the remote is on github.com. The
 * choice is remembered only where it was offered (a github.com remote).
 */
export async function publish(root: string, remote: string, openPr: boolean): Promise<void> {
  if (!on()) return;
  const url = compareUrlFor(root, remote);
  if (url) saveGitPrefs({ openPr });
  const r = await push(root, { publish: { remote } });
  if (r?.outcome === 'ok' && openPr && url) void window.atelier.openUrl(url);
}

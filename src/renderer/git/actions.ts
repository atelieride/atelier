// The renderer's git actions: thin wrappers over window.atelier.git. Main does every check
// and every write; these update the store, toast, and open sheets from the outcome. In Read-only (Settings › Source
// Control › Git actions) nothing here runs (answers null), except Cancel, which always works.
import type { MenuState } from '@shared/api';
import { type GitApi, type GitFacts, type GitOp, type GitOpEvent, type GitOpResult, type StageTarget, type SwitchCarry, type SyncAllRow, upstreamKind } from '@shared/git-write';
import { t } from '../i18n/en';
import { useApp, type AppState, type ToastAction, type ToastActions } from '../store';
import { createCommitAll, keepsRun } from './commit-all';
import { discardToast, type DiscardTarget } from './discard';
import { loadGitPrefs } from './drafts';
import { liveFiles, overlapFiles } from './live';
import { writeMessage } from './message-run';
import { toggleRows, type StageRow } from './staging';
import { nextTarget, stagedCount, undoTarget } from './target';
import { divergedRefusal as isDivergedRefusal } from './slice';
import { isBelow } from '@shared/paths';
import { loadRefs } from '../scm/data';

/** A dropped stash's and a deleted branch's Undo stay this long. */
export const LONG_UNDO_MS = 30_000;

const api = (): GitApi => window.atelier.git;
const on = () => useApp.getState().settings.gitActions === 'on';
const st = () => useApp.getState();

/** The working tree's name as Changes shows it. */
function nameOf(root: string): string {
  return st().repos.find((r) => r.root === root)?.name ?? st().scmRepos?.find((e) => e.root === root)?.name ?? root.split('/').pop() ?? root;
}
const short = (sha: string) => sha.slice(0, 7);
const upstreamOf = (root: string) => st().gitFacts[root]?.upstream ?? nameOf(root);

/** An IPC call that main refused (a schema, a gone window) answers like a failed op: never a throw. */
async function call(fn: () => Promise<GitOpResult>): Promise<GitOpResult> {
  try { return await fn(); } catch (e) { return { outcome: 'error', message: e instanceof Error ? e.message : String(e) }; }
}

/** What a failed op says. */
export function failText(op: GitOp, root: string, r: GitOpResult): string {
  const name = nameOf(root);
  switch (r.outcome) {
    case 'busy': return t.git.busy;
    case 'network': return t.git.network;
    case 'auth': return t.git.pushAuth;
    case 'hook': return t.git.hookFailed(r.hook ?? 'A hook', name);
    case 'sign': return t.git.signFailed(name);
    case 'identity': return t.git.identity;
    case 'stale': return t.git.stale(name);
    case 'nothing': return t.git.nothing;
    default: return r.message ? t.git.failed(t.git.ops[op], r.message) : t.git.failedPlain(t.git.ops[op]);
  }
}

const REMOTE_OPS: ReadonlySet<GitOp> = new Set(['push', 'pull', 'sync']);

/**
 * Toasts a failure (an error toast); ok and cancelled say nothing. A push, pull or sync that printed something offers
 * Show Full Output: its log in the drawer, where the failure stays until dismissed.
 */
function report(op: GitOp, root: string, r: GitOpResult): void {
  if (r.outcome === 'ok' || r.outcome === 'cancelled') return;
  if (r.outcome === 'auth' && REMOTE_OPS.has(op)) { needsSignIn(op, root, r); return; }
  const more = REMOTE_OPS.has(op) && !!r.output?.trim();
  st().showToast(failText(op, root, r), more ? { label: t.git.showOutput, run: () => showLog(root) } : undefined);
}

/** The drawer on that working tree, Changes shown: its last failure's log (drawerLog). */
function showLog(root: string): void {
  if (!st().showChanges) st().toggleChanges();
  st().openGitDrawer({ root });
}

/**
 * git asked for a password: main's message, and Open in Terminal, a terminal in the repository with the command
 * typed but not run, where git can ask.
 */
function needsSignIn(op: GitOp, root: string, r: GitOpResult): void {
  const pulling = op === 'pull' || (op === 'sync' && /^pull/i.test(r.message ?? ''));
  const command = pulling ? 'git pull' : 'git push';
  st().showToast(pulling ? r.message ?? t.git.pushAuth : t.git.pushAuth, { label: t.git.sync.openInTerminal, run: () => void import('../send-selection').then((m) => m.textInNewTerminal(command, root, false)) });
}

/** git refused because the branch diverged since the last look: a pull that can't fast-forward, a sync that would rebase. */
function divergedRefusal(op: 'pull' | 'sync', rebase: boolean, r: GitOpResult): boolean {
  return !rebase && isDivergedRefusal(op, r);
}

const info = (text: string, action?: ToastActions, ms?: number) => st().showToast(text, action, 'info', ms);
/** A toast's text with what git also reported when the op was done all the same (a failing post-checkout hook). */
const noted = (text: string, r: GitOpResult) => (r.warning ? `${text}. ${r.warning}` : text);

/** `view`: for a view of many repositories (All Repositories' blocks): main reads it when a read slot is free. */
export async function refreshFacts(root: string, o?: { view: true }): Promise<GitFacts | null> {
  let facts: GitFacts | null = null;
  try { facts = await (o ? api().facts(root, o) : api().facts(root)); } catch { /* none */ }
  st().setGitFacts(root, facts);
  return facts;
}

/**
 * A stage or unstage, shown at once (stage-intents.ts) until a status read from when git was done shows it; a failure
 * shows the files as git has them again.
 */
async function staging(op: 'stage' | 'unstage', root: string, rels: StageTarget): Promise<GitOpResult> {
  const id = st().addStageIntent(root, rels, op === 'stage' ? 'all' : 'none');
  const r = await call(() => api()[op](root, rels));
  st().endStageIntent(id, r.outcome === 'ok' ? r.at ?? Date.now() : null);
  return r;
}

/** Stage files (`'all'`: the whole repository, past the status cap too); an open drawer follows to that repository. */
export async function stage(root: string, rels: StageTarget): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await staging('stage', root, rels);
  if (r.outcome === 'ok') st().noteStaged(root, rels === 'all' || rels.length === 0 ? root : `${root}/${rels[rels.length - 1]}`);
  else report('stage', root, r);
  return r;
}

export async function unstage(root: string, rels: StageTarget): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await staging('unstage', root, rels);
  report('unstage', root, r);
  return r;
}

/** A row's or a group's checkbox: one stage or unstage per root. */
export async function toggleStage(rows: readonly StageRow[]): Promise<void> {
  if (!on()) return;
  for (const step of toggleRows(rows)) {
    if ('stage' in step) await stage(step.root, step.stage);
    else await unstage(step.root, step.unstage);
  }
}

/**
 * "Commit <name>'s Work…": stages exactly the session's listed files (nothing else is unstaged), then opens the
 * drawer for that session when they are in one repository, or Commit all with those repositories and ✦ Write All
 * started. A failed stage stops there. ✦ starting on its own in the drawer comes with the drawer's ✦ (Task 15).
 */
export async function commitWork(session: string, rows: readonly StageRow[]): Promise<void> {
  if (!on()) return;
  const roots: string[] = [];
  for (const step of toggleRows(rows.map((r) => ({ ...r, stage: 'none' as const })))) {
    if (!('stage' in step)) continue;
    const r = await stage(step.root, step.stage);
    if (r?.outcome !== 'ok') return;
    roots.push(step.root);
  }
  if (roots.length <= 1) {
    st().openGitDrawer({ session });
    // Files someone else staged there go into this commit too (nothing else is unstaged): said, as Commit all does.
    const mine = new Set(rows.map((r) => `${r.repo}\0${r.rel}`));
    const where = roots[0] ?? rows[0]?.repo;
    const others = st().repos.find((r) => r.root === where)?.changes.filter((c) => c.stage !== 'none' && !mine.has(`${where}\0${c.rel}`)).length ?? 0;
    const title = st().terminals.find((x) => x.id === session)?.title;
    if (others && title) info(t.git.commitAll.alsoStaged(others, title));
    // ✦ starts on its own, unless the field has a draft.
    const root = st().gitTarget;
    if (root && !st().gitDrafts[root]?.trim()) await writeMessage(root);
    return;
  }
  openCommitAll(roots, session);
  // Not imported upfront: commit-all-run uses these actions.
  await import('./commit-all-run').then((m) => m.writeAll());
}

/** Git › Commit… (⌥⌘K): the Changes panel shows, the drawer opens on its default target (open already: stays). */
export function openCommitDrawer(): void {
  if (!on()) return;
  if (!st().showChanges) st().toggleChanges();
  if (!st().gitDrawer.open) st().openGitDrawer();
}

/**
 * Commit all with these repositories, by default every one with staged files (the drawer's "Commit all…", its
 * ▾ Commit All Repositories…), their drafts as messages. `session`: opened by "Commit <name>'s Work…".
 */
export function openCommitAll(roots: readonly string[] = st().repos.filter((r) => stagedCount(r) > 0).map((r) => r.root), session: string | null = null): void {
  if (!on()) return;
  // A run still committing, or failures waiting for a retry: that run again, never replaced.
  const cur = st().commitAll;
  if (cur && keepsRun(cur)) { if (!cur.open) st().setCommitAll({ ...cur, open: true }); return; }
  const prefs = loadGitPrefs();
  st().setCommitAll(createCommitAll({
    roots, order: st().repos.map((r) => r.root), drafts: st().gitDrafts, mode: prefs.mode, pushAfter: prefs.pushAfter,
    coAuthor: st().settings.commitCoAuthor, session
  }));
}

/** A working tree committed after its status was read: the staged files that status lists are gone already. */
function committedSince(r: { root: string; checkedAt: number }): boolean {
  const last = st().gitResult[r.root];
  return !!last && 'sha' in last && last.at > r.checkedAt;
}

/**
 * Commit. Done: the draft goes if it is still the message committed (text typed meanwhile stays; amend
 * never touches it), the drawer moves to the next repository with staged files, or closes with a toast offering Push,
 * and Undo while main offers it for this commit. `push`: Commit and Push (the push reports itself). `expectHead`
 * (amend): the commit the drawer showed, the only one main rewrites. A failure stays on the bar and in the drawer (the
 * store's result), unseen.
 */
/**
 * Commit; `keepDrawer`: from somewhere else than the drawer (a block of All Repositories), an open drawer on another
 * repository stays where it is.
 */
export async function commit(o: { root: string; message: string; amend: boolean; coAuthor: boolean; noVerify: boolean; push?: boolean; expectHead?: string; keepDrawer?: boolean }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const { root } = o;
  const r = await call(() => api().commit({
    root, message: o.message, amend: o.amend, coAuthor: o.coAuthor, noVerify: o.noVerify, ...(o.amend && o.expectHead ? { expectHead: o.expectHead } : {})
  }));
  st().recordGitResult(root, 'commit', r);
  if (r.outcome !== 'ok') {
    if (r.outcome === 'nothing') info(t.git.nothing);
    return r;
  }
  if (!o.amend && (st().gitDrafts[root] ?? '') === o.message) st().setGitDraft(root, '');
  const drawerHere = st().gitDrawer.open && (!o.keepDrawer || st().gitTarget === root);
  const next = drawerHere ? nextTarget(st().repos.filter((r) => !committedSince(r)), root) : null;
  if (next) st().setGitTarget(next);
  else {
    if (drawerHere) st().closeGitDrawer();
    if (!o.push && r.sha) {
      const sha = r.sha;
      const pushIt: ToastAction = { label: t.git.push, run: () => void push(root) };
      const facts = await refreshFacts(root);
      const undo: ToastAction = { label: t.git.undo, run: () => void undoIfOffered(root, sha) };
      info(t.git.committed(short(sha), nameOf(root)), facts?.undo?.oid === sha ? [pushIt, undo] : pushIt);
    }
  }
  if (o.push) await push(root);
  return r;
}

/** The toast's Undo, at the click: only while main still offers it for that commit. */
function undoIfOffered(root: string, oid: string): void {
  if (st().gitFacts[root]?.undo?.oid !== oid) { info(t.git.nothingToUndo); return; }
  void undoCommit(root, oid);
}

/** Undo the commit Atelier just made: its changes come back staged, its message as the draft. */
export async function undoCommit(root: string, oid: string): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().undoCommit(root, oid));
  st().recordGitResult(root, 'undoCommit', r);
  if (r.outcome !== 'ok') { report('undoCommit', root, r); return r; }
  const draft = st().gitDrafts[root]?.trim();
  const message = r.message;
  // A next message being written stays: the undone commit's is one click away, never written over it.
  if (message && draft && draft !== message.trim()) {
    info(`${t.git.undone(nameOf(root))}. ${t.git.draftKept}`, { label: t.git.useUndoneMessage, run: () => st().setGitDraft(root, message) });
    return r;
  }
  if (message) st().setGitDraft(root, message);
  info(t.git.undone(nameOf(root)));
  return r;
}

/** This project's commit that Git › Undo Last Commit would undo: null while main offers none. */
export function lastUndo(s: AppState = st()): { root: string; oid: string } | null {
  return undoTarget({ target: s.gitTarget, roots: s.repos.map((r) => r.root), facts: s.gitFacts, results: s.gitResult });
}

/** Git › Undo Last Commit: the target's commit while main offers its Undo, else the project's latest one. */
export async function undoLastCommit(): Promise<GitOpResult | null> {
  if (!on()) return null;
  const u = lastUndo();
  if (!u) { info(t.git.nothingToUndo); return null; }
  return undoCommit(u.root, u.oid);
}

/**
 * Push: a branch without an upstream opens Publish instead, as main's facts say now (never ones not read yet or
 * read before the branch was made); rejected opens its sheet. `quiet`: no toast when it went through (Push All says
 * it once).
 */
export async function push(root: string, opts: { publish?: { remote: string }; lease?: { oid: string }; quiet?: boolean } = {}): Promise<GitOpResult | null> {
  if (!on()) return null;
  // What main's strict schema takes: never `quiet`.
  const { quiet, ...o } = opts;
  if (!o.publish && !o.lease) {
    const now = await refreshFacts(root);
    // No upstream (or one gone: facts read none), or one of another name main would refuse to push to.
    if (now && now.branch && !now.detached && upstreamKind(now.branch, now.upstream, false) !== 'own') { st().setGitSheet({ kind: 'publish', root }); return null; }
  }
  const facts = st().gitFacts[root];
  const r = await call(() => api().push({ root, ...o }));
  st().recordGitResult(root, 'push', r);
  if (r.outcome === 'ok' && quiet) return r;
  if (r.outcome === 'ok') {
    // Where it went, as read before the push; not read yet (Publish clicked before its sheet's facts arrived): as git
    // has it now, the upstream the push just set.
    const known = o.publish ? (facts?.branch ? `${o.publish.remote}/${facts.branch}` : null) : facts?.upstream ?? null;
    info(t.git.pushed(known ?? (await refreshFacts(root))?.upstream ?? nameOf(root)));
  } else if (r.outcome === 'rejected') st().setGitSheet({ kind: 'rejected', root });
  else report('push', root, r);
  return r;
}

/** A count of files when main named them, else main's own words (or a plain sentence): never "0 files". */
const dirtyText = (r: GitOpResult, said: (n: number) => string) => {
  const n = r.files?.length ?? 0;
  return n > 0 ? said(n) : r.message ?? said(0);
};

/**
 * Local changes that a pull or a sync would overwrite: Stash and Pull. After a sync (`sync`), the push it was
 * for follows the pull.
 */
function offerStashAndPull(root: string, rebase: boolean, r: GitOpResult, sync = false): void {
  st().showToast(dirtyText(r, t.git.pullDirty), {
    label: t.git.stashAndPull,
    run: () => void pull(root, { rebase, stash: true }).then((p) => (sync && p?.outcome === 'ok' ? push(root) : null))
  });
}

/**
 * Pull: ff-only, or rebase when asked (a conflicting rebase is aborted by main); `stash`: Stash and Pull.
 * `quiet`: no toast when it went through (Pull All says it once); a warning or a failure still speaks.
 */
export async function pull(root: string, o: { rebase: boolean; stash?: boolean; quiet?: boolean }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().pull({ root, rebase: o.rebase, ...(o.stash ? { stash: true } : {}) }));
  if (divergedRefusal('pull', o.rebase, r)) { st().setGitSheet({ kind: 'pullRebase', root, sync: false, byResult: true }); return r; }
  st().recordGitResult(root, 'pull', r);
  if (r.outcome === 'ok') { if (!o.quiet || r.warning) info(noted(t.git.pulled(upstreamOf(root)), r)); }
  else if (r.outcome === 'conflict' && r.dirty) offerStashAndPull(root, o.rebase, r);
  else if (r.outcome === 'conflict') st().showToast(r.message ?? t.git.rebaseAborted(upstreamOf(root)));
  else report('pull', root, r);
  return r;
}

/** Sync: pull, then push. */
export async function sync(root: string, o: { rebase: boolean }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().sync({ root, rebase: o.rebase }));
  if (divergedRefusal('sync', o.rebase, r)) { st().setGitSheet({ kind: 'pullRebase', root, sync: true, byResult: true }); return r; }
  st().recordGitResult(root, 'sync', r);
  if (r.outcome === 'ok') info(t.git.synced(nameOf(root)));
  else if (r.outcome === 'rejected') st().setGitSheet({ kind: 'rejected', root });
  else if (r.outcome === 'conflict' && r.dirty) offerStashAndPull(root, o.rebase, r, true);
  else if (r.outcome === 'conflict') st().showToast(r.message ?? t.git.rebaseAborted(upstreamOf(root)));
  else report('sync', root, r);
  return r;
}

/** The working trees a pull would change: Source Control's statuses (Changes' where it has none), behind their upstream. */
function behindRoots(): string[] {
  const out = new Map<string, boolean>();
  for (const e of st().scmRepos ?? []) if (e.status) out.set(e.root, !!e.status.upstream && e.status.behind > 0);
  for (const r of st().repos) if (!out.has(r.root)) out.set(r.root, !!r.upstream && r.behind > 0);
  return [...out].filter(([, behind]) => behind).map(([root]) => root);
}

/**
 * Before Sync All: the behind working trees whose incoming files a live session is changing. Main
 * leaves them out (`skip`, answered needsYou 'live'); each one's own guarded Pull asks first.
 */
async function liveSkips(): Promise<string[]> {
  const live = liveFiles(st().terminals, st().attributions);
  if (!live.size) return [];
  const skip: string[] = [];
  for (const root of behindRoots()) {
    let incoming: string[] = [];
    try { incoming = await api().incoming(root); } catch { /* none known: a terminal pull wouldn't ask either */ }
    if (overlapFiles(root, incoming, live).files.length) skip.push(root);
  }
  return skip;
}

/** Sync All Repositories: one toast; Show opens the list when some need you. */
export async function syncAll(): Promise<SyncAllRow[] | null> {
  if (!on()) return null;
  let rows: SyncAllRow[];
  try {
    const skip = await liveSkips();
    rows = await api().syncAll({ skip });
  } catch (e) { st().showToast(t.git.failed(t.git.ops.sync, e instanceof Error ? e.message : String(e))); return null; }
  if (!rows.length) { info(t.git.nothingToSync); return rows; }
  const ok = rows.filter((r) => r.result?.outcome === 'ok').length;
  const needs = rows.length - ok;
  info(t.git.syncedAll(ok, needs), needs ? { label: t.git.show, run: () => useApp.getState().setGitSheet({ kind: 'syncAll', rows }) } : undefined);
  return rows;
}

/** A branch's name as a switch makes it: a local one's short name, a remote one's without its remote. */
function branchName(ref: string): string {
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
  return remote ? remote[1]! : ref.replace(/^refs\/heads\//, '');
}

/**
 * Switch: a dirty tree (carry none) opens the Switch sheet's choices; changes git won't carry over (bring) open
 * it again with the files that clash. Switched: a toast, naming the stash when it stashed.
 */
export async function switchTo(root: string, ref: string, carry: SwitchCarry = 'none'): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().switchTo({ root, ref, carry }));
  if (r.outcome === 'ok') info(noted(r.stash ? t.git.switchedStashed(branchName(ref), r.stash.message) : t.git.switched(branchName(ref)), r));
  else if (r.outcome === 'conflict' && r.dirty) st().setGitSheet({ kind: 'switch', root, ref, ...(carry === 'none' ? {} : { clash: r.files ?? [] }) });
  else report('switch', root, r);
  return r;
}

/** A new branch name as git would take it (check-ref-format in main); false in Read-only or on any failure. */
export async function checkBranchName(root: string, name: string, same?: string): Promise<boolean> {
  if (!on()) return false;
  try { return await api().checkBranchName(root, name, same); } catch { return false; }
}

export async function branchCreate(o: { root: string; name: string; from?: string; switch: boolean }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().branchCreate(o));
  if (r.outcome === 'ok') info(noted(t.git.branchCreated(o.name, o.switch), r));
  else report('branchCreate', o.root, r);
  return r;
}

export async function branchRename(o: { root: string; ref: string; name: string }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().branchRename(o));
  report('branchRename', o.root, r);
  return r;
}

/** Delete a branch: not merged opens the sheet (Delete Anyway); deleted offers Undo for 30 s. */
export async function branchDelete(root: string, ref: string, force = false): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().branchDelete({ root, ref, force }));
  const gone = r.branch;
  if (r.outcome === 'ok' && gone) info(t.git.branchDeleted(gone.name), { label: t.git.undo, run: () => void branchRestore({ root, name: gone.name, oid: gone.oid }) }, LONG_UNDO_MS);
  else if (r.outcome === 'conflict' && !force) st().setGitSheet({ kind: 'deleteBranch', root, ref, ...(r.message ? { message: r.message } : {}) });
  else report('branchDelete', root, r);
  return r;
}

export async function branchRestore(o: { root: string; name: string; oid: string }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().branchRestore(o));
  report('branchRestore', o.root, r);
  return r;
}

/** Where a new worktree would go (inside the project, not there yet, ignored): null in Read-only or on failure. */
export async function worktreeCheck(root: string, path: string): Promise<{ inside: boolean; exists: boolean; ignored: boolean } | null> {
  if (!on()) return null;
  try { return await api().worktreeCheck(root, path); } catch { return null; }
}

/** A new worktree: the toast names its folder in the project and offers a Claude session there. */
export async function worktreeAdd(o: { root: string; path: string; ref?: string; newName?: string }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().worktreeAdd(o));
  if (r.outcome !== 'ok') { report('worktreeAdd', o.root, r); return r; }
  const project = st().project?.realRoot ?? st().project?.root;
  const shown = project && isBelow(project, o.path) ? o.path.slice(project.length + 1) : o.path;
  info(noted(t.git.worktreeAdded(shown), r), { label: t.git.sessionHere, run: () => st().setFolderSheet({ kind: 'session', cwd: o.path }) }, LONG_UNDO_MS);
  return r;
}

/** Stash: Undo pops that exact stash (main checks it is still stash@{0} with that oid). */
export async function stashPush(o: { root: string; message: string; untracked: boolean; staged: boolean }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().stashPush(o));
  const made = r.stash;
  if (r.outcome === 'ok' && made) info(t.git.stashed(nameOf(o.root)), { label: t.git.undo, run: () => void stashApply({ root: o.root, index: 0, oid: made.oid, pop: true }) });
  else report('stashPush', o.root, r);
  return r;
}

/**
 * Apply or pop: refused upfront over dirty files; a conflict keeps the stash. `message`: the row's, for the
 * toast (an Undo of a stash says nothing more than the files coming back).
 */
export async function stashApply(o: { root: string; index: number; oid: string; pop: boolean; message?: string }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const { message, ...at } = o;
  const r = await call(() => api().stashApply(at));
  if (r.outcome === 'ok') { if (message) info(noted(t.git.stashApplied(message, o.pop), r)); else if (r.warning) info(r.warning); }
  else if (r.outcome === 'conflict' && r.dirty) st().showToast(dirtyText(r, t.git.stashDirty));
  else if (r.outcome === 'conflict') st().showToast(t.git.stashConflicts(r.files?.length ?? 0));
  else report('stashApply', o.root, r);
  return r;
}

/** Drop: no confirmation, an Undo for 30 s that stores it back. */
export async function stashDrop(o: { root: string; index: number; oid: string }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().stashDrop(o));
  const gone = r.stash;
  if (r.outcome === 'ok' && gone) info(t.git.stashDropped(gone.message), { label: t.git.undo, run: () => void stashRestore({ root: o.root, oid: gone.oid, message: gone.message }) }, LONG_UNDO_MS);
  else report('stashDrop', o.root, r);
  return r;
}

export async function stashRestore(o: { root: string; oid: string; message: string }): Promise<GitOpResult | null> {
  if (!on()) return null;
  const r = await call(() => api().stashRestore(o));
  report('stashRestore', o.root, r);
  return r;
}

/** One working tree's Discard: main trashes each file first, then restores it from HEAD. Says nothing itself. */
export async function discard(root: string, rels: StageTarget): Promise<GitOpResult | null> {
  if (!on()) return null;
  return call(() => api().discard(root, rels));
}

/**
 * The Discard sheet's answer: each working tree in turn (a failure stops there; one where main kept everything goes
 * on), then one toast with what went to the Trash and what main kept, and why. No Undo: the Trash is the undo.
 */
export async function discardTargets(targets: readonly DiscardTarget[]): Promise<void> {
  if (!on()) return;
  const done: { name: string; r: GitOpResult; fail: string }[] = [];
  for (const x of targets) {
    const r = await discard(x.root, x.rels);
    if (!r) return;
    done.push({ name: nameOf(x.root), r, fail: failText('discard', x.root, r) });
    if (r.outcome !== 'ok' && r.outcome !== 'state') break;
  }
  if (!done.length) return;
  const toast = discardToast(done);
  st().showToast(toast.text, undefined, toast.tone, toast.ms);
}

/** Cancel a running or queued op: always, whatever the setting says now. */
export async function cancelOp(id: string): Promise<void> {
  try { await api().cancel(id); } catch { /* gone already */ }
}

/**
 * ev:gitOp, once at boot: ops already running (a window opened mid-op) come from main, then each event updates the
 * store; an op that ends asks for its root's facts again (HEAD, upstream, Undo). The Git menu's state follows the
 * store: main hears when this window's project gets or loses a repository, when Git actions or messages with
 * Claude turn on or off, and when Undo Last Commit does.
 */
export function installGit(): () => void {
  let sent = '';
  const menu = () => {
    const s = st();
    const now: MenuState = {
      gitUndo: on() && lastUndo() !== null,
      hasRepos: s.repos.length > 0 || (s.scmRepos?.length ?? 0) > 0,
      gitWrites: on(),
      messages: s.settings.commitMessages !== 'off',
      // Workspaces on: the Go menu lists them, File shows New Workspace….
      ...(s.project && !s.popout ? { project: true } : {}),
      ...(s.ws?.on && !s.popout ? { workspaces: { names: s.ws.list.map((w) => w.name), active: Math.max(0, s.ws.list.findIndex((w) => w.id === s.ws!.active)) } } : {})
    };
    const key = JSON.stringify(now);
    if (key === sent) return;
    sent = key;
    try { window.atelier.menuState?.(now); } catch { /* a window going away */ }
  };
  menu();
  const unsubscribe = useApp.subscribe(menu);
  // Git actions leaving On (Read-only): no write stays on screen.
  let writes = on();
  const unwatch = useApp.subscribe((s) => {
    const now = s.settings.gitActions === 'on';
    if (writes && !now) leaveWrites();
    writes = now;
  });
  const offOps = listenOps();
  return () => { unsubscribe(); unwatch(); offOps(); };
}

/** Read-only now: the git sheet closes; Commit all being edited goes (✦ stopped), a run kept is hidden behind the bar. */
function leaveWrites(): void {
  if (st().gitSheet) st().setGitSheet(null);
  const all = st().commitAll;
  if (!all) return;
  if (!keepsRun(all)) void import('./commit-all-run').then((m) => m.doneCommitAll());
  else if (all.open) st().setCommitAll({ ...all, open: false });
}

/** The ops that touch only the index or the working tree: every other one moves refs (main's `refs: true`). */
const INDEX_OPS: ReadonlySet<GitOp> = new Set(['stage', 'unstage', 'discard']);

/**
 * An op moved refs: Source Control's loaded refs of that object store (the branch rows' ↑↓) are read again now, not when
 * the watcher's event comes (seconds on a Windows PC). Main cleared its cache before answering the op.
 */
function refsAgain(root: string): void {
  const s = st();
  const common = s.scmRepos?.find((x) => x.root === root)?.common;
  const same = (r: string) => r === root || (!!common && s.scmRepos?.find((x) => x.root === r)?.common === common);
  for (const r of Object.keys(s.scmRefs)) if (same(r)) void loadRefs(r);
}

function listenOps(): () => void {
  const ended = new Set<string>();
  let listed = false;
  const off = window.atelier.on.gitOp((e: GitOpEvent) => {
    if (!listed && e.phase === 'done') ended.add(e.id);
    useApp.getState().applyGitOp(e);
    if (e.phase === 'done') { void refreshFacts(e.root); if (!INDEX_OPS.has(e.op)) refsAgain(e.root); }
  });
  void api().running().then((list) => {
    listed = true;
    for (const e of list) if (!ended.has(e.id) && !useApp.getState().gitOps[e.id]) useApp.getState().applyGitOp(e);
    ended.clear();
  }).catch(() => { listed = true; });
  return off;
}

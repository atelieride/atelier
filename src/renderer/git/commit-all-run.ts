// Commit all's effects: the run that commits one repository at a
// time, the pushes after it, Undo All, ✦ Write All two at a time, and Ask <session> to Fix. They drive the store's
// `commitAll` through the pure model (commit-all.ts), so the run goes on with the sheet closed. Main does every check
// and every write; nothing here runs in Read-only.
import type { GitApi, GitOpResult, ScmMessageEvent } from '@shared/git-write';
import { buildRows } from '../changes';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { refreshFacts, unstage } from './actions';
import * as M from './commit-all';
import { saveGitPrefs } from './drafts';
import { clicksInGit } from './message-run';
import { coAuthorShown } from './drawer';
import { repoPathOf } from './rows';
import { stagedCount } from './target';

const st = () => useApp.getState();
const api = (): GitApi => window.atelier.git;
const on = () => st().settings.gitActions === 'on';
const cur = () => st().commitAll;
const update = (fn: (s: M.CommitAllState) => M.CommitAllState) => st().updateCommitAll(fn);
const repoOf = (root: string) => st().repos.find((r) => r.root === root);
const stagedOf = (root: string) => { const r = repoOf(root); return r ? stagedCount(r) : 0; };
/** The working tree's path in the project, as Changes shows it by session (plugins/payments). */
const nameOf = (root: string) => repoPathOf(root, st().project?.realRoot ?? st().project?.root ?? null);
/** The card's staged files as Changes sees them, with who changed them. */
export const rowsOf = (root: string) => { const r = repoOf(root); return r ? buildRows([r], st().attributions) : []; };

async function call(fn: () => Promise<GitOpResult>): Promise<GitOpResult> {
  try { return await fn(); } catch (e) { return { outcome: 'error', message: e instanceof Error ? e.message : String(e) }; }
}

/** A card's message as typed: kept as that repository's draft (per repository), like the drawer's. */
export function setCardMessage(root: string, text: string): void {
  update((s) => ({ ...s, cards: s.cards.map((c) => (c.root === root ? { ...c, message: text } : c)) }));
  if (cur()?.mode === 'per-repo') st().setGitDraft(root, text);
}

/** The header's Segmented and the footer's Push after committing are remembered; Co-authored-by is this sheet's. */
export function setMode(mode: M.CommitAllMode): void { update((s) => ({ ...s, mode })); saveGitPrefs({ mode }); }
export function setPushAfter(pushAfter: boolean): void { update((s) => ({ ...s, pushAfter })); saveGitPrefs({ pushAfter }); }

/** A file chip's ×: unstages it; the card's counts follow the status. */
export function unstageFile(root: string, rel: string): void { void unstage(root, [rel]); }

/**
 * Esc, Cancel or a click outside: editing, it goes (each message stays as its repository's draft) and ✦ stops;
 * running, it keeps going behind the commit bar; results with a failure left to retry stay reachable from the bar.
 */
export function closeCommitAll(): void {
  const s = cur();
  if (!s) return;
  if (M.keepsRun(s)) { update((x) => ({ ...x, open: false })); return; }
  stopWrites();
  st().setCommitAll(null);
}

/** Done: the results go. */
export function doneCommitAll(): void { stopWrites(); st().setCommitAll(null); }

/** The commit bar's "Committing 3 of 4…": the sheet again. */
export function reopenCommitAll(): void {
  const s = cur();
  if (s && !s.open) st().setCommitAll({ ...s, open: true });
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Commit N Repositories" (⌘↵): the included ones, one at a time, in the cards' order. */
export function commitAllNow(): void {
  const s = cur();
  if (!s || !on() || s.phase !== 'edit' || M.commitBlock(s, stagedOf) || M.writeProgress(s)) return;
  update((x) => M.startRun(x, stagedOf));
  void drive();
}

export function stopAfterThisOne(): void { update(M.stopAfterThisOne); }

/** Retry (or Commit Without Hooks): that repository alone with the same message; then the pushes, if now due. */
export function retryCard(root: string, noVerify: boolean): void {
  if (!on()) return;
  update((s) => M.retry(s, root, noVerify));
  void drive();
}

let driving = false;

async function drive(): Promise<void> {
  if (driving) return;
  driving = true;
  try {
    for (;;) {
      const s = cur();
      const root = s ? M.nextRun(s) : null;
      if (!s || !root) break;
      update((x) => M.runStarted(x, root, Date.now()));
      const card = s.cards.find((c) => c.root === root)!;
      // The trailer only where a staged file was changed by a Claude session, as the drawer does.
      const coAuthor = s.coAuthor && coAuthorShown(rowsOf(root));
      const r = await call(() => api().commit({ root, message: card.message, amend: false, coAuthor, noVerify: !!card.noVerify }));
      st().recordGitResult(root, 'commit', r);
      if (r.outcome === 'ok') st().setGitDraft(root, '');
      update((x) => M.runEnded(x, root, r));
    }
  } finally {
    driving = false;
  }
  const s = cur();
  if (s && M.shouldAutoPush(s)) await pushAll({ auto: true });
}

// ── Pushes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Push N Repositories, or Push after committing (`auto`): one after the other. */
export async function pushAll(o: { auto?: boolean } = {}): Promise<void> {
  const s = cur();
  if (!s || !on()) return;
  for (const root of M.pushTargets(s, o)) await pushOne(root);
}

/**
 * One repository's push: to its upstream; without one, published to its only remote, or the row asks which
 * (`remote`: the one picked there). Rejected and other failures stay on the row.
 */
export async function pushOne(root: string, remote?: string): Promise<void> {
  if (!on()) return;
  const facts = await refreshFacts(root);
  const plan = remote ? { kind: 'publish' as const, remote } : M.pushPlan(facts ?? undefined);
  if (plan.kind === 'ask') { update((s) => M.pushAsk(s, root, plan.remotes)); return; }
  if (plan.kind === 'none') { update((s) => M.pushEnded(s, root, { outcome: 'error', message: t.git.commitAll.noRemote }, '', false)); return; }
  update((s) => M.pushStarted(s, root));
  const publish = plan.kind === 'publish';
  const r = await call(() => api().push({ root, ...(publish ? { publish: { remote: plan.remote } } : {}) }));
  st().recordGitResult(root, 'push', r);
  const to = publish ? `${plan.remote}/${facts?.branch ?? ''}` : facts?.upstream ?? repoOf(root)?.upstream ?? '';
  update((s) => M.pushEnded(s, root, r, to, publish));
}

/** A rejected push: the sheet that resolves it, in place of this one. */
export function resolveRejected(root: string): void {
  doneCommitAll();
  st().setGitSheet({ kind: 'rejected', root });
}

// ── Undo All ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Undo All: each commit made here, with main's checks; one toast says what couldn't be undone. */
export async function undoAll(): Promise<void> {
  const s = cur();
  if (!s || !on()) return;
  const undone: string[] = [];
  const kept: string[] = [];
  for (const u of M.undoTargets(s)) {
    const r = await call(() => api().undoCommit(u.root, u.oid));
    st().recordGitResult(u.root, 'undoCommit', r);
    if (r.outcome === 'ok') undone.push(u.root); else kept.push(u.root);
  }
  update((x) => M.undoAllDone(x, undone));
  // Back to editing: each message is its repository's draft again (in One message mode, that one message).
  const after = cur();
  if (after) for (const root of undone) st().setGitDraft(root, after.mode === 'one' ? after.message : after.cards.find((c) => c.root === root)?.message ?? '');
  if (kept.length) st().showToast(t.git.commitAll.undoPartial(undone.length, kept.map(nameOf).join(', ')));
  else if (undone.length) st().showToast(t.git.commitAll.undoneAll(undone.length), undefined, 'info');
}

// ── Ask <session> to Fix ─────────────────────────────────────────────────────────────────────────────────────────────

/** The session "Ask <session> to Fix" would ask about this repository, with its name; null: none to ask. */
export function fixer(root: string): { id: string; title: string } | null {
  const s = cur();
  const id = M.askSession(rowsOf(root), s?.session ?? null);
  const term = id ? st().terminals.find((x) => x.id === id) : undefined;
  return term?.session ? { id: term.id, title: term.title } : null;
}

/**
 * Types the failure into the session's prompt (the user presses Return, as Send to… does) and steps aside: the sheet
 * closes, reachable again from the commit bar for Retry.
 */
export function askToFix(root: string): void {
  const s = cur();
  const card = s?.cards.find((c) => c.root === root);
  const who = fixer(root);
  if (!card || card.run?.kind !== 'failed' || !who) return;
  const text = M.fixPrompt({ path: nameOf(root), result: card.run.result });
  update((x) => ({ ...x, open: false }));
  void import('../send-selection').then((m) => m.sendTextTo(who.id, text, false));
}

// ── ✦ Write All ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Message ids main answered → their card's root. */
const writing = new Map<string, string>();
/** Events of an id not known yet (its answer still on the way). */
const early = new Map<string, ScmMessageEvent[]>();
const failures: string[] = [];
let offMessages: (() => void) | null = null;
/** ✦ runs asked of main whose id hasn't come back yet. */
let starting = 0;

/** ✦ Write All: every empty message of the included cards, at most two at a time; the text streams into each card. */
export function writeAll(): void {
  const s = cur();
  if (!s || !on() || s.phase !== 'edit' || st().settings.commitMessages === 'off') return;
  const roots = M.writeTargets(s);
  if (!roots.length) return;
  failures.length = 0;
  update((x) => M.queueWrites(x, roots));
  pump();
}

/** Stop: what is being written goes back to empty, the queue empties. */
export function stopWrites(): void {
  for (const id of writing.keys()) void api().messageCancel(id).catch(() => {});
  writing.clear();
  early.clear();
  update(M.writesStopped);
  failures.length = 0;
  listen(false);
}

function pump(): void {
  const s = cur();
  if (!s) return;
  for (const root of M.nextWrites(s)) void startWrite(root);
  const after = cur();
  if (after && !M.writeProgress(after)) {
    listen(false);
    if (failures.length) st().showToast(t.git.commitAll.writeFailed(failures.length, failures[0]!), undefined, 'info');
    failures.length = 0;
  }
}

function listen(want: boolean): void {
  if (want && !offMessages) {
    offMessages = window.atelier.on.scmMessage(onEvent);
    offSheet = useApp.subscribe(dropGone);
  } else if (!want && offMessages && writing.size === 0) {
    offMessages(); offMessages = null;
    offSheet?.(); offSheet = null;
  }
}

let offSheet: (() => void) | null = null;

/**
 * A write whose card is no longer being written (the sheet replaced by a new one, gone, stopped): main stops it at once,
 * and what it would still send lands nowhere.
 */
function dropGone(): void {
  for (const [id, root] of writing) {
    if (cur()?.cards.find((c) => c.root === root)?.write === 'writing') continue;
    writing.delete(id);
    void api().messageCancel(id).catch(() => {});
  }
}

async function startWrite(root: string): Promise<void> {
  update((s) => M.writeStarted(s, root));
  listen(true);
  const writingHere = () => cur()?.cards.find((c) => c.root === root)?.write === 'writing';
  let res: { id: string } | { error: string } | null;
  starting++;
  try {
    // A checkbox click there not in git yet: main reads the index once it is (stopped meanwhile: never asked).
    await clicksInGit(root);
    res = writingHere() ? await api().message({ root }) : null;
  } catch (e) { res = { error: e instanceof Error ? e.message : String(e) }; } finally { starting--; }
  if (res === null) return;
  if ('error' in res) { ended(root, null, res.error); return; }
  // Stopped (or the sheet went) while main was starting it.
  if (!writingHere()) { void api().messageCancel(res.id).catch(() => {}); early.delete(res.id); return; }
  writing.set(res.id, root);
  const queued = early.get(res.id) ?? [];
  early.delete(res.id);
  for (const e of queued) onEvent(e);
}

function onEvent(e: ScmMessageEvent): void {
  const root = writing.get(e.id);
  // Kept only while an answer is on its way: a stopped write's last event is dropped.
  if (!root) { if (starting > 0) early.set(e.id, [...(early.get(e.id) ?? []), e]); return; }
  if ('chunk' in e) update((s) => M.writeChunk(s, root, e.chunk));
  else if ('done' in e) { writing.delete(e.id); ended(root, e.done.text, null); }
  else { writing.delete(e.id); ended(root, null, e.error); }
}

function ended(root: string, text: string | null, error: string | null): void {
  if (text !== null) {
    update((s) => M.writeDone(s, root, text));
    if (cur()?.mode === 'per-repo') st().setGitDraft(root, text);
  } else {
    update((s) => M.writeFailed(s, root));
    if (error && error !== 'Stopped') failures.push(error);
  }
  pump();
}

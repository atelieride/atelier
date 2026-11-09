// The commit bar and drawer as data: what the bar says by precedence, the drawer's
// notices (at most two lines), the others line, when Co-authored-by shows, the subject counter, why Commit is
// disabled, and what a drag of the handle does. Pure; the components in CommitBar/CommitDrawer render it.
import type { RepoStatus } from '@shared/git';
import type { GitFacts, GitOp } from '@shared/git-write';
import type { CommitNothingStaged } from '@shared/settings';
import { sureBy, type ChangeRow } from '../changes';
import { t } from '../i18n/en';
import type { LiveBy } from './live';
import type { GitResultEntry, GitRunning } from './slice';
import { stagedCount } from './target';

type Repo = Pick<RepoStatus, 'root' | 'name' | 'changes'>;

/** The result notice's life: 30 s, or until the next op. */
export const RESULT_MS = 30_000;
export const SUBJECT_MAX = 72;
/** How far the handle travels before a drag opens or closes the drawer. */
export const DRAG_THRESHOLD = 24;

/** Ops too quick to show on the bar: a checkbox's stage would make it flicker. */
const QUIET: ReadonlySet<GitOp> = new Set(['stage', 'unstage']);

const short = (sha: string) => sha.slice(0, 7);
const nameIn = (repos: readonly Repo[], root: string) => repos.find((r) => r.root === root)?.name ?? root.split('/').pop() ?? root;

export type BarView =
  | { kind: 'running'; id: string; text: string; startedAt: number }
  | { kind: 'failed'; root: string; text: string }
  | { kind: 'draft'; count: number; text: string }
  | { kind: 'staged'; count: number; repos: number; name: string }
  | { kind: 'nothing' };

/** What a running op says on the bar: its hook, the signature it waits on, or the op itself. */
function runningText(e: Pick<GitRunning, 'op' | 'phase' | 'hook'>, name: string): string {
  if (e.phase === 'hook') return t.git.bar.hook(e.hook ?? 'hook', name);
  if (e.phase === 'signing') return t.git.bar.signing;
  switch (e.op) {
    case 'commit': return t.git.bar.committing(name);
    case 'push': return t.git.bar.pushing(name);
    case 'pull': return t.git.bar.pulling(name);
    case 'sync': return t.git.bar.syncing(name);
    default: return t.git.bar.working(t.git.ops[e.op], name);
  }
}

/** A failure in one short line: "pre-commit failed · acme-store". */
function failedText(e: Extract<GitResultEntry, { failed: unknown }>, name: string): string {
  if (e.failed.outcome === 'hook') return t.git.hookFailed(e.failed.hook ?? 'A hook', name);
  if (e.failed.outcome === 'sign') return t.git.signFailed(name);
  return t.git.bar.failed(t.git.ops[e.op], name);
}

/** The first line with words in it, trimmed. */
function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/**
 * The bar, first that applies: an op running in this project (the one that started first), the latest failure
 * not looked at yet, a saved draft for the target, the staged files, nothing staged.
 */
export function barView(o: { repos: readonly Repo[]; ops: readonly GitRunning[]; results: Readonly<Record<string, GitResultEntry>>; drafts: Readonly<Record<string, string>>; target: string | null }): BarView {
  const roots = new Set(o.repos.map((r) => r.root));
  const running = o.ops.filter((e) => roots.has(e.root) && !QUIET.has(e.op)).sort((a, b) => a.startedAt - b.startedAt)[0];
  if (running) return { kind: 'running', id: running.id, text: runningText(running, nameIn(o.repos, running.root)), startedAt: running.startedAt };
  let failed: { root: string; e: Extract<GitResultEntry, { failed: unknown }> } | null = null;
  for (const [root, e] of Object.entries(o.results)) {
    if (roots.has(root) && 'failed' in e && !e.seen && (!failed || e.at > failed.e.at)) failed = { root, e };
  }
  if (failed) return { kind: 'failed', root: failed.root, text: failedText(failed.e, nameIn(o.repos, failed.root)) };
  const draft = o.target ? firstLine(o.drafts[o.target] ?? '') : '';
  if (o.target && draft) {
    const target = o.repos.find((r) => r.root === o.target);
    return { kind: 'draft', count: target ? stagedCount(target) : 0, text: draft };
  }
  const staged = o.repos.filter((r) => stagedCount(r) > 0);
  if (!staged.length) return { kind: 'nothing' };
  return { kind: 'staged', count: staged.reduce((n, r) => n + stagedCount(r), 0), repos: staged.length, name: staged[0]!.name };
}

/** The bar's elapsed time: "4s", then "1:01". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type Notice =
  | { kind: 'live'; text: string; color: string }
  | { kind: 'failed'; root: string; text: string }
  /** blocks: Commit is disabled; terminal: the root "Open in Terminal" opens. */
  | { kind: 'state'; text: string; blocks: boolean; terminal?: string }
  | { kind: 'result'; root: string; sha: string; text: string; undo: { oid: string } | null }
  /** Nothing staged, `count` changes Stage All would take. */
  | { kind: 'unstaged'; text: string; count: number };

/** Which notices stay when there are more than two: blocks first, then a failure, live files, the rest, Stage All last. */
function rank(n: Notice): number {
  if (n.kind === 'state') return n.blocks ? 0 : 3;
  return n.kind === 'failed' ? 1 : n.kind === 'live' ? 2 : n.kind === 'unstaged' ? 5 : 4;
}

/**
 * The drawer's notices, at most two lines in the order live, state, result: who is still editing a staged file
 * of the target; a commit that can't or shouldn't happen here (mid-operation, no identity, detached); the target's
 * failure; the project's last commit for 30 s or until the next op (`actedAt`: when the latest op started), with Undo
 * only while main offers it for that very commit (`allFacts`). `amendMoved`: HEAD moved while Amend was on.
 * `unstaged`: nothing staged and Stage All offered for that many changes.
 */
export function drawerNotices(o: {
  target: string | null; repos: readonly Repo[]; facts: GitFacts | undefined; allFacts: Readonly<Record<string, Pick<GitFacts, 'undo'>>>;
  live: ReadonlyMap<string, LiveBy>; results: Readonly<Record<string, GitResultEntry>>; actedAt: number; now: number; amendMoved?: boolean;
  unstaged?: number;
}): Notice[] {
  const out: Notice[] = [];
  const target = o.target ? o.repos.find((r) => r.root === o.target) ?? null : null;
  if (target) {
    const editing = target.changes.filter((c) => c.stage !== 'none' && o.live.has(c.path));
    if (editing.length) {
      const by = editing.map((c) => o.live.get(c.path)!);
      const who = [...new Set(by.map((b) => b.title))];
      out.push({ kind: 'live', text: t.git.drawer.editing(who, editing.map((c) => c.rel.split('/').pop() ?? c.rel)), color: by[0]!.color });
    }
    const failed = o.results[target.root];
    if (failed && 'failed' in failed) out.push({ kind: 'failed', root: target.root, text: failedText(failed, target.name) });
    const f = o.facts;
    if (f) {
      if (f.state) out.push({ kind: 'state', text: t.git.drawer.midOp(target.name, f.state), blocks: true });
      if (!f.identity) out.push({ kind: 'state', text: t.git.identity, blocks: true, terminal: target.root });
      if (f.detached) out.push({ kind: 'state', text: t.git.drawer.detached, blocks: false });
    }
  }
  if (o.amendMoved) out.push({ kind: 'state', text: t.git.drawer.amendMoved, blocks: false });
  const roots = new Set(o.repos.map((r) => r.root));
  let last: { root: string; sha: string; at: number } | null = null;
  for (const [root, e] of Object.entries(o.results)) {
    if (!roots.has(root) || !('sha' in e)) continue;
    if (o.now - e.at >= RESULT_MS || e.at < o.actedAt) continue;
    if (!last || e.at > last.at) last = { root, sha: e.sha, at: e.at };
  }
  if (last) {
    const offered = o.allFacts[last.root]?.undo?.oid === last.sha;
    out.push({ kind: 'result', root: last.root, sha: short(last.sha), text: t.git.drawer.result(short(last.sha), nameIn(o.repos, last.root)), undo: offered ? { oid: last.sha } : null });
  }
  if (o.unstaged) out.push({ kind: 'unstaged', text: t.git.drawer.unstagedLine(o.unstaged), count: o.unstaged });
  const kept = new Set([...out].sort((a, b) => rank(a) - rank(b)).slice(0, 2));
  return out.filter((n) => kept.has(n));
}

/** The others line: files staged outside the target, in how many repositories; null when none. */
export function othersLine(repos: readonly Repo[], target: string | null): { files: number; repos: number } | null {
  const others = repos.filter((r) => r.root !== target && stagedCount(r) > 0);
  if (!others.length) return null;
  return { files: others.reduce((n, r) => n + stagedCount(r), 0), repos: others.length };
}

/** Co-authored-by Claude shows when a staged file of the target is surely by a Claude session. */
export function coAuthorShown(rows: readonly Pick<ChangeRow, 'stage' | 'by'>[]): boolean {
  return rows.some((r) => r.stage !== 'none' && sureBy(r.by).length > 0);
}

/** The subject counter: the first line's length in characters, amber past 72; it never blocks. */
export function subjectCount(message: string): { n: number; over: boolean } {
  const n = [...(message.split('\n')[0] ?? '')].length;
  return { n, over: n > SUBJECT_MAX };
}

/**
 * Why Commit is disabled, null when it isn't. `amend`: nothing staged rewords HEAD. `nothingStaged`
 *: with nothing staged, Commit stages everything first (asking, or not) unless the
 * setting says never or Stage All isn't offered; an unmerged file says to resolve it first.
 */
export function commitBlock(o: {
  target: string | null; name: string; staged: number; message: string; running: boolean; notices: readonly Notice[]; amend?: boolean;
  nothingStaged?: { mode: CommitNothingStaged; offered: boolean; conflicts: boolean };
}): string | null {
  if (!o.target) return t.git.drawer.noTarget;
  if (o.running) return t.git.drawer.running(o.name);
  const block = o.notices.find((n) => n.kind === 'state' && n.blocks);
  if (block) return block.text;
  if (o.staged === 0 && !o.amend) {
    const n = o.nothingStaged;
    if (n?.conflicts) return t.git.drawer.resolveFirst;
    if (!n || !n.offered || n.mode === 'never') return t.git.drawer.nothingStaged(o.name);
  }
  if (!o.message.trim()) return t.git.drawer.noMessage;
  return null;
}

/**
 * Amend is offered only when HEAD exists, is not a merge and is not on its upstream (main checks again before
 * it runs). Not offered: why, for the toggle's tooltip. `sha`: HEAD's short form, for "Amending f0d6c52".
 */
export function amendOffer(f: GitFacts | undefined): { ok: true; sha: string } | { ok: false; tip: string } {
  if (!f) return { ok: false, tip: t.git.drawer.amendReading };
  if (!f.head) return { ok: false, tip: t.git.drawer.amendNoHead };
  if (f.headIsMerge) return { ok: false, tip: t.git.drawer.amendMerge };
  if (f.headPushed) return { ok: false, tip: t.git.drawer.amendPushed };
  return { ok: true, sha: short(f.head) };
}

/** Amend in the drawer: HEAD's message in the field and the commit it shows, the one main may rewrite (expectHead). */
export interface AmendState { on: boolean; text: string; head: string | null }
export const AMEND_OFF: AmendState = { on: false, text: '', head: null };

/** Turning Amend on: HEAD's message and HEAD itself; null when amend isn't offered. */
export function amendStart(f: GitFacts | undefined): AmendState | null {
  if (!f || !amendOffer(f).ok) return null;
  return { on: true, text: (f.headMessage ?? '').replace(/\s+$/, ''), head: f.head };
}

/**
 * Amend as the facts change: off once it is no longer offered (pushed meanwhile), and off with a notice when HEAD
 * is no longer the commit it showed (a commit from a terminal or a session): it would rewrite one the user never chose.
 */
export function amendFollow(a: AmendState, f: GitFacts | undefined): { amend: AmendState; moved: boolean } {
  if (!a.on || !f) return { amend: a, moved: false };
  if (f.head !== a.head) return { amend: AMEND_OFF, moved: true };
  if (!amendOffer(f).ok) return { amend: AMEND_OFF, moved: false };
  return { amend: a, moved: false };
}

/** Commit all's line on the bar while its sheet is closed (commitAllBar). */
type CommitAllBar = { kind: 'running' } | { kind: 'results' };

/**
 * What the closed bar shows and does: Commit all running (its "Committing 3 of 4…"), else an op running in
 * the drawer (with Cancel) before Commit all's results kept for a retry, else the bar's own line. A click reopens Commit
 * all, or opens the drawer (on the failed repository when the bar shows a failure).
 */
export function barChoice(view: BarView, all: CommitAllBar | null): { show: 'all' | 'view'; click: { kind: 'reopenAll' } | { kind: 'open'; root?: string }; cancel: string | null } {
  if (all && (all.kind === 'running' || view.kind !== 'running')) return { show: 'all', click: { kind: 'reopenAll' }, cancel: null };
  return { show: 'view', click: view.kind === 'failed' ? { kind: 'open', root: view.root } : { kind: 'open' }, cancel: view.kind === 'running' ? view.id : null };
}

export type DrawerLog =
  | { kind: 'running'; id: string; text: string; startedAt: number; output: string }
  /** withoutHooks: a commit's hook failed (Commit Without Hooks is offered); noShellEnv: ran without the user's env. */
  | { kind: 'failed'; op: GitOp; text: string; output: string; withoutHooks: boolean; noShellEnv: boolean };

/**
 * The drawer's op log: the target's op running now (its label and what it printed so far, with Cancel),
 * else its last failure (its output, Retry, Commit Without Hooks after a commit's hook). Null: nothing to show.
 */
export function drawerLog(o: { target: string | null; name: string; ops: readonly GitRunning[]; results: Readonly<Record<string, GitResultEntry>> }): DrawerLog | null {
  if (!o.target) return null;
  const running = o.ops.filter((e) => e.root === o.target && !QUIET.has(e.op)).sort((a, b) => a.startedAt - b.startedAt)[0];
  if (running) return { kind: 'running', id: running.id, text: runningText(running, o.name), startedAt: running.startedAt, output: running.output };
  const e = o.results[o.target];
  if (!e || !('failed' in e)) return null;
  return {
    kind: 'failed', op: e.op, text: failedText(e, o.name), output: e.failed.output ?? e.failed.message ?? '',
    withoutHooks: e.op === 'commit' && e.failed.outcome === 'hook', noShellEnv: !!e.failed.noShellEnv
  };
}

/** The log's first `n` lines with words in them (leading and trailing blank lines dropped), and how many follow. */
export function logPreview(output: string, n: number): { lines: string[]; more: number } {
  const all = output.split(/\r\n|\r|\n/);
  while (all.length && !all[0]!.trim()) all.shift();
  while (all.length && !all.at(-1)!.trim()) all.pop();
  return { lines: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/** The drawer's height while its handle is dragged: from its natural height up to the max (60% of the panel). */
export function liveHeight(o: { natural: number; max: number; start: number; dy: number }): number {
  return Math.max(o.natural, Math.min(o.start - o.dy, o.max));
}

/**
 * A drag of the handle, at release. Closed: up past the threshold opens, and so does a click (no travel). Open:
 * down past the natural height by the threshold closes; otherwise the height it was dragged to (null: back to natural,
 * near it).
 */
export function dragEnd(o: { open: boolean; natural: number; max: number; start: number; dy: number }): { kind: 'open' } | { kind: 'close' } | { kind: 'height'; height: number | null } | { kind: 'none' } {
  const click = Math.abs(o.dy) < 3;
  if (!o.open) return o.dy <= -DRAG_THRESHOLD || click ? { kind: 'open' } : { kind: 'none' };
  if (click) return { kind: 'none' };
  const h = o.start - o.dy;
  if (h < o.natural - DRAG_THRESHOLD) return { kind: 'close' };
  const height = liveHeight(o);
  return { kind: 'height', height: height <= o.natural + 4 ? null : height };
}

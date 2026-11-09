// Commit all: several repositories in one sheet. Pure: the cards in Changes' order, what
// blocks the commit, the sequential run (Stop After This One, Retry of one), the results, the pushes that follow only
// once every included repository committed, Undo All, and ✦ Write All two at a time. The effects that
// drive it live in commit-all-run.ts.
import { type GitFacts, type GitOpResult, upstreamKind } from '@shared/git-write';
import type { ChangeBy } from '../changes';
import type { LiveBy } from './live';

export type CommitAllMode = 'one' | 'per-repo';

/** A card's commit in this run. */
export type CardRun =
  | { kind: 'waiting' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'committed'; sha: string; undo: { oid: string } | null }
  | { kind: 'failed'; result: GitOpResult }
  /** Stop After This One: never started. */
  | { kind: 'skipped' }
  /** Undo All took it back (others couldn't be). */
  | { kind: 'undone' };

/** A committed card's push. `ask`: no upstream and several remotes, the row asks which one. */
export type CardPush =
  | { kind: 'running' }
  | { kind: 'pushed'; to: string; published: boolean }
  | { kind: 'failed'; result: GitOpResult }
  | { kind: 'ask'; remotes: string[] };

export type CardWrite = 'queued' | 'writing' | 'written' | 'failed';

export interface CommitAllCard {
  root: string; include: boolean; message: string;
  run?: CardRun; push?: CardPush; write?: CardWrite;
  /** Retry chose Commit Without Hooks. */
  noVerify?: boolean;
}

/** The Commit all sheet; closing it while it runs keeps it (open: false), the commit bar reopens it. */
export interface CommitAllState {
  open: boolean; mode: CommitAllMode; message: string; cards: CommitAllCard[];
  /** "Commit <session>'s Work…": the session's terminal id. */
  session: string | null;
  pushAfter: boolean; coAuthor: boolean;
  phase: 'edit' | 'running' | 'results';
  stopAfter: boolean;
  /** The staged files the run set out to commit (the header's count once commits have emptied the index). */
  files: number;
}

/** ✦ Write All writes this many messages at once. */
export const WRITE_AT_ONCE = 2;

type Staged = (root: string) => number;

const setCard = (s: CommitAllState, root: string, fn: (c: CommitAllCard) => CommitAllCard): CommitAllState =>
  ({ ...s, cards: s.cards.map((c) => (c.root === root ? fn(c) : c)) });

/** The sheet as it opens: the cards in Changes' order (`order`, roots it doesn't know last), each with its draft. */
export function createCommitAll(o: {
  roots: readonly string[]; order: readonly string[]; drafts: Readonly<Record<string, string>>; mode: CommitAllMode; pushAfter: boolean; coAuthor: boolean;
  session: string | null;
}): CommitAllState {
  const at = (root: string) => { const i = o.order.indexOf(root); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const roots = [...new Set(o.roots)].map((root, i) => ({ root, i })).sort((a, b) => at(a.root) - at(b.root) || a.i - b.i).map((x) => x.root);
  return {
    open: true, mode: o.mode, message: '', session: o.session, pushAfter: o.pushAfter, coAuthor: o.coAuthor, phase: 'edit', stopAfter: false, files: 0,
    cards: roots.map((root) => ({ root, include: true, message: o.drafts[root] ?? '' }))
  };
}

export const messageOf = (s: CommitAllState, c: CommitAllCard): string => (s.mode === 'one' ? s.message : c.message);

/** The cards that would commit: included, with something staged. */
export const included = (s: CommitAllState, staged: Staged): CommitAllCard[] => s.cards.filter((c) => c.include && staged(c.root) > 0);

/** Why "Commit N Repositories" is disabled: no repository to commit, or a message missing (`root` null: the one message). */
export function commitBlock(s: CommitAllState, staged: Staged): { kind: 'none' } | { kind: 'message'; root: string | null } | null {
  const cards = included(s, staged);
  if (cards.length === 0) return { kind: 'none' };
  if (s.mode === 'one') return s.message.trim() ? null : { kind: 'message', root: null };
  const missing = cards.find((c) => !c.message.trim());
  return missing ? { kind: 'message', root: missing.root } : null;
}

/** Commit: the included cards wait their turn (one message mode copies it into each), the others stay out of the run. */
export function startRun(s: CommitAllState, staged: Staged): CommitAllState {
  const cards = included(s, staged);
  const go = new Set(cards.map((c) => c.root));
  return {
    ...s, phase: 'running', stopAfter: false, files: cards.reduce((n, c) => n + staged(c.root), 0),
    cards: s.cards.map(({ run: _r, push: _p, noVerify: _n, ...c }) => {
      const card = { ...c, message: messageOf(s, c) };
      return go.has(c.root) ? { ...card, run: { kind: 'waiting' as const } } : card;
    })
  };
}

/** The next repository to commit, one at a time, in the cards' order; none while one runs or after Stop. */
export function nextRun(s: CommitAllState): string | null {
  if (s.phase !== 'running' || s.stopAfter || s.cards.some((c) => c.run?.kind === 'running')) return null;
  return s.cards.find((c) => c.run?.kind === 'waiting')?.root ?? null;
}

export const runStarted = (s: CommitAllState, root: string, now: number): CommitAllState =>
  setCard(s, root, (c) => ({ ...c, run: { kind: 'running', startedAt: now } }));

/** Nothing running and nothing left to start (or Stop): the waiting ones are skipped, the results show. */
function settle(s: CommitAllState): CommitAllState {
  if (s.phase !== 'running' || s.cards.some((c) => c.run?.kind === 'running')) return s;
  if (!s.stopAfter && s.cards.some((c) => c.run?.kind === 'waiting')) return s;
  return { ...s, phase: 'results', stopAfter: false, cards: s.cards.map((c) => (c.run?.kind === 'waiting' ? { ...c, run: { kind: 'skipped' } } : c)) };
}

/** A commit ended: a sha is a commit; anything else (nothing to commit included) is a failure the row shows. */
export function runEnded(s: CommitAllState, root: string, r: GitOpResult): CommitAllState {
  const run: CardRun = r.outcome === 'ok' && r.sha ? { kind: 'committed', sha: r.sha, undo: r.undo ?? null } : { kind: 'failed', result: r };
  return settle(setCard(s, root, (c) => ({ ...c, run })));
}

/** Stop After This One: the running repository finishes, the rest are skipped. Only while running. */
export function stopAfterThisOne(s: CommitAllState): CommitAllState {
  return s.phase === 'running' ? settle({ ...s, stopAfter: true }) : s;
}

/** Retry: that repository alone, with the same message; `noVerify`: Commit Without Hooks. Only a failed one. */
export function retry(s: CommitAllState, root: string, noVerify: boolean): CommitAllState {
  const card = s.cards.find((c) => c.root === root);
  if (!card || card.run?.kind !== 'failed') return s;
  return { ...setCard(s, root, (c) => ({ ...c, run: { kind: 'waiting' }, noVerify })), phase: 'running', stopAfter: false };
}

const FINISHED = new Set(['committed', 'failed', 'skipped', 'undone']);

/** The run's progress ("2 of 4"); `current`: the one committing now (1-based), 0 when none. */
export function progress(s: CommitAllState): { done: number; total: number; current: number } {
  const inRun = s.cards.filter((c) => c.run);
  const done = inRun.filter((c) => FINISHED.has(c.run!.kind)).length;
  return { done, total: inRun.length, current: inRun.some((c) => c.run!.kind === 'running') ? done + 1 : 0 };
}

/** "3 of 4 committed". */
export function summary(s: CommitAllState): { committed: number; total: number } {
  const inRun = s.cards.filter((c) => c.run);
  return { committed: inRun.filter((c) => c.run!.kind === 'committed').length, total: inRun.length };
}

/**
 * The commit bar while the sheet is closed: the run going on ("Committing 3 of 4…"), or its results while a
 * failed repository is left to retry (after "Ask <session> to Fix"); a click reopens the sheet. Null: the bar's own.
 */
export function commitAllBar(s: CommitAllState | null):
  | { kind: 'running'; done: number; total: number; current: number } | { kind: 'results'; committed: number; total: number } | null {
  if (!s || s.open) return null;
  if (s.phase === 'running') {
    const p = progress(s);
    return { kind: 'running', ...p, current: p.current || Math.min(p.done + 1, p.total) };
  }
  if (s.phase === 'results' && s.cards.some((c) => c.run?.kind === 'failed')) return { kind: 'results', ...summary(s) };
  return null;
}

/**
 * A run that must not be lost: still committing, or results with a failure left to retry. Closing keeps it
 * (behind the commit bar), and opening Commit all again brings it back instead of a new sheet.
 */
export function keepsRun(s: CommitAllState): boolean {
  return s.phase === 'running' || (s.phase === 'results' && s.cards.some((c) => c.run?.kind === 'failed'));
}

// ── Pushes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The committed repositories to push: by the button "Push N Repositories", every one not pushed or pushing (a failed
 * push again); `auto` (Push after committing), only those never tried.
 */
export function pushTargets(s: CommitAllState, o: { auto?: boolean } = {}): string[] {
  return s.cards.filter((c) => c.run?.kind === 'committed' && (o.auto ? !c.push : !c.push || c.push.kind === 'failed')).map((c) => c.root);
}

/** Push after committing runs once every repository in the run committed; otherwise the button waits. */
export function shouldAutoPush(s: CommitAllState): boolean {
  if (!s.pushAfter || s.phase !== 'results') return false;
  const inRun = s.cards.filter((c) => c.run);
  return inRun.length > 0 && inRun.every((c) => c.run!.kind === 'committed') && pushTargets(s, { auto: true }).length > 0;
}

/**
 * How a repository pushes: to its upstream of the same name, else (none, or one of another name main refuses to
 * push to) publish to its only remote, else ask which, or nowhere.
 */
export function pushPlan(f: Pick<GitFacts, 'branch' | 'upstream' | 'remotes' | 'detached'> | undefined): { kind: 'push' } | { kind: 'publish'; remote: string } | { kind: 'ask'; remotes: string[] } | { kind: 'none' } {
  if (!f || !f.branch || f.detached || upstreamKind(f.branch, f.upstream, false) === 'own') return { kind: 'push' };
  if (f.remotes.length === 1) return { kind: 'publish', remote: f.remotes[0]! };
  return f.remotes.length > 1 ? { kind: 'ask', remotes: [...f.remotes] } : { kind: 'none' };
}

export const pushStarted = (s: CommitAllState, root: string): CommitAllState => setCard(s, root, (c) => ({ ...c, push: { kind: 'running' } }));
export const pushAsk = (s: CommitAllState, root: string, remotes: string[]): CommitAllState => setCard(s, root, (c) => ({ ...c, push: { kind: 'ask', remotes } }));

export function pushEnded(s: CommitAllState, root: string, r: GitOpResult, to: string, published: boolean): CommitAllState {
  return setCard(s, root, (c) => ({ ...c, push: r.outcome === 'ok' ? { kind: 'pushed', to, published } : { kind: 'failed', result: r } }));
}

// ── Undo All ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Undo All: the commits made here that still offer an Undo and were not pushed. */
export function undoTargets(s: CommitAllState): { root: string; oid: string }[] {
  return s.cards.flatMap((c) => (c.run?.kind === 'committed' && c.run.undo && c.push?.kind !== 'pushed' && c.push?.kind !== 'running' ? [{ root: c.root, oid: c.run.undo.oid }] : []));
}

/**
 * Undo All answered: `undone` are back to staged. Nothing committed left: back to editing, the messages kept (commit
 * again, or change them); otherwise the results stay and the undone rows say so.
 */
export function undoAllDone(s: CommitAllState, undone: readonly string[]): CommitAllState {
  const marked = { ...s, cards: s.cards.map((c) => (undone.includes(c.root) ? { ...c, run: { kind: 'undone' as const } } : c)) };
  if (marked.cards.some((c) => c.run?.kind === 'committed')) return marked;
  return { ...marked, phase: 'edit', stopAfter: false, cards: marked.cards.map(({ run: _r, push: _p, noVerify: _n, ...c }) => c) };
}

// ── ✦ Write All ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** What ✦ Write All writes: every included card's empty message (per repository only), not one already on its way. */
export function writeTargets(s: CommitAllState): string[] {
  if (s.mode === 'one') return [];
  return s.cards.filter((c) => c.include && !c.message.trim() && c.write !== 'queued' && c.write !== 'writing').map((c) => c.root);
}

/** A new Write All: those queued, the last one's finished marks forgotten ("N of M" counts this one). */
export function queueWrites(s: CommitAllState, roots: readonly string[]): CommitAllState {
  return {
    ...s,
    cards: s.cards.map((c) => {
      if (roots.includes(c.root)) return { ...c, write: 'queued' as const };
      if (c.write === 'written' || c.write === 'failed') { const { write: _w, ...rest } = c; return rest; }
      return c;
    })
  };
}

/** The queued cards to start now so that at most `limit` are being written. */
export function nextWrites(s: CommitAllState, limit = WRITE_AT_ONCE): string[] {
  const busy = s.cards.filter((c) => c.write === 'writing').length;
  return s.cards.filter((c) => c.write === 'queued').slice(0, Math.max(0, limit - busy)).map((c) => c.root);
}

export const writeStarted = (s: CommitAllState, root: string): CommitAllState => setCard(s, root, (c) => ({ ...c, write: 'writing', message: '' }));
export const writeChunk = (s: CommitAllState, root: string, chunk: string): CommitAllState =>
  setCard(s, root, (c) => (c.write === 'writing' ? { ...c, message: c.message + chunk } : c));
export const writeDone = (s: CommitAllState, root: string, text: string): CommitAllState => setCard(s, root, (c) => ({ ...c, write: 'written', message: text }));
/** Failed or stopped: the field is as it was before ✦ (empty: ✦ only writes empty ones). */
export const writeFailed = (s: CommitAllState, root: string): CommitAllState => setCard(s, root, (c) => ({ ...c, write: 'failed', message: '' }));

/** Write All stopped (or the sheet closed): the queued and half-written ones as they were before it, empty. */
export const writesStopped = (s: CommitAllState): CommitAllState =>
  ({ ...s, cards: s.cards.map((c) => (c.write === 'queued' || c.write === 'writing' ? { ...c, write: 'failed' as const, message: '' } : c)) });

/** "3 of 4 written" while Write All runs; null once nothing is queued or being written. */
export function writeProgress(s: CommitAllState): { done: number; total: number } | null {
  const asked = s.cards.filter((c) => c.write);
  if (!asked.some((c) => c.write === 'queued' || c.write === 'writing')) return null;
  return { done: asked.filter((c) => c.write === 'written' || c.write === 'failed').length, total: asked.length };
}

// ── Cards' contents and failures ─────────────────────────────────────────────────────────────────────────────────────

type CardRow = { path: string; rel: string; stage: 'none' | 'all' | 'partial'; added: number | null; removed: number | null; by: readonly Pick<ChangeBy, 'terminalId' | 'title' | 'maybe' | 'unclear'>[] };
const sure = (b: Pick<ChangeBy, 'maybe' | 'unclear'>) => !b.maybe && !b.unclear;

/**
 * A card's files (the staged ones) and counts; with a session: the other sessions that also changed each file
 * ("also changed by billing-tests"), how many staged files are not the session's ("Also staged"); and the first
 * staged file a session is still editing (live).
 */
export function cardInfo(o: { rows: readonly CardRow[]; session: string | null; live: ReadonlyMap<string, LiveBy> }): {
  files: { rel: string; path: string; also: string[] }[]; added: number; removed: number; alsoStaged: number; live: { title: string; n: number; rel: string } | null;
} {
  const rows = o.rows.filter((r) => r.stage !== 'none');
  const files = rows.map((r) => ({
    rel: r.rel, path: r.path,
    also: o.session ? [...new Set(r.by.filter((b) => sure(b) && b.terminalId !== o.session).map((b) => b.title))] : []
  }));
  const alsoStaged = o.session ? rows.filter((r) => !r.by.some((b) => sure(b) && b.terminalId === o.session)).length : 0;
  const liveRows = rows.filter((r) => o.live.has(r.path));
  const first = liveRows[0];
  return {
    files, alsoStaged,
    added: rows.reduce((n, r) => n + (r.added ?? 0), 0), removed: rows.reduce((n, r) => n + (r.removed ?? 0), 0),
    live: first ? { title: o.live.get(first.path)!.title, n: liveRows.length, rel: first.rel } : null
  };
}

/** Who "Ask <session> to Fix" asks: the sheet's session, else the one that surely changed most of the staged files. */
export function askSession(rows: readonly CardRow[], session: string | null): string | null {
  if (session) return session;
  const count = new Map<string, number>();
  for (const r of rows) {
    if (r.stage === 'none') continue;
    for (const id of new Set(r.by.filter(sure).map((b) => b.terminalId))) count.set(id, (count.get(id) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const e of count) if (!best || e[1] > best[1]) best = e;
  return best?.[0] ?? null;
}

/** The log's first `n` lines with words in them (blank lines around dropped), and how many follow. */
export function logLines(output: string, n: number): { lines: string[]; more: number } {
  const all = output.split(/\r\n|\r|\n/);
  while (all.length && !all[0]!.trim()) all.shift();
  while (all.length && !all.at(-1)!.trim()) all.pop();
  return { lines: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/** Lines of the log "Ask <session> to Fix" passes on. */
const FIX_LINES = 30;

/**
 * "Ask <session> to Fix": the prompt typed into the session (the user presses Enter): what failed where, git's output,
 * and not to commit (the retry stays in the sheet).
 */
export function fixPrompt(o: { path: string; result: GitOpResult }): string {
  const r = o.result;
  const what = r.outcome === 'hook' ? `The ${r.hook ?? 'pre-commit'} hook failed in ${o.path} while committing.` : `Committing in ${o.path} failed${r.message ? `: ${r.message}` : '.'}`;
  const log = logLines(r.output ?? r.message ?? '', FIX_LINES).lines.join('\n');
  return `${what} Fix what it reports, but don't commit: I'll retry the commit from Atelier.${log ? `\n\n${log}` : ''}`;
}

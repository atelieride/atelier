import { appendFileSync } from 'node:fs';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, SessionState } from '@shared/session';
import { backgroundWork, effectiveState, type WorkScan } from '@shared/background';
import { NOTIFY_DONE_AFTER_MS, type NotifyDoneAfter, type Settings } from '@shared/settings';
import { noteText, reasonLabel, type NoteEntry, type NoteKind, type NoteSession, type NoteWait, type StateNoteKind } from '@shared/notifications';
import { isLimitPaused, isWaiting, waitKind } from '@shared/session-view';
import { NOTIFY_EVERY_MS, TriggerThrottle, scopeAllows } from '@shared/triggers';

// "Waiting for you" means a permission or an answer: the idle notice (waitingFor 'input') is not.
// A session paused at a usage limit is not "stopped": no banner while it waits, one when the pause ends.
const inState = (s: SessionState) => (t: TerminalInfo) => (s === 'waiting' ? isWaiting(t.session) : t.session?.state === s && !(s === 'error' && isLimitPaused(t.session)));
const waiting = inState('waiting');
/** What a waiting session asks for, when its atelierd says (states2). */
const waitOf = (t: TerminalInfo): NoteWait | undefined => { const k = waitKind(t.session); return k === 'permission' || k === 'question' ? k : undefined; };
// A permission request blocks the work outright: it goes first, then questions, then the unspecified waits.
const URGENCY: Record<string, number> = { permission: 0, question: 1 };
const byUrgency = (list: TerminalInfo[]) => [...list].sort((a, b) => (URGENCY[waitOf(a) ?? ''] ?? 2) - (URGENCY[waitOf(b) ?? ''] ?? 2));

/** Terminals that just entered the state (they were not in it in the previous list): one notification per entry. */
export function newlyIn(state: SessionState, prev: TerminalInfo[], next: TerminalInfo[]): TerminalInfo[] {
  const is = inState(state);
  const before = new Set(prev.filter(is).map((t) => t.id));
  return next.filter((t) => is(t) && !before.has(t.id));
}

/** Terminals that just switched to "waiting for you". */
export function newlyWaiting(prev: TerminalInfo[], next: TerminalInfo[]): TerminalInfo[] {
  return newlyIn('waiting', prev, next);
}

/** Dock number: sessions waiting across all windows. */
export function waitingCount(lists: TerminalInfo[][]): number {
  return lists.reduce((n, l) => n + l.filter(waiting).length, 0);
}

/**
 * Who enters the waiting state between one list and the next. The first list after each connection is only the baseline:
 * reopening the app with sessions already waiting must not notify them again.
 */
export class StateTracker {
  private prev: TerminalInfo[] | null = null;
  constructor(private readonly state: SessionState) {}
  reset(): void { this.prev = null; }
  /** `quiet`: terminals whose entry is a baseline (tracked, never reported). */
  update(next: TerminalInfo[], quiet: ReadonlySet<string> = new Set()): TerminalInfo[] {
    const prev = this.prev;
    this.prev = next;
    return prev ? newlyIn(this.state, prev, next).filter((t) => !quiet.has(t.id)) : [];
  }
}

export class WaitingTracker extends StateTracker {
  constructor() { super('waiting'); }
}

/** What a terminal's work was last computed from. */
interface WorkInputs { session: SessionInfo; scan: WorkScan | null; counting: boolean }

/**
 * The counting dropped only because shells became servers: the last inputs with just the new scan's servers applied
 * no longer count. No agent is woken for a server, so that finish needs no work-end hold.
 */
function serversOnly(p: WorkInputs, scan: WorkScan | undefined, now: number, countAsWork: boolean): boolean {
  if (!scan || scan.servers.length === 0) return false;
  const base = p.scan ?? { matched: {}, gone: [] };
  return !backgroundWork(p.session, { at: scan.at, matched: base.matched, servers: scan.servers, gone: base.gone }, now, { countAsWork }).counting;
}

/**
 * Who finishes: "done" on the effective state, so a session is done only when its main agent is
 * and no background work counts. Intermediate turns (done → running → done while work counts) never finish; the last
 * Stop with nothing left, or the end of the work after a Stop, finishes once. A stop that only time explains (a cap
 * expiry, a subagent's 2-hour expiry, or the setting turned off) is a baseline: the terminal's last inputs, replayed
 * now, would not count either.
 */
export class DoneTracker {
  private tracker = new StateTracker('done');
  private inputs = new Map<string, WorkInputs>();
  reset(): void { this.tracker.reset(); this.inputs.clear(); }
  /** `next`: terminals with their work attached; `scans`: the scans that work came from. */
  update(next: TerminalInfo[], scans: Record<string, WorkScan>, now: number, countAsWork: boolean): TerminalInfo[] {
    return this.finishes(next, scans, now, countAsWork).map((f) => f.term);
  }
  /**
   * The same, as finishes at `now`: a "work-end" one when the main agent was already done and only the counting
   * dropped (Claude Code is about to wake an agent with the report: the queue holds it, see FinishQueue).
   */
  finishes(next: TerminalInfo[], scans: Record<string, WorkScan>, now: number, countAsWork: boolean): Finish[] {
    const quiet = new Set<string>();
    const workEnd = new Set<string>();
    for (const t of next) {
      const p = this.inputs.get(t.id);
      if (p?.counting && !t.work?.counting && !backgroundWork(p.session, p.scan, now, { countAsWork }).counting) quiet.add(t.id);
      if (p?.counting && p.session.state === 'done' && !serversOnly(p, scans[t.id], now, countAsWork)) workEnd.add(t.id);
    }
    this.inputs = new Map(next.flatMap((t) => (t.session && t.work ? [[t.id, { session: t.session, scan: scans[t.id] ?? null, counting: t.work.counting }] as const] : [])));
    // The tracker sees the effective state: "running" while work counts.
    const effective = next.map((t) => (t.session && effectiveState(t) !== t.session.state ? { ...t, session: { ...t.session, state: effectiveState(t)! } } : t));
    const ids = new Set(this.tracker.update(effective, quiet).map((t) => t.id));
    return next.filter((t) => ids.has(t.id)).map((term): Finish => (workEnd.has(term.id) ? { term, kind: 'done', at: now, workEnd: true } : { term, kind: 'done', at: now }));
  }
}

/**
 * When each session's turn began, on the effective state: it starts when the session starts working and goes on
 * through waits for a permission or an answer and through background work (not through the idle notice, which comes
 * after the turn). A turn whose start was never seen (the app opened mid-turn) has no length.
 */
export class TurnClock {
  /** Sessions in a turn: when it started (null: unknown). Sessions seen out of a turn: 'out'. */
  private turns = new Map<string, number | null | 'out'>();
  /** In a turn only because background work counts (the main agent at rest). */
  private onWork = new Set<string>();
  /**
   * The last turn that ended with its background work: the report turn Claude Code wakes right after (within
   * WORK_END_HOLD_MS) continues it, so the whole job's length decides.
   */
  private ended = new Map<string, { start: number | null; at: number }>();
  update(next: TerminalInfo[], now: number): void {
    const turns = new Map<string, number | null | 'out'>();
    const onWork = new Set<string>();
    const ended = new Map<string, { start: number | null; at: number }>();
    for (const t of next) {
      const prev = this.turns.get(t.id);
      const last = this.ended.get(t.id);
      const recent = last && now - last.at <= WORK_END_HOLD_MS ? last : undefined;
      // No session yet (the shell before claude starts) is out of a turn too: the first turn is then seen starting.
      const state = effectiveState(t);
      if (!t.session || (state !== 'running' && !isWaiting(t.session))) {
        turns.set(t.id, 'out');
        if (prev !== undefined && prev !== 'out' && this.onWork.has(t.id)) ended.set(t.id, { start: prev, at: now });
        else if (recent) ended.set(t.id, recent);
        continue;
      }
      if (t.session.state !== state) onWork.add(t.id);
      turns.set(t.id, prev === 'out' ? (recent ? recent.start : now) : prev === undefined ? null : prev);
    }
    this.turns = turns;
    this.onWork = onWork;
    this.ended = ended;
  }
  /**
   * How long the turn has lasted at `now` — called before the update that ends it. A session last seen out of a turn
   * finished one shorter than a list interval (0); null when unknown (never seen, or first seen mid-turn).
   */
  took(id: string, now: number): number | null {
    const s = this.turns.get(id);
    return s === 'out' ? 0 : typeof s === 'number' ? now - s : null;
  }
}

/**
 * The finishes worth notifying (bell entry, chime, macOS banner): errors always; a done only after a turn of `after`
 * or more, or of unknown length.
 */
export function longFinishes(items: Finish[], after: NotifyDoneAfter): Finish[] {
  const min = NOTIFY_DONE_AFTER_MS[after];
  return items.filter((f) => f.kind === 'error' || min === 0 || f.took == null || f.took >= min);
}

export interface Note { term: TerminalInfo; kind: NoteKind; body: string; silent: boolean; /** Title of a grouped notification (otherwise the session's). */ title?: string }

/** Kinds in banners and center entries (the renderer has the same words in its strings). */
export const KIND_TEXT: Record<StateNoteKind, string> = { waiting: 'Waiting for you', done: 'Finished', error: 'Stopped with an error' };

/** The notifications to show for whoever just started waiting or finished, according to the settings. */
export function notesFor(s: Settings, waitingNow: TerminalInfo[], doneNow: TerminalInfo[], errorNow: TerminalInfo[] = []): Note[] {
  const silent = !s.notifySound;
  const note = (kind: StateNoteKind) => (term: TerminalInfo): Note => ({ term, kind, body: noteText(kind, term.session?.activity ?? null, KIND_TEXT, kind === 'waiting' ? waitOf(term) : undefined), silent });
  return [
    ...(s.notifyWaiting ? byUrgency(waitingNow).map(note('waiting')) : []),
    ...(s.notifyDone ? doneNow.map(note('done')) : []),
    // Turn stopped by an error (rate limit, API): under the setting for finishes, said as a stop with the reason.
    ...(s.notifyDone ? errorNow.map(note('error')) : [])
  ];
}

/**
 * Three or more sessions finished at the same moment: a single "N sessions finished" with the names, leading to the
 * first; three or more stopped by an error: "N sessions stopped", with the reason when they share it. An error is never
 * counted as a finish. Waiting sessions stay one notification per session: each one asks for something.
 */
export function groupNotes(notes: Note[]): Note[] {
  let out = notes;
  for (const kind of ['done', 'error'] as const) {
    const same = out.filter((n) => n.kind === kind);
    if (same.length < GROUP_MIN) continue;
    const names = same.map((n) => n.term.title).join(', ');
    const reasons = new Set(same.map((n) => n.term.session?.activity ?? 'error'));
    const reason = kind === 'error' && reasons.size === 1 ? [...reasons][0]! : 'error';
    const text = reason !== 'error' ? `${reasonLabel(reason)} · ${names}` : names;
    const body = text.length > 120 ? `${text.slice(0, 119)}…` : text;
    const title = `${same.length} sessions ${kind === 'error' ? 'stopped' : 'finished'}`;
    out = [...out.filter((n) => n.kind !== kind), { term: same[0]!.term, kind, title, body, silent: same[0]!.silent }];
  }
  return out;
}

/**
 * Sessions finishing within this long of the first one go out together (one center entry, one OS notification); a
 * "done" also waits at least this long itself, so a report turn right after it can make it stale.
 */
export const FINISH_WINDOW_MS = 2500;
/**
 * A work-end finish (the main agent was already done, only its background work ended) waits this long: Claude Code
 * wakes the agent that launched the work with the report, and that turn ends with its own Stop.
 */
export const WORK_END_HOLD_MS = 8000;
/** A batch waits for its young finishes at most this long from its start (then they move to the next batch). */
const MAX_BATCH_MS = 2 * FINISH_WINDOW_MS;
/** From this many finishes in a batch (per project for the center), a single "N sessions finished". */
const GROUP_MIN = 3;

/** A session that finished or stopped, and when (entries carry this time, not the time the batch goes out). */
export interface Finish {
  term: TerminalInfo; kind: 'done' | 'error'; at: number; /** Held WORK_END_HOLD_MS. */ workEnd?: boolean;
  /** How long the turn lasted (TurnClock); null or absent when unknown. */
  took?: number | null;
}

/**
 * A batch of finishes as it goes out: a "done" only for a session still done
 * now (effective state), and one per session, its latest. A background subagent that stops for good with the main
 * agent at rest reads as done until Claude Code wakes the main agent with its report: that turn (running, then its
 * own Stop) lands in the same batch, or makes the earlier finish stale by the time it goes out. Errors, other
 * sessions, terminals no longer listed and sessions that ended meanwhile are kept as they are.
 */
export function settleFinishes(items: Finish[], current: readonly TerminalInfo[]): Finish[] {
  const now = new Map(current.map((t) => [t.id, t]));
  const latest = new Map<string, Finish>();
  for (const f of items) if (f.kind === 'done') latest.set(f.term.id, f);
  return items.filter((f) => {
    if (f.kind !== 'done') return true;
    if (latest.get(f.term.id) !== f) return false;
    const t = now.get(f.term.id);
    // A session that ended right after its final Stop (SessionEnd) finished: no report turn can follow.
    return !t || !t.session || effectiveState(t) === 'done';
  });
}

const noteSession = (x: TerminalInfo): NoteSession => ({ id: x.id, title: x.title, color: x.color });

/**
 * Notification center entries, whatever the OS-notification settings: one per session that starts
 * waiting (at `now`); the finishes of a batch per project and per kind, three or more of a kind as one entry (an error
 * is never counted as a finish; stopped together for the same reason, the entry keeps it). `seen`: sessions already
 * viewed by the time the batch goes out (they start read).
 */
export function centerEntries(waitingNow: TerminalInfo[], finished: Finish[], now: number, newId: () => string, seen: Set<string> = new Set()): { project: string; entry: NoteEntry }[] {
  const unseen = (list: TerminalInfo[]) => list.map((x) => x.id).filter((id) => !seen.has(id));
  const out: { project: string; entry: NoteEntry }[] = waitingNow.map((x) => {
    const entry: NoteEntry = { id: newId(), at: now, kind: 'waiting', sessions: [noteSession(x)], activity: x.session?.activity ?? null, unseen: [x.id] };
    const wait = waitOf(x);
    if (wait) entry.wait = wait;
    return { project: x.projectRoot, entry };
  });
  const groups = new Map<string, { project: string; kind: Finish['kind']; list: Finish[] }>();
  for (const f of finished) {
    const key = JSON.stringify([f.term.projectRoot, f.kind]);
    const g = groups.get(key) ?? { project: f.term.projectRoot, kind: f.kind, list: [] };
    g.list.push(f);
    groups.set(key, g);
  }
  for (const { project, kind, list } of groups.values()) {
    if (list.length >= GROUP_MIN) {
      const terms = list.map((f) => f.term);
      const reasons = new Set(terms.map((x) => x.session?.activity ?? null));
      const activity = kind === 'error' && reasons.size === 1 ? [...reasons][0]! : null;
      out.push({ project, entry: { id: newId(), at: Math.max(...list.map((f) => f.at)), kind, sessions: terms.map(noteSession), activity, unseen: unseen(terms) } });
      continue;
    }
    for (const f of list) out.push({ project, entry: { id: newId(), at: f.at, kind: f.kind, sessions: [noteSession(f.term)], activity: f.term.session?.activity ?? null, unseen: unseen([f.term]) } });
  }
  return out;
}

/**
 * Sessions someone is looking at in a window main knows is focused (a tab pop-out; the main window's renderer decides
 * for its own panes): their entries arrive read, and marked `quiet` for them — the main window never chimes for those.
 * Only this mark silences: an entry merely already seen (looked at earlier) chimes as always.
 */
export function seenWhereViewed(list: { project: string; entry: NoteEntry }[], viewed: (project: string, id: string) => boolean): { project: string; entry: NoteEntry }[] {
  return list.map((x) => {
    const quiet = x.entry.sessions.map((s) => s.id).filter((id) => viewed(x.project, id));
    return quiet.length ? { ...x, entry: { ...x.entry, unseen: x.entry.unseen.filter((id) => !quiet.includes(id)), quiet } } : x;
  });
}

/**
 * Collects finishes for a short window from the first one, then hands them over together: sessions finishing a few
 * seconds apart become one entry and one notification (they rarely land in the same terminal list). Each "done" gets
 * its own full window, whatever other sessions do: the batch waits for its youngest (up to MAX_BATCH_MS from its
 * start), and one still younger than FINISH_WINDOW_MS then moves to the next batch (a new window); a work-end one
 * waits WORK_END_HOLD_MS without holding the others. A session's later "done" replaces its
 * earlier one wherever it waits. What goes out is settled against the current list (`current`): a session working
 * again by then (the report turn) loses its stale finish; its own Stop brings a fresh one.
 */
export class FinishQueue {
  private items: Finish[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = 0;
  /** When the current batch started: it waits for its young finishes until MAX_BATCH_MS after that. */
  private started = 0;
  constructor(private readonly current: () => readonly TerminalInfo[], private readonly onFlush: (items: Finish[]) => void) {}

  push(items: Finish[]): void {
    if (items.length === 0) return;
    const now = Date.now();
    if (!this.items.some((f) => !f.workEnd)) this.started = now;
    this.items.push(...items);
    // A new finish never waits longer than its own window, even behind a held work-end.
    if (this.timer === null || this.due > now + FINISH_WINDOW_MS) this.arm(FINISH_WINDOW_MS);
  }

  private arm(ms: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.due = Date.now() + ms;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, ms);
    this.timer.unref?.();
  }

  private flush(): void {
    const now = Date.now();
    const latest = new Map<string, Finish>();
    // The latest "done" stands for the session's earlier ones: it keeps the longest turn length, unknown above all.
    const longest = new Map<string, number | null>();
    for (const f of this.items) {
      if (f.kind !== 'done') continue;
      latest.set(f.term.id, f);
      const prev = longest.get(f.term.id);
      const took = f.took ?? null;
      longest.set(f.term.id, prev === undefined ? took : prev === null || took === null ? null : Math.max(prev, took));
    }
    const queued = this.items
      .filter((f) => f.kind !== 'done' || latest.get(f.term.id) === f)
      .map((f) => (f.kind === 'done' && (f.took ?? null) !== longest.get(f.term.id) ? { ...f, took: longest.get(f.term.id)! } : f));
    this.items = queued;
    // Sessions finishing a moment apart go out together: the batch waits for its youngest "done" (not for held
    // work-ends), up to MAX_BATCH_MS from its start so a stream of finishes can't hold it forever.
    const young = queued.filter((f) => f.kind === 'done' && !f.workEnd && now - f.at < FINISH_WINDOW_MS);
    const cap = this.started + MAX_BATCH_MS;
    if (young.length && now < cap) { this.arm(Math.min(cap, Math.max(...young.map((f) => f.at + FINISH_WINDOW_MS))) - now); return; }
    const ready = (f: Finish) => f.kind !== 'done' || now - f.at >= (f.workEnd ? WORK_END_HOLD_MS : FINISH_WINDOW_MS);
    const out = queued.filter(ready);
    this.items = queued.filter((f) => !ready(f));
    const settled = settleFinishes(out, this.current());
    if (settled.length) this.onFlush(settled);
    if (this.items.length === 0) return;
    // The next batch: a new window for the young ones, or, with only held work-ends left, the first of them.
    this.started = now;
    this.arm(young.length ? FINISH_WINDOW_MS : Math.max(0, Math.min(...this.items.map((f) => f.at + WORK_END_HOLD_MS)) - now));
  }
}

/**
 * OS banners for "notify" triggers. The renderer matches and already throttles; main decides the banner
 * on its own too (setting, window in front, one per rule per terminal every 30 s, at most 6 a minute in all, and only
 * for a rule that is an enabled notify rule of the settings, in scope for that terminal), so a renderer can't flood
 * macOS nor put its own words in a banner title.
 */
export const TRIGGER_BANNERS_PER_MINUTE = 6;

export class TriggerBanners {
  private throttle = new TriggerThrottle(NOTIFY_EVERY_MS);
  private shown: number[] = [];
  note(s: Settings, term: TerminalInfo, rule: string, line: string, focused: boolean, now: number): Note | null {
    if (!s.notifyTriggers || focused) return null;
    const kind = term.session ? 'session' : 'terminal';
    if (!s.triggers.some((r) => r.enabled && r.action === 'notify' && r.pattern === rule && scopeAllows(r.scope, kind))) return null;
    this.shown = this.shown.filter((at) => now - at < 60_000 && at <= now);
    if (this.shown.length >= TRIGGER_BANNERS_PER_MINUTE || !this.throttle.allow(term.id, rule, now)) return null;
    this.shown.push(now);
    const text = line.trim() ? `${term.title} · ${line.trim()}` : term.title;
    return { term, kind: 'trigger', title: `Trigger: ${rule}`, body: text.length > 120 ? `${text.slice(0, 119)}…` : text, silent: !s.notifySound };
  }
  /** Entries in the throttle memory (tests: it stays bounded). */
  size(): number { return this.throttle.size(); }
}

/**
 * Shows an OS banner. Tests only (ATELIER_TEST_NOTIFY_LOG, inert in the packaged app): the banner is recorded in the
 * log, one JSON object per line, and nothing reaches macOS.
 */
export function showBanner(b: { title: string; body: string; silent: boolean }, testLog: string | undefined, show: () => void): void {
  if (testLog) { appendFileSync(testLog, JSON.stringify({ title: b.title, body: b.body, silent: b.silent }) + '\n'); return; }
  show();
}

/** A banner's own sound only for a project with no window: an open window plays Atelier's chime (renderer chime.ts). */
export const bannerSilent = (silent: boolean, windowOpen: boolean): boolean => silent || windowOpen;

export function badgeText(s: Settings, waiting: number): string {
  return s.dockBadge && waiting > 0 ? String(waiting) : '';
}

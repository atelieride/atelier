// Ask in the live demo: `window.atelier.companion` as an in-memory companion
// per demo session. It keeps main's contract (src/main/companion/service.ts, imitated, never imported): one run per
// session at a time, the others queued; a question joins the thread when its run's turn comes; a run says `started`,
// streams its trace and its text, lands its item in the thread (a `thread` event, unseen) and ends with exactly one
// `ended`. What a run says comes from the script (engine/ask.ts over world/ask.ts, one chunk loaded on first use);
// everything plays on the demo's clock, so a paused demo pauses its answers.
import type { AtelierApi } from '@shared/api';
import { appendItems, newThread } from '@shared/companion/thread';
import type { Binding, CompanionErrorKind, CompanionEvent, CompanionModel, Thread, ThreadItem } from '@shared/companion/types';
import type { AskFacts, AskPlayer } from '../engine/ask';
import type { Cancel } from '../engine/clock';
import { noop, resolved, type DemoContext } from './context';
import { newId } from './terminals';

/** The first trace line, then one every TRACE_MS (Claude reading the chat, then the files). */
export const TRACE_FIRST_MS = 300;
export const TRACE_MS = 450;
/** From the last trace line to the first words of an answer, or to a Catch me up's card. */
export const TEXT_AFTER_MS = 500;
export const CARD_AFTER_MS = 600;
/** The answer streams in chunks of about CHUNK_CHARS, cut at word boundaries, CHUNK_MS apart. */
export const CHUNK_MS = 380;
export const CHUNK_CHARS = 60;
/** What a run says when the script can't be loaded (a chunk that failed to arrive). */
export const LOAD_FAILED = "Ask couldn't start in this demo";
/** What an answer costs by model, about: the ⋯ menu's "Cost so far" moves as in the app. */
const COST: Record<CompanionModel, number> = { haiku: 0.002, sonnet: 0.008, opus: 0.04 };

/** The script and its reader, as a chunk of their own: out of the demo's first paint (its budget has little room). */
export const loadAskPlayer = (): Promise<AskPlayer> => import('../engine/ask').then((m) => m.ASK_PLAYER);

/** `text` in pieces of about `size` characters, each but the last ending at a space or a line break. */
export function chunks(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const gap = text.slice(end).search(/\s/);
      end = gap < 0 ? text.length : end + gap + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

interface Job {
  runId: string;
  sessionId: string;
  binding: Binding;
  question: { id: string; text: string } | null;
  catchUp: { final: boolean } | null;
  model: CompanionModel;
  /** held: behind another run of its session (its question not in the thread yet); running: started. */
  state: 'held' | 'running';
  timers: Cancel[];
  /** What it streamed so far: a Stop keeps it. */
  text: string;
  /** When it read the chat (it started): its item's time, so edits during the run make it stale. */
  readAt: number;
  /** Its outcome landed, or New Thread dropped it: nothing more of it, and its `ended` went out. */
  over: boolean;
}

export function createCompanion(ctx: DemoContext, opts: { load?: () => Promise<AskPlayer> } = {}): AtelierApi['companion'] {
  const threads = new Map<string, Thread>();
  let jobs: Job[] = [];
  let player: Promise<AskPlayer> | null = null;
  // Once per visit; a load that failed is tried again by the next run.
  const load = () => (player ??= (opts.load ?? loadAskPlayer)().catch((e: unknown) => { player = null; throw e; }));

  const emit = (e: CompanionEvent) => ctx.events.emit('companion', e);
  const save = (t: Thread) => { threads.set(t.sessionId, t); emit({ sessionId: t.sessionId, kind: 'thread', thread: t }); };
  const current = (sessionId: string) => threads.get(sessionId) ?? newThread(sessionId, newId(), ctx.now());
  const questionItem = (j: Job): ThreadItem => ({ kind: 'question', id: j.question!.id, at: ctx.now(), text: j.question!.text });
  const errorItem = (j: Job, reason: CompanionErrorKind, message: string): ThreadItem => ({ kind: 'error', id: newId(), at: ctx.now(), questionId: j.question?.id ?? null, reason, message });

  /**
   * What the demo knows of the session now: the terminal's own session (if it still runs that conversation), the files,
   * the visitor's prompts and how their turns ended, how its scripted turn ended. After `/clear` it is a new
   * conversation: nothing scripted from before it.
   */
  function factsOf(b: Binding): AskFacts {
    const term = ctx.state.terminals.find((t) => t.id === b.terminalId);
    const s = term?.session?.sessionId === b.sessionId ? term.session : null;
    const cleared = ctx.state.cleared.has(b.terminalId);
    return {
      scenario: cleared ? null : ctx.world.sessions.find((x) => x.terminal.session?.sessionId === b.sessionId)?.scenario ?? null,
      state: s?.state ?? null, activity: s?.activity ?? null, files: ctx.state.files, prompts: ctx.state.prompts.get(b.terminalId) ?? [],
      scripted: cleared ? null : ctx.state.scripted.get(b.terminalId) ?? null,
      lastMessageAt: s?.lastMessageAt ?? null, now: ctx.now()
    };
  }

  function job(b: Binding, o: Pick<Job, 'question' | 'catchUp' | 'model'>): Job {
    return { runId: newId(), sessionId: b.sessionId, binding: b, ...o, state: 'held', timers: [], text: '', readAt: 0, over: false };
  }

  /** At the head of its session: it starts now; behind another run: it waits, and says so. */
  function enqueue(j: Job, head: boolean): { runId: string } {
    jobs.push(j);
    if (head) start(j);
    else emit({ sessionId: j.sessionId, kind: 'queued', runId: j.runId, questionId: j.question?.id ?? null });
    return { runId: j.runId };
  }

  function start(j: Job): void {
    j.state = 'running';
    j.readAt = ctx.now();
    emit({ sessionId: j.sessionId, kind: 'started', runId: j.runId, questionId: j.question?.id ?? null });
    // Stopped or dropped while the chunk was on its way: nothing of it plays once it arrives.
    load().then((p) => { if (!j.over) play(j, p); }, () => { if (!j.over) finish(j, [errorItem(j, 'exit', LOAD_FAILED)]); });
  }

  /** The run on the clock: its trace, then its card, or its text in chunks and the answer. */
  function play(j: Job, { script, catchUpFor, answerFor }: AskPlayer): void {
    const later = (ms: number, fn: () => void) => { j.timers.push(ctx.clock.after(ms, fn)); };
    /** The trace lines on the clock; when the last one shows. */
    const trace = (lines: readonly string[]): number => {
      lines.forEach((line, i) => later(TRACE_FIRST_MS + i * TRACE_MS, () => emit({ sessionId: j.sessionId, kind: 'trace', runId: j.runId, line })));
      return TRACE_FIRST_MS + (lines.length - 1) * TRACE_MS;
    };
    const f = factsOf(j.binding);
    if (j.catchUp) {
      const { final } = j.catchUp;
      const c = catchUpFor(script, f, final);
      later(trace(c.trace) + CARD_AFTER_MS, () => finish(j, [{ kind: 'catchup', id: newId(), at: j.readAt, data: c.data, read: c.read, model: j.model, final }]));
      return;
    }
    const a = answerFor(script, f, j.question!.text);
    const read = trace(a.trace);
    const parts = chunks(a.md);
    const answer = () => finish(j, [{ kind: 'answer', id: newId(), at: j.readAt, questionId: j.question!.id, markdown: a.md, read: a.read, model: j.model, costUsd: COST[j.model] }], COST[j.model]);
    // No text, no chunk: the answer still lands, where its first words would have come.
    if (parts.length === 0) { later(read + TEXT_AFTER_MS, answer); return; }
    parts.forEach((part, i) => later(read + TEXT_AFTER_MS + i * CHUNK_MS, () => {
      j.text += part;
      emit({ sessionId: j.sessionId, kind: 'delta', runId: j.runId, text: part });
      if (i === parts.length - 1) answer();
    }));
  }

  /** The run's outcome lands (unseen), then its end; then its session's next run takes its turn. */
  function finish(j: Job, items: ThreadItem[], cost = 0): void {
    if (j.over) return;
    drop(j);
    const t = appendItems(current(j.sessionId), items, ctx.now());
    const landed = items.some((i) => i.kind === 'answer' || i.kind === 'catchup');
    save({
      ...t, unseen: true, costUsd: t.costUsd + cost, ...(landed ? { started: true } : {}),
      lastCatchUpAt: items.find((i) => i.kind === 'catchup')?.at ?? t.lastCatchUpAt
    });
    emit({ sessionId: j.sessionId, kind: 'ended', runId: j.runId });
    const next = jobs.find((x) => x.sessionId === j.sessionId);
    if (next?.state !== 'held') return;
    if (next.question) save(appendItems(current(next.sessionId), [questionItem(next)], ctx.now()));
    start(next);
  }

  /** Out of the queue, its timers cancelled: nothing more of it plays. */
  function drop(j: Job): void {
    j.over = true;
    for (const cancel of j.timers) cancel();
    j.timers = [];
    jobs = jobs.filter((x) => x !== j);
  }

  return {
    thread: (sessionId) => resolved(threads.get(sessionId) ?? null),

    ask(o) {
      const b = o.binding;
      if (!o.text.trim()) return resolved({ error: 'Empty question' });
      let t = current(b.sessionId);
      if (o.model) t = { ...t, model: o.model };
      if (o.account) t = { ...t, account: o.account };
      const j = job(b, { question: { id: newId(), text: o.text }, catchUp: null, model: t.model ?? ctx.state.settings.askModel });
      // A question behind another run joins the thread only when its turn comes (main's order: q1, a1, q2, a2).
      const head = !jobs.some((x) => x.sessionId === b.sessionId);
      if (head) t = appendItems(t, [questionItem(j)], ctx.now());
      save(t);
      return resolved(enqueue(j, head));
    },

    catchUp(o) {
      const b = o.binding;
      let t = current(b.sessionId);
      if ((o.model && o.model !== t.model) || (o.account && o.account !== t.account)) {
        t = { ...t, ...(o.model ? { model: o.model } : {}), ...(o.account ? { account: o.account } : {}) };
        save(t);
      }
      // One already on its way answers for this one; a final one (the session ended) makes a waiting one final.
      const pending = jobs.findLast((x) => x.sessionId === b.sessionId && x.catchUp !== null);
      if (pending?.catchUp && (pending.catchUp.final || !o.final)) return resolved({ runId: pending.runId });
      if (pending?.catchUp && pending.state !== 'running') { pending.catchUp = { final: true }; return resolved({ runId: pending.runId }); }
      const head = !jobs.some((x) => x.sessionId === b.sessionId);
      return resolved(enqueue(job(b, { question: null, catchUp: { final: o.final }, model: t.model ?? ctx.state.settings.askModel }), head));
    },

    /** The session's current run ends: what it streamed stays, marked stopped; else a Stopped item. */
    stop(sessionId) {
      const j = jobs.find((x) => x.sessionId === sessionId);
      if (!j) return noop();
      const stopped = errorItem(j, 'stopped', 'Stopped');
      if (j.state === 'held') finish(j, j.question ? [questionItem(j), stopped] : [stopped]);
      else if (j.question && j.text.trim()) finish(j, [{ kind: 'answer', id: newId(), at: j.readAt, questionId: j.question.id, markdown: j.text, read: [], model: j.model, costUsd: null, stopped: true }]);
      else finish(j, [stopped]);
      return noop();
    },

    /** Empty, under a new conversation id, its model and account kept; its runs dropped, each still ending once. */
    newThread(sessionId) {
      const dropped = jobs.filter((x) => x.sessionId === sessionId);
      for (const j of dropped) drop(j);
      const old = threads.get(sessionId);
      const t: Thread = { ...newThread(sessionId, newId(), ctx.now()), model: old?.model ?? null, account: old?.account ?? null };
      save(t);
      for (const j of dropped) emit({ sessionId, kind: 'ended', runId: j.runId });
      return resolved(t);
    },

    seen(sessionId) {
      const t = threads.get(sessionId);
      if (t?.unseen) save({ ...t, unseen: false });
      return noop();
    }
  };
}

// Ask companion: main's side of the panel. A question or a Catch me
// up becomes a run: it waits behind its session's own run and the app-wide limit, the session's chat and Atelier's facts
// are written for it, the isolated `claude -p` runs through the runner, and its outcome lands in the thread. thread.json
// is the truth: every change loads it, changes it and saves it in one synchronous step, so two windows never race.
import { realpathSync } from 'node:fs';
import { companionArgs, companionRoot } from '@shared/companion/args';
import { CATCHUP_SCHEMA, parseCatchUp } from '@shared/companion/catchup';
import { renderChat, type ChatCursor } from '@shared/companion/chat';
import { renderFacts } from '@shared/companion/facts';
import type { LiveFacts } from '@shared/companion/live';
import { rulesText } from '@shared/companion/rules';
import { traceLine, type StreamItem } from '@shared/companion/stream';
import { cutEnd } from '@shared/companion/text';
import { appendItems, expired, newThread, quitError, RETENTION_MS, settleOrphans, THREADS_KEPT } from '@shared/companion/thread';
import type { Binding, CompanionErrorKind, CompanionEvent, CompanionModel, Thread, ThreadItem } from '@shared/companion/types';
import { SESSION_ID } from '@shared/history';
import { currentPlatform } from '@shared/platform';
import type { Settings } from '@shared/settings';
import { sessionTranscript } from '../claude-history';
import { toOut } from '../cpath';
import { readChat } from './digest';
import { COMPANION_TIMEOUT_MS, type RunOutcome, type runCompanion } from './run';
import type { CompanionStore } from './store';

/** Runs at once in the whole app; more wait their turn, first come first served. */
export const MAX_RUNS = 3;

/** An answer's Markdown kept in the thread, at most (characters): a runaway answer never bloats thread.json. */
export const ANSWER_MAX = 256 * 1024;

export interface CompanionDeps {
  store: CompanionStore;
  claudeBin(): string | null;
  settings(): Settings;
  /** The config dir to run with: 'session' → the session's own; an id no longer configured → the session's own too. */
  accountDir(choice: string, sessionConfigDir: string | null): string | null;
  projectRoot(terminalId: string): string | null;
  /** Atelier's facts for facts.md; `model` (the session's own model, when known) goes into rules.md. */
  facts(b: Binding): { facts: LiveFacts; waiting: string | null; files: { rel: string; at: number }[]; costUsd: number | null; branch: string | null; model?: string | null };
  /** Session ids live in a terminal or kept under Resume: their threads are never swept by age. */
  live(): ReadonlySet<string>;
  /** Session ids open in a terminal (or being resumed), Resume's left out: never taken by the thread cap. */
  open(): ReadonlySet<string>;
  run: typeof runCompanion;
  now(): number;
  uuid(): string;
}

export const CHAT_UNREADABLE = "Couldn't read this session's chat: answers come from the code only";
const CHAT_PLACEHOLDER = "# Session chat\n\nThe session's chat couldn't be read. Answer from the code and facts.md only, and say so when it matters.\n";
const NOTHING_ASKED = 'Nothing asked yet';
/** No transcript file yet: the session has no conversation yet, which is not an unreadable chat. */
const NO_CHAT = (): ChatCursor => ({ offset: 0, size: 0, partial: '', state: { prompts: 0, tools: {} }, entries: [] });

/** A Catch me up asks for the catch-up only: another request in the same run ends up inside `points`. */
function catchUpPrompt(final: boolean): string {
  return [
    'Catch me up on this session. Reply only with the catch-up the JSON schema describes; nothing else is asked in this turn.',
    "- points: the user's requests, from their numbered prompts (YOU) in chat.md, in order. A numbered list in a prompt gives one point per item; a later prompt that adds something adds a point. n is the point's number, status is done, in_progress, not_started or unclear, at is the local time (HH:MM, 24 h) it was done or null, note is one short line when it helps or null.",
    '- where: where the session is now, in two or three plain sentences.',
    '- choices: up to three decisions the session took on its own that the user may not expect (a value it fixed, something it kept or skipped).',
    final
      ? '- leftOpen: the session has ended: what it left open or unfinished, in a sentence or two (null when nothing).'
      : '- leftOpen: null.',
    "Use facts.md for Atelier's exact facts; read the code only to check a status."
  ].join('\n');
}

type Item<K extends ThreadItem['kind']> = Extract<ThreadItem, { kind: K }>;

interface Job {
  runId: string;
  sessionId: string;
  binding: Binding;
  question: { id: string; text: string } | null;
  catchUp: { final: boolean } | null;
  model: CompanionModel;
  account: string;
  /** held: behind another job of its session, its question not in the thread yet; ready: its turn, waiting for a slot. */
  state: 'held' | 'ready' | 'running';
  abort: AbortController | null;
  /** New Thread or quit: whatever the run ends with is thrown away. */
  dropped: boolean;
  /** Its `ended` event went out: sent once per run. */
  over: boolean;
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim().split('\n', 1)[0]!.slice(0, 200) || 'Something went wrong';

/** A folder's real path (symlinks resolved), or the path as given when it can't be resolved. */
function realOr(p: string): string {
  try { return toOut(realpathSync(p)); } catch { return p; }
}

export class CompanionService {
  private jobs: Job[] = [];
  /** The session's transcript read so far (digest.ts): later questions read only what was appended. */
  private readonly cursors = new Map<string, { file: string; cursor: ChatCursor }>();
  private closed = false;

  constructor(private readonly deps: CompanionDeps, private readonly listener: (e: CompanionEvent) => void) {}

  /** Events are news for the windows: one that fails to arrive never breaks a save or the queue's bookkeeping. */
  private emit(e: CompanionEvent): void {
    try { this.listener(e); } catch { /* a window gone: it reloads the thread when it opens */ }
  }

  /** The saved thread; a question an earlier run of the app left unanswered ends as "Stopped when Atelier quit". */
  thread(sessionId: string): Thread | null {
    const saved = this.deps.store.load(sessionId);
    if (!saved) return null;
    const t = settleOrphans(saved, this.activeQuestions(sessionId), this.deps.now());
    if (t !== saved) this.save(t);
    return t;
  }

  ask(b: Binding, q: { text: string; model?: CompanionModel; account?: string }): { runId: string } | { error: string } {
    const refused = this.refuse(b);
    if (refused) return refused;
    if (!q.text.trim()) return { error: 'Empty question' };
    let t = this.current(b.sessionId);
    if (q.model) t = { ...t, model: q.model };
    if (q.account) t = { ...t, account: q.account };
    const s = this.deps.settings();
    const job = this.job(b, { question: { id: this.deps.uuid(), text: q.text }, catchUp: null, model: t.model ?? s.askModel, account: t.account ?? s.askAccount });
    // Two windows asking at once: the second question joins the thread only when its turn comes (q1, a1, q2, a2).
    const head = !this.jobs.some((j) => j.sessionId === b.sessionId);
    if (head) {
      job.state = 'ready';
      t = appendItems(t, [this.questionItem(job)], this.deps.now());
    }
    try { this.save(t); } catch { return { error: "Couldn't save the thread" }; }
    return this.enqueue(job);
  }

  catchUp(b: Binding, o: { final: boolean; model?: CompanionModel; account?: string }): { runId: string } | { error: string } {
    const refused = this.refuse(b);
    if (refused) return refused;
    // The thread's pickers stay the thread's, as a question's do.
    let t = this.current(b.sessionId);
    if ((o.model && o.model !== t.model) || (o.account && o.account !== t.account)) {
      t = { ...t, ...(o.model ? { model: o.model } : {}), ...(o.account ? { account: o.account } : {}) };
      try { this.save(t); } catch { return { error: "Couldn't save the thread" }; }
    }
    // Two windows opening Ask at once ask for the same summary: one run. A final one (the session ended) answers a
    // request that isn't, and turns a pending one final; one already running can't change, so a final one follows it.
    const pending = this.jobs.findLast((j) => j.sessionId === b.sessionId && j.catchUp !== null && !j.dropped);
    if (pending?.catchUp && (pending.catchUp.final || !o.final)) return { runId: pending.runId };
    if (pending?.catchUp && pending.state !== 'running') {
      pending.catchUp = { final: true };
      return { runId: pending.runId };
    }
    const s = this.deps.settings();
    const job = this.job(b, { question: null, catchUp: { final: o.final }, model: t.model ?? s.askModel, account: t.account ?? s.askAccount });
    if (!this.jobs.some((j) => j.sessionId === b.sessionId)) job.state = 'ready';
    return this.enqueue(job);
  }

  /**
   * Stop: the session's current run ends (what it wrote stays, marked stopped); one still waiting for a slot never runs.
   * A run New Thread dropped is already stopping: Stop acts on what was asked since.
   */
  stop(sessionId: string): void {
    const j = this.jobs.find((x) => x.sessionId === sessionId && !x.dropped);
    if (!j) return;
    if (j.state === 'running') { j.abort?.abort(); return; }
    const stopped = this.errorItem(j, 'stopped', 'Stopped');
    // A held question isn't in the thread yet: it joins it with its ending, the user's words kept.
    this.end(j, j.state === 'held' && j.question ? [this.questionItem(j), stopped] : [stopped]);
    this.finish(j);
  }

  /** Empty items, a new Ask conversation (new uuid), the thread's model and account kept; its runs are dropped. */
  newThread(sessionId: string): Thread {
    for (const j of this.jobs) {
      if (j.sessionId !== sessionId) continue;
      j.dropped = true;
      j.abort?.abort();
    }
    const dropped = this.jobs.filter((j) => j.sessionId === sessionId && j.state !== 'running');
    this.jobs = this.jobs.filter((j) => j.sessionId !== sessionId || j.state === 'running');
    const old = this.deps.store.load(sessionId);
    const t: Thread = { ...newThread(sessionId, this.deps.uuid(), this.deps.now()), model: old?.model ?? null, account: old?.account ?? null };
    try {
      this.save(t);
    } finally {
      // A running one ends when its process does (finish); the ones that never ran end now, after the empty thread
      // (even when it could not be saved: they are gone from the queue either way).
      for (const j of dropped) this.over(j);
    }
    return t;
  }

  seen(sessionId: string): void {
    const t = this.deps.store.load(sessionId);
    if (t?.unseen) this.save({ ...t, unseen: false });
  }

  /**
   * Retention: a thread goes when its conversation is neither live nor under Resume and it wasn't used for
   * 30 days. A thread file that can't be read goes only when its folder hasn't changed for 30 days either: a fresh one
   * may be a newer version's. Then, past THREADS_KEPT, the least recently used go (Resume
   * has no age limit), never one open in a terminal. A session with a run going or waiting is never touched.
   */
  sweep(): void {
    const now = this.deps.now();
    const live = this.deps.live();
    const busy = new Set(this.jobs.map((j) => j.sessionId));
    const { store } = this.deps;
    const drop = (id: string) => { store.remove(id); this.cursors.delete(id); };
    // Each thread read once per sweep (it runs on the main thread).
    const read = new Map<string, Thread | null>();
    const load = (id: string) => { if (!read.has(id)) read.set(id, store.load(id)); return read.get(id)!; };
    for (const id of store.list()) {
      if (busy.has(id) || live.has(id)) continue;
      const t = load(id);
      const changed = t ? null : store.changedAt(id);
      if (t ? expired(t, false, now) : changed !== null && now - changed > RETENTION_MS) drop(id);
    }
    const left = store.list();
    if (left.length > THREADS_KEPT) {
      const open = this.deps.open();
      // When it was last used; an unreadable thread by when its folder last changed.
      const usedAt = (id: string) => load(id)?.lastUsedAt ?? store.changedAt(id) ?? 0;
      const oldest = left.filter((id) => !busy.has(id) && !open.has(id)).map((id) => ({ id, at: usedAt(id) })).sort((a, b) => a.at - b.at);
      for (const { id } of oldest.slice(0, left.length - THREADS_KEPT)) drop(id);
    }
    // Cached transcripts of sessions gone from the app are read again from the start if ever needed.
    for (const id of [...this.cursors.keys()]) if (!live.has(id) && !busy.has(id)) this.cursors.delete(id);
  }

  /**
   * App quit: every question still in flight ends as "Stopped when Atelier quit", saved now (quit doesn't wait for the
   * runs), then the runs are stopped; what they end with is thrown away and nothing new starts.
   */
  stopAll(): void {
    this.closed = true;
    const now = this.deps.now();
    const sessions = [...new Set(this.jobs.map((j) => j.sessionId))];
    for (const sessionId of sessions) {
      const jobs = this.jobs.filter((j) => j.sessionId === sessionId && !j.dropped);
      if (jobs.length === 0) continue;
      try {
        const saved = this.deps.store.load(sessionId) ?? newThread(sessionId, this.deps.uuid(), now);
        // The admitted question (running or waiting for a slot) is in the thread: settled like an orphan. Held ones join
        // it each followed by its own ending, so nothing interleaves.
        let t = settleOrphans(saved, new Set(), now);
        const held: ThreadItem[] = [];
        for (const j of jobs) if (j.state === 'held' && j.question) held.push(this.questionItem(j), quitError(j.question.id, now));
        if (held.length) t = appendItems(t, held, now);
        if (t !== saved) this.save(t);
      } catch { /* quitting: the next start settles what is left */ }
    }
    for (const j of this.jobs) {
      j.dropped = true;
      j.abort?.abort();
    }
    const dropped = this.jobs.filter((j) => j.state !== 'running');
    this.jobs = this.jobs.filter((j) => j.state === 'running');
    for (const j of dropped) this.over(j);
  }

  /** The run's explicit end for the windows (once): sent after the thread event that closes it. */
  private over(j: Job): void {
    if (j.over) return;
    j.over = true;
    this.emit({ sessionId: j.sessionId, kind: 'ended', runId: j.runId });
  }

  // --- queue -------------------------------------------------------------------------------------------------------

  private refuse(b: Binding): { error: string } | null {
    if (this.closed) return { error: 'Atelier is quitting' };
    if (!SESSION_ID.test(b.sessionId)) return { error: 'Not a Claude session' };
    return null;
  }

  private job(b: Binding, o: Pick<Job, 'question' | 'catchUp' | 'model' | 'account'>): Job {
    return { runId: this.deps.uuid(), sessionId: b.sessionId, binding: b, ...o, state: 'held', abort: null, dropped: false, over: false };
  }

  private enqueue(job: Job): { runId: string } {
    this.jobs.push(job);
    this.pump();
    if (job.state !== 'running') this.emit({ sessionId: job.sessionId, kind: 'queued', runId: job.runId, questionId: job.question?.id ?? null });
    return { runId: job.runId };
  }

  /** Starts, first come first served, every job whose turn has come while a slot is free. */
  private pump(): void {
    for (const j of this.jobs) {
      if (this.jobs.filter((x) => x.state === 'running').length >= MAX_RUNS) return;
      if (j.state === 'ready') this.start(j);
    }
  }

  private start(j: Job): void {
    j.state = 'running';
    j.abort = new AbortController();
    this.emit({ sessionId: j.sessionId, kind: 'started', runId: j.runId, questionId: j.question?.id ?? null });
    void this.execute(j)
      .catch((e: unknown) => { try { this.end(j, [this.errorItem(j, 'exit', firstLine(e))]); } catch { /* nothing more to tell */ } })
      .finally(() => this.finish(j));
  }

  /** A job is over: the next one of its session takes its turn (its question joins the thread), then any free slot. */
  private finish(j: Job): void {
    this.jobs = this.jobs.filter((x) => x !== j);
    this.over(j);
    if (this.closed) return;
    const next = this.jobs.find((x) => x.sessionId === j.sessionId);
    if (next?.state === 'held') {
      next.state = 'ready';
      if (next.question) {
        try {
          const now = this.deps.now();
          this.save(appendItems(this.current(next.sessionId), [this.questionItem(next)], now));
        } catch { /* its outcome lands all the same */ }
      }
    }
    this.pump();
  }

  // --- a run -------------------------------------------------------------------------------------------------------

  private async execute(j: Job): Promise<void> {
    const { deps } = this;
    const b = j.binding;
    const projectRoot = deps.projectRoot(b.terminalId);
    if (projectRoot === null) return this.end(j, [this.errorItem(j, 'exit', "This session's project isn't open")]);
    const claudeBin = deps.claudeBin();
    if (claudeBin === null) return this.end(j, [this.errorItem(j, 'not-found', 'Claude Code was not found')]);

    const cursor = await this.readChat(b, projectRoot);
    // What the outcome knows of the session dates from here: a file edited during the run marks it stale.
    const readAt = deps.now();
    if (j.dropped) return;
    if (j.catchUp && cursor && !cursor.entries.some((e) => e.k === 'prompt')) {
      const data = { points: [], where: NOTHING_ASKED, choices: [], leftOpen: null };
      return this.end(j, [{ kind: 'catchup', id: deps.uuid(), at: readAt, data, read: [], model: j.model, final: j.catchUp.final }]);
    }
    if (!cursor) this.noteChatUnreadable(j.sessionId);

    // The Ask conversation lives in the config dir it was started in: run on another one (the thread's account picker,
    // Settings, a removed account) and it can't be resumed there, so a fresh one starts. The items stay; chat.md and
    // facts.md carry the context.
    const runDir = deps.accountDir(j.account, b.configDir);
    const onDisk = deps.store.load(j.sessionId) !== null;
    let thread = this.current(j.sessionId);
    const moved = thread.started && thread.convDir !== runDir;
    if (moved) thread = { ...thread, claudeUuid: deps.uuid(), started: false };
    // Saved before its uuid goes into the argv (a first Catch me up has no thread yet): the outcome lands on that uuid.
    if (moved || !onDisk) this.save(thread);
    const dir = deps.store.dirOf(j.sessionId);
    const platform = currentPlatform();
    const argsFor = (t: Thread) => companionArgs({ model: j.model, projectRoot, threadDir: dir, claudeUuid: t.claudeUuid, resume: t.started, platform, ...(j.catchUp ? { schema: CATCHUP_SCHEMA } : {}) });
    // rules.md names the root exactly as --add-dir gives it (native on Windows): a model may mangle a root it rewrites.
    let root: string;
    try {
      argsFor(thread);
      root = companionRoot(projectRoot, platform);
    } catch {
      return this.end(j, [this.errorItem(j, 'exit', "Ask can't read this project's folder")]);
    }
    const settings = deps.settings();
    const f = deps.facts(b);
    try {
      deps.store.writeInputs(j.sessionId, {
        rules: rulesText({ title: b.title, project: root, answers: settings.askAnswers, known: settings.askKnown, sessionModel: f.model ?? null }),
        chat: cursor ? renderChat(cursor.entries) : CHAT_PLACEHOLDER,
        facts: renderFacts({ title: b.title, facts: f.facts, waiting: f.waiting, files: f.files, costUsd: f.costUsd, branch: f.branch, now: deps.now() })
      });
    } catch {
      return this.end(j, [this.errorItem(j, 'exit', "Couldn't write Ask's files")]);
    }

    // Claude reports paths by their real spelling (its cwd, the thread folder, through a symlinked home: /var is
    // /private/var), the project often as it was given: both spellings name the same roots.
    const roots = { project: projectRoot, thread: dir };
    const real = { project: realOr(projectRoot), thread: realOr(dir) };
    const sameRoots = real.project === roots.project && real.thread === roots.thread;
    let text = '';
    const attempt = async (t: Thread): Promise<{ outcome: RunOutcome; began: boolean }> => {
      let began = false;
      const onItem = (item: StreamItem) => {
        if (j.dropped) return;
        if (item.t === 'init') {
          if (!began) this.markStarted(j, t.claudeUuid, runDir);
          began = true;
        } else if (item.t === 'delta') {
          text += item.text;
          this.emit({ sessionId: j.sessionId, kind: 'delta', runId: j.runId, text: item.text });
        } else if (item.t === 'tool') {
          const line = traceLine(item, roots) ?? (sameRoots ? null : traceLine(item, real));
          if (line !== null) this.emit({ sessionId: j.sessionId, kind: 'trace', runId: j.runId, line });
        }
      };
      const outcome = await deps.run({
        claudeBin, args: argsFor(t), cwd: dir, projectRoot, ...(runDir !== null ? { configDir: runDir } : {}),
        input: j.catchUp ? catchUpPrompt(j.catchUp.final) : j.question!.text,
        onItem, signal: j.abort!.signal, timeoutMs: COMPANION_TIMEOUT_MS[j.catchUp ? 'catchup' : 'question'][j.model]
      });
      return { outcome, began };
    };
    let { outcome, began } = await attempt(thread);
    // Claude exited with an error before starting (no init): a resume of a conversation it no longer has (its
    // cleanupPeriodDays) or a session id it refuses. Once more, at once, as a fresh conversation; never a third time.
    if (!j.dropped && !outcome.ok && outcome.kind === 'exit' && !began) {
      thread = { ...this.current(j.sessionId), claudeUuid: deps.uuid(), started: false };
      this.save(thread);
      ({ outcome, began } = await attempt(thread));
    }
    if (j.dropped) return;
    // Claude saves the conversation once it started (init): later runs resume it, even after this one failed.
    this.end(j, [this.outcomeItem(j, outcome, text, readAt)], { started: outcome.ok || began, convDir: runDir, costUsd: outcome.ok ? outcome.costUsd : null });
  }

  /** Claude started the conversation (init): saved at once, so a quit or a crash before the outcome still resumes it. */
  private markStarted(j: Job, uuid: string, convDir: string | null): void {
    try {
      const t = this.current(j.sessionId);
      if (t.claudeUuid === uuid && (!t.started || t.convDir !== convDir)) this.save({ ...t, started: true, convDir });
    } catch { /* the outcome saves it too */ }
  }

  /**
   * The run's item. An answer or a catch-up is dated `readAt`, when the chat was read (the stale rule counts edits from
   * there); errors when they happen. An answer's Markdown is capped (ANSWER_MAX).
   */
  private outcomeItem(j: Job, o: RunOutcome, streamed: string, readAt: number): ThreadItem {
    const id = this.deps.uuid();
    if (o.ok) {
      if (j.catchUp) {
        const data = parseCatchUp(o.structured);
        if (!data) return this.errorItem(j, 'invalid-catchup', "Couldn't put the summary together");
        return { kind: 'catchup', id, at: readAt, data, read: o.read, model: j.model, final: j.catchUp.final };
      }
      return { kind: 'answer', id, at: readAt, questionId: j.question!.id, markdown: cutEnd(o.text, ANSWER_MAX), read: o.read, model: j.model, costUsd: o.costUsd };
    }
    if (o.kind === 'stopped') {
      if (j.question && streamed.trim()) return { kind: 'answer', id, at: readAt, questionId: j.question.id, markdown: cutEnd(streamed, ANSWER_MAX), read: [], model: j.model, costUsd: null, stopped: true };
      return this.errorItem(j, 'stopped', 'Stopped');
    }
    const e = this.errorItem(j, o.kind, o.message);
    if (o.kind !== 'limit') return e;
    // Which account hit it: the item names that one, whatever the thread's account is later.
    return { ...e, ...(o.resetsAt !== undefined ? { resetsAt: o.resetsAt } : {}), ...(o.window ? { window: o.window } : {}), account: j.account };
  }

  /** The run's outcome lands: unseen until looked at, the thread's cost and conversation state updated. */
  private end(j: Job, items: ThreadItem[], o: { started?: boolean; convDir?: string | null; costUsd?: number | null } = {}): void {
    if (j.dropped) return;
    const now = this.deps.now();
    const t = appendItems(this.current(j.sessionId), items, now);
    this.save({
      ...t,
      unseen: true,
      ...(o.started ? { started: true, convDir: o.convDir ?? null } : {}),
      costUsd: t.costUsd + (o.costUsd ?? 0),
      // As of the chat it read: activity during the run counts as "moved since" for the next open.
      lastCatchUpAt: items.find((i) => i.kind === 'catchup')?.at ?? t.lastCatchUpAt
    });
  }

  /** Once per thread: the chat couldn't be read, so answers come from the code only. */
  private noteChatUnreadable(sessionId: string): void {
    const t = this.current(sessionId);
    if (t.items.some((i) => i.kind === 'error' && i.reason === 'chat-unreadable')) return;
    const now = this.deps.now();
    this.save(appendItems(t, [{ kind: 'error', id: this.deps.uuid(), at: now, questionId: null, reason: 'chat-unreadable', message: CHAT_UNREADABLE }], now));
  }

  /**
   * The transcript from where the last read stopped: where it is now (sessionTranscript: Claude Code moves it into the
   * worktree a session enters, the binding's cwd stays the start folder). No file yet is an empty chat (nothing asked
   * yet); null when it can't be read (a folder or a symlink in its place, no path for the binding).
   */
  private async readChat(b: Binding, projectRoot: string): Promise<ChatCursor | null> {
    const file = sessionTranscript(b, [projectRoot, b.cwd]);
    if (file === null) return null;
    const last = this.cursors.get(b.sessionId);
    try {
      const cursor = await readChat(file, last?.file === file ? last.cursor : null, projectRoot);
      this.cursors.set(b.sessionId, { file, cursor });
      return cursor;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      this.cursors.delete(b.sessionId);
      return NO_CHAT();
    }
  }

  // --- threads -----------------------------------------------------------------------------------------------------

  /** The saved thread (a new one when none or unreadable), orphans settled: ready to change and save. */
  private current(sessionId: string): Thread {
    const now = this.deps.now();
    const t = this.deps.store.load(sessionId) ?? newThread(sessionId, this.deps.uuid(), now);
    return settleOrphans(t, this.activeQuestions(sessionId), now);
  }

  private activeQuestions(sessionId: string): Set<string> {
    return new Set(this.jobs.filter((j) => j.sessionId === sessionId && j.question).map((j) => j.question!.id));
  }

  private questionItem(j: Job): Item<'question'> {
    return { kind: 'question', id: j.question!.id, at: this.deps.now(), text: j.question!.text };
  }

  private errorItem(j: Job, reason: CompanionErrorKind, message: string): Item<'error'> {
    return { kind: 'error', id: this.deps.uuid(), at: this.deps.now(), questionId: j.question?.id ?? null, reason, message };
  }

  private save(t: Thread): void {
    this.deps.store.save(t);
    this.emit({ sessionId: t.sessionId, kind: 'thread', thread: t });
  }
}

// Output triggers in the window: new output of every mounted terminal is split into lines here (cheap,
// ANSI stripped), batched, and matched in a worker; a watchdog stops a worker stuck on a pathological regex and pauses
// that rule. Never fed the attach snapshot: registry.ts only passes live data.
import { LineSplitter, TriggerRepeats, TriggerThrottle, type TerminalKind, type TriggerHit, type TriggerRule } from '@shared/triggers';
import type { BatchEntry, TriggerWorkerOut } from './triggers.worker-core';

/** New lines wait this long to go out together (a burst of output is one batch). */
export const BATCH_MS = 120;
/** A batch not done after this long: the worker is stuck, it is replaced and the running rule paused. */
export const WATCHDOG_MS = 1000;
/** Per terminal and batch, only the newest lines are matched (a flood like `seq 1 1000000` is skipped over). */
export const MAX_QUEUED_LINES = 400;
/** A worker that fails to load or start: the next try waits this long, doubling up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 15_000;
export const RETRY_MAX_MS = 5 * 60_000;

export interface TriggerWorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  /** A module worker that fails to load says so here (an ErrorEvent), never by throwing. */
  onerror?: ((e: { message?: string }) => void) | null;
  postMessage(m: unknown): void;
  terminate(): void;
}

export interface TriggerEngineDeps {
  makeWorker: () => TriggerWorkerLike;
  /** A Claude session or a plain terminal; null: not a terminal of this window (its lines are dropped). */
  kindOf: (termId: string) => TerminalKind | null;
  onNotify: (termId: string, rule: TriggerRule, line: string) => void;
  /** Texts matched by highlight rules in a terminal's new output. */
  onHighlight: (termId: string, texts: string[]) => void;
  /** A rule stopped the worker: it is paused until the app restarts or the rule is edited. */
  onSlow: (rule: TriggerRule) => void;
  /** Whether the terminal shows its alternate screen now: the starting point of a terminal's stream. */
  altScreen?: (termId: string) => boolean;
  /** The matcher could not start (worker failed to load): said once until it works again. */
  onBroken: (reason: string) => void;
  now?: () => number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

const ruleKey = (r: TriggerRule) => `${r.id}\u0000${r.pattern}`;

export class TriggerEngine {
  private rules: TriggerRule[] = [];
  private active: TriggerRule[] = [];
  /** Rules (id + pattern: editing one gives it another chance) that stopped a worker. */
  private paused = new Set<string>();
  private splitters = new Map<string, LineSplitter>();
  private queue = new Map<string, { text: string; alt: boolean }[]>();
  private worker: TriggerWorkerLike | null = null;
  private timer: unknown = null;
  private inflight: { seq: number; running: string | null; watchdog: unknown } | null = null;
  private seq = 0;
  private throttle = new TriggerThrottle();
  private repeats = new TriggerRepeats();
  /** Consecutive worker failures and when the next try may start (back-off); `told`: the user knows. */
  private failures = 0;
  private retryAt = 0;
  private told = false;
  private readonly now: () => number;
  private readonly timers: NonNullable<TriggerEngineDeps['timers']>;

  constructor(private readonly deps: TriggerEngineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  setRules(rules: readonly TriggerRule[]): void {
    this.rules = rules.map((r) => ({ ...r }));
    this.refresh();
  }

  private refresh(): void {
    this.active = this.rules.filter((r) => r.enabled && !this.paused.has(ruleKey(r)));
    this.worker?.postMessage({ rules: this.active });
    if (this.active.length === 0) { this.queue.clear(); this.splitters.clear(); }
  }

  /** New output of a terminal (never the attach snapshot). */
  data(termId: string, chunk: string): void {
    if (this.active.length === 0) return;
    let sp = this.splitters.get(termId);
    if (!sp) { sp = new LineSplitter(this.deps.altScreen?.(termId) ?? false); this.splitters.set(termId, sp); }
    const lines = sp.feedTagged(chunk);
    if (lines.length === 0) return;
    const q = this.queue.get(termId) ?? [];
    for (const l of lines.length > MAX_QUEUED_LINES ? lines.slice(-MAX_QUEUED_LINES) : lines) q.push(l);
    if (q.length > MAX_QUEUED_LINES) q.splice(0, q.length - MAX_QUEUED_LINES);
    this.queue.set(termId, q);
    this.schedule();
  }

  /**
   * The terminal's screen was replaced by a snapshot (attach, reconnection): its partial line is not new output, and
   * the snapshot is only read for the screen it leaves active (never matched).
   */
  snapshot(termId: string, snapshot = ''): void {
    let sp = this.splitters.get(termId);
    if (!sp && snapshot) { sp = new LineSplitter(); this.splitters.set(termId, sp); }
    sp?.reset(snapshot);
  }

  dispose(termId: string): void { this.splitters.delete(termId); this.queue.delete(termId); }

  private schedule(): void {
    if (this.timer !== null || this.inflight) return;
    this.timer = this.timers.set(() => { this.timer = null; this.flush(); }, BATCH_MS);
  }

  private flush(): void {
    if (this.inflight) return;
    const batch: BatchEntry[] = [];
    for (const [termId, lines] of this.queue) {
      const kind = this.deps.kindOf(termId);
      if (kind) batch.push({ termId, kind, lines: lines.map((l) => l.text), alt: lines.map((l) => l.alt) });
    }
    this.queue.clear();
    if (batch.length === 0 || this.active.length === 0) return;
    // A worker that failed to start is not recreated before its back-off: those lines are skipped.
    if (!this.worker && this.now() < this.retryAt) return;
    const w = this.ensureWorker();
    if (!w) return;
    const seq = ++this.seq;
    this.inflight = { seq, running: null, watchdog: this.timers.set(() => this.stuck(seq), WATCHDOG_MS) };
    w.postMessage({ batch, seq });
  }

  private ensureWorker(): TriggerWorkerLike | null {
    if (this.worker) return this.worker;
    let w: TriggerWorkerLike;
    try { w = this.deps.makeWorker(); } catch (err) { this.broken((err as Error)?.message ?? String(err)); return null; }
    w.onmessage = (e) => this.onMessage(w, e.data as TriggerWorkerOut);
    w.onerror = (e) => { if (w === this.worker) this.broken(e?.message || 'the matcher stopped'); };
    w.postMessage({ rules: this.active });
    this.worker = w;
    return w;
  }

  /** The worker failed to load or start: dropped, retried after a back-off; the user is told once. */
  private broken(reason: string): void {
    if (this.inflight) { this.timers.clear(this.inflight.watchdog); this.inflight = null; }
    this.worker?.terminate();
    this.worker = null;
    this.failures++;
    this.retryAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (this.failures - 1));
    this.queue.clear();
    if (!this.told) { this.told = true; this.deps.onBroken(reason.slice(0, 200)); }
  }

  private onMessage(w: TriggerWorkerLike, m: TriggerWorkerOut): void {
    if (w !== this.worker || !this.inflight) return;
    if ('rule' in m) { this.inflight.running = m.rule; return; }
    if (m.done !== this.inflight.seq) return;
    this.timers.clear(this.inflight.watchdog);
    this.inflight = null;
    // It works (again): a later failure is news.
    this.failures = 0; this.told = false;
    this.dispatch(m.hits);
    if (this.queue.size) this.schedule();
  }

  private stuck(seq: number): void {
    if (!this.inflight || this.inflight.seq !== seq) return;
    const running = this.inflight.running;
    // No rule ever started: the worker itself never came up (failed to load), no rule is to blame.
    if (running === null) { this.broken('the matcher did not start'); return; }
    this.inflight = null;
    this.worker?.terminate();
    this.worker = null;
    const r = this.rules.find((x) => x.id === running);
    if (r) { this.paused.add(ruleKey(r)); this.refresh(); this.deps.onSlow(r); }
    if (this.queue.size) this.schedule();
  }

  private dispatch(hits: (TriggerHit & { termId: string })[]): void {
    const now = this.now();
    const marks = new Map<string, string[]>();
    for (const h of hits) {
      const r = this.active.find((x) => x.id === h.ruleId);
      if (!r) continue;
      if (r.action === 'notify') {
        // The same line again (a TUI redraws its screen) is not news; then at most one per rule and terminal per 30 s.
        if (!this.repeats.seenRecently(h.termId, r.id, h.line, now) && this.throttle.allow(h.termId, r.id, now)) {
          this.repeats.record(h.termId, r.id, h.line, now);
          this.deps.onNotify(h.termId, r, h.line);
        }
        continue;
      }
      const list = marks.get(h.termId) ?? [];
      list.push(...h.texts);
      marks.set(h.termId, list);
    }
    for (const [termId, texts] of marks) this.deps.onHighlight(termId, texts);
  }
}

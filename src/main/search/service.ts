// Find in Files for one window: the files are listed here in main, searched in a worker thread, and the search's
// events passed on. One search at a time. A worker that stops answering (a regular expression stuck on one line) is
// terminated, and the next search gets a fresh one.
import { SEARCH_LIMITS, type SearchEvent, type SearchRequest } from '@shared/search';
import type { ListedFile } from './list';
import { SHARED_FILE, SHARED_STOP, sharedSlots, type RunInput, type WorkerIn, type WorkerMsg } from './run';

/** The part of a worker thread the service uses (tests give it fakes). */
export interface WorkerLike {
  postMessage(m: unknown): void;
  on(ev: 'message' | 'error' | 'exit', cb: (x: unknown) => void): void;
  terminate(): Promise<number>;
}

/** What a search covers: the files in order, whether the listing stopped at its cap, the root with symlinks resolved. */
export interface SearchListing { files: ListedFile[]; capped: boolean; realRoot: string }

export interface SearchServiceDeps {
  /** A new worker (the search worker bundled next to the main process). */
  spawn: () => WorkerLike;
  /** The files a request covers (its include and exclude filters, ignored files or not). */
  list: (req: SearchRequest) => Promise<SearchListing>;
  /** Overrides of the search limits (tests). */
  limits?: Partial<RunInput['limits']>;
  /** Time a busy worker may stay silent before it is terminated. */
  watchdogMs?: number;
}

/** A busy worker silent this long is stuck: it beats several times a second while it works. */
export const WATCHDOG_MS = 5_000;
/**
 * A worker that has said nothing for this long after a stop is stuck (a live one beats several times a second): it is
 * terminated. One already silent this long when the stop is asked goes at once.
 */
export const STOP_SILENT_MS = 1_000;

const DEFAULT_LIMITS: RunInput['limits'] = {
  maxResults: SEARCH_LIMITS.maxResults,
  wholeReadBytes: SEARCH_LIMITS.wholeReadBytes,
  maxBytes: SEARCH_LIMITS.maxBytes,
  keptLineChars: SEARCH_LIMITS.keptLineChars,
};

/** Monotonic time: a wall clock that jumps (the machine waking from sleep) must not look like a silent worker. */
const clock = (): number => performance.now();

interface Run {
  /** The id the window gave the search: every event it gets carries it. */
  searchId: number;
  /** The service's own id for this run, never reused: a late message from an earlier run is never taken for this one's. */
  runId: number;
  regex: boolean;
  emit: (e: SearchEvent) => void;
  /** Set once the files are listed, when the run goes to the worker. */
  input: RunInput | null;
  /** The worker has posted something for this run: it is (or was) the one running. */
  started: boolean;
  /** Files searched, as the last batch said. */
  searched: number;
  stopAsked: boolean;
  /** Started again on a fresh worker once already: a worker that fails before reaching it twice is an error. */
  moved: boolean;
}

/** The file the worker is matching, from the slot it writes. */
function fileOf(run: Run): string | null {
  const k = run.input ? Atomics.load(run.input.shared!, SHARED_FILE) : 0;
  return k > 0 ? (run.input!.files[k - 1]?.rel ?? null) : null;
}

/** The end of a search stopped on request, with the files its last batch said were searched. */
function stoppedDone(run: Run): SearchEvent {
  return { kind: 'done', searchId: run.searchId, searched: run.searched, total: run.input?.files.length ?? 0, skipped: [], limitHit: false, fileCap: run.input?.fileCap ?? null, stopped: true };
}

function tooLong(run: Run, rel: string | null): string {
  if (!rel) return 'The search stopped: it took too long.';
  return run.regex ? `The search stopped: a regular expression took too long on ${rel}.` : `The search stopped: searching ${rel} took too long.`;
}

export class SearchService {
  private worker: WorkerLike | null = null;
  private run: Run | null = null;
  /** Runs the worker was given and has not finished: while there are any, the watchdog counts. */
  private readonly busy = new Set<number>();
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** Waiting for the worker to say anything after a stop (`askStop`). */
  private stopWait: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private disposed = false;
  /** An emit has failed once already: later failures are not logged again. */
  private warned = false;
  private readonly limits: RunInput['limits'];
  private readonly watchdogMs: number;

  constructor(private readonly deps: SearchServiceDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.watchdogMs = deps.watchdogMs ?? WATCHDOG_MS;
  }

  /** Starts a search, stopping the one before: nothing more is heard from that one. */
  start(req: SearchRequest, emit: (e: SearchEvent) => void): void {
    if (this.disposed) return;
    this.drop();
    const run: Run = { searchId: req.searchId, runId: ++this.seq, regex: req.regex, emit, input: null, started: false, searched: 0, stopAsked: false, moved: false };
    this.run = run;
    Promise.resolve()
      .then(() => this.deps.list(req))
      .then(
        (listing) => {
          if (this.run !== run) return;
          run.input = {
            searchId: run.runId,
            spec: { query: req.query, matchCase: req.matchCase, wholeWord: req.wholeWord, regex: req.regex },
            files: listing.files,
            unsaved: req.unsaved,
            fileCap: listing.capped ? listing.files.length : null,
            limits: this.limits,
            realRoot: listing.realRoot,
            shared: sharedSlots(),
          };
          this.send(run);
        },
        () => {
          if (this.run !== run) return;
          this.run = null;
          this.tell(run, { kind: 'error', searchId: run.searchId, message: "The search stopped: the project's files could not be listed.", rel: null });
        },
      )
      .catch(() => {
        // The worker could not be spawned or given the search: the next search starts from a fresh one.
        if (this.run !== run) return;
        this.run = null;
        this.dropWorker();
        this.tell(run, { kind: 'error', searchId: run.searchId, message: 'The search stopped: it could not be started.', rel: null });
      });
  }

  /** Stops the search with this id; it ends with a `done` that says it was stopped. */
  stop(searchId: number): void {
    const run = this.run;
    if (!run || run.searchId !== searchId) return;
    if (!run.input) {
      // Still listing: nothing was searched.
      this.run = null;
      this.tell(run, { kind: 'done', searchId, searched: 0, total: 0, skipped: [], limitHit: false, fileCap: null, stopped: true });
      return;
    }
    run.stopAsked = true;
    if (this.silentLong()) {
      // Silent for a while already (a regular expression stuck on a line): its answer may never come.
      this.run = null;
      this.dropWorker();
      this.tell(run, stoppedDone(run));
      return;
    }
    this.askStop(run);
  }

  /** Ends everything: the worker is terminated and nothing is emitted any more. */
  dispose(): void {
    this.disposed = true;
    this.run = null;
    this.dropWorker();
  }

  /**
   * Passes an event on. An emit that throws (a window gone mid-search, or a bug in the caller) must not break the
   * service: the next search starts as usual, and the first failure is logged so a real bug does not go unseen.
   */
  private tell(run: Run, e: SearchEvent): void {
    try {
      run.emit(e);
    } catch (err) {
      if (this.warned) return;
      this.warned = true;
      console.warn('Find in Files: a search event could not be passed on:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The current search, stopped and forgotten. A worker already silent for a while is not waited for: the next search
   * gets a fresh one rather than queueing behind a line that may never end.
   */
  private drop(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (!run.input) return;
    if (this.silentLong()) this.dropWorker();
    else this.askStop(run);
  }

  /** The worker owes an answer and has said nothing for STOP_SILENT_MS. */
  private silentLong(): boolean {
    return this.busy.size > 0 && clock() - this.lastHeard > STOP_SILENT_MS;
  }

  /**
   * Tells the worker to stop `run` (a message, and the shared slot it reads between two lines). A worker that says
   * nothing at all for STOP_SILENT_MS after that is stuck on one line: it is let go, and what was waiting for it ends
   * (a stopped search) or moves to a fresh worker (the search that replaced it).
   */
  private askStop(run: Run): void {
    Atomics.store(run.input!.shared!, SHARED_STOP, 1);
    this.post({ type: 'stop', searchId: run.runId });
    const w = this.worker;
    if (!w || this.stopWait) return;
    this.stopWait = setTimeout(() => {
      this.stopWait = null;
      this.lost(w, 'silent');
    }, STOP_SILENT_MS);
  }

  private clearStopWait(): void {
    if (this.stopWait) clearTimeout(this.stopWait);
    this.stopWait = null;
  }

  private post(m: WorkerIn): void {
    this.worker?.postMessage(m);
  }

  private send(run: Run): void {
    const w = this.worker ?? this.spawn();
    // The watchdog counts from now only if the worker was idle; a busy one still owes an answer.
    if (this.busy.size === 0) this.lastHeard = clock();
    this.busy.add(run.runId);
    w.postMessage({ type: 'start', input: run.input! } satisfies WorkerIn);
    this.arm();
  }

  private spawn(): WorkerLike {
    const w = this.deps.spawn();
    this.worker = w;
    w.on('message', (m) => { if (this.worker === w) this.heard(m as WorkerMsg); });
    w.on('error', () => this.lost(w, 'quit'));
    w.on('exit', () => this.lost(w, 'quit'));
    return w;
  }

  private heard(m: WorkerMsg): void {
    this.lastHeard = clock();
    // It speaks: not stuck, whatever it was asked to stop (the watchdog still counts for what it runs now).
    this.clearStopWait();
    if (m.kind === 'done' || m.kind === 'error') {
      this.busy.delete(m.searchId);
      if (this.busy.size === 0) this.disarm();
    }
    const run = this.run;
    if (!run || m.searchId !== run.runId) return;
    run.started = true;
    if (m.kind === 'beat') return;
    if (m.kind === 'batch') run.searched = m.searched;
    if (m.kind === 'done' || m.kind === 'error') this.run = null;
    this.tell(run, { ...m, searchId: run.searchId });
  }

  private arm(): void {
    if (this.watchdog) return;
    const check = (): void => {
      const idle = clock() - this.lastHeard;
      if (idle < this.watchdogMs) {
        this.watchdog = setTimeout(check, this.watchdogMs - idle);
        return;
      }
      this.watchdog = null;
      if (this.worker) this.lost(this.worker, 'silent');
    };
    this.watchdog = setTimeout(check, Math.max(0, this.watchdogMs - (clock() - this.lastHeard)));
  }

  private disarm(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private dropWorker(): void {
    const w = this.worker;
    this.worker = null;
    this.busy.clear();
    this.disarm();
    this.clearStopWait();
    if (w) void w.terminate().catch(() => undefined);
  }

  /** The worker went silent or quit: it is let go, and the current search ends or moves to a fresh worker. */
  private lost(w: WorkerLike, why: 'silent' | 'quit'): void {
    if (this.worker !== w) return;
    // Read before the worker goes: the file it was stuck in.
    const rel = this.run ? fileOf(this.run) : null;
    this.dropWorker();
    const run = this.run;
    // Still listing: it gets a fresh worker once its files are listed.
    if (!run?.input) return;
    if (!run.started && !run.stopAsked && !run.moved) {
      // The worker failed in a search already replaced, before reaching this one: it starts again on a fresh one.
      run.moved = true;
      this.send(run);
      return;
    }
    this.run = null;
    // Asked to stop: it ends as stopped, with what it had searched, whatever became of its worker.
    if (run.stopAsked) {
      this.tell(run, stoppedDone(run));
      return;
    }
    if (why === 'silent') this.tell(run, { kind: 'error', searchId: run.searchId, message: tooLong(run, rel), rel });
    else this.tell(run, { kind: 'error', searchId: run.searchId, message: 'The search stopped: its worker quit unexpectedly.', rel: null });
  }
}

// Find in Files for one window: the files are listed here in main, searched in a worker thread, and the search's
// events passed on. One search at a time. A worker that stops answering (a regular expression stuck on one line) is
// terminated, and the next search gets a fresh one.
import { Worker } from 'node:worker_threads';
import { SEARCH_LIMITS, type SearchEvent, type SearchRequest } from '@shared/search';
import { join } from '../cpath';
import type { ListedFile } from './list';
import type { RunInput, WorkerIn, WorkerMsg } from './run';

/** The part of a worker thread the service uses (tests give it fakes). */
export interface WorkerLike {
  postMessage(m: unknown): void;
  on(ev: 'message' | 'error' | 'exit', cb: (x: unknown) => void): void;
  terminate(): Promise<number>;
}

/** What a search covers: the files in order, whether the listing stopped at its cap, the root with symlinks resolved. */
export interface SearchListing { files: ListedFile[]; capped: boolean; realRoot: string }

export interface SearchServiceDeps {
  /** A new worker; by default the search worker bundled next to the main process. */
  spawn?: () => WorkerLike;
  /** The files a request covers (its include and exclude filters, ignored files or not). */
  list: (req: SearchRequest) => Promise<SearchListing>;
  /** Overrides of the search limits (tests). */
  limits?: Partial<RunInput['limits']>;
  /** Time a busy worker may stay silent before it is terminated. */
  watchdogMs?: number;
}

/** A busy worker silent this long is stuck: it beats several times a second while it works. */
export const WATCHDOG_MS = 5_000;

const DEFAULT_LIMITS: RunInput['limits'] = {
  maxResults: SEARCH_LIMITS.maxResults,
  wholeReadBytes: SEARCH_LIMITS.wholeReadBytes,
  maxBytes: SEARCH_LIMITS.maxBytes,
  keptLineChars: SEARCH_LIMITS.keptLineChars,
};

/** This module is bundled into out/main/index.js, so `__dirname` is out/main, next to search-worker.js. */
function spawnSearchWorker(): WorkerLike {
  return new Worker(join(__dirname, 'search-worker.js'));
}

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
  /** The file the last beat named. */
  rel: string | null;
  stopAsked: boolean;
  /** Started again on a fresh worker once already: a worker that fails before reaching it twice is an error. */
  moved: boolean;
}

function tooLong(run: Run): string {
  if (!run.rel) return 'The search stopped: it took too long.';
  return run.regex ? `The search stopped: a regular expression took too long on ${run.rel}.` : `The search stopped: searching ${run.rel} took too long.`;
}

export class SearchService {
  private worker: WorkerLike | null = null;
  private run: Run | null = null;
  /** Runs the worker was given and has not finished: while there are any, the watchdog counts. */
  private readonly busy = new Set<number>();
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private disposed = false;
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
    const run: Run = { searchId: req.searchId, runId: ++this.seq, regex: req.regex, emit, input: null, started: false, rel: null, stopAsked: false, moved: false };
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
            fileCap: listing.capped ? listing.files.length : null,
            limits: this.limits,
            realRoot: listing.realRoot,
          };
          this.send(run);
        },
        () => {
          if (this.run !== run) return;
          this.run = null;
          emit({ kind: 'error', searchId: run.searchId, message: "The search stopped: the project's files could not be listed.", rel: null });
        },
      );
  }

  /** Stops the search with this id; it ends with a `done` that says it was stopped. */
  stop(searchId: number): void {
    const run = this.run;
    if (!run || run.searchId !== searchId) return;
    if (!run.input) {
      // Still listing: nothing was searched.
      this.run = null;
      run.emit({ kind: 'done', searchId, searched: 0, total: 0, skipped: [], limitHit: false, fileCap: null, stopped: true });
      return;
    }
    run.stopAsked = true;
    this.post({ type: 'stop', searchId: run.runId });
  }

  /** Ends everything: the worker is terminated and nothing is emitted any more. */
  dispose(): void {
    this.disposed = true;
    this.run = null;
    this.dropWorker();
  }

  /** The current search, stopped and forgotten. */
  private drop(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (run.input) this.post({ type: 'stop', searchId: run.runId });
  }

  private post(m: WorkerIn): void {
    this.worker?.postMessage(m);
  }

  private send(run: Run): void {
    const w = this.worker ?? this.spawn();
    // The watchdog counts from now only if the worker was idle; a busy one still owes an answer.
    if (this.busy.size === 0) this.lastHeard = Date.now();
    this.busy.add(run.runId);
    w.postMessage({ type: 'start', input: run.input! } satisfies WorkerIn);
    this.arm();
  }

  private spawn(): WorkerLike {
    const w = (this.deps.spawn ?? spawnSearchWorker)();
    this.worker = w;
    w.on('message', (m) => { if (this.worker === w) this.heard(m as WorkerMsg); });
    w.on('error', () => this.lost(w, 'quit'));
    w.on('exit', () => this.lost(w, 'quit'));
    return w;
  }

  private heard(m: WorkerMsg): void {
    this.lastHeard = Date.now();
    if (m.kind === 'done' || m.kind === 'error') {
      this.busy.delete(m.searchId);
      if (this.busy.size === 0) this.disarm();
    }
    const run = this.run;
    if (!run || m.searchId !== run.runId) return;
    run.started = true;
    if (m.kind === 'beat') {
      run.rel = m.rel;
      return;
    }
    if (m.kind === 'done' || m.kind === 'error') this.run = null;
    run.emit({ ...m, searchId: run.searchId });
  }

  private arm(): void {
    if (this.watchdog) return;
    const check = (): void => {
      const idle = Date.now() - this.lastHeard;
      if (idle < this.watchdogMs) {
        this.watchdog = setTimeout(check, this.watchdogMs - idle);
        return;
      }
      this.watchdog = null;
      if (this.worker) this.lost(this.worker, 'silent');
    };
    this.watchdog = setTimeout(check, Math.max(0, this.watchdogMs - (Date.now() - this.lastHeard)));
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
    if (w) void w.terminate().catch(() => undefined);
  }

  /** The worker went silent or quit: it is let go, and the current search ends or moves to a fresh worker. */
  private lost(w: WorkerLike, why: 'silent' | 'quit'): void {
    if (this.worker !== w) return;
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
    if (!run.started && run.stopAsked) {
      run.emit({ kind: 'done', searchId: run.searchId, searched: 0, total: run.input.files.length, skipped: [], limitHit: false, fileCap: run.input.fileCap, stopped: true });
      return;
    }
    const message = why === 'silent' ? tooLong(run) : 'The search stopped: its worker quit unexpectedly.';
    run.emit({ kind: 'error', searchId: run.searchId, message, rel: why === 'silent' ? run.rel : null });
  }
}

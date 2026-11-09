import type { TokenSpans } from './tokens';

export const MAX_HIGHLIGHT_CHARS = 2 * 1024 * 1024;
export const MAX_HIGHLIGHT_LINES = 20000;
/** A highlight no longer wanted is stopped (worker replaced) once it has run this long, unless it finished before. */
const STOP_AFTER_MS = 300;

export interface WorkerLike { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void; terminate(): void }

/** null: the language can't be highlighted (plain text); 'dropped': a newer request or a closed editor replaced it. */
export type HighlightResult = TokenSpans | null | 'dropped';

interface Job { id: number; code: string; lang: string; key: string | null; resolve: (r: HighlightResult) => void }

/**
 * Syntax highlighting in a worker, one request at a time. Requests carry the key of their editor: a newer request
 * for the same editor (or cancel(key) when it closes) drops the older one; if that one is already running and slow,
 * the worker is stopped and replaced, so a huge stale file never delays what is on screen.
 */
export function createHighlighter(
  makeWorker: () => WorkerLike,
  now: () => number = Date.now,
  later: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms); }
) {
  let worker: WorkerLike | null = null;
  let seq = 0;
  const queue: Job[] = [];
  let running: { job: Job; startedAt: number; wanted: boolean } | null = null;

  const getWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = makeWorker();
    w.onmessage = (e: MessageEvent<{ id: number; result: TokenSpans | null }>) => {
      if (worker !== w || !running || running.job.id !== e.data.id) return;
      const { job, wanted } = running;
      running = null;
      job.resolve(wanted ? e.data.result : 'dropped');
      next();
    };
    worker = w;
    return w;
  };

  const next = () => {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = { job, startedAt: now(), wanted: true };
    try {
      getWorker().postMessage({ id: job.id, code: job.code, lang: job.lang });
    } catch {
      // A request the worker can't take (not cloneable): uncolored, and the queue doesn't stall behind it.
      running = null;
      job.resolve(null);
      next();
    }
  };

  /** Drops what an editor asked for: waiting requests at once, the running one stopped if slow. */
  const cancel = (key: string) => {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.key === key) { queue[i]!.resolve('dropped'); queue.splice(i, 1); }
    if (!running || running.job.key !== key || !running.wanted) return;
    const ran = now() - running.startedAt;
    if (ran >= STOP_AFTER_MS) { stop(); return; }
    // Quick so far: it may finish on its own; if it is still running at the deadline, it is stopped then.
    running.wanted = false;
    const id = running.job.id;
    later(() => { if (running && running.job.id === id && !running.wanted) stop(); }, STOP_AFTER_MS - ran);
  };

  /** Stops the running job (its worker is replaced) and goes on with the queue. */
  const stop = () => {
    if (!running) return;
    const { job } = running;
    running = null;
    worker?.terminate();
    worker = null;
    job.resolve('dropped');
    next();
  };

  const highlight = (code: string, lang: string, key: string | null = null): Promise<HighlightResult> => {
    if (code.length > MAX_HIGHLIGHT_CHARS || code.split('\n').length > MAX_HIGHLIGHT_LINES) return Promise.resolve(null);
    if (key !== null) cancel(key);
    return new Promise((resolve) => {
      queue.push({ id: ++seq, code, lang, key, resolve });
      next();
    });
  };

  return { highlight, cancel };
}

const shared = createHighlighter(() => new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);

/** Highlights `code`; `key` (the editor's) makes a later call for the same editor replace this one. */
export const highlight = shared.highlight;
/** The editor closed: what it asked for is no longer needed. */
export const cancelHighlight = shared.cancel;

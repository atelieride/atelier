// CSV viewer: detection, parsing and the columns' profile off the main thread, one job at a
// time. Requests carry their editor's key: a newer request replaces the one still waiting and makes the running one's
// answer 'dropped', so the table always shows the newest text.
import type { WorkerLike } from '../editor/highlighter';
import type { ColumnProfile, CsvData, CsvOptions, Detected, Resolved } from './types';

/** rows: false for the source alone (its colors and address need the options, widths and problems, not the rows). */
export interface CsvRequest { text: string; options: CsvOptions; hint: 'csv' | 'tsv'; rows: boolean }
/** partial: made without the rows (data.rows, lines and endLines empty). */
export interface CsvResult { data: CsvData; profiles: ColumnProfile[]; resolved: Resolved; detected: Detected; partial: boolean }
export interface CsvReply { id: number; result: CsvResult; ms: number }
export type CsvOutcome = { result: CsvResult; ms: number } | 'dropped';

interface Job { id: number; req: CsvRequest; key: string; resolve: (r: CsvOutcome) => void }

export function createCsvParser(makeWorker: () => WorkerLike) {
  let worker: WorkerLike | null = null;
  let seq = 0;
  const queue: Job[] = [];
  let running: { job: Job; wanted: boolean } | null = null;

  const getWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = makeWorker();
    // A worker that fails (out of memory, a bug): its job is dropped and the next one gets a new worker.
    (w as WorkerLike & { onerror: ((e: unknown) => void) | null }).onerror = () => {
      if (worker !== w) return;
      worker = null;
      w.terminate();
      const job = running?.job;
      running = null;
      job?.resolve('dropped');
      next();
    };
    w.onmessage = (e: MessageEvent<CsvReply>) => {
      if (worker !== w || !running || running.job.id !== e.data.id) return;
      const { job, wanted } = running;
      running = null;
      job.resolve(wanted ? { result: e.data.result, ms: e.data.ms } : 'dropped');
      next();
    };
    worker = w;
    return w;
  };

  const next = () => {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = { job, wanted: true };
    getWorker().postMessage({ id: job.id, ...job.req });
  };

  const cancel = (key: string) => {
    for (let k = queue.length - 1; k >= 0; k--) if (queue[k]!.key === key) queue.splice(k, 1)[0]!.resolve('dropped');
    if (running?.job.key === key) running.wanted = false;
  };

  const parse = (req: CsvRequest, key: string): Promise<CsvOutcome> => {
    cancel(key);
    return new Promise((resolve) => {
      queue.push({ id: ++seq, req, key, resolve });
      next();
    });
  };

  return { parse, cancel };
}

const shared = createCsvParser(() => new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
export const parseCsvInWorker = shared.parse;
export const cancelCsvParse = shared.cancel;

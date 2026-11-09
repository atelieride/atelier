// JSON navigation: JSON parsing off the main thread, one job at a time. Requests carry their
// editor's key: a newer request replaces the one still waiting and makes the running one's answer 'dropped', so the
// tree and the error marks always show the newest text.
import type { WorkerLike } from '../editor/highlighter';
import type { ParseResult } from './parse';

export interface ParseReply { id: number; result: ParseResult; ms: number }
export type ParseOutcome = { result: ParseResult; ms: number } | 'dropped';

interface Job { id: number; text: string; jsonc: boolean; key: string; resolve: (r: ParseOutcome) => void }

export function createJsonParser(makeWorker: () => WorkerLike) {
  let worker: WorkerLike | null = null;
  let seq = 0;
  const queue: Job[] = [];
  let running: { job: Job; wanted: boolean } | null = null;

  const getWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = makeWorker();
    w.onmessage = (e: MessageEvent<ParseReply>) => {
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
    getWorker().postMessage({ id: job.id, text: job.text, jsonc: job.jsonc });
  };

  const cancel = (key: string) => {
    for (let k = queue.length - 1; k >= 0; k--) if (queue[k]!.key === key) queue.splice(k, 1)[0]!.resolve('dropped');
    if (running?.job.key === key) running.wanted = false;
  };

  const parse = (text: string, jsonc: boolean, key: string): Promise<ParseOutcome> => {
    cancel(key);
    return new Promise((resolve) => {
      queue.push({ id: ++seq, text, jsonc, key, resolve });
      next();
    });
  };

  return { parse, cancel };
}

const shared = createJsonParser(() => new Worker(new URL('./json.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
export const parseInWorker = shared.parse;
export const cancelParse = shared.cancel;

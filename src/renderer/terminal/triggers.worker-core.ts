// The output triggers worker's logic, apart from the Worker global so it can be tested in-process.
import { compileRules, matchLines, type CompiledRule, type TerminalKind, type TriggerHit, type TriggerRule } from '@shared/triggers';

/** Time one batch may take across all its terminals; what is left over is skipped (and said). */
export const BUDGET_MS = 50;

/** `alt[i]`: line i was written on the alternate screen (never notified). */
export interface BatchEntry { termId: string; kind: TerminalKind; lines: string[]; alt?: boolean[] }
/** To the worker: the rules to use, or a batch of new lines. */
export type TriggerWorkerIn = { rules: TriggerRule[] } | { batch: BatchEntry[]; seq: number };
/** From the worker: a rule starts (for the watchdog), or the batch is done. */
export type TriggerWorkerOut = { rule: string } | { done: number; hits: (TriggerHit & { termId: string })[]; truncated: boolean };

/** One worker's state: its compiled rules. Returns the message handler. */
export function triggerWorkerCore(post: (m: TriggerWorkerOut) => void, now: () => number): (msg: unknown) => void {
  let rules: CompiledRule[] = [];
  return (msg) => {
    const m = msg as Partial<{ rules: TriggerRule[]; batch: BatchEntry[]; seq: number }>;
    if (Array.isArray(m.rules)) { rules = compileRules(m.rules); return; }
    if (!Array.isArray(m.batch) || typeof m.seq !== 'number') return;
    const start = now();
    const hits: (TriggerHit & { termId: string })[] = [];
    let truncated = false;
    for (const entry of m.batch) {
      const left = BUDGET_MS - (now() - start);
      if (left <= 0) { truncated = true; break; }
      const r = matchLines(rules, entry.lines, entry.kind, { now, budgetMs: left, onRule: (id) => post({ rule: id }), alt: Array.isArray(entry.alt) ? entry.alt : undefined });
      for (const h of r.hits) hits.push({ ...h, termId: entry.termId });
      truncated ||= r.truncated;
    }
    post({ done: m.seq, hits, truncated });
  };
}

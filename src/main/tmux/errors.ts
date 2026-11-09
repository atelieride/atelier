import { classify, stripAnsi } from '@shared/logline';

export const countErrors = (lines: string[]) => lines.reduce((n, l) => n + (classify(stripAnsi(l)) === 'error' ? 1 : 0), 0);

/**
 * Errors to report for a pane: only the new ones not yet seen.
 * - The first capture is history (often hours old): it doesn't count.
 * - While the pane is in front of the user the number stays at zero.
 * - The live line counts, without being counted twice.
 */
export function nextErrors(prev: { committed: number }, e: { reset: boolean; first: boolean; appended: string[]; live: string; seen: boolean }): { committed: number; total: number } {
  if (e.seen) return { committed: 0, total: 0 };
  const committed = e.first ? 0 : e.reset ? countErrors(e.appended) : prev.committed + countErrors(e.appended);
  return { committed, total: committed + countErrors([e.live]) };
}

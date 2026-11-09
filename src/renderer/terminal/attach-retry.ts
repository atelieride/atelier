/**
 * A terminal view attaches to its terminal once, when it mounts. An attach can fail for a moment (main does not know
 * the terminal yet, atelierd reconnecting): a view that gave up then would stay blank for good while the terminal runs.
 * So a failed attach is tried again with back-off, as long as the terminal is still listed.
 */
export const ATTACH_RETRY_MS = [100, 250, 500, 1000, 2000] as const;

type Schedule = (fn: () => void, ms: number) => () => void;
const timer: Schedule = (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };

export interface PendingAttach {
  /** No more tries; true if the attach had not succeeded yet (the next mount must attach again). */
  cancel(): boolean;
}

export function attachWithRetry(
  attach: () => Promise<void>,
  o: { alive: () => boolean; onAttached: () => void; schedule?: Schedule }
): PendingAttach {
  const schedule = o.schedule ?? timer;
  let done = false;
  let cancelled = false;
  let tries = 0;
  let unschedule: (() => void) | null = null;
  const run = () => {
    unschedule = null;
    attach().then(
      () => {
        if (cancelled) return;
        done = true;
        o.onAttached();
      },
      () => {
        if (cancelled || !o.alive()) return;
        unschedule = schedule(() => { if (o.alive()) run(); }, ATTACH_RETRY_MS[Math.min(tries++, ATTACH_RETRY_MS.length - 1)]!);
      }
    );
  };
  run();
  return {
    cancel() {
      cancelled = true;
      unschedule?.();
      unschedule = null;
      return !done;
    }
  };
}

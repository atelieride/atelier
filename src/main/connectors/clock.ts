// The connectors' time: injected, so the status machine's waits (the 5 minute Connect timeout, 60 s staleness, the
// 5 minute poll, the 30 s → 5 min backoff, rate-limit waits, the 30 s call deadline) are tested with a manual clock.
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
};

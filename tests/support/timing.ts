/**
 * Speed checks in the unit tests: the fastest of `runs` timed calls of `fn`, in ms, after one untimed warm-up (V8
 * compiles it). A busy CI runner can stall any single run, while a slower algorithm makes every run slow: the best
 * run still catches the regression without the noise.
 */
export function bestTime(fn: () => void, runs = 5): number {
  fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

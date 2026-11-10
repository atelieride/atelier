import { expect, test } from 'vitest';
import { bestTime } from './timing';

test('bestTime: one untimed warm-up, then the fastest of the timed runs', () => {
  let calls = 0;
  // The first timed run stalls (as a busy CI runner can): the best one is reported.
  const ms = bestTime(() => {
    calls++;
    if (calls === 2) { const end = performance.now() + 30; while (performance.now() < end) { /* stall */ } }
  }, 4);
  expect(calls).toBe(5);
  expect(ms).toBeLessThan(30);
});

test('bestTime: a function slow every time is reported slow', () => {
  const ms = bestTime(() => { const end = performance.now() + 5; while (performance.now() < end) { /* slow */ } }, 3);
  expect(ms).toBeGreaterThanOrEqual(5);
});

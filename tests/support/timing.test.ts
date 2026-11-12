import { expect, test } from 'vitest';
import { bestTime, bestTimeAsync } from './timing';

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('bestTimeAsync: each run awaited; a run that stalls is not the one reported, one slow every time is', async () => {
  let calls = 0;
  let running = 0;
  let overlapped = false;
  const ms = await bestTimeAsync(async () => {
    calls++;
    overlapped ||= running > 0;
    running++;
    await wait(calls === 2 ? 60 : 0);
    running--;
  }, 4);
  expect(calls).toBe(5);
  expect(overlapped).toBe(false);
  expect(ms).toBeLessThan(60);
  expect(await bestTimeAsync(() => wait(20), 2)).toBeGreaterThanOrEqual(19);
});

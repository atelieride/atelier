import { expect, test } from 'vitest';
import { attachWithRetry, ATTACH_RETRY_MS } from './attach-retry';

/** A scheduler driven by hand: run() fires the next timer. */
function clock() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    pending: () => timers.filter((t) => !t.cancelled),
    run: () => { const t = timers.find((x) => !x.cancelled)!; t.cancelled = true; t.fn(); }
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('an attach that succeeds at once: onAttached, nothing scheduled', async () => {
  const c = clock();
  let calls = 0, attached = 0;
  attachWithRetry(async () => { calls++; }, { alive: () => true, onAttached: () => attached++, schedule: c.schedule });
  await flush();
  expect([calls, attached, c.pending().length]).toEqual([1, 1, 0]);
});

test('a refused attach is tried again with back-off until it succeeds', async () => {
  // A terminal main does not know yet (its list arrives a moment after the launch reply) refuses the first attaches.
  const c = clock();
  let calls = 0, attached = 0;
  attachWithRetry(async () => { calls++; if (calls < 4) throw new Error('terminal of another project'); }, { alive: () => true, onAttached: () => attached++, schedule: c.schedule });
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) { await flush(); delays.push(c.pending()[0]!.ms); c.run(); }
  await flush();
  expect(delays).toEqual(ATTACH_RETRY_MS.slice(0, 3));
  expect([calls, attached, c.pending().length]).toEqual([4, 1, 0]);
});

test('the back-off stays at its last step', async () => {
  const c = clock();
  attachWithRetry(async () => { throw new Error('no'); }, { alive: () => true, onAttached: () => {}, schedule: c.schedule });
  for (let i = 0; i < ATTACH_RETRY_MS.length + 2; i++) { await flush(); c.run(); }
  await flush();
  expect(c.pending()[0]!.ms).toBe(ATTACH_RETRY_MS.at(-1));
});

test('a terminal that is gone is not tried again', async () => {
  const c = clock();
  let alive = true, calls = 0;
  attachWithRetry(async () => { calls++; throw new Error('gone'); }, { alive: () => alive, onAttached: () => {}, schedule: c.schedule });
  await flush();
  alive = false;
  c.run();
  await flush();
  expect([calls, c.pending().length]).toEqual([1, 0]);
});

test('cancel: no more tries, and it says whether the attach was still pending', async () => {
  const c = clock();
  let calls = 0;
  const pending = attachWithRetry(async () => { calls++; throw new Error('no'); }, { alive: () => true, onAttached: () => {}, schedule: c.schedule });
  await flush();
  expect(pending.cancel()).toBe(true);
  expect(c.pending().length).toBe(0);
  expect(calls).toBe(1);

  const done = attachWithRetry(async () => {}, { alive: () => true, onAttached: () => {}, schedule: c.schedule });
  await flush();
  expect(done.cancel()).toBe(false);
});

test('an attach in flight when cancelled neither calls onAttached nor schedules', async () => {
  const c = clock();
  let release!: (ok: boolean) => void;
  let attached = 0;
  const a = attachWithRetry(() => new Promise<void>((res, rej) => { release = (ok) => (ok ? res() : rej(new Error('no'))); }), { alive: () => true, onAttached: () => attached++, schedule: c.schedule });
  expect(a.cancel()).toBe(true);
  release(false);
  await flush();
  expect([attached, c.pending().length]).toEqual([0, 0]);
});

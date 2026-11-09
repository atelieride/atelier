import { expect, test, vi } from 'vitest';
import { ScreenResync, isLayoutChange } from './screen-resync';

function setup() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const run = vi.fn();
  const r = new ScreenResync({
    delayMs: 1000, run,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; }
  });
  const fire = () => { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); } };
  return { r, run, timers, fire };
}

test('a burst of wake and display events runs once, after the last one settles', () => {
  const { r, run, timers, fire } = setup();
  r.poke(); r.poke(); r.poke();
  expect(run).not.toHaveBeenCalled();
  expect(timers.filter((t) => t.live)).toHaveLength(1);
  expect(timers.at(-1)!.ms).toBe(1000);
  fire();
  expect(run).toHaveBeenCalledTimes(1);
  r.poke(); fire();
  expect(run).toHaveBeenCalledTimes(2);
});

test('disposed: a pending run is dropped and later events are ignored', () => {
  const { r, run, fire } = setup();
  r.poke();
  r.dispose();
  r.poke();
  fire();
  expect(run).not.toHaveBeenCalled();
});

test("a display's metrics: its size or scale moves windows, its work area alone (the Dock) does not", () => {
  expect(isLayoutChange(['bounds'])).toBe(true);
  expect(isLayoutChange(['scaleFactor', 'workArea'])).toBe(true);
  expect(isLayoutChange(['workArea'])).toBe(false);
  expect(isLayoutChange(['rotation'])).toBe(true);
});

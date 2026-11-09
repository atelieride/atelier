import { expect, test } from 'vitest';
import { BLINK_REST_MS, BlinkIdle } from './blink-idle';

function harness(enabled: boolean) {
  const st = { enabled, blink: null as boolean | null, timers: [] as { fn: () => void; ms: number; live: boolean }[] };
  const b = new BlinkIdle({
    enabled: () => st.enabled,
    set: (v) => { st.blink = v; },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; st.timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; }
  });
  const fire = () => { const t = st.timers.filter((x) => x.live).at(-1); if (t) { t.live = false; t.fn(); } };
  return { st, b, fire };
}

test('blinks on input, rests after BLINK_REST_MS, blinks again on the next input', () => {
  const { st, b, fire } = harness(true);
  b.wake();
  expect(st.blink).toBe(true);
  expect(st.timers.at(-1)!.ms).toBe(BLINK_REST_MS);
  fire();
  expect(st.blink).toBe(false);
  b.wake();
  expect(st.blink).toBe(true);
});

test('each input restarts the rest timer (only one live timer)', () => {
  const { st, b } = harness(true);
  b.wake(); b.wake(); b.wake();
  expect(st.timers.filter((t) => t.live)).toHaveLength(1);
});

test('setting off: never blinks, even on input; turning it on blinks at once; dispose stops the timer', () => {
  const { st, b } = harness(false);
  b.wake();
  expect(st.blink).toBe(false);
  b.settingsChanged(true);
  expect(st.blink).toBe(true);
  b.settingsChanged(false);
  expect(st.blink).toBe(false);
  expect(st.timers.filter((t) => t.live)).toHaveLength(0);
  b.settingsChanged(true);
  b.dispose();
  expect(st.timers.filter((t) => t.live)).toHaveLength(0);
});

test('settingsChanged takes the new value itself: the store may still hold the old one (adoptSettings applies to the terminals first)', () => {
  const { st, b } = harness(false);
  b.settingsChanged(true);
  expect(st.blink).toBe(true);
  b.wake();
  expect(st.blink).toBe(true);
  const on = harness(true);
  on.b.settingsChanged(false);
  on.b.wake();
  expect(on.st.blink).toBe(false);
});

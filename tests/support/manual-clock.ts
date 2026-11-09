// A Clock (src/main/connectors/clock.ts) that only moves when a test says so. Network stays real (the fake ClickUp):
// only the connector's own waits are simulated.
import type { Clock } from '../../src/main/connectors/clock';

export interface ManualClock extends Clock {
  /** Moves time forward, running every timer that falls due (in order), awaiting a few microtasks after each. */
  advance(ms: number): Promise<void>;
  /** Pending timers (for "no timer left" checks). */
  pending(): number;
  /** Due times of the pending timers, relative to now. */
  dueIn(): number[];
}

/** Starts at the real time by default: the fake ClickUp's x-ratelimit-reset is real unix seconds. */
export function manualClock(start = Date.now()): ManualClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h) { timers.delete(h as number); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => timers.size,
    dueIn: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b)
  };
}

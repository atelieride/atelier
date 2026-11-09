// The demo's one scheduler: every timer of the engine (Claude's beats, Docker logs, the
// Redis monitor, TTLs) goes through it, so the page can pause the whole world at once when the iframe is hidden or the
// tab goes to the background, and a demo left open costs nothing. Paused, a task keeps the time it had left.

export type Cancel = () => void;

export interface Clock {
  /** Runs `fn` once, `ms` from now (counting only time the clock runs). */
  after(ms: number, fn: () => void): Cancel;
  /** Runs `fn` every `ms`, the first time `ms` from now. */
  every(ms: number, fn: () => void): Cancel;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  /** Cancels every task (tests, a torn-down demo). */
  dispose(): void;
}

interface Task { fn: () => void; period: number | null; left: number; armedAt: number; timer: ReturnType<typeof setTimeout> | null }

export function createClock(): Clock {
  const tasks = new Set<Task>();
  let paused = false;

  const arm = (t: Task) => {
    t.armedAt = Date.now();
    t.timer = setTimeout(() => fire(t), t.left);
  };
  const fire = (t: Task) => {
    t.timer = null;
    if (t.period === null) tasks.delete(t);
    else { t.left = t.period; arm(t); }
    // One failing task (a beat with a bug) must not stop the rest of the world.
    try { t.fn(); } catch (e) { console.error(e); }
  };
  const add = (ms: number, fn: () => void, period: number | null): Cancel => {
    const t: Task = { fn, period, left: Math.max(0, ms), armedAt: 0, timer: null };
    tasks.add(t);
    if (!paused) arm(t);
    return () => {
      if (t.timer) clearTimeout(t.timer);
      tasks.delete(t);
    };
  };

  return {
    after: (ms, fn) => add(ms, fn, null),
    every: (ms, fn) => add(ms, fn, Math.max(1, ms)),
    get paused() { return paused; },
    pause() {
      if (paused) return;
      paused = true;
      const at = Date.now();
      for (const t of tasks) {
        if (!t.timer) continue;
        clearTimeout(t.timer);
        t.timer = null;
        t.left = Math.max(0, t.left - (at - t.armedAt));
      }
    },
    resume() {
      if (!paused) return;
      paused = false;
      for (const t of tasks) arm(t);
    },
    dispose() {
      for (const t of tasks) if (t.timer) clearTimeout(t.timer);
      tasks.clear();
    }
  };
}

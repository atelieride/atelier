import { afterEach, expect, test, vi } from 'vitest';
import { nextArrivalKey, nextRisingKey, play, trackWindowActivity } from './motion';

/** The page as reducedMotion() reads it: Atelier's setting on the root, the system's through matchMedia. */
function page(o: { setting?: 'reduced'; system?: boolean } = {}) {
  vi.stubGlobal('document', { documentElement: { dataset: o.setting ? { motion: o.setting } : {} } });
  vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: !!o.system && q === '(prefers-reduced-motion: reduce)' }) });
}
afterEach(() => { vi.unstubAllGlobals(); });

function element() {
  const calls: [Keyframe[], KeyframeAnimationOptions][] = [];
  const anim = {} as Animation;
  return { calls, anim, el: { animate: (kf: Keyframe[], o: KeyframeAnimationOptions) => { calls.push([kf, o]); return anim; } } as unknown as Element };
}

test('play animates and holds nothing at rest unless asked: fill is none by default', () => {
  page();
  const { calls, anim, el } = element();
  const kf = [{ opacity: 0 }, { opacity: 1 }];
  expect(play(el, kf, { duration: 240 })).toBe(anim);
  expect(calls).toEqual([[kf, { fill: 'none', duration: 240 }]]);
  play(el, kf, { duration: 240, fill: 'backwards' });
  expect(calls[1]![1].fill).toBe('backwards');
});

test('play does nothing under Reduce motion, Atelier\'s or the system\'s', () => {
  for (const o of [{ setting: 'reduced' as const }, { system: true }]) {
    page(o);
    const { calls, el } = element();
    expect(play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 240 })).toBeNull();
    expect(calls).toEqual([]);
  }
});

test('the cue key moves only when the count rises: a new waiting session replays the cue, an answered one does not', () => {
  let k = { count: 0, key: 0 };
  const seq = [1, 2, 1, 1, 3, 0, 1].map((n) => (k = nextRisingKey(k, n)).key);
  expect(seq).toEqual([1, 2, 2, 2, 3, 3, 4]);
});

/** The keys a row would key its cue on, one per state it shows in turn, starting from nothing seen. */
const arrivals = (states: string[], target = 'done') => {
  let k: { state: string | null; key: number } = { state: null, key: 0 };
  return states.map((s) => (k = nextArrivalKey(k, s, target)).key);
};

test('the arrival key stays put the first time a state is seen: a row mounted on a finished session plays nothing', () => {
  expect(arrivals(['done'])).toEqual([0]);
  expect(nextArrivalKey({ state: null, key: 0 }, 'done', 'done')).toEqual({ state: 'done', key: 0 });
});

test('the arrival key moves when the target is reached from another state, and only then', () => {
  expect(arrivals(['running', 'done'])).toEqual([0, 1]);
  // Staying there is no arrival.
  expect(arrivals(['running', 'done', 'done'])).toEqual([0, 1, 1]);
  // Leaving and coming back is another.
  expect(arrivals(['done', 'running', 'done'])).toEqual([0, 0, 1]);
  expect(arrivals(['running', 'done', 'running', 'done'])).toEqual([0, 1, 1, 2]);
  // Other states never move it.
  expect(arrivals(['running', 'waiting', 'idle', 'error'])).toEqual([0, 0, 0, 0]);
  expect(arrivals(['running', 'waiting'], 'waiting')).toEqual([0, 1]);
});

function fakeWindow() {
  const handlers: Record<string, (() => void)[]> = { focus: [], blur: [] };
  return {
    addEventListener: (type: 'focus' | 'blur', fn: () => void) => { handlers[type]!.push(fn); },
    removeEventListener: (type: 'focus' | 'blur', fn: () => void) => { handlers[type] = handlers[type]!.filter((f) => f !== fn); },
    fire: (type: 'focus' | 'blur') => handlers[type]!.forEach((f) => f())
  };
}

test('data-window is right from the start, follows focus and blur, and the cleanup detaches', () => {
  const win = fakeWindow();
  const root = { dataset: {} as Record<string, string | undefined> };
  const stop = trackWindowActivity(win, root, false);
  expect(root.dataset.window).toBe('inactive');
  win.fire('focus');
  expect(root.dataset.window).toBe('active');
  win.fire('blur');
  expect(root.dataset.window).toBe('inactive');
  stop();
  win.fire('focus');
  expect(root.dataset.window).toBe('inactive');
});

test('a window that starts focused starts active', () => {
  const root = { dataset: {} as Record<string, string | undefined> };
  trackWindowActivity(fakeWindow(), root, true);
  expect(root.dataset.window).toBe('active');
});

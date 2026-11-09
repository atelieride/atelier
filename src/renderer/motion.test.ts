import { expect, test } from 'vitest';
import { nextRisingKey, trackWindowActivity } from './motion';

test('the cue key moves only when the count rises: a new waiting session replays the cue, an answered one does not', () => {
  let k = { count: 0, key: 0 };
  const seq = [1, 2, 1, 1, 3, 0, 1].map((n) => (k = nextRisingKey(k, n)).key);
  expect(seq).toEqual([1, 2, 2, 2, 3, 3, 4]);
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

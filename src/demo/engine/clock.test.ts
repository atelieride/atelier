import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createClock } from './clock';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('after runs once, every repeats, cancel stops both', () => {
  const clock = createClock();
  const once = vi.fn(), tick = vi.fn();
  clock.after(100, once);
  const stop = clock.every(50, tick);
  vi.advanceTimersByTime(99);
  expect(once).not.toHaveBeenCalled();
  expect(tick).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(once).toHaveBeenCalledTimes(1);
  expect(tick).toHaveBeenCalledTimes(2);
  stop();
  vi.advanceTimersByTime(500);
  expect(tick).toHaveBeenCalledTimes(2);
  expect(once).toHaveBeenCalledTimes(1);
});

test('a paused clock runs nothing and resumes with the time that was left', () => {
  const clock = createClock();
  const once = vi.fn(), tick = vi.fn();
  clock.after(100, once);
  clock.every(40, tick);
  vi.advanceTimersByTime(70);
  expect(tick).toHaveBeenCalledTimes(1);
  clock.pause();
  vi.advanceTimersByTime(10_000);
  expect(once).not.toHaveBeenCalled();
  expect(tick).toHaveBeenCalledTimes(1);
  clock.resume();
  vi.advanceTimersByTime(9);
  expect(tick).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(tick).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(20);
  expect(once).toHaveBeenCalledTimes(1);
});

test('tasks scheduled while paused wait for resume; pause and resume are idempotent', () => {
  const clock = createClock();
  const once = vi.fn();
  clock.pause();
  clock.pause();
  clock.after(10, once);
  vi.advanceTimersByTime(100);
  expect(once).not.toHaveBeenCalled();
  clock.resume();
  clock.resume();
  vi.advanceTimersByTime(10);
  expect(once).toHaveBeenCalledTimes(1);
});

test('a task that throws does not stop the others', () => {
  const clock = createClock();
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((e) => { errors.push(e); });
  const ok = vi.fn();
  clock.after(10, () => { throw new Error('boom'); });
  clock.after(10, ok);
  vi.advanceTimersByTime(10);
  expect(ok).toHaveBeenCalledTimes(1);
  expect(errors).toHaveLength(1);
  spy.mockRestore();
});

test('dispose cancels everything', () => {
  const clock = createClock();
  const once = vi.fn();
  clock.after(10, once);
  clock.every(10, once);
  clock.dispose();
  vi.advanceTimersByTime(100);
  expect(once).not.toHaveBeenCalled();
});

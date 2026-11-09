import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { visibleTimeout, type Visibility } from './visible-timeout';

/** A document's visibility, driven by the test. */
function fakeVisibility(hidden = false): Visibility & { set(h: boolean): void; listeners: number } {
  const subs = new Set<() => void>();
  return {
    hidden: () => hidden,
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
    set(h) { hidden = h; for (const cb of [...subs]) cb(); },
    get listeners() { return subs.size; }
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('fires after `ms` of visible time, once, and stops listening', () => {
  const vis = fakeVisibility();
  const fn = vi.fn();
  visibleTimeout(1000, fn, vis);
  vi.advanceTimersByTime(999);
  expect(fn).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(vis.listeners).toBe(0);
  vis.set(true); vis.set(false);
  vi.advanceTimersByTime(5000);
  expect(fn).toHaveBeenCalledTimes(1);
});

test('hidden time does not count: a background tab that stalls never trips it', () => {
  const vis = fakeVisibility();
  const fn = vi.fn();
  visibleTimeout(1000, fn, vis);
  vi.advanceTimersByTime(600);
  vis.set(true);
  vi.advanceTimersByTime(60_000);
  expect(fn).not.toHaveBeenCalled();
  vis.set(false);
  vi.advanceTimersByTime(399);
  expect(fn).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(fn).toHaveBeenCalledTimes(1);
});

test('started hidden (opened into a background tab): the count starts when the page is first seen', () => {
  const vis = fakeVisibility(true);
  const fn = vi.fn();
  visibleTimeout(1000, fn, vis);
  vi.advanceTimersByTime(30_000);
  expect(fn).not.toHaveBeenCalled();
  vis.set(false);
  vi.advanceTimersByTime(1000);
  expect(fn).toHaveBeenCalledTimes(1);
});

test('cancel stops it for good and stops listening', () => {
  const vis = fakeVisibility();
  const fn = vi.fn();
  const cancel = visibleTimeout(1000, fn, vis);
  vi.advanceTimersByTime(500);
  cancel();
  expect(vis.listeners).toBe(0);
  vis.set(true); vis.set(false);
  vi.advanceTimersByTime(5000);
  expect(fn).not.toHaveBeenCalled();
});

test('repeated visibility events of the same state change nothing', () => {
  const vis = fakeVisibility();
  const fn = vi.fn();
  visibleTimeout(1000, fn, vis);
  vi.advanceTimersByTime(400);
  vis.set(false); // visible again, while visible: must not restart the count
  vi.advanceTimersByTime(600);
  expect(fn).toHaveBeenCalledTimes(1);
});

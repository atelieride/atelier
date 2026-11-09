import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createClock } from '../engine/clock';
import { watchScreen } from './screen-watch';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('looks every 600 ms on the demo clock, and not at all while it is paused (a hidden iframe costs nothing)', () => {
  const clock = createClock();
  const look = vi.fn(() => false);
  watchScreen(clock, look);
  vi.advanceTimersByTime(1800);
  expect(look).toHaveBeenCalledTimes(3);
  clock.pause();
  vi.advanceTimersByTime(60_000);
  expect(look).toHaveBeenCalledTimes(3);
  clock.resume();
  vi.advanceTimersByTime(600);
  expect(look).toHaveBeenCalledTimes(4);
});

test('stops once the look says it has seen everything it waits for', () => {
  const clock = createClock();
  let n = 0;
  const look = vi.fn(() => ++n >= 2);
  watchScreen(clock, look);
  vi.advanceTimersByTime(6000);
  expect(look).toHaveBeenCalledTimes(2);
});

test('the cancel stops it', () => {
  const clock = createClock();
  const look = vi.fn(() => false);
  const cancel = watchScreen(clock, look);
  vi.advanceTimersByTime(600);
  cancel();
  vi.advanceTimersByTime(6000);
  expect(look).toHaveBeenCalledTimes(1);
});

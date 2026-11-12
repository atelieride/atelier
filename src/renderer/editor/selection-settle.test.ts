import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SETTLE_MS, selectionSettle } from './selection-settle';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const make = () => {
  const settled = vi.fn();
  return { s: selectionSettle(settled), settled };
};

test('a mouse drag settles once, on mouse up, however many selection changes it made', () => {
  const { s, settled } = make();
  s.pointerDown();
  for (let i = 0; i < 20; i++) { s.selectionChanged(); vi.advanceTimersByTime(SETTLE_MS * 2); }
  expect(settled).not.toHaveBeenCalled();
  s.pointerUp();
  expect(settled).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(SETTLE_MS * 4);
  expect(settled).toHaveBeenCalledTimes(1);
});

test('a keyboard selection settles after a quiet moment, restarting at every change', () => {
  const { s, settled } = make();
  s.selectionChanged();
  vi.advanceTimersByTime(SETTLE_MS - 10);
  s.selectionChanged();
  vi.advanceTimersByTime(SETTLE_MS - 10);
  expect(settled).not.toHaveBeenCalled();
  vi.advanceTimersByTime(10);
  expect(settled).toHaveBeenCalledTimes(1);
});

test('releasing Shift settles a keyboard selection at once', () => {
  const { s, settled } = make();
  s.selectionChanged();
  s.keyUp('Shift');
  expect(settled).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(SETTLE_MS * 2);
  expect(settled).toHaveBeenCalledTimes(1);
});

test('nothing to settle: mouse up without a change, other keys, Shift during a drag', () => {
  const { s, settled } = make();
  s.pointerUp();
  s.keyUp('Shift');
  expect(settled).not.toHaveBeenCalled();
  s.pointerDown();
  s.selectionChanged();
  s.keyUp('Shift');
  s.keyUp('a');
  vi.advanceTimersByTime(SETTLE_MS * 2);
  expect(settled).not.toHaveBeenCalled();
  s.pointerUp();
  expect(settled).toHaveBeenCalledTimes(1);
});

test('a click (down and up, the selection set on down) settles on up; dispose drops a pending settle', () => {
  const { s, settled } = make();
  s.pointerDown();
  s.selectionChanged();
  s.pointerUp();
  expect(settled).toHaveBeenCalledTimes(1);
  s.selectionChanged();
  s.dispose();
  vi.advanceTimersByTime(SETTLE_MS * 2);
  expect(settled).toHaveBeenCalledTimes(1);
});

test('a selection set for the user (a search result\'s match) has nothing left to settle: no timer, no Shift', () => {
  const { s, settled } = make();
  s.selectionChanged();
  s.reset();
  vi.advanceTimersByTime(SETTLE_MS * 2);
  s.keyUp('Shift');
  expect(settled).not.toHaveBeenCalled();
  // The user's own change afterwards settles as it always does.
  s.selectionChanged();
  s.keyUp('Shift');
  expect(settled).toHaveBeenCalledTimes(1);
});

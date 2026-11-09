import { expect, test } from 'vitest';
import { carryLive, LIVE_KEY } from './log-expand';

// Review minor: an expanded live line stays expanded once it is committed; the next live line starts folded.
// carryLive(expanded, live before, live now, lines now, seq now)
test('the live line committed: its expansion moves to its line key (seq - 1), the new live line is folded', () => {
  const was = new Set([3, LIVE_KEY]);
  expect([...carryLive(was, 'Error: long', 'GET /x', ['a', 'Error: long'], 10)].sort((a, b) => a - b)).toEqual([3, 9]);
});

test('the live line only grew: nothing moves', () => {
  const was = new Set([LIVE_KEY]);
  expect(carryLive(was, 'Error: lo', 'Error: long', ['a'], 10)).toBe(was);
  expect(carryLive(was, 'Error: lo', 'Error: lo', ['a'], 10)).toBe(was);
});

test('nothing expanded live: unchanged; a live line replaced by another one is folded', () => {
  const was = new Set([3]);
  expect(carryLive(was, 'x', 'y', ['x'], 5)).toBe(was);
  expect([...carryLive(new Set([LIVE_KEY]), 'gone', 'other', ['z'], 5)]).toEqual([]);
});

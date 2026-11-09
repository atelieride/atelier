import { expect, test } from 'vitest';
import { nextLabelChange } from './minute';
import { relativeTime } from './history';

// Review minor: "just now" must turn into "1m ago" right at the minute after the message, not up to a minute later.
const M = 60_000, H = 60 * M, D = 24 * H;

test('the next time the "ago" label changes, from the message time itself', () => {
  const at = 1_000_000;
  expect(nextLabelChange(at, at + 10_000)).toBe(at + M);
  expect(nextLabelChange(at, at + 5 * M + 1)).toBe(at + 6 * M);
  expect(nextLabelChange(at, at + 3 * H + 7)).toBe(at + 4 * H);
  expect(nextLabelChange(at, at + 2 * D + 7)).toBe(at + 3 * D);
});

test('at every change the label really changes, and not before', () => {
  const at = Date.UTC(2026, 9, 14, 12, 0, 0);
  for (const now of [at + 1000, at + 59 * M + 3, at + 5 * H, at + 3 * D + 11]) {
    const next = nextLabelChange(at, now);
    expect(relativeTime(at, next - 1)).toBe(relativeTime(at, now));
    expect(relativeTime(at, next)).not.toBe(relativeTime(at, now));
  }
});

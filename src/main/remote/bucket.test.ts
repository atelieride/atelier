import { expect, test } from 'vitest';
import { TokenBucket } from './bucket';

test('up to the burst at once, then refilled at its rate', () => {
  let now = 1_000_000;
  const b = new TokenBucket(5, 5, () => now);
  for (let i = 0; i < 5; i++) expect(b.tryTake(1)).toBe(true);
  expect(b.tryTake(1)).toBe(false);
  expect(b.wait(1)).toBe(200);
  now += 200;
  expect(b.tryTake(1)).toBe(true);
  // Never more than the burst, however long it waited.
  now += 60_000;
  expect(b.wait(5)).toBe(0);
  expect(b.wait(6)).toBe(0);
  b.take(5);
  expect(b.tryTake(1)).toBe(false);
});

test('a clock set back (a time sync, the user) is no time passed: what follows refills as usual, not after the jump', () => {
  let now = 1_000_000;
  const b = new TokenBucket(5, 5, () => now);
  b.take(5);
  now -= 10_000;
  expect(b.tryTake(1)).toBe(false);
  now += 1000;
  // A second later, a second's worth: not ten seconds of debt first.
  expect(b.wait(5)).toBe(0);
  expect(b.tryTake(5)).toBe(true);
});

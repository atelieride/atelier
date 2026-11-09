import { expect, test, vi } from 'vitest';
import { sameAsLast } from './same-as-last';

test('calls through only when the value differs from the last one', () => {
  const fn = vi.fn();
  const f = sameAsLast(fn);
  f([{ id: 'a' }]); f([{ id: 'a' }]); f([{ id: 'b' }]);
  expect(fn).toHaveBeenCalledTimes(2);
});

test('a custom key decides what counts (usage without updatedAt)', () => {
  const fn = vi.fn();
  const f = sameAsLast(fn, (u: { pct: number; updatedAt: number }) => String(u.pct));
  f({ pct: 1, updatedAt: 1 }); f({ pct: 1, updatedAt: 2 });
  expect(fn).toHaveBeenCalledTimes(1);
});

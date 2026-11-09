import { expect, test } from 'vitest';
import { LastSent } from './last-sent';

test('same value under a key is not a change; a different one is; keys are independent', () => {
  const s = new LastSent();
  expect(s.changed('terminals:1', [{ id: 'a' }])).toBe(true);
  expect(s.changed('terminals:1', [{ id: 'a' }])).toBe(false);
  expect(s.changed('terminals:2', [{ id: 'a' }])).toBe(true);
  expect(s.changed('terminals:1', [{ id: 'b' }])).toBe(true);
});

test('forget(prefix) makes the next value count as changed (a window that registers again gets its list)', () => {
  const s = new LastSent();
  s.changed('terminals:1', 1); s.changed('terminals:2', 1); s.changed('badge', '2');
  s.forget('terminals:1');
  expect(s.changed('terminals:1', 1)).toBe(true);
  expect(s.changed('terminals:2', 1)).toBe(false);
  expect(s.changed('badge', '2')).toBe(false);
});

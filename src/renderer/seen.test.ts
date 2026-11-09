import { expect, test } from 'vitest';
import { enterClass } from './seen';

test('enter animation only on first appearance', () => {
  expect(enterClass('x1')).toBe('enter');
  expect(enterClass('x1')).toBe('');
  expect(enterClass('x2')).toBe('enter');
});

import { expect, test } from 'vitest';
import { radioNext } from './radio';

test('arrows in a radio group: forward and back, wrapping; other keys do nothing', () => {
  const v = ['bar', 'block', 'underline'];
  expect(radioNext(v, 'bar', 'ArrowRight')).toBe('block');
  expect(radioNext(v, 'bar', 'ArrowDown')).toBe('block');
  expect(radioNext(v, 'underline', 'ArrowRight')).toBe('bar');
  expect(radioNext(v, 'bar', 'ArrowLeft')).toBe('underline');
  expect(radioNext(v, 'block', 'ArrowUp')).toBe('bar');
  expect(radioNext(v, 'block', 'Home')).toBe('bar');
  expect(radioNext(v, 'block', 'End')).toBe('underline');
  expect(radioNext(v, 'block', 'Enter')).toBeNull();
});

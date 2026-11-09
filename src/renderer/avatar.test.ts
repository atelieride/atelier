import { expect, test } from 'vitest';
import { initialOf } from './avatar';

test('avatar initial: one whole grapheme, uppercase', () => {
  expect(initialOf('refactor')).toBe('R');
  expect(initialOf('  spazi')).toBe('S');
  expect(initialOf('🚀 lancio')).toBe('🚀');
  expect(initialOf('👩‍💻 dev')).toBe('👩‍💻');
  expect(initialOf('')).toBe('?');
});

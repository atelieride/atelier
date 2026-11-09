import { expect, test } from 'vitest';
import { findInText, nextIndex } from './find-text';

const spec = (search: string, o: { caseSensitive?: boolean; wholeWord?: boolean; regexp?: boolean } = {}) =>
  ({ search, caseSensitive: false, wholeWord: false, regexp: false, replace: '', ...o });

test('literal search ignores case unless asked', () => {
  expect(findInText('Flush, flush, FLUSH', spec('flush'))).toEqual({ ranges: [{ from: 0, to: 5 }, { from: 7, to: 12 }, { from: 14, to: 19 }], capped: false, valid: true });
  expect(findInText('Flush, flush', spec('flush', { caseSensitive: true })).ranges).toEqual([{ from: 7, to: 12 }]);
  expect(findInText('anything', spec('')).ranges).toEqual([]);
});

test('whole word skips matches inside words (letters of any language)', () => {
  expect(findInText('flush flushed reflush flush', spec('flush', { wholeWord: true })).ranges).toEqual([{ from: 0, to: 5 }, { from: 22, to: 27 }]);
  expect(findInText('più piùmeno', spec('più', { wholeWord: true })).ranges).toEqual([{ from: 0, to: 3 }]);
});

test('regular expressions; an invalid one is flagged; empty matches are skipped', () => {
  expect(findInText('a1 b22 c', spec('\\d+', { regexp: true })).ranges).toEqual([{ from: 1, to: 2 }, { from: 4, to: 6 }]);
  expect(findInText('abc', spec('(', { regexp: true }))).toEqual({ ranges: [], capped: false, valid: false });
  expect(findInText('abc', spec('x*', { regexp: true })).ranges).toEqual([]);
});

test('stops at the cap', () => {
  const r = findInText('a'.repeat(20), spec('a'), 5);
  expect(r.ranges).toHaveLength(5);
  expect(r.capped).toBe(true);
});

test('next and previous wrap around', () => {
  expect(nextIndex(-1, 3, 1)).toBe(0);
  expect(nextIndex(-1, 3, -1)).toBe(2);
  expect(nextIndex(2, 3, 1)).toBe(0);
  expect(nextIndex(0, 3, -1)).toBe(2);
  expect(nextIndex(0, 0, 1)).toBe(-1);
});

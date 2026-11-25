import { expect, test } from 'vitest';
import { AnswerBook } from './answers';

const BEING = 'This request is being answered';
const ALREADY = 'This request was answered already';

test('an answer begins once per wait, one at a time per terminal; another terminal is apart', () => {
  const b = new AnswerBook();
  expect(b.begin('a', 'w1')).toBeNull();
  expect(b.begin('a', 'w1')).toBe(BEING);
  expect(b.begin('a', 'w2')).toBe(BEING);
  expect(b.begin('b', 'w1')).toBeNull();
  // Nothing typed: the wait may be answered again.
  b.end('a', 'w1', false);
  expect(b.begin('a', 'w1')).toBeNull();
  b.end('a', 'w1', true);
  expect(b.begin('a', 'w1')).toBe(ALREADY);
  // The next wait of that terminal goes.
  expect(b.begin('a', 'w2')).toBeNull();
});

test('typing holds a terminal as an answer does: neither starts while the other is on its way', () => {
  const b = new AnswerBook();
  expect(b.hold('a')).toBeNull();
  expect(b.hold('a')).toBe(BEING);
  expect(b.begin('a', 'w1')).toBe(BEING);
  // Another terminal is free.
  expect(b.hold('b')).toBeNull();
  b.release('a');
  expect(b.begin('a', 'w1')).toBeNull();
  expect(b.hold('a')).toBe(BEING);
  b.end('a', 'w1', true);
  // A wait answered doesn't hold the terminal; holding answers no wait.
  expect(b.hold('a')).toBeNull();
  b.release('a');
  expect(b.begin('a', 'w1')).toBe(ALREADY);
  expect(b.begin('a', 'w2')).toBeNull();
});

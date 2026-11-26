import { expect, test } from 'vitest';
import { AnswerBook } from './answers';

const BEING = 'This request is being answered';
const ALREADY = 'This request was answered already';

test('an answer begins once per wait, one at a time per terminal; another terminal is apart', () => {
  const b = new AnswerBook();
  expect(b.begin('a', { ask: 'w1' })).toBeNull();
  expect(b.begin('a', { ask: 'w1' })).toBe(BEING);
  expect(b.begin('a', { ask: 'w2' })).toBe(BEING);
  expect(b.begin('b', { ask: 'w1' })).toBeNull();
  // Nothing typed: the wait may be answered again.
  b.end('a', { ask: 'w1' }, false);
  expect(b.begin('a', { ask: 'w1' })).toBeNull();
  b.end('a', { ask: 'w1' }, true);
  expect(b.begin('a', { ask: 'w1' })).toBe(ALREADY);
  // The next wait of that terminal goes.
  expect(b.begin('a', { ask: 'w2' })).toBeNull();
});

test('the row and an option chosen answer the same wait: each refuses the other; another page of the wait is answered too', () => {
  const b = new AnswerBook();
  // An option chosen, then the row: the wait is answered.
  expect(b.begin('a', { ask: 'w1', page: 'p1' })).toBeNull();
  b.end('a', { ask: 'w1', page: 'p1' }, true);
  expect(b.begin('a', { ask: 'w1' })).toBe(ALREADY);
  expect(b.begin('a', { ask: 'w1', page: 'p1' })).toBe(ALREADY);
  // The wait's next page (a question's next one, its review page) takes its own answer.
  expect(b.begin('a', { ask: 'w1', page: 'p2' })).toBeNull();
  b.end('a', { ask: 'w1', page: 'p2' }, true);
  expect(b.begin('a', { ask: 'w1', page: 'p1' })).toBe(ALREADY);
  expect(b.begin('a', { ask: 'w1', page: 'p2' })).toBe(ALREADY);
  // The row first: no page of that wait is chosen after it.
  expect(b.begin('a', { ask: 'w2' })).toBeNull();
  b.end('a', { ask: 'w2' }, true);
  expect(b.begin('a', { ask: 'w2', page: 'p3' })).toBe(ALREADY);
  // A wait that comes after starts with nothing answered.
  expect(b.begin('a', { ask: 'w3', page: 'p1' })).toBeNull();
});

test('typing holds a terminal as an answer does: neither starts while the other is on its way', () => {
  const b = new AnswerBook();
  expect(b.hold('a')).toBeNull();
  expect(b.hold('a')).toBe(BEING);
  expect(b.begin('a', { ask: 'w1' })).toBe(BEING);
  // Another terminal is free.
  expect(b.hold('b')).toBeNull();
  b.release('a');
  expect(b.begin('a', { ask: 'w1' })).toBeNull();
  expect(b.hold('a')).toBe(BEING);
  // A release with no hold of its own (the hold above was refused) leaves the answer on its way.
  b.release('a');
  expect(b.begin('a', { ask: 'w2' })).toBe(BEING);
  b.end('a', { ask: 'w1' }, true);
  // A wait answered doesn't hold the terminal; holding answers no wait.
  expect(b.hold('a')).toBeNull();
  b.release('a');
  expect(b.begin('a', { ask: 'w1' })).toBe(ALREADY);
  expect(b.begin('a', { ask: 'w2' })).toBeNull();
});

test('isAnswered: a wait any answer went to (the row, a page of its dialog), until another wait comes; nothing typed is no answer', () => {
  const b = new AnswerBook();
  expect(b.isAnswered('a', 'w1')).toBe(false);
  expect(b.begin('a', { ask: 'w1', page: 'p1' })).toBeNull();
  // On its way, nothing typed yet.
  expect(b.isAnswered('a', 'w1')).toBe(false);
  b.end('a', { ask: 'w1', page: 'p1' }, true);
  expect(b.isAnswered('a', 'w1')).toBe(true);
  expect(b.isAnswered('a', 'w2')).toBe(false);
  expect(b.isAnswered('b', 'w1')).toBe(false);
  // The row answers the next wait; one whose keys never went isn't answered.
  expect(b.begin('a', { ask: 'w2' })).toBeNull();
  b.end('a', { ask: 'w2' }, true);
  expect(b.isAnswered('a', 'w2')).toBe(true);
  expect(b.isAnswered('a', 'w1')).toBe(false);
  expect(b.begin('b', { ask: 'w3' })).toBeNull();
  b.end('b', { ask: 'w3' }, false);
  expect(b.isAnswered('b', 'w3')).toBe(false);
});

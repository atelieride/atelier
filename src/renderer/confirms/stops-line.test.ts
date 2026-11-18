import { expect, test } from 'vitest';
import { stopsLine } from './InlineConfirm';

// The rose line under a close question: what closing interrupts.

test('a quiet idle session loses nothing: no line', () => {
  expect(stopsLine({ kind: 'claude', doing: 'idle', quiet: true })).toBeNull();
});

test('an idle Claude that may still lose something (unknown state, background work, crons) says Claude stops', () => {
  expect(stopsLine({ kind: 'claude', doing: 'idle' })).toBe('Claude stops.');
});

test('a turn, a question, a paused continuation or a program: what stops', () => {
  expect(stopsLine({ kind: 'claude', doing: 'working' })).toBe('Claude is working: it stops.');
  expect(stopsLine({ kind: 'claude', doing: 'waiting' })).toBe('Claude is waiting for you: it stops.');
  expect(stopsLine({ kind: 'process', what: 'sleep' })).toBe('sleep stops.');
});

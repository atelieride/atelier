import { expect, test } from 'vitest';
import { backgroundTarget } from './background-command';

const s = (id: string, entries = 0, session = true) => ({ id, session: session ? { sessionId: id } : null, work: { entries: Array.from({ length: entries }, (_, i) => ({ id: `${id}${i}` })) } }) as never;

test('the selected session, else one with background work, else the first session', () => {
  expect(backgroundTarget([s('a'), s('b', 2)], 'a')).toBe('a');
  expect(backgroundTarget([s('a'), s('b', 2)], 'x')).toBe('b');
  expect(backgroundTarget([s('a'), s('b')], null)).toBe('a');
  expect(backgroundTarget([s('t', 0, false)], 't')).toBeNull();
});

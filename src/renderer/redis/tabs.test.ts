import { expect, test } from 'vitest';
import { parseRedisKey, redisKey, redisTabTitle, redisViewsShown } from './tabs';

// Redis tabs: one per view.

test('each view has its key, and the key gives the view back', () => {
  for (const v of ['keys', 'queues', 'live', 'overview'] as const) {
    expect(redisKey(v)).toBe(`rd:${v}`);
    expect(parseRedisKey(redisKey(v))).toBe(v);
  }
});

test('a malformed key names no view', () => {
  for (const k of ['rd:', 'rd:nope', 'redis', 'dk:overview']) expect(parseRedisKey(k)).toBeNull();
});

test('the views an instance offers: Queues only with queues, Live and Overview only with INFO; all before the status is known', () => {
  expect(redisViewsShown(null)).toEqual(['keys', 'queues', 'live', 'overview']);
  expect(redisViewsShown({ queues: [], denied: [] })).toEqual(['keys', 'live', 'overview']);
  expect(redisViewsShown({ queues: [{ id: 'q' }] as never, denied: ['info'] })).toEqual(['keys', 'queues']);
});

test('a tab is named by its view (its space says it is Redis’s)', () => {
  expect((['keys', 'queues', 'live', 'overview'] as const).map((v) => redisTabTitle(v))).toEqual(['Keys', 'Queues', 'Live', 'Overview']);
});

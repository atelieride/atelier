import { expect, test } from 'vitest';
import { MAX_VIEW_KEY, isAutoTabKey, isDockerTabKey, isRedisTabKey } from './view-keys';

// Spaces: the keys of Docker, Redis and Automations tabs, checked wherever a key
// crosses a boundary (a pop-out, a saved state).

test('a Docker tab key names the engine overview, a compose project or a container id', () => {
  expect(isDockerTabKey('dk:overview')).toBe(true);
  expect(isDockerTabKey('dk:s:acme-store')).toBe(true);
  expect(isDockerTabKey(`dk:s:${encodeURIComponent('acme store')}`)).toBe(true);
  expect(isDockerTabKey('dk:c:0123456789ab')).toBe(true);
  expect(isDockerTabKey(`dk:c:${'a'.repeat(64)}`)).toBe(true);
});

test('anything else is no Docker tab key', () => {
  for (const k of ['dk:', 'dk:c:', 'dk:c:XYZ', 'dk:c:0123', 'dk:s:', 'dk:s:a/b', 'dk:s:a b', 'dk:x:1', 'docker', `dk:s:${'a'.repeat(MAX_VIEW_KEY)}`]) {
    expect(isDockerTabKey(k)).toBe(false);
  }
});

test('a Redis tab key is one of its four views', () => {
  for (const v of ['keys', 'queues', 'live', 'overview']) expect(isRedisTabKey(`rd:${v}`)).toBe(true);
  for (const k of ['rd:', 'rd:nope', 'redis', 'rd:keys ']) expect(isRedisTabKey(k)).toBe(false);
});

test('an Automations tab key is every project’s list or one automation id', () => {
  expect(isAutoTabKey('au:all')).toBe(true);
  expect(isAutoTabKey('au:a1_B-2')).toBe(true);
  for (const k of ['au:', 'au:../x', 'au:a b', `au:${'a'.repeat(65)}`, 'automations']) expect(isAutoTabKey(k)).toBe(false);
});

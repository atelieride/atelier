import { expect, test } from 'vitest';
import { dockerKey, parseDockerKey } from './tabs';

// Docker tabs: one per target, keyed by it.

test('each target has its key, and the key gives the target back', () => {
  const targets = [{ kind: 'overview' }, { kind: 'stack', project: 'acme store' }, { kind: 'container', id: '0123456789ab' }] as const;
  for (const target of targets) expect(parseDockerKey(dockerKey(target))).toEqual(target);
  expect(dockerKey({ kind: 'overview' })).toBe('dk:overview');
  expect(dockerKey({ kind: 'stack', project: 'acme-store' })).toBe('dk:s:acme-store');
  expect(dockerKey({ kind: 'container', id: '0123456789ab' })).toBe('dk:c:0123456789ab');
});

test('a malformed key names no target', () => {
  for (const k of ['dk:', 'dk:c:XYZ', 'dk:s:', 'docker', 'f:/x']) expect(parseDockerKey(k)).toBeNull();
});

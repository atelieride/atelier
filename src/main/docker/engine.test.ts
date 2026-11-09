import { describe, expect, test } from 'vitest';
import { ALLOWED_PATHS, assertAllowed, pathOf } from './engine';

const ID = 'a1b2c3d4e5f6';

describe('pathOf: the only requests the app can make', () => {
  test.each([
    [{ kind: 'ping' }, '/_ping'],
    [{ kind: 'version' }, '/version'],
    [{ kind: 'info' }, '/info'],
    [{ kind: 'containers' }, '/containers/json?all=1'],
    [{ kind: 'inspect', id: ID }, `/containers/${ID}/json`],
    [{ kind: 'logs', id: ID, follow: true, tail: 5000 }, `/containers/${ID}/logs?follow=1&stdout=1&stderr=1&timestamps=1&tail=5000`],
    [{ kind: 'logs', id: ID, follow: false, tail: 20, since: 1760000000 }, `/containers/${ID}/logs?follow=0&stdout=1&stderr=1&timestamps=1&tail=20&since=1760000000`],
    [{ kind: 'stats', id: ID, stream: true }, `/containers/${ID}/stats?stream=1`],
    [{ kind: 'events' }, '/events?filters=%7B%22type%22%3A%5B%22container%22%2C%22image%22%2C%22volume%22%2C%22network%22%5D%7D'],
    [{ kind: 'df' }, '/system/df']
  ] as const)('%o', (req, path) => {
    expect(pathOf(req as never)).toBe(path);
    expect(() => assertAllowed(path)).not.toThrow();
  });

  test('ids are validated', () => {
    for (const id of ['../x', 'ABC123456789', 'a1b2c3', `${ID}/../../start`, `${ID}?x=1`]) expect(() => pathOf({ kind: 'inspect', id })).toThrow();
  });

  test('tail and since are bounded integers', () => {
    expect(() => pathOf({ kind: 'logs', id: ID, follow: true, tail: -1 })).toThrow();
    expect(() => pathOf({ kind: 'logs', id: ID, follow: true, tail: 1.5 })).toThrow();
    expect(() => pathOf({ kind: 'logs', id: ID, follow: true, tail: 10, since: Number.NaN })).toThrow();
  });
});

describe('assertAllowed: a second barrier on the final path', () => {
  test.each([
    '/containers/a1b2c3d4e5f6/start', '/containers/a1b2c3d4e5f6/exec', '/containers/a1b2c3d4e5f6/attach', '/containers/create',
    '/containers/prune', '/images/json', '/v1.41/containers/json', '/containers/json?all=1&x=y', '/containers/A1B2C3D4E5F6/json', '/_ping/..'
  ])('%s is refused', (p) => {
    expect(() => assertAllowed(p)).toThrow();
  });

  test('the allowlist is exactly the nine read endpoints', () => {
    expect(ALLOWED_PATHS.length).toBe(9);
  });
});

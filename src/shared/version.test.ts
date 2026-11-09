import { expect, test } from 'vitest';
import { PROTOCOL_VERSION } from './version';

test('protocol version is a positive integer', () => {
  expect(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0).toBe(true);
});

import { expect, test } from 'vitest';
import { FakeRedis } from './fake-redis';

// The in-process door to the fake's command table (no socket): the live demo's build reads its queues through it
// (src/demo/compile/redis-queues.ts), as main's client would over a connection.
test('command() runs a command in process, on the database asked, as a connection would', () => {
  const fake = new FakeRedis();
  expect(fake.command(['SET', 'greeting', 'hi'])).toBe('OK');
  expect(String(fake.command(['GET', 'greeting']))).toBe('hi');
  expect(fake.command(['GET', 'greeting'], 1)).toBeNull();
  expect(fake.command([Buffer.from('SET'), Buffer.from('k'), Buffer.from('v')], 1)).toBe('OK');
  expect(String(fake.command(['GET', 'k'], 1))).toBe('v');
  expect(fake.log.at(-1)).toEqual(['GET', 'k']);
});

test('errors come back as values with a message, never thrown', () => {
  const fake = new FakeRedis({ deny: ['FLUSHALL'] });
  expect(fake.command(['FLUSHALL'])).toEqual({ message: expect.stringMatching(/^NOPERM/) });
  expect(fake.command(['NOSUCHCOMMAND'])).toEqual({ message: expect.stringMatching(/unknown command/i) });
});

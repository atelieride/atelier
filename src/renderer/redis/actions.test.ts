import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RedisValueReply } from '@shared/redis';

const sent: string[] = [];
const asked: [string, string, string][] = [];
// The Docker view's session helpers, as Redis uses them: the paste, and one "ask in a new session" for the three views.
vi.mock('../docker/actions', () => ({
  sendToSession: (text: string) => { sent.push(text); },
  askInSession: async (name: string, prompt: string, typed: string) => { asked.push([name, prompt, typed]); }
}));

const { askKey, sendKey } = await import('./actions');
const { useRedis } = await import('./store');

const reply = { meta: { type: 'string', ttl: -1, length: 5, encoding: 'raw' }, body: { kind: 'string', text: 'hello' } } as unknown as RedisValueReply;

beforeEach(() => {
  sent.length = 0;
  asked.length = 0;
  (globalThis as unknown as { window: unknown }).window = { atelier: { redis: { value: vi.fn(async () => reply) } } };
  useRedis.setState({ value: null, db: 0 });
});
afterEach(() => { delete (globalThis as unknown as { window?: unknown }).window; });

// ⌥↩ right after picking a key, before its value arrived, did nothing (the value builds the prompt): it waits for it.
test('Send before the value has loaded sends once it has, the value in the prompt', async () => {
  sendKey('cache:a');
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toContain('cache:a');
  expect(sent[0]).toContain('hello');
});

test('Send with the value loaded sends at once, without reading it again', () => {
  useRedis.setState({ value: { key: 'cache:a', reply, at: 0, loading: false, error: null, more: false } });
  sendKey('cache:a');
  expect(sent).toHaveLength(1);
  expect((window as unknown as { atelier: { redis: { value: ReturnType<typeof vi.fn> } } }).atelier.redis.value).not.toHaveBeenCalled();
});

// One "ask in a new session" for Docker, Redis and Databases: Redis's session name and toast through it.
test('Ask in a New Session: a session "redis <key>", the key\'s prompt typed in, Redis\'s toast — through askInSession', () => {
  useRedis.setState({ value: { key: 'cache:a', reply, at: 0, loading: false, error: null, more: false } });
  askKey('cache:a');
  expect(asked).toHaveLength(1);
  const [name, prompt, typed] = asked[0]!;
  expect(name).toBe('redis cache:a');
  expect(prompt).toContain('hello');
  expect(typed).toBe('The cache:a context is in the prompt. Review it and press Enter to send.');
  expect(sent).toEqual([]);
});

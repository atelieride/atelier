import { afterEach, describe, expect, test } from 'vitest';
import { createServer } from 'node:net';
import { FakeRedis } from '../support/fake-redis';
import { NoAuth, NoPerm, RedisClient, Refused, Unknown } from '../../src/main/redis/client';
import { text } from '../../src/main/redis/resp';

let fake: FakeRedis | null = null;
let client: RedisClient | null = null;
afterEach(async () => { client?.close(); client = null; await fake?.stop(); fake = null; });

describe('RedisClient against the fake', () => {
  test('connects, names itself, reads, pipelines and selects databases', async () => {
    fake = await FakeRedis.start();
    fake.str('a', '1');
    fake.str('b', '2', null, 3);
    client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier' });
    expect(fake.connections[0]?.name).toBe('atelier');
    expect(text(await client.call(['GET', 'a']))).toBe('1');
    const [x, y] = await client.pipeline([['GET', 'b'], ['PTTL', 'b']], 3);
    expect(text(x!)).toBe('2');
    expect(y).toBe(-1);
    expect(await client.call(['GET', 'b'])).toBeNull(); // back on db 0
    expect(fake.log.filter((l) => l[0] === 'SELECT').map((l) => l[1])).toEqual(['3', '0']);
  });

  test('refuses commands outside the allowlist before writing a byte', async () => {
    fake = await FakeRedis.start();
    client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier' });
    await expect(client.call(['FLUSHALL'])).rejects.toThrow(/not allowed/);
    await expect(client.call(['DEL', 'a'])).rejects.toThrow(/not allowed/);
    await expect(client.pipeline([['GET', 'a'], ['KEYS', '*']])).rejects.toThrow(/not allowed/);
    expect(fake.log.some((l) => ['FLUSHALL', 'DEL', 'KEYS'].includes(l[0]!))).toBe(false);
  });

  test('writes only through unsafeWrite, which still checks its own table', async () => {
    fake = await FakeRedis.start();
    fake.str('a', '1');
    client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier' });
    expect(await client.unsafeWrite(['UNLINK', 'a'])).toBe(1);
    await expect(client.unsafeWrite(['FLUSHALL'])).rejects.toThrow(/not allowed/);
  });

  test('typed errors: auth, permissions, unknown commands; pipeline replies keep them in place', async () => {
    fake = await FakeRedis.start({ password: 's3cret', deny: ['MONITOR'], unknown: ['CONFIG'] });
    await expect(RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier', auth: { password: 'nope' } })).rejects.toBeInstanceOf(NoAuth);
    const noAuth = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier' });
    await expect(noAuth.call(['PING'])).rejects.toBeInstanceOf(NoAuth);
    noAuth.close();
    client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier', auth: { password: 's3cret' } });
    expect(await client.call(['PING'])).toBe('PONG');
    await expect(client.call(['MONITOR'])).rejects.toBeInstanceOf(NoPerm);
    await expect(client.call(['CONFIG', 'GET', 'dir'])).rejects.toBeInstanceOf(Unknown);
    const [ok, bad] = await client.pipeline([['PING'], ['CONFIG', 'GET', 'dir']]);
    expect(ok).toBe('PONG');
    expect(bad).toHaveProperty('message');
  });

  test('a refused port is Refused; only loopback hosts', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(RedisClient.connect({ kind: 'tcp', port }, { name: 'atelier' })).rejects.toBeInstanceOf(Refused);
    await expect(RedisClient.connect({ kind: 'tcp', port: 6379, host: '10.0.0.1' as '127.0.0.1' }, { name: 'atelier' })).rejects.toThrow(/loopback/);
  });

  test('monitor streams lines until closed; nothing else runs on that connection', async () => {
    fake = await FakeRedis.start();
    client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier-monitor' });
    const lines: string[] = [];
    await client.monitor((l) => lines.push(l));
    const other = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'app' });
    await other.call(['GET', 'cache:x']);
    other.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(lines.some((l) => l.includes('"GET" "cache:x"'))).toBe(true);
    await expect(client.call(['PING'])).rejects.toThrow(/monitor/);
  });

  test('the server going away rejects what is pending and reports the close', async () => {
    fake = await FakeRedis.start();
    let closed = false;
    client = await RedisClient.connect({ kind: 'tcp', port: fake.port }, { name: 'atelier', onClose: () => { closed = true; } });
    fake.dropConnections();
    await new Promise((r) => setTimeout(r, 30));
    expect(closed).toBe(true);
    await expect(client.call(['PING'])).rejects.toThrow();
  });
});

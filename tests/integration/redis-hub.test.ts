import { afterEach, describe, expect, test } from 'vitest';
import { createServer } from 'node:net';
import { FakeRedis } from '../support/fake-redis';
import { acmeStore } from '../support/redis-fixtures';
import { RedisHub, type RedisHubDeps, type RedisSettings } from '../../src/main/redis/hub';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { RedisSnapshot, RedisStatus } from '../../src/shared/redis';

const ROOT = '/code/acme';
let hub: RedisHub | null = null;
let fake: FakeRedis | null = null;
afterEach(async () => { hub?.dispose(); hub = null; await fake?.stop(); fake = null; });

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

function setup(port: number, o: { env?: Record<string, string>; settings?: Partial<RedisSettings> } = {}) {
  const settings: RedisSettings = { ...DEFAULT_SETTINGS, ...o.settings };
  const sent: { ch: string; p: unknown }[] = [];
  const secrets = new Map<string, string>();
  const picks = new Map<string, string>();
  const banners: unknown[] = [];
  const deps: RedisHubDeps = {
    settings: () => settings, focused: () => true, testPorts: [port],
    readEnv: () => o.env ?? {}, readCompose: () => [], dockerContainers: () => [], dockerSecret: async () => null, dockerIps: async () => new Map(),
    terminalPorts: () => [], clientOrigins: async () => new Map(),
    secrets: { read: (id) => secrets.get(id) ?? null, write: (id, v) => { secrets.set(id, v); }, remove: (id) => { secrets.delete(id); } },
    picks: { get: (r) => picks.get(r) ?? null, set: (r, k) => { picks.set(r, k); } },
    brewInstalled: () => false, banner: (b) => { banners.push(b); },
    timing: { tickMs: 40, probeMs: 300, infoFastMs: 80, infoSlowMs: 200, queuesMs: 80, detectMs: 200, monitorFlushMs: 20, connectMs: 300 }
  };
  hub = new RedisHub(deps);
  const wc = { id: 1, send: (ch: string, p: unknown) => { sent.push({ ch, p }); }, isDestroyed: () => false, once: () => {} };
  hub.open(ROOT, wc);
  const last = <T>(ch: string) => [...sent].reverse().find((x) => x.ch === ch)?.p as T | undefined;
  return { settings, sent, secrets, banners, snap: () => last<RedisSnapshot>('ev:redis'), status: () => last<RedisStatus>('ev:redisStatus'), monitor: () => sent.filter((x) => x.ch === 'ev:redisMonitor') };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
}

describe('RedisHub', () => {
  test('no Redis: nothing listed, nothing mentioned, probing done', async () => {
    const h = setup(await freePort());
    await until(() => !!h.snap()?.probed);
    expect(h.snap()).toMatchObject({ instances: [], pick: null, mentions: false });
  });

  test('a running server: listed with its version, INFO polled at the Overview cadence', async () => {
    fake = await FakeRedis.start({ version: '8.4.0' });
    acmeStore(fake);
    const h = setup(fake.port);
    await until(() => h.snap()?.instances[0]?.state === 'running');
    expect(h.snap()!.instances[0]).toMatchObject({ key: `tcp:${fake.port}`, server: { name: 'redis', version: '8.4.0', mode: 'standalone' }, badge: 'local', label: 'Local' });
    expect(h.snap()!.pick).toBe(`tcp:${fake.port}`);
    hub!.watch(1, { db: 0, sidebar: true, queues: false, overview: true, live: false });
    await until(() => (h.status()?.samples.length ?? 0) >= 3);
    expect(h.status()!.info).toMatchObject({ usedMemory: 2642344, keyspace: [{ db: 0 }, { db: 1, keys: 12 }] });
  });

  test('the 10 minutes of INFO samples go only to a window showing the Overview or Live; the footer still gets INFO', async () => {
    fake = await FakeRedis.start();
    acmeStore(fake);
    const h = setup(fake.port);
    await until(() => h.snap()?.instances[0]?.state === 'running');
    hub!.watch(1, { db: 0, sidebar: true, queues: false, overview: false, live: false });
    await until(() => !!h.status()?.info);
    await new Promise((r) => setTimeout(r, 600));
    expect(h.status()!.samples).toEqual([]);
    hub!.watch(1, { db: 0, sidebar: true, queues: false, overview: true, live: false });
    await until(() => (h.status()?.samples.length ?? 0) >= 2);
  });

  test('a password: the project .env one offered by name, Use It authenticates and keeps it in the Keychain', async () => {
    fake = await FakeRedis.start({ password: 's3cret' });
    const h = setup(fake.port, { env: { REDIS_PASSWORD: 's3cret', REDIS_HOST: 'redis-elsewhere' } });
    await until(() => h.snap()?.instances[0]?.state === 'auth');
    expect(h.snap()!.instances[0]!.envPassword).toBe('REDIS_PASSWORD');
    expect(JSON.stringify(h.sent)).not.toContain('s3cret');
    expect(await hub!.auth(1, { key: `tcp:${fake.port}`, password: 'nope' })).toEqual({ ok: false, reason: 'wrong' });
    expect(await hub!.auth(1, { key: `tcp:${fake.port}`, useEnv: true })).toEqual({ ok: true });
    await until(() => h.snap()?.instances[0]?.state === 'running');
    expect([...h.secrets.values()][0]).toContain('s3cret');
    expect(JSON.stringify(h.sent)).not.toContain('s3cret');
  });

  test('queues: counted while the sidebar shows; a new failure is unseen, notified, and seen() clears it', async () => {
    fake = await FakeRedis.start();
    acmeStore(fake);
    const h = setup(fake.port, { settings: { redisNotify: true } });
    hub!.watch(1, { db: 0, sidebar: true, queues: false, overview: false, live: false });
    await until(() => (h.status()?.queues?.length ?? 0) === 4);
    const email = h.status()!.queues!.find((q) => q.name === 'email-queue')!;
    expect(email).toMatchObject({ lib: 'bullmq', counts: { waiting: 12, active: 1, delayed: 2, failed: 3 }, workers: 1, actions: true });
    expect(h.status()!.unseen).toEqual({});
    fake.hash('bull:email-queue:9001', { name: 'send-receipt', failedReason: 'boom', opts: '{"attempts":1}', finishedOn: String(Date.now()), atm: '1' });
    (fake.get('bull:email-queue:failed') as { v: Map<string, number> }).v.set('9001', Date.now());
    await until(() => h.status()?.unseen[email.id] === 1);
    await until(() => h.sent.some((x) => x.ch === 'ev:redisNote'));
    expect(h.sent.find((x) => x.ch === 'ev:redisNote')!.p).toMatchObject({ queue: { name: 'email-queue' }, job: { id: '9001', reason: 'boom' } });
    hub!.seen(1, email.id);
    await until(() => !h.status()?.unseen[email.id]);
  });

  test('live: MONITOR only while Live is watched; our own commands are not in it', async () => {
    fake = await FakeRedis.start();
    acmeStore(fake);
    const h = setup(fake.port);
    await until(() => h.snap()?.instances[0]?.state === 'running');
    expect(fake.log.some((l) => l[0] === 'MONITOR')).toBe(false);
    hub!.watch(1, { db: 0, sidebar: false, queues: false, overview: false, live: true });
    await until(() => fake!.connections.some((c) => c.monitor));
    fake.emitMonitor(['GET', 'cache:products:page:1'], '127.0.0.1:50211');
    await until(() => h.monitor().length > 0);
    const lines = h.monitor().flatMap((m) => (m.p as { lines: { cmd: string; args: string[] }[] }).lines);
    expect(lines.some((l) => l.cmd === 'GET' && l.args[0] === 'cache:products:page:1')).toBe(true);
    expect(lines.some((l) => l.cmd === 'INFO' || l.cmd === 'CLIENT')).toBe(false);
    hub!.watch(1, { db: 0, sidebar: false, queues: false, overview: false, live: false });
    await until(() => !fake!.connections.some((c) => c.monitor));
  });

  test('writes: refused in Read-only, done and undone with Ask first', async () => {
    fake = await FakeRedis.start();
    acmeStore(fake);
    const h = setup(fake.port, { settings: { redisEdits: 'readonly' } });
    await until(() => h.snap()?.instances[0]?.state === 'running');
    expect(await hub!.write(1, { db: 0, instance: `tcp:${fake.port}`, op: { op: 'delete', keys: ['cache:product:8812'] } })).toEqual({ ok: false, reason: 'refused' });
    expect(fake.writes).toEqual([]);
    h.settings.redisEdits = 'ask';
    const r = await hub!.write(1, { db: 0, instance: `tcp:${fake.port}`, op: { op: 'delete', keys: ['cache:product:8812'] } });
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(await hub!.undo(1, r.ok ? r.undo! : '')).toMatchObject({ ok: true });
    expect(fake.get('cache:product:8812')).not.toBeNull();
  });

  test('a server that stops: an expected one says stopped, a common port just disappears', async () => {
    fake = await FakeRedis.start();
    const port = fake.port;
    const h = setup(port, { env: { REDIS_URL: `redis://127.0.0.1:${port}` } });
    await until(() => h.snap()?.instances[0]?.state === 'running');
    expect(h.snap()!.instances[0]).toMatchObject({ hint: "this project's .env (REDIS_URL)", mine: true });
    await fake.stop();
    fake = null;
    await until(() => h.snap()?.instances[0]?.state === 'stopped');
  });

  test('in tests, only the test ports are ever contacted (a Docker Redis on another port is ignored)', async () => {
    fake = await FakeRedis.start();
    const other = await FakeRedis.start();
    const h = setup(fake.port);
    (hub as unknown as { deps: RedisHubDeps }).deps.dockerContainers = () => [{
      id: 'c'.repeat(64), name: 'redis', containerName: 'x-redis-1', project: 'x', service: 'redis', workingDir: '/elsewhere', configFiles: [], image: 'redis:7', state: 'running',
      health: null, exitCode: null, restarts: 0, startedAt: 1, finishedAt: null, ports: [{ host: other.port, container: 6379, proto: 'tcp' }], exposed: [6379], tty: false, oomKilled: false, restartPolicy: 'no'
    }];
    await hub!.probe();
    await until(() => !!h.snap()?.probed);
    expect(other.log).toEqual([]);
    expect(h.snap()!.instances.map((i) => i.key)).toEqual([`tcp:${fake.port}`]);
    await other.stop();
  });

  test('a write names the instance it was confirmed on: refused once the window shows another', async () => {
    fake = await FakeRedis.start();
    acmeStore(fake);
    const h = setup(fake.port);
    await until(() => h.snap()?.instances[0]?.state === 'running');
    expect(await hub!.write(1, { db: 0, instance: 'tcp:1', op: { op: 'flushdb' } })).toEqual({ ok: false, reason: 'moved' });
    await expect(hub!.preview(1, { db: 0, instance: 'tcp:1', pattern: 'cache:*' })).rejects.toThrow(/moved/);
    expect(fake.writes).toEqual([]);
    expect(await hub!.write(1, { db: 0, instance: `tcp:${fake.port}`, op: { op: 'delete', keys: ['rate:api:user:4021'] } })).toMatchObject({ ok: true });
  });

  test('a Keychain that cannot be read leaves the server asking for a password (not "not Redis")', async () => {
    fake = await FakeRedis.start({ password: 'pw' });
    const h = setup(fake.port);
    (hub as unknown as { deps: RedisHubDeps }).deps.secrets = { read: () => { throw new Error('SecretUnavailable'); }, write: () => {}, remove: () => {} };
    await hub!.probe();
    await until(() => h.snap()?.instances[0]?.state === 'auth');
  });

  test('Show Redis = Never: no connection at all', async () => {
    fake = await FakeRedis.start();
    const h = setup(fake.port, { settings: { showRedis: 'never' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.log).toEqual([]);
    expect(hub!.snapshotFor(1)).toMatchObject({ instances: [] });
    void h;
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DOCKER_CHANNELS, DockerHub, type DockerSettings, type HubWindow } from '../../src/main/docker/hub';
import type { DockerNote, DockerSnapshot } from '../../src/shared/docker';
import type { DockerLogLine } from '../../src/shared/docker-logs';
import { FakeDocker } from '../support/fake-docker';

let dir: string;
let fake: FakeDocker;
let hub: DockerHub;
let settings: DockerSettings;
let focused: boolean;
let banners: { title: string; body: string }[];

class Win implements HubWindow {
  sent: { channel: string; payload: unknown }[] = [];
  private gone: (() => void)[] = [];
  constructor(readonly id: number) {}
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload }); }
  isDestroyed() { return false; }
  once(_e: 'destroyed', fn: () => void) { this.gone.push(fn); }
  destroy() { for (const f of this.gone) f(); }
  last<T>(channel: string): T | undefined { return [...this.sent].reverse().find((s) => s.channel === channel)?.payload as T | undefined; }
  all<T>(channel: string): T[] { return this.sent.filter((s) => s.channel === channel).map((s) => s.payload as T); }
}

const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

const ROOT = '/Users/me/code/acme-store';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dkh-'));
  fake = await FakeDocker.start(join(dir, 'd.sock'));
  settings = { showDocker: 'auto', dockerSocket: '', dockerOthers: true, dockerNotify: true, dockerLogLines: 5000, notifySound: true };
  focused = true;
  banners = [];
  hub = new DockerHub({
    settings: () => settings, home: dir, testSocket: fake.socket, focused: () => focused, banner: (b) => banners.push(b),
    timing: { tickMs: 50, probeMs: 200, relistMs: 10_000, debounceMs: 20, lingerMs: 300, flushMs: 10, coalesceMs: 2000, killWindowMs: 2000 }
  });
});
afterEach(async () => {
  hub.dispose();
  expect(fake.nonGet()).toEqual([]);
  await fake.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const snap = (w: Win) => w.last<DockerSnapshot>(DOCKER_CHANNELS.snapshot);
const names = (w: Win) => (snap(w)?.containers ?? []).map((c) => `${c.name}:${c.state}`).sort();

describe('DockerHub against a fake engine', () => {
  test('finds the engine and lists the containers; a change follows an event', async () => {
    const api = fake.add({ name: 'api', project: 'acme-store', workingDir: ROOT, ports: [{ host: 3000, container: 3000 }] }, ['listening']);
    fake.add({ name: 'redis', project: 'acme-store', workingDir: ROOT });
    const w = new Win(1);
    hub.open(ROOT, w);
    await until(() => snap(w)?.engine.state === 'running' && names(w).length === 2);
    expect(snap(w)!.engine).toMatchObject({ state: 'running', name: 'OrbStack', version: '27.3.1' });
    expect(names(w)).toEqual(['api:running', 'redis:running']);
    fake.change(api, { name: 'api', project: 'acme-store', workingDir: ROOT, state: 'exited', exitCode: 0 }, [{ action: 'kill', attrs: { signal: '15' } }, { action: 'die', attrs: { exitCode: '0' } }, { action: 'stop' }]);
    await until(() => names(w).includes('api:exited'));
    // Newest first; the kill is noise (a stop says it).
    expect(hub.eventsList().map((e) => e.action).slice(0, 2)).toEqual(['stop', 'die']);
  });

  test('logs: the history, then live lines, for a watching window only; a minute later they go', async () => {
    const api = fake.add({ name: 'api', project: 'acme-store', workingDir: ROOT }, ['one', 'two']);
    const w = new Win(1);
    const other = new Win(2);
    hub.open(ROOT, w);
    hub.open('/elsewhere', other);
    await until(() => names(w).length === 1);
    hub.watchLogs(1, [api]);
    const got = () => w.all<{ id: string; lines: DockerLogLine[] }>(DOCKER_CHANNELS.logs).flatMap((e) => e.lines.map((l) => l.text));
    await until(() => got().length === 2);
    fake.log(api, 'Error: boom', true);
    await until(() => got().length === 3);
    expect(got()).toEqual(['one', 'two', 'Error: boom']);
    const last = hub.logsOf(api).lines.at(-1)!;
    expect(last).toMatchObject({ err: true, text: 'Error: boom', seq: 3 });
    expect(typeof last.at).toBe('number');
    expect(other.all(DOCKER_CHANNELS.logs)).toEqual([]);
    hub.watchLogs(1, []);
    await until(() => hub.logsOf(api).lines.length === 0, 2000);
  });

  test('logs of a stopped container end; when it starts again they continue without repeating', async () => {
    const spec = { name: 'worker', project: 'acme-store', workingDir: ROOT };
    const id = fake.add(spec, ['booting']);
    const w = new Win(1);
    hub.open(ROOT, w);
    await until(() => names(w).length === 1);
    hub.watchLogs(1, [id]);
    await until(() => hub.logsOf(id).lines.length === 1);
    fake.change(id, { ...spec, state: 'exited', exitCode: 1 }, [{ action: 'die', attrs: { exitCode: '1' } }]);
    await until(() => hub.logsOf(id).ended);
    fake.log(id, 'restarted', false, Date.now() + 5);
    fake.change(id, spec, [{ action: 'start' }]);
    await until(() => hub.logsOf(id).lines.length === 2);
    expect(hub.logsOf(id).lines.map((l) => l.text)).toEqual(['booting', 'restarted']);
  });

  test('a crash notifies the project window (and others when listed); a stop does not; banners only when unfocused, once', async () => {
    const spec = { name: 'worker', project: 'acme-store', workingDir: ROOT };
    const id = fake.add(spec, ['starting', 'Error: connect ECONNREFUSED 127.0.0.1:6379', '    at TCPConnectWrap.afterConnect (node:net:1607:16)']);
    const w = new Win(1);
    const other = new Win(2);
    hub.open(ROOT, w);
    hub.open('/elsewhere', other);
    await until(() => names(w).length === 1);
    focused = false;
    fake.event(id, 'die', { exitCode: '1' });
    await until(() => w.all(DOCKER_CHANNELS.note).length === 1);
    const n = w.last<DockerNote>(DOCKER_CHANNELS.note)!;
    expect(n).toMatchObject({ container: { id, name: 'worker', project: 'acme-store' }, reason: 'crash', exitCode: 1, line: 'Error: connect ECONNREFUSED 127.0.0.1:6379' });
    await until(() => other.all(DOCKER_CHANNELS.note).length === 1);
    expect(banners).toEqual([{ title: 'worker exited (1)', body: 'Error: connect ECONNREFUSED 127.0.0.1:6379', silent: false, containerId: id, root: ROOT }]);
    // Again within the coalescing window (5 min; 2 s here): folded, no entry, no banner.
    fake.event(id, 'die', { exitCode: '1' });
    await new Promise((r) => setTimeout(r, 200));
    expect(w.all(DOCKER_CHANNELS.note)).toHaveLength(1);
    expect(banners).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 2000));
    // docker stop: kill first, then die 143. Nothing.
    fake.event(id, 'kill', { signal: '15' });
    fake.event(id, 'die', { exitCode: '143' });
    await new Promise((r) => setTimeout(r, 200));
    expect(w.all(DOCKER_CHANNELS.note)).toHaveLength(1);
    // Others off: the other project's window no longer hears about it.
    settings = { ...settings, dockerOthers: false };
    hub.settingsChanged();
    await until(() => snap(w)?.engine.state === 'running');
    fake.event(id, 'start');
    fake.event(id, 'oom');
    fake.event(id, 'die', { exitCode: '137' });
    await until(() => w.all(DOCKER_CHANNELS.note).length === 2);
    expect(w.last<DockerNote>(DOCKER_CHANNELS.note)!.reason).toBe('oom');
    expect(other.all(DOCKER_CHANNELS.note)).toHaveLength(1);
  });

  test('a restart (kill, die, start) then a real crash: notified (the kill counts only for its own die)', async () => {
    const spec = { name: 'api', project: 'acme-store', workingDir: ROOT };
    const id = fake.add(spec, ['Error: boom']);
    const w = new Win(1);
    hub.open(ROOT, w);
    await until(() => names(w).length === 1);
    fake.event(id, 'kill', { signal: '15' });
    fake.event(id, 'die', { exitCode: '143' });
    fake.event(id, 'stop');
    fake.event(id, 'start');
    await new Promise((r) => setTimeout(r, 100));
    fake.event(id, 'die', { exitCode: '1' });
    await until(() => w.all(DOCKER_CHANNELS.note).length === 1);
    expect(w.last<DockerNote>(DOCKER_CHANNELS.note)!.reason).toBe('crash');
    // An OOM marker is consumed by its die: a later clean stop is not "out of memory".
    fake.event(id, 'start');
    fake.event(id, 'oom');
    fake.event(id, 'die', { exitCode: '137' });
    await new Promise((r) => setTimeout(r, 2100));
    fake.event(id, 'start');
    fake.event(id, 'die', { exitCode: '2' });
    await until(() => w.all(DOCKER_CHANNELS.note).length >= 2, 4000);
    expect(w.all<DockerNote>(DOCKER_CHANNELS.note).map((n) => n.reason)).toEqual(['crash', 'crash']);
  });

  test('a crash loop (restart: always) notifies once per container per coalescing window, not on every die', async () => {
    const id = fake.add({ name: 'worker', project: 'acme-store', workingDir: ROOT, restartPolicy: 'always' }, ['Error: boom']);
    const w = new Win(1);
    hub.open(ROOT, w);
    await until(() => names(w).length === 1);
    for (let i = 0; i < 5; i++) { fake.event(id, 'die', { exitCode: '1' }); fake.event(id, 'start'); }
    await until(() => w.all(DOCKER_CHANNELS.note).length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(w.all(DOCKER_CHANNELS.note)).toHaveLength(1);
    // After the window (2 s in tests), it may say so again.
    await new Promise((r) => setTimeout(r, 2000));
    fake.event(id, 'die', { exitCode: '1' });
    await until(() => w.all(DOCKER_CHANNELS.note).length === 2);
  });

  test('a socket changed in Settings while a probe is on its way: the new one wins', async () => {
    const other = await FakeDocker.start(join(dir, 'e.sock'));
    try {
      other.info = { ...other.info, OperatingSystem: 'Docker Desktop' };
      const custom = new DockerHub({
        settings: () => settings, home: dir, focused: () => true, banner: () => {},
        timing: { tickMs: 50, probeMs: 200, debounceMs: 20 },
        detect: { version: async (s: string) => { await new Promise((r) => setTimeout(r, 150)); return { Version: '27.3.1', ApiVersion: '1.47', Os: 'linux', Arch: 'arm64', s }; } }
      });
      settings = { ...settings, dockerSocket: fake.socket };
      const w = new Win(1);
      custom.open(ROOT, w);
      await new Promise((r) => setTimeout(r, 30));
      settings = { ...settings, dockerSocket: other.socket };
      custom.settingsChanged();
      await until(() => snap(w)?.engine.state === 'running' && (snap(w)!.engine as { socket: string }).socket === other.socket, 3000);
      await new Promise((r) => setTimeout(r, 400));
      expect((snap(w)!.engine as { socket: string }).socket).toBe(other.socket);
      custom.dispose();
    } finally {
      await other.close();
    }
  });

  test('unhealthy notifies once per change; notifications off: nothing', async () => {
    const spec = { name: 'api', project: 'acme-store', workingDir: ROOT, health: 'healthy' as const };
    const id = fake.add(spec);
    const w = new Win(1);
    hub.open(ROOT, w);
    await until(() => names(w).length === 1);
    fake.event(id, 'health_status: healthy');
    fake.event(id, 'health_status: unhealthy');
    fake.event(id, 'health_status: unhealthy');
    await until(() => w.all(DOCKER_CHANNELS.note).length === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(w.all(DOCKER_CHANNELS.note)).toHaveLength(1);
    expect(hub.eventsList().filter((e) => e.action === 'health').map((e) => e.detail)).toEqual(['unhealthy']);
    settings = { ...settings, dockerNotify: false };
    fake.event(id, 'die', { exitCode: '2' });
    await new Promise((r) => setTimeout(r, 200));
    expect(w.all(DOCKER_CHANNELS.note)).toHaveLength(1);
  });

  test('the engine stops: "stopped", streams end; it comes back: running again', async () => {
    const id = fake.add({ name: 'api', project: 'acme-store', workingDir: ROOT });
    const w = new Win(1);
    hub.open(ROOT, w);
    await until(() => names(w).length === 1);
    hub.watchLogs(1, [id]);
    await fake.close();
    await until(() => snap(w)?.engine.state === 'stopped');
    expect(snap(w)!.containers).toEqual([]);
    // The socket file is gone too: still "stopped" (an engine seen this session), never "absent".
    await new Promise((r) => setTimeout(r, 450));
    expect(snap(w)!.engine).toEqual({ state: 'stopped', socket: fake.socket });
    fake = await FakeDocker.start(join(dir, 'd.sock'));
    fake.add({ name: 'api', project: 'acme-store', workingDir: ROOT });
    hub.onFocus();
    await until(() => snap(w)?.engine.state === 'running' && names(w).length === 1);
  });

  test('no socket at all: absent; Never: no request at all', async () => {
    await fake.close();
    const w = new Win(1);
    hub.open(ROOT, w);
    await new Promise((r) => setTimeout(r, 300));
    expect(snap(w)?.engine.state ?? 'absent').toBe('absent');
    fake = await FakeDocker.start(join(dir, 'd.sock'));
    settings = { ...settings, showDocker: 'never' };
    hub.settingsChanged();
    await new Promise((r) => setTimeout(r, 400));
    expect(fake.requests).toEqual([]);
  });

  test('stats, inspect, disk usage', async () => {
    fake.statsEveryMs = 50;
    const id = fake.add({ name: 'api', project: 'acme-store', workingDir: ROOT, env: ['JWT_SECRET=x', 'NODE_ENV=dev'] });
    const w = new Win(1);
    hub.open(ROOT, w);
    await until(() => names(w).length === 1);
    hub.watchStats(1, [id]);
    await until(() => w.all(DOCKER_CHANNELS.stats).length >= 3);
    const s = w.last<{ id: string; sample: { cpu: number; mem: number; pids: number } }>(DOCKER_CHANNELS.stats)!;
    expect(s.id).toBe(id);
    expect(s.sample.cpu).toBeGreaterThan(10);
    expect(s.sample.mem).toBe(182 * 1024 * 1024);
    expect(s.sample.pids).toBe(23);
    expect(hub.statsOf([id])[id]!.length).toBeGreaterThanOrEqual(3);
    hub.watchStats(1, []);
    expect(hub.statsOf([id])).toEqual({});
    const i = await hub.inspect(id);
    expect(i?.detail.env).toEqual([{ key: 'JWT_SECRET', value: 'x' }, { key: 'NODE_ENV', value: 'dev' }]);
    expect(await hub.inspect('abcdefabcdef')).toBeNull();
    expect((await hub.df())?.buildCache.size).toBe(6_100_000_000);
  });
});

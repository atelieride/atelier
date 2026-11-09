import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { daemonPaths } from '../../src/shared/paths.node';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon } from '../../src/daemon/main';
import { DaemonClient } from '../../src/main/daemon-client';
import { readDaemonInfo, stopStaleDaemon } from '../../src/main/daemon-launcher';
import type { TerminalInfo } from '../../src/shared/protocol';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); }
};

test('create, attach, data and terminal list', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const d = await runDaemon({ home, version: '1.0.0', shellArgs: ['-f'] });
  cleanups.push(() => d.stop());
  const client = new DaemonClient(async () => readDaemonInfo(d.paths.info)!);
  cleanups.push(() => client.stop());
  await client.start();
  expect(client.daemonVersion).toBe('1.0.0');

  const lists: TerminalInfo[][] = [];
  client.on('terminals', (l: TerminalInfo[]) => lists.push(l));
  const info = await client.request<TerminalInfo>({ t: 'create', projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
  await until(() => lists.some((l) => l.some((x) => x.id === info.id)));

  let out = '';
  client.on('data', (id: string, data: string) => { if (id === info.id) out += data; });
  await client.request({ t: 'attach', id: info.id });
  client.send({ t: 'input', id: info.id, data: 'echo dal-client-$((2+2))\r' });
  await until(() => out.includes('dal-client-4'));
});

test('service dies and comes back → the client reconnects on its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  let d = await runDaemon({ home, version: '1.0.0', shellArgs: ['-f'] });
  const client = new DaemonClient(async () => {
    const i = readDaemonInfo(d.paths.info);
    if (!i) throw new Error('service not ready yet');
    return i;
  }, { backoffMs: [50, 100, 200] });
  cleanups.push(() => client.stop());
  await client.start();
  const states: string[] = [];
  client.on('status', (s: string) => states.push(s));

  await d.stop();
  await until(() => states.includes('disconnected'));
  d = await runDaemon({ home, version: '1.0.1', shellArgs: ['-f'] });
  cleanups.push(() => d.stop());
  await until(() => client.connected && client.daemonVersion === '1.0.1');
  expect(states.at(-1)).toBe('connected');
});

test('service error → the request fails with its message', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const d = await runDaemon({ home, version: '1', shellArgs: ['-f'] });
  cleanups.push(() => d.stop());
  const client = new DaemonClient(async () => readDaemonInfo(d.paths.info)!, { requestTimeoutMs: 300 });
  cleanups.push(() => client.stop());
  await client.start();
  await expect(client.request({ t: 'attach', id: 'inesistente' })).rejects.toThrow(/unknown terminal/);
});

test('unresponsive service → timeout, the request doesn\'t hang', async () => {
  // A fake service that welcomes and then goes silent.
  const dir = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const sock = join(dir, 's.sock');
  const server = net.createServer((s) => {
    s.once('data', () => s.write(JSON.stringify({ t: 'welcome', v: 1, version: 'muto', pid: 1 }) + '\n'));
  });
  await new Promise<void>((r) => server.listen(sock, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const client = new DaemonClient(async () => ({ sock, token: 't', pid: 1, version: 'muto', startedAt: 0 }), { requestTimeoutMs: 200 });
  cleanups.push(() => client.stop());
  await client.start();
  await expect(client.request({ t: 'list' })).rejects.toThrow(/not responding/);
});

test('readDaemonInfo: missing or malformed file → null', () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  expect(readDaemonInfo(join(home, 'nessuno.json'))).toBeNull();
});

test('service that accepts but sends no welcome → start fails within the timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const sock = join(dir, 's.sock');
  const server = net.createServer((s) => { s.resume(); /* reads and discards, never replies */ });
  await new Promise<void>((r) => server.listen(sock, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const client = new DaemonClient(async () => ({ sock, token: 't', pid: 1, version: 'x', startedAt: 0 }), { welcomeTimeoutMs: 300, backoffMs: [60000] });
  cleanups.push(() => client.stop());
  const t0 = Date.now();
  await expect(client.start()).rejects.toThrow(/did not send welcome/);
  expect(Date.now() - t0).toBeLessThan(2000);
});

test('incompatible protocol → dedicated state, no retry loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const sock = join(dir, 's.sock');
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    s.once('data', () => s.end(JSON.stringify({ t: 'incompatible', v: 99 }) + '\n'));
  });
  await new Promise<void>((r) => server.listen(sock, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const client = new DaemonClient(async () => ({ sock, token: 't', pid: 1, version: 'x', startedAt: 0 }), { backoffMs: [50] });
  cleanups.push(() => client.stop());
  const states: string[] = [];
  client.on('status', (s: string) => states.push(s));
  await expect(client.start()).rejects.toThrow(/incompatible/);
  await new Promise((r) => setTimeout(r, 400));
  expect(states).toContain('incompatible');
  expect(connections).toBe(1);
});

test('request made before the service is ready → waits for the connection instead of failing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  let d: Awaited<ReturnType<typeof runDaemon>> | null = null;
  const client = new DaemonClient(async () => {
    const i = d && readDaemonInfo(d.paths.info);
    if (!i) throw new Error('service not ready yet');
    return i;
  }, { backoffMs: [50] });
  cleanups.push(() => client.stop());
  void client.start().catch(() => {});
  const pending = client.request<unknown[]>({ t: 'list' });
  await new Promise((r) => setTimeout(r, 300));
  d = await runDaemon({ home, version: '1', shellArgs: ['-f'] });
  cleanups.push(() => d!.stop());
  await expect(pending).resolves.toEqual([]);
});

test('launcher: failed attempts leave no open descriptors', async () => {
  const { ensureDaemon } = await import('../../src/main/daemon-launcher');
  const { readdirSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'atl-fd-'));
  const count = () => readdirSync('/dev/fd').length;
  const before = count();
  for (let i = 0; i < 5; i++) {
    await expect(ensureDaemon({ execPath: process.execPath, script: join(home, 'non-esiste.js'), version: 't', home, timeoutMs: 200 })).rejects.toThrow();
  }
  expect(count() - before).toBeLessThanOrEqual(1);
});

test('incompatible service → the old atelierd is stopped and the client connects to the new one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const paths = daemonPaths(home);
  mkdirSync(paths.home, { recursive: true });
  // An old atelierd (same script name) speaking a different protocol.
  const dir = mkdtempSync(join(tmpdir(), 'atl-old-'));
  const script = join(dir, 'daemon.js');
  writeFileSync(script, `
    const net = require('net'), fs = require('fs');
    const [sock, info] = process.argv.slice(2);
    const s = net.createServer((c) => c.once('data', () => c.end(JSON.stringify({ t: 'incompatible', v: 99 }) + '\\n')));
    s.listen(sock, () => fs.writeFileSync(info, JSON.stringify({ pid: process.pid, version: 'old', sock, token: 't', startedAt: 1 })));
    process.on('SIGTERM', () => { s.close(); try { fs.unlinkSync(info); } catch {} process.exit(0); });
  `);
  const old = spawn(process.execPath, [script, join(dir, 's.sock'), paths.info], { stdio: 'ignore' });
  cleanups.push(() => { old.kill('SIGKILL'); });
  await until(() => readDaemonInfo(paths.info) !== null);
  const oldPid = readDaemonInfo(paths.info)!.pid;

  const client = new DaemonClient(async () => {
    const i = readDaemonInfo(paths.info);
    if (!i) throw new Error('service not ready yet');
    return i;
  }, { backoffMs: [50] });
  cleanups.push(() => client.stop());
  await expect(client.start()).rejects.toThrow(/incompatible/);

  expect(await stopStaleDaemon(paths.info)).toBe(true);
  expect(() => process.kill(oldPid, 0)).toThrow();
  const d = await runDaemon({ home, version: '2.0.0', shellArgs: ['-f'] });
  cleanups.push(() => d.stop());
  await client.retry();
  expect(client.connected).toBe(true);
  expect(client.daemonVersion).toBe('2.0.0');
});

test('stopStaleDaemon doesn\'t touch a process that isn\'t atelierd', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const paths = daemonPaths(home);
  mkdirSync(paths.home, { recursive: true });
  const other = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  cleanups.push(() => { other.kill('SIGKILL'); });
  writeFileSync(paths.info, JSON.stringify({ pid: other.pid, version: 'x', sock: '/nessuno', token: 't', startedAt: 1 }));
  expect(await stopStaleDaemon(paths.info)).toBe(false);
  expect(() => process.kill(other.pid!, 0)).not.toThrow();
});

test('capabilities: read from welcome; an atelierd without them (older than profiles) has none', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const d = await runDaemon({ home, version: '1', shellArgs: ['-f'] });
  cleanups.push(() => d.stop());
  const client = new DaemonClient(async () => readDaemonInfo(d.paths.info)!);
  cleanups.push(() => client.stop());
  expect(client.hasCapability('profiles')).toBe(false);
  await client.start();
  expect(client.hasCapability('profiles')).toBe(true);
  // Test flag: the app behaves as with an older atelierd.
  const hidden = new DaemonClient(async () => readDaemonInfo(d.paths.info)!, { hideCapabilities: true });
  cleanups.push(() => hidden.stop());
  await hidden.start();
  expect(hidden.hasCapability('profiles')).toBe(false);
  expect(hidden.hasCapability('states2')).toBe(false);
  // Only some hidden: an atelierd with profiles but older than v2.0.
  const partly = new DaemonClient(async () => readDaemonInfo(d.paths.info)!, { hideCapabilities: ['states2'] });
  cleanups.push(() => partly.stop());
  await partly.start();
  expect(partly.hasCapability('profiles')).toBe(true);
  expect(partly.hasCapability('states2')).toBe(false);

  // An older atelierd: a welcome with no capabilities field.
  const dir = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const sock = join(dir, 's.sock');
  const server = net.createServer((s) => { s.once('data', () => s.write(JSON.stringify({ t: 'welcome', v: 1, version: 'old', pid: 1 }) + '\n')); });
  await new Promise<void>((r) => server.listen(sock, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const old = new DaemonClient(async () => ({ sock, token: 't', pid: 1, version: 'old', startedAt: 0 }));
  cleanups.push(() => old.stop());
  await old.start();
  expect(old.connected).toBe(true);
  expect(old.hasCapability('profiles')).toBe(false);
});

test('capabilities are forgotten when the connection drops (the next atelierd may be another one)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const d = await runDaemon({ home, version: '1', shellArgs: ['-f'] });
  const client = new DaemonClient(async () => readDaemonInfo(d.paths.info)!, { backoffMs: [60000] });
  cleanups.push(() => client.stop());
  await client.start();
  const seen: boolean[] = [];
  client.on('status', () => seen.push(client.hasCapability('profiles')));
  await d.stop();
  await until(() => !client.connected);
  expect(client.hasCapability('profiles')).toBe(false);
  expect(seen.at(-1)).toBe(false);
});

test('a request can wait longer than the default timeout (reloadEnv replies after the capture, up to ~10 s)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const sock = join(dir, 's.sock');
  const server = net.createServer((s) => {
    s.setEncoding('utf8');
    let first = true;
    s.on('data', (chunk: string) => {
      if (first) { first = false; s.write(JSON.stringify({ t: 'welcome', v: 1, version: 'x', pid: 1, capabilities: ['profiles'] }) + '\n'); return; }
      const rid = (JSON.parse(chunk.trim()) as { rid: number }).rid;
      setTimeout(() => s.write(JSON.stringify({ t: 'reply', rid, ok: true, result: { capturedAt: 7 } }) + '\n'), 300);
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const client = new DaemonClient(async () => ({ sock, token: 't', pid: 1, version: 'x', startedAt: 0 }), { requestTimeoutMs: 100 });
  cleanups.push(() => client.stop());
  await client.start();
  await expect(client.request({ t: 'reloadEnv' }, { timeoutMs: 2000 })).resolves.toEqual({ capturedAt: 7 });
});

// A message that depends on the connected atelierd (its capabilities, e.g. whether to send a profile) is built only
// once the connection is up: during an atelierd restart a new terminal would otherwise lose its profile.
test('a request built by a function is built once connected, with the capabilities of the atelierd it goes to', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  let d: Awaited<ReturnType<typeof runDaemon>> | null = null;
  const client = new DaemonClient(async () => {
    const i = d && readDaemonInfo(d.paths.info);
    if (!i) throw new Error('service not ready yet');
    return i;
  }, { backoffMs: [50] });
  cleanups.push(() => client.stop());
  void client.start().catch(() => {});
  let capable: boolean | null = null;
  const pending = client.request<unknown[]>(() => { capable = client.hasCapability('profiles'); return { t: 'list' }; });
  await new Promise((r) => setTimeout(r, 300));
  expect(capable).toBeNull();
  d = await runDaemon({ home, version: '1', shellArgs: ['-f'] });
  cleanups.push(() => d!.stop());
  await expect(pending).resolves.toEqual([]);
  expect(capable).toBe(true);
  // A builder that throws fails its request, nothing else.
  await expect(client.request(() => { throw new Error('profile not available'); })).rejects.toThrow('profile not available');
});

test('shellEnv: the capture state arrives after welcome and on every change', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-c-'));
  const zdot = mkdtempSync(join(tmpdir(), 'atl-cz-'));
  writeFileSync(join(zdot, '.zshrc'), '[[ -t 0 ]] || exit 3\n');
  const d = await runDaemon({ home, version: '1', shellArgs: ['-f'], userZdotdir: zdot, captureShellEnv: true, extraEnv: { HOME: home } });
  cleanups.push(() => d.stop());
  const client = new DaemonClient(async () => readDaemonInfo(d.paths.info)!);
  cleanups.push(() => client.stop());
  const states: { state: string; error?: string }[] = [];
  client.on('shellEnv', (s: { state: string; error?: string }) => states.push(s));
  await client.start();
  await until(() => states.some((s) => s.state === 'failed'), 10000);
  expect(states.find((s) => s.state === 'failed')!.error).toMatch(/exited \(3\)/);
});

test('toolCalls frames reach the app only when atelierd announced the capability', async () => {
  const list = [{ id: 'b1', terminalId: 't1', sessionId: 's1', agent: 'main', tool: 'Bash', start: 1, end: null }];
  const serve = async (capabilities: string[] | undefined, opts: { hideCapabilities?: string[] } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'atl-c-'));
    const sock = join(dir, 's.sock');
    const server = net.createServer((s) => {
      s.once('data', () => s.write(JSON.stringify({ t: 'welcome', v: 1, version: 'x', pid: 1, ...(capabilities ? { capabilities } : {}) }) + '\n' + JSON.stringify({ t: 'toolCalls', list, full: true }) + '\n'));
    });
    await new Promise<void>((r) => server.listen(sock, r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const client = new DaemonClient(async () => ({ sock, token: 't', pid: 1, version: 'x', startedAt: 0 }), opts as never);
    cleanups.push(() => client.stop());
    const got: unknown[][] = [];
    client.on('toolCalls', (...a: unknown[]) => got.push(a));
    await client.start();
    await new Promise((r) => setTimeout(r, 100));
    return got;
  };
  expect(await serve(undefined)).toEqual([]);
  expect(await serve(['profiles'])).toEqual([]);
  expect(await serve(['profiles', 'toolcalls'], { hideCapabilities: ['toolcalls'] })).toEqual([]);
  expect(await serve(['profiles', 'toolcalls'])).toEqual([[list, true]]);
});

test('the signals notebook reaches the app only when atelierd announced the capability', async () => {
  const book = { lastVersion: '2.1.320', since: 1, entries: [{ kind: 'notification', event: 'Notification', value: 'quota_new_thing', version: '2.1.320', first: 1, last: 1, count: 1 }] };
  const serve = async (capabilities: string[] | undefined, opts: { hideCapabilities?: string[] } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'atl-c-'));
    const sock = join(dir, 's.sock');
    const frames = [{ t: 'welcome', v: 1, version: 'x', pid: 1, ...(capabilities ? { capabilities } : {}) }, { t: 'signals', book }];
    const server = net.createServer((s) => { s.once('data', () => s.write(frames.map((m) => JSON.stringify(m) + '\n').join(''))); });
    await new Promise<void>((r) => server.listen(sock, r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const client = new DaemonClient(async () => ({ sock, token: 't', pid: 1, version: 'x', startedAt: 0 }), opts as never);
    cleanups.push(() => client.stop());
    const got: unknown[] = [];
    client.on('signals', (b: unknown) => got.push(b));
    await client.start();
    await new Promise((r) => setTimeout(r, 100));
    return got;
  };
  expect(await serve(undefined)).toEqual([]);
  expect(await serve(['profiles', 'schedules'])).toEqual([]);
  expect(await serve(['profiles', 'signals'], { hideCapabilities: ['signals'] })).toEqual([]);
  expect(await serve(['profiles', 'signals'])).toEqual([book]);
});

test('limits per config dir: forwarded with the capability, the app-wide value wrapped as one entry without it', async () => {
  const usage = { fiveHour: { pct: 22, resetsAt: 4102444800 }, sevenDay: null, updatedAt: 1 };
  const byDir = [{ configDir: '/u/.claude', usage: { ...usage, fiveHour: { pct: 0, resetsAt: 4102444900 } } }, { configDir: '/u/.claude_ops', usage }];
  const serve = async (capabilities: string[], opts: { hideCapabilities?: string[] } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'atl-c-'));
    const sock = join(dir, 's.sock');
    const frames = [{ t: 'welcome', v: 1, version: 'x', pid: 1, capabilities }, { t: 'usage', usage }, { t: 'usageByConfigDir', list: byDir }];
    const server = net.createServer((s) => { s.once('data', () => s.write(frames.map((m) => JSON.stringify(m) + '\n').join(''))); });
    await new Promise<void>((r) => server.listen(sock, r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const client = new DaemonClient(async () => ({ sock, token: 't', pid: 1, version: 'x', startedAt: 0 }), opts as never);
    cleanups.push(() => client.stop());
    const got: unknown[] = [];
    client.on('usageByConfigDir', (list: unknown) => got.push(list));
    await client.start();
    await new Promise((r) => setTimeout(r, 100));
    return got;
  };
  expect(await serve(['profiles', 'config-dirs'])).toEqual([byDir]);
  expect(await serve(['profiles'])).toEqual([[{ configDir: null, usage }]]);
  expect(await serve(['profiles', 'config-dirs'], { hideCapabilities: ['config-dirs'] })).toEqual([[{ configDir: null, usage }]]);
});

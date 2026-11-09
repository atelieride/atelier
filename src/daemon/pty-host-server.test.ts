import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyHostServer, type HostEvents } from './pty-host-server';

// atelierd's host socket: pty-host.js fetches its launch with a one-time token, then the
// native host reports started / exit (or failed) on a connection of its own. Separate from the app's socket.

let server: PtyHostServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

const launch = { slave: '/dev/ttys999', cwd: '/tmp', file: '/bin/zsh', args: ['-l'], env: { TERM: 'xterm-256color', SECRET: 's' } };

async function start(): Promise<{ sock: string; events: HostEvents & Record<string, ReturnType<typeof vi.fn>> }> {
  const sock = join(mkdtempSync(join(tmpdir(), 'atl-hs-')), 'h.sock');
  server = await PtyHostServer.start(sock, () => {});
  const events = { started: vi.fn(), failed: vi.fn(), exit: vi.fn(), lost: vi.fn(), timeout: vi.fn() };
  return { sock, events };
}

/** Sends lines on a new connection; resolves with what the server wrote back once it closed. */
function talk(sock: string, lines: string[], o: { keepOpen?: boolean } = {}): Promise<{ reply: string; socket: net.Socket }> {
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    let reply = '';
    s.setEncoding('utf8');
    s.on('data', (d: string) => { reply += d; });
    s.on('connect', () => { for (const l of lines) s.write(l + '\n'); if (o.keepOpen) setTimeout(() => resolve({ reply, socket: s }), 100); else setTimeout(() => s.end(), 30); });
    s.on('close', () => resolve({ reply, socket: s }));
    s.on('error', () => resolve({ reply, socket: s }));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('the socket is private to the user', async () => {
  const { sock } = await start();
  expect(statSync(sock).mode & 0o777).toBe(0o600);
});

test('fetch returns the launch once; a second fetch with the same token gets nothing', async () => {
  const { sock, events } = await start();
  const { token } = server!.issue(launch, events);
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  const first = await talk(sock, [JSON.stringify({ t: 'fetch', token })]);
  expect(JSON.parse(first.reply)).toEqual({ t: 'launch', ...launch });
  const second = await talk(sock, [JSON.stringify({ t: 'fetch', token })]);
  expect(second.reply).toBe('');
});

test('started then exit on one connection reach the events in order', async () => {
  const { sock, events } = await start();
  const { token } = server!.issue(launch, events);
  await talk(sock, [JSON.stringify({ t: 'fetch', token })]);
  await talk(sock, [JSON.stringify({ t: 'hello', token }), JSON.stringify({ t: 'started', pid: 4242, coalition: 61000 }), JSON.stringify({ t: 'exit', code: 7, signal: 0 })]);
  await settle();
  expect(events.started).toHaveBeenCalledWith(4242, 61000);
  expect(events.exit).toHaveBeenCalledWith(7, 0);
  expect(events.lost).not.toHaveBeenCalled();
});

test('a report connection that closes without exit is "lost" (the host was killed, e.g. a force quit)', async () => {
  const { sock, events } = await start();
  const { token } = server!.issue(launch, events);
  await talk(sock, [JSON.stringify({ t: 'fetch', token })]);
  await talk(sock, [JSON.stringify({ t: 'hello', token }), JSON.stringify({ t: 'started', pid: 1, coalition: 0 })]);
  await settle();
  expect(events.started).toHaveBeenCalled();
  expect(events.lost).toHaveBeenCalledTimes(1);
  expect(events.exit).not.toHaveBeenCalled();
});

test('failed is reported once, and the token is spent', async () => {
  const { sock, events } = await start();
  const { token } = server!.issue(launch, events);
  await talk(sock, [JSON.stringify({ t: 'fetch', token })]);
  await talk(sock, [JSON.stringify({ t: 'hello', token }), JSON.stringify({ t: 'failed', step: 16, errno: 2 })]);
  await talk(sock, [JSON.stringify({ t: 'hello', token }), JSON.stringify({ t: 'started', pid: 1, coalition: 0 })]);
  await settle();
  expect(events.failed).toHaveBeenCalledWith(16, 2);
  expect(events.started).not.toHaveBeenCalled();
});

test('hello before fetch, an unknown token, a revoked token or garbage are refused', async () => {
  const { sock, events } = await start();
  const issued = server!.issue(launch, events);
  await talk(sock, [JSON.stringify({ t: 'hello', token: issued.token }), JSON.stringify({ t: 'started', pid: 1, coalition: 0 })]);
  expect((await talk(sock, [JSON.stringify({ t: 'fetch', token: 'f'.repeat(32) })])).reply).toBe('');
  expect((await talk(sock, ['not json'])).reply).toBe('');
  expect((await talk(sock, [JSON.stringify({ t: 'fetch', token: issued.token, extra: 1 })])).reply).toBe('');
  issued.revoke();
  expect((await talk(sock, [JSON.stringify({ t: 'fetch', token: issued.token })])).reply).toBe('');
  await settle();
  expect(events.started).not.toHaveBeenCalled();
});

test('a host that never fetches, or never reports after fetching, times out once', async () => {
  const { sock, events } = await start();
  server!.issue(launch, events, { fetchMs: 60, reportMs: 60 });
  const other = { started: vi.fn(), failed: vi.fn(), exit: vi.fn(), lost: vi.fn(), timeout: vi.fn() };
  const fetched = server!.issue(launch, other, { fetchMs: 60, reportMs: 60 });
  await talk(sock, [JSON.stringify({ t: 'fetch', token: fetched.token })]);
  await new Promise((r) => setTimeout(r, 200));
  expect(events.timeout).toHaveBeenCalledTimes(1);
  expect(other.timeout).toHaveBeenCalledTimes(1);
  // Spent: a late fetch gets nothing.
  expect((await talk(sock, [JSON.stringify({ t: 'fetch', token: fetched.token })])).reply).toBe('');
});

test('a connection that says nothing is dropped', async () => {
  const { sock } = await start();
  const s = net.createConnection(sock);
  const closed = new Promise((r) => s.on('close', r));
  await closed;
}, 5000);

test('a host that said hello is never timed out while fork and exec are slow; a hello without started is a failure', async () => {
  const { sock, events } = await start();
  const { token } = server!.issue(launch, events, { fetchMs: 60, reportMs: 60 });
  await talk(sock, [JSON.stringify({ t: 'fetch', token })]);
  const slow = await talk(sock, [JSON.stringify({ t: 'hello', token })], { keepOpen: true });
  // Well past the 2 s header window and the report timer.
  await new Promise((r) => setTimeout(r, 2300));
  expect(slow.socket.destroyed).toBe(false);
  expect(events.timeout).not.toHaveBeenCalled();
  slow.socket.write(JSON.stringify({ t: 'started', pid: 9, coalition: 1 }) + '\n');
  await settle();
  expect(events.started).toHaveBeenCalledWith(9, 1);
  slow.socket.end();

  const other = { started: vi.fn(), failed: vi.fn(), exit: vi.fn(), lost: vi.fn(), timeout: vi.fn() };
  const second = server!.issue(launch, other);
  await talk(sock, [JSON.stringify({ t: 'fetch', token: second.token })]);
  await talk(sock, [JSON.stringify({ t: 'hello', token: second.token })]);
  await settle();
  expect(other.failed).toHaveBeenCalledWith(-1, 0);
  expect(other.lost).not.toHaveBeenCalled();
}, 10_000);

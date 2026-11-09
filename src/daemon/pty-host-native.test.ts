import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, writeSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tty from 'node:tty';
// @ts-expect-error plain ESM build script
import { compilePtyHost } from '../../scripts/build-pty-host.mjs';
import { ptyNative } from './pty-native';

// The native PTY host, driven directly as atelierd would after the launchd
// job's execve: a PTY opened here, a report socket served here. No launchd involved.
const native = ptyNative();

let dir: string;
let host: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atl-ph-'));
  host = join(dir, 'atelier-pty-host');
  compilePtyHost(host);
});

interface Run { output: string; messages: Record<string, unknown>[]; hostCode: number | null }

const servers: net.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

/** Runs the host on a fresh PTY: `script` is /bin/sh -c's argument; `input` is typed once the shell started. */
async function runHost(script: string, o: { input?: string; env?: Record<string, string>; file?: string; args?: string[]; cwd?: string; proto?: string; token?: string; extraFds?: boolean; noServer?: boolean; ignoreChld?: boolean } = {}): Promise<Run> {
  const pty = native.open(100, 30);
  const sock = join(dir, `r${servers.length}.sock`);
  const messages: Record<string, unknown>[] = [];
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>((r) => { resolveStarted = r; });
  let reportClosed: () => void = () => {};
  const closed = new Promise<void>((r) => { reportClosed = r; });
  if (!o.noServer) {
    const server = net.createServer((c) => {
      let buf = '';
      c.setEncoding('utf8');
      c.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const m = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
          buf = buf.slice(i + 1);
          messages.push(m);
          if (m.t === 'started' || m.t === 'failed') resolveStarted();
        }
      });
      c.on('close', () => reportClosed());
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
  } else {
    reportClosed();
  }
  let output = '';
  const reader = new tty.ReadStream(pty.master);
  reader.setEncoding('utf8');
  reader.on('data', (d: string) => { output += d; });
  const readerDone = new Promise<void>((r) => { reader.on('error', () => r()); reader.on('close', () => r()); });
  const argv = [o.proto ?? '1', sock, o.token ?? 'abc123', pty.pty, o.cwd ?? dir, o.file ?? '/bin/sh', ...(o.args ?? ['-c', script])];
  // ignoreChld: the host inherits SIGCHLD ignored through execve (sh's trap "" CHLD), as a careless parent could leave it.
  const child = o.ignoreChld ? spawn('/bin/sh', ['-c', 'trap "" CHLD; exec "$@"', 'sh', host, ...argv], { env: { PATH: '/usr/bin:/bin', ...o.env }, stdio: 'ignore' }) : spawn(host, argv, { env: { PATH: '/usr/bin:/bin', ...o.env }, stdio: o.extraFds ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : 'ignore' });
  const hostCode = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  if (!o.noServer) {
    await Promise.race([started, hostCode]);
    // As atelierd does on "started": the shell holds the slave now.
    closeSync(pty.slave);
    if (o.input) { await new Promise((r) => setTimeout(r, 300)); writeSync(pty.master, o.input); }
  } else {
    closeSync(pty.slave);
  }
  const code = await hostCode;
  await closed;
  await Promise.race([readerDone, new Promise((r) => setTimeout(r, 500))]);
  reader.destroy();
  return { output, messages, hostCode: code };
}

test('runs the shell on the PTY as its controlling terminal, in its cwd and env, and reports started then exit', async () => {
  const r = await runHost('echo "cwd=$(pwd) foo=$FOO"; echo probe > /dev/tty && echo ctty=yes; stty size; stty -a | tr " " "\\n" | grep -x -e iutf8 -e -iutf8; exit 7', { env: { FOO: 'bar', PWD: dir } });
  expect(r.output).toContain(`cwd=${dir} foo=bar`);
  expect(r.output).toContain('ctty=yes');
  expect(r.output).toContain('30 100');
  expect(r.output).toMatch(/(^|\s)iutf8(\s|$)/m);
  expect(r.output).not.toContain('-iutf8');
  // hello as soon as it connects (before fork: a slow fork/exec never looks like a silent connection), then started.
  expect(r.messages.map((m) => m.t)).toEqual(['hello', 'started', 'exit']);
  expect(r.messages[0]).toEqual({ t: 'hello', token: 'abc123' });
  // Exactly what atelierd's host socket accepts (pty-host-server.ts parses these strictly).
  expect(r.messages[1]).toEqual({ t: 'started', pid: expect.any(Number), coalition: expect.any(Number) });
  expect(r.messages[2]).toEqual({ t: 'exit', code: 7, signal: 0 });
  expect(r.hostCode).toBe(7);
});

test('^C reaches the foreground process group; a death by signal is reported as such', async () => {
  const r = await runHost('exec sleep 30', { input: '\x03' });
  expect(r.messages.at(-1)).toEqual({ t: 'exit', code: 0, signal: 2 });
  expect(r.hostCode).toBe(130);
});

test('the shell gets fds 0-2 only and default signal dispositions (SIGPIPE not ignored)', async () => {
  const r = await runHost('for f in 3 4 5 6; do [ -e /dev/fd/$f ] && echo leak$f; done; yes | head -n 1 >/dev/null; echo checked', { extraFds: true });
  expect(r.output).toContain('checked');
  expect(r.output).not.toMatch(/leak\d/);
  expect(r.output).not.toContain('Broken pipe');
});

test('a shell that cannot start is reported as failed, never as started', async () => {
  const r = await runHost('', { file: '/nonexistent/shell', args: [] });
  expect(r.messages.map((m) => m.t)).toEqual(['hello', 'failed']);
  expect(r.messages[1]).toEqual({ t: 'failed', step: 16, errno: 2 });
  expect(r.hostCode).toBe(1);
});

test('a missing cwd fails like node-pty spawn-helper did (exit 1), without starting the shell', async () => {
  const r = await runHost('echo never', { cwd: join(dir, 'missing') });
  expect(r.messages[1]).toMatchObject({ t: 'failed', step: 15 });
  expect(r.output).not.toContain('never');
});

test('refuses an unknown host protocol, a malformed token, and an unreachable atelierd', async () => {
  expect((await runHost('true', { proto: '2', noServer: true })).hostCode).toBe(64);
  expect((await runHost('true', { token: 'NOT-HEX', noServer: true })).hostCode).toBe(64);
  expect((await runHost('true', { noServer: true })).hostCode).toBe(69);
});

test('--coalition prints the resource and jetsam coalitions of a pid', () => {
  const out = execFileSync(host, ['--coalition', String(process.pid)], { encoding: 'utf8' });
  expect(out).toMatch(/^\d+ \d+\n$/);
});

test('an inherited ignored SIGCHLD does not lose the shell\'s exit code', async () => {
  const r = await runHost('exit 7', { ignoreChld: true });
  expect(r.messages.at(-1)).toEqual({ t: 'exit', code: 7, signal: 0 });
});

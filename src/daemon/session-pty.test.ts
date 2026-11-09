import { afterEach, expect, test, vi } from 'vitest';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { HostEvents, HostLaunch } from './pty-host-server';
import { ptyNative } from './pty-native';
import { isolatedSpawner, type IsolationDeps, type PtyProcess, type PtySpawnOptions } from './session-pty';

// The isolated terminal: the PTY opened here, the shell started by a launchd job
// that atelierd only hears from through the host socket. Here the test plays launchd and the host: it opens the slave
// like the shell would and fires the host events.

const native = ptyNative();
const opts: PtySpawnOptions = { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: { A: 'b' }, encoding: 'utf8' };

interface Harness {
  deps: IsolationDeps;
  issued: { launch: HostLaunch; events: HostEvents; revoked: boolean }[];
  bootstrapped: { label: string; plist: string }[];
  bootedOut: string[];
  direct: ReturnType<typeof vi.fn>;
  kills: [number, string][];
  logs: string[];
  failBootstrap: boolean;
}

const open: number[] = [];
afterEach(() => { for (const fd of open.splice(0)) try { closeSync(fd); } catch { /* closed */ } });

function harness(): Harness {
  const h: Harness = {
    issued: [], bootstrapped: [], bootedOut: [], kills: [], logs: [], failBootstrap: false,
    direct: vi.fn(() => fakeDirect()),
    deps: undefined as unknown as IsolationDeps
  };
  h.deps = {
    launchd: {
      bootstrap: async (label, plist) => { if (h.failBootstrap) throw new Error('Bootstrap failed: 5'); h.bootstrapped.push({ label, plist }); },
      bootout: async (label) => { h.bootedOut.push(label); return true; }
    },
    server: {
      issue: (launch, events) => {
        const entry = { launch, events, revoked: false };
        h.issued.push(entry);
        return { token: 'f'.repeat(32), revoke: () => { entry.revoked = true; } };
      }
    },
    native,
    label: (id) => `dev.useatelier.session.0123456789ab.${id}`,
    program: (token) => ['/A/Atelier', '/h/bin/pty-host.js', '/h/bin/atelier-pty-host', '/h/run/pty-host.sock', token],
    stderr: '/h/logs/atelierd.log',
    direct: h.direct as unknown as IsolationDeps['direct'],
    kill: (pid, sig) => { h.kills.push([pid, sig]); },
    log: (m) => { h.logs.push(m); }
  };
  return h;
}

function fakeDirect(): PtyProcess & { emitter: EventEmitter; written: string[] } {
  const emitter = new EventEmitter();
  const written: string[] = [];
  return {
    emitter, written, pid: 777, process: 'zsh',
    onData: (l) => { emitter.on('data', l); return { dispose: () => emitter.off('data', l) }; },
    onExit: (l) => { emitter.on('exit', l); return { dispose: () => emitter.off('exit', l) }; },
    write: (d) => { written.push(d); },
    resize: vi.fn(),
    kill: vi.fn()
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Opens the slave as the shell would (after the host's setsid): what the terminal writes arrives here. */
function attachShell(slave: string): number {
  const fd = openSync(slave, 'r+');
  open.push(fd);
  return fd;
}

function readSlave(fd: number): string {
  const b = Buffer.alloc(4096);
  try { return b.subarray(0, readSync(fd, b, 0, b.length, null)).toString('utf8'); } catch { return ''; }
}

function collect(p: PtyProcess) {
  const data: string[] = [];
  const exits: { exitCode: number | undefined; signal?: number }[] = [];
  const pids: number[] = [];
  p.onData((d) => data.push(d));
  p.onExit((e) => exits.push(e));
  p.onPid?.((pid) => pids.push(pid));
  return { data, exits, pids };
}

test('bootstraps the terminal\'s job with the launch on the host socket, never in the plist', async () => {
  const h = harness();
  const p = isolatedSpawner(h.deps)('t1')('/bin/zsh', ['-l'], opts);
  await tick();
  expect(h.bootstrapped).toHaveLength(1);
  expect(h.bootstrapped[0]!.label).toBe('dev.useatelier.session.0123456789ab.t1');
  expect(h.bootstrapped[0]!.plist).toContain('<string>/h/bin/pty-host.js</string>');
  expect(h.bootstrapped[0]!.plist).toContain('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>');
  expect(h.bootstrapped[0]!.plist).not.toContain('<key>A</key>');
  // As node-pty: PWD and TERM set for the shell.
  expect(h.issued[0]!.launch).toMatchObject({ cwd: '/tmp', file: '/bin/zsh', args: ['-l'], env: { A: 'b', PWD: '/tmp', TERM: 'xterm-256color' } });
  expect(h.issued[0]!.launch.slave).toMatch(/^\/dev\/ttys\d+$/);
  p.kill();
});

test('input typed before the shell starts waits, then reaches it; the pid arrives with "started"', async () => {
  const h = harness();
  const p = isolatedSpawner(h.deps)('t2')('/bin/zsh', [], opts);
  const c = collect(p);
  p.write('early\r');
  expect(p.pid).toBe(0);
  const shell = attachShell(h.issued[0]!.launch.slave);
  h.issued[0]!.events.started(4242, 61000);
  await tick();
  expect(p.pid).toBe(4242);
  expect(c.pids).toEqual([4242]);
  expect(readSlave(shell)).toContain('early');
  expect(h.logs.join('\n')).toMatch(/shell 4242.*coalition 61000/);
  writeSync(shell, 'hello from shell\n');
  await tick(80);
  expect(c.data.join('')).toContain('hello from shell');
  p.kill('SIGTERM');
  expect(h.kills).toEqual([[4242, 'SIGTERM']]);
});

test('exit: reported once with the shell\'s code once the PTY closes, then the job is booted out', async () => {
  const h = harness();
  const p = isolatedSpawner(h.deps)('t3')('/bin/zsh', [], opts);
  const c = collect(p);
  const shell = attachShell(h.issued[0]!.launch.slave);
  h.issued[0]!.events.started(10, 0);
  await tick();
  h.issued[0]!.events.exit(7, 0);
  closeSync(shell);
  open.splice(open.indexOf(shell), 1);
  await tick(400);
  expect(c.exits).toEqual([{ exitCode: 7, signal: 0 }]);
  expect(h.bootedOut).toEqual(['dev.useatelier.session.0123456789ab.t3']);
});

test('a host killed with its coalition (force quit) ends the terminal with no code; a held PTY does not block it', async () => {
  const h = harness();
  const p = isolatedSpawner(h.deps)('t4')('/bin/zsh', [], opts);
  const c = collect(p);
  attachShell(h.issued[0]!.launch.slave); // still open: an orphan holds the tty
  h.issued[0]!.events.started(10, 0);
  await tick();
  h.issued[0]!.events.lost();
  await tick(400);
  expect(c.exits).toEqual([{ exitCode: undefined }]);
});

test('a shell that cannot start (missing cwd, exec failure) exits 1 like node-pty, without a fallback', async () => {
  const h = harness();
  const p = isolatedSpawner(h.deps)('t5')('/nope', [], opts);
  const c = collect(p);
  h.issued[0]!.events.failed(16, 2);
  await tick(400);
  expect(c.exits).toEqual([{ exitCode: 1 }]);
  expect(h.direct).not.toHaveBeenCalled();
});

test('launchd failing falls back to node-pty for this terminal, replaying input and size, and for the next ones', async () => {
  const h = harness();
  h.failBootstrap = true;
  const spawn = isolatedSpawner(h.deps);
  const p = spawn('t6')('/bin/zsh', ['-l'], opts);
  const c = collect(p);
  p.write('typed');
  p.resize(120, 40);
  await tick();
  expect(h.direct).toHaveBeenCalledTimes(1);
  expect(h.direct.mock.calls[0]).toEqual(['/bin/zsh', ['-l'], opts]);
  const d = h.direct.mock.results[0]!.value as ReturnType<typeof fakeDirect>;
  expect(d.written).toEqual(['typed']);
  expect(d.resize).toHaveBeenCalledWith(120, 40);
  expect(p.pid).toBe(777);
  expect(c.pids).toEqual([777]);
  d.emitter.emit('data', 'x');
  d.emitter.emit('exit', { exitCode: 3 });
  expect(c.data).toEqual(['x']);
  expect(c.exits).toEqual([{ exitCode: 3 }]);
  expect(h.issued[0]!.revoked).toBe(true);
  expect(h.logs.filter((l) => /falling back/.test(l))).toHaveLength(1);
  // The next terminal goes straight to node-pty: no second bootstrap attempt, no second log line.
  spawn('t7')('/bin/zsh', [], opts);
  expect(h.direct).toHaveBeenCalledTimes(2);
  expect(h.issued).toHaveLength(1);
  expect(h.logs.filter((l) => /falling back/.test(l))).toHaveLength(1);
});

test('a host that never starts (timeout) also falls back; killed meanwhile, the terminal just ends', async () => {
  const h = harness();
  const p = isolatedSpawner(h.deps)('t8')('/bin/zsh', [], opts);
  collect(p);
  h.issued[0]!.events.timeout();
  await tick();
  expect(h.direct).toHaveBeenCalledTimes(1);

  const h2 = harness();
  const q = isolatedSpawner(h2.deps)('t9')('/bin/zsh', [], opts);
  const c2 = collect(q);
  q.kill();
  h2.issued[0]!.events.timeout();
  await tick(400);
  expect(h2.direct).not.toHaveBeenCalled();
  expect(c2.exits).toEqual([{ exitCode: undefined }]);
});

test('killed before it started: the signal goes to the shell as soon as its pid is known', async () => {
  const h = harness();
  const p = isolatedSpawner(h.deps)('t10')('/bin/zsh', [], opts);
  p.kill('SIGHUP');
  expect(h.kills).toEqual([]);
  attachShell(h.issued[0]!.launch.slave);
  h.issued[0]!.events.started(55, 0);
  await tick();
  expect(h.kills).toEqual([[55, 'SIGHUP']]);
});

test('process: the shell\'s name until it attaches, then node-pty\'s answer (undefined when the leader exited)', async () => {
  const h = harness();
  let answer: string | undefined = 'kernel_task';
  h.deps.native = { ...native, process: () => answer };
  const p = isolatedSpawner(h.deps)('t11')('/bin/zsh', [], opts);
  expect(p.process).toBe('zsh');
  attachShell(h.issued[0]!.launch.slave);
  h.issued[0]!.events.started(10, 0);
  await tick();
  answer = 'vim';
  expect(p.process).toBe('vim');
  answer = undefined;
  expect(p.process).toBeUndefined();
  answer = 'kernel_task';
  expect(p.process).toBe('/bin/zsh');
  p.kill();
});

test('once the PTY closed, nothing more reaches its fd number (it may already belong to something else)', async () => {
  const h = harness();
  const resize = vi.fn(native.resize);
  h.deps.native = { ...native, resize };
  const p = isolatedSpawner(h.deps)('t12')('/bin/zsh', [], opts);
  const shell = attachShell(h.issued[0]!.launch.slave);
  h.issued[0]!.events.started(10, 0);
  await tick();
  closeSync(shell);
  open.splice(open.indexOf(shell), 1);
  await tick(100);
  // The master is closed; a new PTY now likely holds its number.
  const other = native.open(80, 24);
  open.push(other.master, other.slave);
  p.write('LEAK');
  p.resize(100, 30);
  await tick(50);
  const b = Buffer.alloc(64);
  let got = '';
  try { got = b.subarray(0, readSync(other.slave, b, 0, 64, null)).toString(); } catch { /* nothing to read */ }
  expect(got).not.toContain('LEAK');
  expect(resize).not.toHaveBeenCalled();
  expect(p.process).toBe('zsh');
});

test('a fallback waits until the job is booted out before closing the PTY and starting node-pty; a late host is ignored', async () => {
  const h = harness();
  let release: () => void = () => {};
  h.deps.launchd = { ...h.deps.launchd, bootout: (label) => { h.bootedOut.push(label); return new Promise<boolean>((r) => { release = () => r(true); }); } };
  const p = isolatedSpawner(h.deps)('t13')('/bin/zsh', [], opts);
  const c = collect(p);
  h.issued[0]!.events.timeout();
  await tick();
  expect(h.bootedOut).toEqual(['dev.useatelier.session.0123456789ab.t13']);
  expect(h.direct).not.toHaveBeenCalled();
  // A host that still reports now must not take the terminal.
  h.issued[0]!.events.started(99, 0);
  expect(p.pid).toBe(0);
  release();
  await tick();
  expect(h.direct).toHaveBeenCalledTimes(1);
  expect(p.pid).toBe(777);
  expect(c.pids).toEqual([777]);
});

import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runPtyHost, type PtyHostDeps } from './pty-host-entry';

// pty-host.js: the launchd job's first image runs it with Atelier's executable, so
// the job carries Atelier's identity; it fetches the launch and execve()s the native host at once (same pid).

const TOKEN = 'a'.repeat(32);
const launch = { t: 'launch', slave: '/dev/ttys004', cwd: '/w', file: '/bin/zsh', args: ['-l'], env: { TERM: 'xterm-256color', A: 'b' } };

function fake(reply: string | null, o: { error?: boolean } = {}) {
  const sock = new PassThrough();
  const written: string[] = [];
  sock.write = ((d: string) => { written.push(d); return true; }) as typeof sock.write;
  const execve = vi.fn<PtyHostDeps['execve']>();
  const fail = vi.fn<PtyHostDeps['fail']>();
  const deps = {
    connect: () => {
      setTimeout(() => {
        if (o.error) { sock.emit('error', new Error('ECONNREFUSED')); return; }
        sock.emit('connect');
        if (reply !== null) sock.push(reply);
        sock.push(null);
      }, 5);
      return sock as unknown as ReturnType<PtyHostDeps['connect']>;
    },
    execve,
    fail,
    timeoutMs: 500
  } satisfies PtyHostDeps;
  return { deps, written };
}

test('fetches with its token, then execve()s the native host with the launch as argv and environment', async () => {
  const { deps, written } = fake(JSON.stringify(launch) + '\n');
  await runPtyHost(['/A/bin/atelier-pty-host', '/h/run/pty-host.sock', TOKEN], deps);
  expect(written).toEqual([JSON.stringify({ t: 'fetch', token: TOKEN }) + '\n']);
  expect(deps.execve).toHaveBeenCalledWith('/A/bin/atelier-pty-host',
    ['/A/bin/atelier-pty-host', '1', '/h/run/pty-host.sock', TOKEN, '/dev/ttys004', '/w', '/bin/zsh', '-l'], { TERM: 'xterm-256color', A: 'b' });
  expect(deps.fail).not.toHaveBeenCalled();
});

test('fails (never execs) on bad arguments, an unreachable atelierd, no launch, or a malformed one', async () => {
  const cases: [string[], string | null, { error?: boolean }][] = [
    [['/A/host', '/s'], '', {}],
    [['/A/host', '/s', 'NOTHEX'], '', {}],
    [['/A/host', '/s', TOKEN], null, { error: true }],
    [['/A/host', '/s', TOKEN], '', {}],
    [['/A/host', '/s', TOKEN], '{"t":"launch"}\n', {}],
    [['/A/host', '/s', TOKEN], JSON.stringify({ ...launch, args: [1] }) + '\n', {}],
    [['/A/host', '/s', TOKEN], JSON.stringify({ ...launch, env: { A: 1 } }) + '\n', {}],
    [['/A/host', '/s', TOKEN], JSON.stringify({ ...launch, file: 'a\0b' }) + '\n', {}]
  ];
  for (const [argv, reply, o] of cases) {
    const { deps } = fake(reply, o);
    await runPtyHost(argv, deps);
    expect(deps.execve, JSON.stringify(argv) + reply).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledTimes(1);
  }
});

test('stays dependency-free: copied alone into ATELIER_HOME/bin, it may load node built-ins only', () => {
  const src = readFileSync(join(__dirname, 'pty-host-entry.ts'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((i) => i!.startsWith('node:'))).toBe(true);
  expect(src).not.toMatch(/\brequire\(/);
});

test('if execve itself fails (the native host missing), atelierd hears it at once instead of waiting for a timeout', async () => {
  const sockets: { written: string[] }[] = [];
  const execve = vi.fn<PtyHostDeps['execve']>(() => { throw new Error('ENOENT'); });
  const fail = vi.fn<PtyHostDeps['fail']>();
  let n = 0;
  const deps = {
    connect: () => {
      const sock = new PassThrough();
      const entry = { written: [] as string[] };
      sockets.push(entry);
      sock.write = ((d: string) => { entry.written.push(d); return true; }) as typeof sock.write;
      const first = n++ === 0;
      setTimeout(() => { sock.emit('connect'); if (first) { sock.push(JSON.stringify(launch) + '\n'); sock.push(null); } }, 5);
      return sock as unknown as ReturnType<PtyHostDeps['connect']>;
    },
    execve, fail, timeoutMs: 500
  } satisfies PtyHostDeps;
  await runPtyHost(['/A/bin/atelier-pty-host', '/h/run/pty-host.sock', TOKEN], deps);
  await new Promise((r) => setTimeout(r, 50));
  expect(execve).toHaveBeenCalledTimes(1);
  expect(sockets[1]!.written.join('')).toBe(JSON.stringify({ t: 'hello', token: TOKEN }) + '\n' + JSON.stringify({ t: 'failed', step: 2, errno: 0 }) + '\n');
  expect(fail).toHaveBeenCalledTimes(1);
});

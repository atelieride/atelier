import { afterAll, beforeAll, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
// @ts-expect-error plain ESM build script
import { compilePtyHost } from '../../scripts/build-pty-host.mjs';
import { runDaemon, type RunningDaemon } from '../../src/daemon/main';
import { Launchd, jobLabel } from '../../src/daemon/launchd';

// The whole chain under the real launchd: atelierd bootstraps each terminal's job, the
// job runs pty-host.js (here with node, Atelier's executable in the app), which execve()s the native host, which starts
// the shell on atelierd's PTY. Labels carry this test home's hash and are all booted out at the end.

let dir: string;
let home: string;
let nativeHost: string;
let hostScript: string;
let d: RunningDaemon | null = null;
const launchd = () => new Launchd({ runDir: join(home, 'run') });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atl-iso-'));
  home = join(dir, 'h');
  nativeHost = join(dir, 'atelier-pty-host');
  compilePtyHost(nativeHost);
  hostScript = join(dir, 'pty-host.js');
  buildSync({ entryPoints: [resolve(__dirname, '../../src/daemon/pty-host-main.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: hostScript, logLevel: 'silent' });
});

afterAll(async () => {
  await d?.stop();
  const ld = launchd();
  for (const l of await ld.ownLabels(jobLabel('session', home))) await ld.bootout(l);
  expect(await ld.ownLabels(jobLabel('session', home))).toEqual([]);
});

async function daemon(): Promise<RunningDaemon> {
  d ??= await runDaemon({ home, version: '0.0.0-test', shellArgs: ['-f'], isolation: { execPath: process.execPath, hostScript, nativeHost } });
  return d;
}

function until<T>(f: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const poll = () => {
      const v = f();
      if (v) { res(v); return; }
      if (Date.now() - t0 > ms) { rej(new Error('timed out')); return; }
      setTimeout(poll, 25);
    };
    poll();
  });
}

const coalition = (pid: number) => execFileSync(nativeHost, ['--coalition', String(pid)], { encoding: 'utf8' }).split(' ')[0]!;

test('a terminal runs in a launchd job of its own: own coalition, normal priority, job control, gone when closed', async () => {
  const dm = await daemon();
  const info = dm.terminals.create({ projectRoot: dir, cwd: dir, cols: 80, rows: 24 });
  let out = '';
  const detach = dm.terminals.attach(info.id, (snap) => { out += snap; }, (data) => { out += data; });
  // The pid arrives once the host reports the shell.
  const pid = await until(() => dm.terminals.list().find((t) => t.id === info.id)?.pid);
  const other = dm.terminals.create({ projectRoot: dir, cwd: dir, cols: 80, rows: 24 });
  const otherPid = await until(() => dm.terminals.list().find((t) => t.id === other.id)?.pid);

  expect(coalition(pid)).not.toBe(coalition(process.pid));
  expect(coalition(pid)).not.toBe(coalition(otherPid));
  // An interactive app's priority (31), whatever the caller's: launchd starts the job, so a test runner that runs
  // throttled (CI's agent at 20, `taskpolicy -b` at 4) must not pass its priority on, and must not lower the bar either.
  expect(execFileSync('/bin/ps', ['-o', 'pri=', '-p', String(pid)], { encoding: 'utf8' }).trim()).toBe('31');
  expect(await launchd().ownLabels(jobLabel('session', home))).toContain(jobLabel('session', home, info.id));

  dm.terminals.input(info.id, 'echo "ctty=$(tty) pwd=$PWD"; sleep 30\r');
  await until(() => out.includes('ctty=/dev/ttys'));
  expect(out).toContain(`pwd=${dir}`);
  // ^C once sleep is really in front (the shell gave it the terminal): the name comes from the PTY's foreground group.
  await until(() => { dm.terminals.pollForeground(); return dm.terminals.list().find((t) => t.id === info.id)?.foreground === 'sleep'; });
  dm.terminals.input(info.id, '\x03');
  // A computed value: the echo of what was typed ahead could not match it.
  dm.terminals.input(info.id, 'echo after-$((6*7))\r');
  await until(() => out.includes('after-42'), 3000);

  const exited = new Promise<number | null>((r) => dm.terminals.on('exit', (id: string, code: number | null) => { if (id === info.id) r(code); }));
  dm.terminals.input(info.id, 'exit 7\r');
  expect(await exited).toBe(7);
  detach();
  await until(async () => !(await launchd().ownLabels(jobLabel('session', home))).includes(jobLabel('session', home, info.id)) as unknown as boolean, 3000).catch(() => {});
  expect(await launchd().ownLabels(jobLabel('session', home))).not.toContain(jobLabel('session', home, info.id));
  dm.terminals.kill(other.id);
}, 30_000);

test('a nohup background process outlives its shell and its job', async () => {
  const dm = await daemon();
  const info = dm.terminals.create({ projectRoot: dir, cwd: dir, cols: 80, rows: 24 });
  await until(() => dm.terminals.list().find((t) => t.id === info.id)?.pid);
  const marker = `atl-orphan-${Date.now()}`;
  const exited = new Promise<void>((r) => dm.terminals.on('exit', (id: string) => { if (id === info.id) r(); }));
  dm.terminals.input(info.id, `nohup /bin/sh -c 'exec -a ${marker} sleep 20' >/dev/null 2>&1 &!\rexit\r`);
  await exited;
  await new Promise((r) => setTimeout(r, 500));
  const alive = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(marker));
  expect(alive).toHaveLength(1);
  process.kill(Number(alive[0]!.trim().split(/\s+/)[0]), 'SIGTERM');
}, 30_000);

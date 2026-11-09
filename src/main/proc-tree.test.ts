import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { childOptions, signalTree } from './proc-tree';
import { isWin } from '../../tests/support/platform';

// Stopping a child and everything it started: the process group on macOS, as
// before; `taskkill /T /F` on Windows, which has no process groups and no SIGTERM.

const fakeChild = (pid: number | undefined) => {
  const kills: string[] = [];
  return { kills, child: { pid, kill: (s?: NodeJS.Signals | number) => { kills.push(String(s)); return true; } } };
};

test('macOS: the group gets the signal; the child alone when the group is gone', () => {
  const groups: [number, string][] = [];
  const { child, kills } = fakeChild(42);
  signalTree(child, 'SIGTERM', { platform: 'darwin', killGroup: (pid, sig) => { groups.push([pid, sig]); } });
  expect(groups).toEqual([[-42, 'SIGTERM']]);
  signalTree(child, 'SIGKILL', { platform: 'darwin', killGroup: () => { throw new Error('ESRCH'); } });
  expect(kills).toEqual(['SIGKILL']);
});

test('Windows: taskkill on the tree, forced (no graceful stop there), whichever signal is asked', () => {
  const runs: [string, string[]][] = [];
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) signalTree(fakeChild(42).child, sig, { platform: 'win32', systemRoot: 'C:\\Windows', run: (f, a) => runs.push([f, a]) });
  expect(runs).toEqual([
    ['C:\\Windows\\System32\\taskkill.exe', ['/PID', '42', '/T', '/F']],
    ['C:\\Windows\\System32\\taskkill.exe', ['/PID', '42', '/T', '/F']]
  ]);
  signalTree(fakeChild(undefined).child, 'SIGKILL', { platform: 'win32', run: (f, a) => runs.push([f, a]) });
  expect(runs).toHaveLength(2);
});

test('Windows: once per child, and never after it exited (its pid may already be another process)', () => {
  const runs: string[][] = [];
  const run = (_f: string, a: string[]) => { runs.push(a); };
  const child = { pid: 42, exitCode: null as number | null, signalCode: null as string | null, kill: () => true };
  signalTree(child, 'SIGTERM', { platform: 'win32', run });
  signalTree(child, 'SIGKILL', { platform: 'win32', run });
  expect(runs).toHaveLength(1);
  const gone = { pid: 43, exitCode: 0, signalCode: null, kill: () => true };
  signalTree(gone, 'SIGKILL', { platform: 'win32', run });
  expect(runs).toHaveLength(1);
});

test('spawn options: its own process group on macOS; on Windows no console window and no new console', () => {
  expect(childOptions('darwin')).toEqual({ detached: true, windowsHide: true });
  expect(childOptions('win32')).toEqual({ detached: false, windowsHide: true });
});

test.runIf(isWin)('Windows, for real: a child and its grandchild are gone', async () => {
  const child = spawn('cmd.exe', ['/d', '/c', 'ping -n 30 127.0.0.1 >nul'], { ...childOptions('win32'), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  signalTree(child, 'SIGKILL', { platform: 'win32' });
  await exited;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
}, 15_000);

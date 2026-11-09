import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import type { ExecFileLike } from './procs/exec';
import { busyShells, commandText } from './foreground';

afterEach(() => resetPlatformForTests());

// A fake ps: the groups form answers from `groups`, the args form from `args`.
const fake = (groups: string, args: string, calls: string[][] = []): ExecFileLike => (_f, a, _o, cb) => {
  calls.push(a);
  cb(null, a[0] === '-ww' ? args : groups, '');
};

test('a shell whose terminal has another foreground group runs a command: its leader’s command line', async () => {
  initPlatform('darwin');
  const calls: string[][] = [];
  const exec = fake(' 100 100 100\n 200 200 250\n 300 300 300\n', ' 250 /opt/homebrew/bin/node /usr/lib/npm-cli.js run dev\n', calls);
  const busy = await busyShells([{ id: 'a', pid: 100 }, { id: 'b', pid: 200 }, { id: 'c', pid: 300 }, { id: 'nopid' }], exec);
  expect([...busy]).toEqual([['b', 'node /usr/lib/npm-cli.js run dev']]);
  expect(calls).toEqual([['-o', 'pid=,pgid=,tpgid=', '-p', '100,200,300'], ['-ww', '-o', 'pid=,args=', '-p', '250']]);
});

test('a leader gone before its args were read still counts, without a command line', async () => {
  initPlatform('darwin');
  const busy = await busyShells([{ id: 'b', pid: 200 }], fake(' 200 200 250\n', ''));
  expect([...busy]).toEqual([['b', '']]);
});

test('nothing to read or Windows: no busy shell (counted idle); ps failing throws (the close then keeps everything)', async () => {
  initPlatform('darwin');
  const calls: string[][] = [];
  expect((await busyShells([{ id: 'x' }], fake('', '', calls))).size).toBe(0);
  expect(calls).toEqual([]);
  const failing: ExecFileLike = (_f, _a, _o, cb) => cb(Object.assign(new Error('boom'), { code: 2 }), '', 'ps: boom');
  await expect(busyShells([{ id: 'a', pid: 1 }], failing)).rejects.toThrow('ps: boom');
  initPlatform('win32');
  expect((await busyShells([{ id: 'a', pid: 1 }], fake(' 1 1 2\n', ''))).size).toBe(0);
});

test('the command line shown: the program’s name without its folder, cut at 80', () => {
  expect(commandText('/usr/bin/ssh -p 22 host')).toBe('ssh -p 22 host');
  expect(commandText('vim')).toBe('vim');
  expect(commandText(`npm ${'x'.repeat(100)}`)).toHaveLength(80);
});

import { expect, test } from 'vitest';
import { endTreeWith } from './win-tree';

// Windows before 11 24H2: closing a console waits for every program in it, so atelierd starts taskkill on the shell's
// tree (/T /F: the shell and what it started, at once) right before closing the console. The pid is the shell's only
// while its image is the shell's: a shell that exited a moment ago left its pid free for any process (measured on the
// PC: a filter that doesn't match ends nothing, matching is case-insensitive).

test('taskkill from System32: the shell\'s pid, only while its image is the shell\'s, its tree, forced', () => {
  const runs: { file: string; args: string[] }[] = [];
  endTreeWith((file, args) => runs.push({ file, args }), 'D:\\Win')(4242, 'pwsh.exe');
  expect(runs).toEqual([{ file: 'D:\\Win\\System32\\taskkill.exe', args: ['/PID', '4242', '/FI', 'IMAGENAME eq pwsh.exe', '/T', '/F'] }]);
});

test('an image with a space is one argument; a pid or an image that is not one runs nothing', () => {
  const runs: string[][] = [];
  const end = endTreeWith((_f, args) => runs.push(args));
  end(7, 'My Shell.exe');
  expect(runs).toEqual([['/PID', '7', '/FI', 'IMAGENAME eq My Shell.exe', '/T', '/F']]);
  runs.length = 0;
  for (const pid of [0, -1, 1.5, Number.NaN]) end(pid, 'pwsh.exe');
  for (const image of ['', 'pwsh', 'a"b.exe', 'C:\\x\\pwsh.exe', 'a*.exe', 'x.exe\n']) end(7, image);
  expect(runs).toEqual([]);
});

test('a taskkill that can\'t start is no error: the console closes all the same', () => {
  expect(() => endTreeWith(() => { throw new Error('spawn EPERM'); })(4242, 'pwsh.exe')).not.toThrow();
});

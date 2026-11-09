import { afterEach, expect, test } from 'vitest';
import { setTestDefaultPlatform } from '@shared/platform';
import { parseTcp, readArgs, readEstablished, readListening, readProcessTree, useWindowsProcs, validateProcCommand, type ExecFileLike } from './exec';

// Ports, background work and Redis clients on Windows: atelier-procs.exe instead of
// ps and lsof — the process table, command lines, and the TCP table with owners (numbers, never localized text).

const BIN = 'C:\\Program Files\\WindowsApps\\A\\resources\\bin\\atelier-procs.exe';
afterEach(() => { setTestDefaultPlatform('darwin'); useWindowsProcs(null); });

const TCP = [
  'L 4 139 System', 'L 5120 3000 node.exe', 'L 5120 3000 node.exe', 'L 5120 5173 node.exe', 'L 77 6379 redis-server.exe',
  'E 5130 52000 6379', 'E 5140 52001 6379', 'E 5130 52002 5432', 'garbage', 'L x 1 y', 'L 9 0 bad.exe'
].join('\r\n');

test('the TCP table: listening ports by pid (sorted, once, with the image), loopback connections', () => {
  const t = parseTcp(TCP);
  expect(t.listening.get(5120)).toEqual({ name: 'node.exe', ports: [3000, 5173] });
  expect(t.listening.get(4)).toEqual({ name: 'System', ports: [139] });
  expect(t.listening.has(9)).toBe(false);
  expect(t.established).toEqual([{ pid: 5130, local: 52000, remote: 6379 }, { pid: 5140, local: 52001, remote: 6379 }, { pid: 5130, local: 52002, remote: 5432 }]);
});

test('only atelier-procs.exe at the path main gave, with one of three argv forms', () => {
  setTestDefaultPlatform('win32');
  useWindowsProcs(BIN);
  expect(() => validateProcCommand(BIN, ['tree'])).not.toThrow();
  expect(() => validateProcCommand(BIN, ['tcp'])).not.toThrow();
  expect(() => validateProcCommand(BIN, ['args', '12,345'])).not.toThrow();
  for (const bad of [['args', '1;calc'], ['args', ''], ['tree', 'x'], ['kill', '1'], []]) expect(() => validateProcCommand(BIN, bad), bad.join(' ')).toThrow();
  expect(() => validateProcCommand('C:\\evil\\atelier-procs.exe', ['tree'])).toThrow();
});

test('the readers on Windows: tree, args, listening of given pids, connections to a port', async () => {
  setTestDefaultPlatform('win32');
  useWindowsProcs(BIN);
  const calls: string[][] = [];
  const exec: ExecFileLike = (file, args, _o, cb) => {
    calls.push([file, ...args]);
    cb(null, args[0] === 'tree' ? '1 0\r\n10 1\r\n11 10\r\n' : args[0] === 'args' ? '10 npm run dev\r\n11 "C:\\node.exe" vite\r\n' : TCP, '');
  };
  expect([...(await readProcessTree(exec)).entries()]).toEqual([[0, [1]], [1, [10]], [10, [11]]]);
  expect(await readArgs([10, 11], exec)).toEqual([{ pid: 10, ppid: 0, args: 'npm run dev' }, { pid: 11, ppid: 0, args: '"C:\\node.exe" vite' }]);
  expect([...(await readListening([5120, 99], exec)).entries()]).toEqual([[5120, { name: 'node.exe', ports: [3000, 5173] }]]);
  expect([...(await readEstablished(6379, [5130, 9], exec)).entries()]).toEqual([[52000, 5130]]);
  expect(calls.map((c) => c.slice(1).join(' '))).toEqual(['tree', 'args 10,11', 'tcp', 'tcp']);
  expect(calls.every((c) => c[0] === BIN)).toBe(true);
});

test('Windows without the binary (a dev run that did not build it): no reading, an error the hubs already handle', async () => {
  setTestDefaultPlatform('win32');
  await expect(readProcessTree(() => { throw new Error('not run'); })).rejects.toThrow(/atelier-procs/);
});

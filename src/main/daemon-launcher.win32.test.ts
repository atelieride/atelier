import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { requestStop, startWindowsDaemon, type WindowsStart } from './daemon-launcher';
import { runDaemon, type RunningDaemon } from '../daemon/main';
import type { DaemonInfo } from '@shared/protocol';
import { useMachinePlatform } from '../../tests/support/platform';

// Starting atelierd on Windows: from a runtime copy outside the Store package, through
// a short-lived middle process (nothing links it to the app's process tree), falling back to the package when the copy
// can't run (Smart App Control) or can't be made.

const INFO: DaemonInfo = { pid: 1, version: 'v', sock: '\\\\.\\pipe\\atelier-x', token: 't', startedAt: 1 };
const PKG = 'C:\\Program Files\\WindowsApps\\FrancescoMusso.AtelierIDE_1.0.0.0_x64__abc';

function start(o: { packaged?: boolean; copy?: WindowsStart['copy']; ready?: (exec: string) => boolean } = {}) {
  const hops: string[][] = [];
  const logs: string[] = [];
  let last = '';
  const s: WindowsStart = {
    execPath: `${PKG}\\Atelier.exe`, script: `${PKG}\\resources\\app.asar\\out\\main\\daemon.js`, args: ['--version=v+fp'],
    env: { ATELIER_HOME: 'C:\\Users\\m\\.atelier' }, packaged: o.packaged ?? true, fingerprint: 'fp1', runtimeRoot: 'C:\\Users\\m\\.atelier\\runtime',
    copy: o.copy ?? ((_src, root, fp) => `${root}\\${fp}`),
    hop: (exec, args) => { hops.push([exec, ...args]); last = exec; },
    waitReady: async () => (o.ready ?? (() => true))(last) ? INFO : null,
    log: (m) => logs.push(m)
  };
  return { s, hops, logs };
}

test('packaged: atelierd starts from the runtime copy, the script at the same place inside it', async () => {
  const { s, hops } = start();
  expect(await startWindowsDaemon(s)).toBe(INFO);
  expect(hops).toEqual([[
    'C:\\Users\\m\\.atelier\\runtime\\fp1\\Atelier.exe',
    'C:\\Users\\m\\.atelier\\runtime\\fp1\\resources\\app.asar\\out\\main\\daemon.js', '--version=v+fp'
  ]]);
});

test('the copy doesn’t come up (blocked): logged, then started from the package', async () => {
  const { s, hops, logs } = start({ ready: (exec) => exec.startsWith(PKG) });
  const waits: number[] = [];
  const wait = s.waitReady;
  s.waitReady = (ms) => { waits.push(ms); return wait(ms); };
  expect(await startWindowsDaemon(s)).toBe(INFO);
  // A fresh copy's first start may be slow (an antivirus scanning it): it gets longer than the package.
  expect(waits).toEqual([20_000, 8000]);
  expect(hops.map((h) => h[0])).toEqual(['C:\\Users\\m\\.atelier\\runtime\\fp1\\Atelier.exe', `${PKG}\\Atelier.exe`]);
  expect(logs.join('\n')).toMatch(/runtime copy/);
});

test('the copy can’t be made (disk full): from the package at once', async () => {
  const { s, hops, logs } = start({ copy: () => { throw new Error('ENOSPC'); } });
  await startWindowsDaemon(s);
  expect(hops.map((h) => h[0])).toEqual([`${PKG}\\Atelier.exe`]);
  expect(logs.join('\n')).toMatch(/ENOSPC/);
});

test('a development run (not packaged) starts in place, no copy', async () => {
  const copies: string[] = [];
  const { s, hops } = start({ packaged: false, copy: (src) => { copies.push(src); return src; } });
  await startWindowsDaemon(s);
  expect(copies).toEqual([]);
  expect(hops[0]![0]).toBe(`${PKG}\\Atelier.exe`);
});

test('nothing comes up at all: an error naming the log', async () => {
  const { s } = start({ ready: () => false });
  await expect(startWindowsDaemon(s)).rejects.toThrow(/did not start/);
});

describe('stopping a daemon of another protocol version', () => {
  useMachinePlatform();
  const running: RunningDaemon[] = [];
  afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

  test('requestStop: the stop header with the info file’s token; a wrong token stops nothing', async () => {
    let stopped = false;
    const d = await runDaemon({ home: mkdtempSync(join(tmpdir(), 'atl-rs-')), version: '0.0.0-test', shellArgs: ['-f'], onStopped: () => { stopped = true; } });
    running.push(d);
    expect(await requestStop({ ...d.info, token: 'f'.repeat(64) })).toBe(false);
    expect(stopped).toBe(false);
    expect(await requestStop(d.info)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(true);
  });
});

test('packaged: the copy is checked for the files atelierd runs from (the executable, its script, the bridge)', async () => {
  const asked: (readonly string[] | undefined)[] = [];
  const { s } = start({ copy: (_src, root, fp, keys) => { asked.push(keys); return `${root}\\${fp}`; } });
  await startWindowsDaemon(s);
  expect(asked).toEqual([['Atelier.exe', 'resources\\app.asar\\out\\main\\daemon.js', 'resources\\bin\\atelier-bridge.exe']]);
});

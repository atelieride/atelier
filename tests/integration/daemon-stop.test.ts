import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { isSocketAlive, runDaemon, type RunningDaemon } from '../../src/daemon/main';
import { encode } from '../../src/shared/protocol';
import { useMachinePlatform } from '../support/platform';
import { connectControl, connectRaw } from './helpers';

// Stopping atelierd without a signal: Windows has no graceful one, and a later app may speak
// another protocol version, which closes `hello` before any request. The `stop` header needs only the control token.
// Runs on macOS (unix socket) and Windows (named pipe) alike.

useMachinePlatform();
const running: RunningDaemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function start(onStopped?: () => void) {
  const home = mkdtempSync(join(tmpdir(), 'atl-stop-'));
  const d = await runDaemon({ home, version: '0.0.0-test', shellArgs: ['-f'], onStopped });
  running.push(d);
  return d;
}

test('the stop header with the control token stops atelierd as a shutdown does', async () => {
  let stopped!: () => void;
  const done = new Promise<void>((r) => { stopped = r; });
  const d = await start(() => stopped());
  const c = await connectRaw(d.paths.sock, encode({ t: 'stop', token: d.info.token }));
  expect(await c.next((m) => m.t === 'stopping')).toEqual({ t: 'stopping' });
  await done;
  expect(existsSync(d.paths.info)).toBe(false);
  expect(await isSocketAlive(d.paths.sock)).toBe(false);
});

test('without the control token nothing stops (the hook token, a wrong one)', async () => {
  const d = await start();
  for (const token of [d.hookToken, 'x'.repeat(64)]) {
    const c = await connectRaw(d.paths.sock, encode({ t: 'stop', token }));
    await c.closed;
    expect(c.messages).toEqual([]);
  }
  expect(await isSocketAlive(d.paths.sock)).toBe(true);
  const c = await connectControl(d.paths.sock, d.info.token);
  expect((await c.next((m) => m.t === 'welcome')).t).toBe('welcome');
  c.close();
});

test('the info file names where the service listens (a pipe on Windows, a socket elsewhere)', async () => {
  const d = await start();
  if (process.platform === 'win32') expect(d.info.sock).toMatch(/^\\\\\.\\pipe\\atelier-[0-9a-f]{16}$/);
  else expect(d.info.sock).toBe(d.paths.sock);
  expect(await isSocketAlive(d.info.sock)).toBe(true);
});

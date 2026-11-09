import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon, type RunningDaemon } from '../../src/daemon/main';
import { DaemonClient } from '../../src/main/daemon-client';
import { readDaemonInfo } from '../../src/main/daemon-launcher';
import type { TerminalInfo } from '../../src/shared/protocol';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function start(): Promise<{ d: RunningDaemon; client: DaemonClient }> {
  const home = mkdtempSync(join(tmpdir(), 'atl-f-'));
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'] });
  cleanups.push(() => d.stop());
  const client = new DaemonClient(async () => readDaemonInfo(d.paths.info)!, { requestTimeoutMs: 3000 });
  cleanups.push(() => client.stop());
  await client.start();
  return { d, client };
}

test('a terminal watched by the app with a flood of output: service responsive, no exception', async () => {
  const { client } = await start();
  const errors: unknown[] = [];
  const onErr = (e: unknown) => errors.push(e);
  process.on('uncaughtException', onErr);
  const info = await client.request<TerminalInfo>({ t: 'create', projectRoot: tmpdir(), cwd: tmpdir(), cols: 120, rows: 40 });
  let received = 0;
  client.on('data', (_id: string, d: string) => { received += d.length; });
  await client.request({ t: 'attach', id: info.id });
  client.send({ t: 'input', id: info.id, data: 'yes "una riga di prova abbastanza lunga per riempire in fretta"\r' });
  let worst = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const s = Date.now();
    await client.request({ t: 'list' });
    worst = Math.max(worst, Date.now() - s);
    await new Promise((r) => setTimeout(r, 150));
  }
  client.send({ t: 'input', id: info.id, data: '\x03' });
  process.off('uncaughtException', onErr);
  console.log(`watched flood: ${(received / 1e6).toFixed(0)} MB, worst latency ${worst} ms`);
  expect(errors).toEqual([]);
  expect(worst).toBeLessThan(1000);
}, 30000);

test('an unwatched terminal producing a flood of output does not crash or block the service', async () => {
  const { client } = await start();
  const info = await client.request<TerminalInfo>({ t: 'create', projectRoot: tmpdir(), cwd: tmpdir(), cols: 120, rows: 40 });
  client.send({ t: 'input', id: info.id, data: 'yes "una riga di prova abbastanza lunga per riempire in fretta"\r' });
  const rss0 = process.memoryUsage().rss;
  let worst = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const s = Date.now();
    await client.request({ t: 'list' });
    worst = Math.max(worst, Date.now() - s);
    await new Promise((r) => setTimeout(r, 150));
  }
  client.send({ t: 'input', id: info.id, data: '\x03' });
  expect(worst).toBeLessThan(1000);
  expect(process.memoryUsage().rss - rss0).toBeLessThan(400 * 1024 * 1024);
}, 30000);

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon } from '../../src/daemon/main';
import { DaemonClient } from '../../src/main/daemon-client';
import { readDaemonInfo } from '../../src/main/daemon-launcher';
import type { TerminalInfo } from '../../src/shared/protocol';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const until = async (cond: () => boolean, ms = 20000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); }
};

test('long, color-heavy scrollback: the screen arrives whole and the connection stays alive', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-sn-'));
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'] });
  cleanups.push(() => d.stop());
  const client = new DaemonClient(async () => readDaemonInfo(d.paths.info)!, { requestTimeoutMs: 15000 });
  cleanups.push(() => client.stop());
  await client.start();
  const info = await client.request<TerminalInfo>({ t: 'create', projectRoot: tmpdir(), cwd: tmpdir(), cols: 200, rows: 40 });

  // 10,000 lines of 200 columns, 12 runs with different foreground and background colors (like a Claude diff).
  const awk = `awk 'BEGIN{for(i=0;i<10000;i++){l="";for(j=0;j<12;j++){l=l sprintf("\\033[38;2;%d;%d;%dm\\033[48;2;%d;%d;%dm%-16s",(i+j)%256,(i*3+j)%256,(i*7)%256,(j*20)%256,(i+40)%256,(j*9)%256,"seg" j);}print l "\\033[0m"}print "END-SCROLLBACK"}'`;
  let streamed = '';
  client.on('data', (_i: string, x: string) => { streamed += x; });
  await client.request({ t: 'attach', id: info.id });
  client.send({ t: 'input', id: info.id, data: awk + '\r' });
  await until(() => streamed.includes('END-SCROLLBACK'));
  await client.request({ t: 'detach', id: info.id });
  await new Promise((r) => setTimeout(r, 500));

  let snapshot = '';
  client.on('snapshot', (_i: string, s: string) => { snapshot = s; });
  await client.request({ t: 'attach', id: info.id });
  expect(snapshot.length).toBeGreaterThan(4 * 1024 * 1024 / 6);
  expect(snapshot).toContain('END-SCROLLBACK');
  expect(client.connected).toBe(true);
  await client.request({ t: 'list' });
}, 60000);

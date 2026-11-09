import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DOCKER_CHANNELS, DockerHub, type DockerSettings, type HubWindow } from '../../src/main/docker/hub';
import type { DockerSnapshot } from '../../src/shared/docker';
import { FakeDocker } from '../support/fake-docker';
import { isWin, useMachinePlatform } from '../support/platform';

// Docker on Windows: the engine is a named pipe. A fake engine on a pipe, set as Settings ›
// Docker › Engine in the npipe:// form a docker context uses: found, listed. (No Docker on the test PC: the fake stands
// in for Docker Desktop's \\.\pipe\docker_engine.)

useMachinePlatform();
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

class Win implements HubWindow {
  sent: { channel: string; payload: unknown }[] = [];
  constructor(readonly id: number) {}
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload }); }
  isDestroyed() { return false; }
  once() {}
  last<T>(channel: string): T | undefined { return [...this.sent].reverse().find((s) => s.channel === channel)?.payload as T | undefined; }
}

test.runIf(isWin)('a fake engine on a named pipe, set as npipe://: running, its containers listed', async () => {
  const name = `atl-docker-test-${process.pid}`;
  const fake = await FakeDocker.start(`\\\\.\\pipe\\${name}`);
  cleanup.push(() => fake.close().catch(() => {}));
  fake.add({ name: 'api', project: 'acme-store', workingDir: 'C:/code/acme-store' });
  const home = mkdtempSync(join(tmpdir(), 'dkw-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const settings: DockerSettings = { showDocker: 'auto', dockerSocket: `npipe:////./pipe/${name}`, dockerOthers: true, dockerNotify: true, dockerLogLines: 5000, notifySound: true };
  const hub = new DockerHub({
    settings: () => settings, home, testSocket: undefined, focused: () => true, banner: () => {},
    timing: { tickMs: 50, probeMs: 200, relistMs: 10_000, debounceMs: 20, lingerMs: 300, flushMs: 10, coalesceMs: 2000, killWindowMs: 2000 }
  });
  cleanup.push(() => hub.dispose());
  const w = new Win(1);
  hub.open('C:/code/acme-store', w);
  const end = Date.now() + 8000;
  const snap = () => w.last<DockerSnapshot>(DOCKER_CHANNELS.snapshot);
  while (!(snap()?.engine.state === 'running' && (snap()?.containers.length ?? 0) > 0) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(snap()?.engine).toMatchObject({ state: 'running', socket: `\\\\.\\pipe\\${name}` });
  expect(snap()?.containers.map((c) => c.name)).toEqual(['api']);
}, 20_000);

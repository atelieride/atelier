import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Demuxer, LineSplitter } from '../../src/main/docker/demux';
import { Denied, EngineGone, NotFound, TooLarge, getJson, getText, openStream } from '../../src/main/docker/engine';
import { FakeDocker } from '../support/fake-docker';

let dir: string;
let fake: FakeDocker;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dk-'));
  fake = await FakeDocker.start(join(dir, 'd.sock'));
});
afterEach(async () => {
  expect(fake.nonGet()).toEqual([]);
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

describe('engine client against a fake engine', () => {
  test('ping, version, containers, inspect', async () => {
    const id = fake.add({ name: 'api', project: 'acme', workingDir: '/w' });
    expect(await getText(fake.socket, { kind: 'ping' })).toBe('OK');
    expect(await getJson(fake.socket, { kind: 'version' })).toMatchObject({ ApiVersion: '1.47' });
    expect((await getJson(fake.socket, { kind: 'containers' }) as { Id: string }[]).map((c) => c.Id)).toEqual([id]);
    expect(await getJson(fake.socket, { kind: 'inspect', id })).toMatchObject({ Id: id });
    expect(fake.requests.map((r) => r.path)).toEqual(['/_ping', '/version', '/containers/json?all=1', `/containers/${id}/json`]);
  });

  test('typed errors: not found, gone, denied, too large', async () => {
    await expect(getJson(fake.socket, { kind: 'inspect', id: 'abcdefabcdef' })).rejects.toBeInstanceOf(NotFound);
    await expect(getText(join(dir, 'missing.sock'), { kind: 'ping' })).rejects.toBeInstanceOf(EngineGone);
    await expect(getJson(fake.socket, { kind: 'df' }, { maxBytes: 10 })).rejects.toBeInstanceOf(TooLarge);
    chmodSync(fake.socket, 0o000);
    try { await expect(getText(fake.socket, { kind: 'ping' })).rejects.toBeInstanceOf(Denied); } finally { chmodSync(fake.socket, 0o600); }
  });

  test('a followed multiplexed log stream: history, then new lines live, both streams', async () => {
    const id = fake.add({ name: 'api' }, ['one', 'two', 'three']);
    const demux = new Demuxer();
    const out = new LineSplitter();
    const err = new LineSplitter();
    const lines: string[] = [];
    const s = openStream(fake.socket, { kind: 'logs', id, follow: true, tail: 2 }, {
      data: (c) => { for (const f of demux.push(c)) for (const l of (f.err ? err : out).push(f.data)) lines.push(`${f.err ? 'E' : 'O'} ${l.replace(/^\S+ /, '')}`); },
      end: () => {}
    });
    await until(() => lines.length === 2);
    fake.log(id, 'boom', true);
    await until(() => lines.length === 3);
    s.close();
    expect(lines).toEqual(['O two', 'O three', 'E boom']);
  });

  test('a stream ends when the engine ends it; close() stops callbacks', async () => {
    const id = fake.add({ name: 'old', state: 'exited', exitCode: 1 }, ['bye']);
    let ended = false;
    openStream(fake.socket, { kind: 'logs', id, follow: true, tail: 10 }, { data: () => {}, end: (e) => { ended = e === undefined; } });
    await until(() => ended);
    let calls = 0;
    const run = fake.add({ name: 'run' });
    const s = openStream(fake.socket, { kind: 'stats', id: run, stream: true }, { data: () => { calls++; }, end: () => { calls += 1000; } });
    await until(() => calls > 0);
    s.close();
    const at = calls;
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toBe(at);
  });
});

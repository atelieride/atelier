import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { expectMode } from '../../../tests/support/platform';

// Windows: a rename over a file an indexer or antivirus holds for a moment fails there (EPERM, EBUSY).
const held = vi.hoisted(() => ({ codes: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      const code = held.codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
      fs.renameSync(from, to);
    }
  };
});
const { ModelStore } = await import('./model');

const SIZE = 300_000;
const body = randomBytes(SIZE);
const sha = createHash('sha256').update(body).digest('hex');
let server: Server | null = null;
const ranges: (string | undefined)[] = [];

/** Local server with Range support; stall=true stops halfway (to test interruption and resume). */
async function serve(o: { stall?: boolean } = {}): Promise<string> {
  server = createServer((req, res) => {
    ranges.push(req.headers.range);
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { 'Content-Length': String(SIZE - from) });
    if (o.stall) { res.write(body.subarray(from, from + 100_000)); return; }
    res.end(body.subarray(from));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/m.bin`;
}
afterEach(() => { server?.close(); server = null; ranges.length = 0; held.codes = []; resetPlatformForTests(); });

const dir = () => join(mkdtempSync(join(tmpdir(), 'atl-model-')), 'models');

test('full download: progress, verification, file ready, no partial; private folder', async () => {
  const url = await serve();
  const d = dir();
  const store = new ModelStore({ dir: d, spec: { file: 'm.bin', url, size: SIZE, sha256: sha } });
  expect(store.state()).toBe('missing');
  const seen: number[] = [];
  expect(await store.download((r, t) => { expect(t).toBe(SIZE); seen.push(r); })).toBe('ready');
  expect(seen.at(-1)).toBe(SIZE);
  expect(store.state()).toBe('ready');
  expect(readFileSync(store.path())).toEqual(body);
  expect(existsSync(store.path() + '.part')).toBe(false);
  expectMode(d, 0o700);
});

test('wrong checksum: corrupted, no final file', async () => {
  const url = await serve();
  const store = new ModelStore({ dir: dir(), spec: { file: 'm.bin', url, size: SIZE, sha256: '0'.repeat(64) } });
  expect(await store.download(() => {})).toBe('corrupted');
  expect(existsSync(store.path())).toBe(false);
  expect(store.state()).toBe('missing');
});

test('interrupted halfway: the partial stays and the second download resumes where it left off', async () => {
  let url = await serve({ stall: true });
  const d = dir();
  const spec = { file: 'm.bin', url, size: SIZE, sha256: sha };
  const store = new ModelStore({ dir: d, spec });
  const ac = new AbortController();
  const p = store.download((r) => { if (r >= 100_000) ac.abort(); }, ac.signal);
  expect(await p).toBe('cancelled');
  expect(statSync(store.path() + '.part').size).toBe(100_000);
  server!.close();
  url = await serve();
  const again = new ModelStore({ dir: d, spec: { ...spec, url } });
  expect(await again.download(() => {})).toBe('ready');
  expect(ranges.at(-1)).toBe('bytes=100000-');
  expect(readFileSync(again.path())).toEqual(body);
});

test('remove deletes the model, the partial and the verification mark', async () => {
  const url = await serve();
  const store = new ModelStore({ dir: dir(), spec: { file: 'm.bin', url, size: SIZE, sha256: sha } });
  await store.download(() => {});
  writeFileSync(store.path() + '.part', 'x');
  store.remove();
  expect(store.state()).toBe('missing');
  expect(existsSync(store.path() + '.part')).toBe(false);
  expect(existsSync(store.path() + '.ok')).toBe(false);
});

test('file of the right size but unverified: corrupted', async () => {
  const d = dir();
  const store = new ModelStore({ dir: d, spec: { file: 'm.bin', url: 'http://x', size: 3, sha256: sha } });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(d, { recursive: true });
  writeFileSync(store.path(), 'abc');
  expect(store.state()).toBe('corrupted');
});

test('Windows: a model held for a moment by an antivirus is still put in place (the rename is tried again)', async () => {
  initPlatform('win32');
  const url = await serve();
  const store = new ModelStore({ dir: dir(), spec: { file: 'm.bin', url, size: SIZE, sha256: sha } });
  held.codes = ['EPERM'];
  expect(await store.download(() => {})).toBe('ready');
  expect(held.codes).toEqual([]);
  expect(readFileSync(store.path())).toEqual(body);
});

test('a complete partial left by a failed rename is verified and put in place, not downloaded again', async () => {
  const d = dir();
  const store = new ModelStore({ dir: d, spec: { file: 'm.bin', url: 'http://127.0.0.1:1/never', size: SIZE, sha256: sha } });
  mkdirSync(d, { recursive: true });
  writeFileSync(store.path() + '.part', body);
  const seen: number[] = [];
  expect(await store.download((r) => seen.push(r))).toBe('ready');
  expect(seen).toEqual([SIZE]);
  expect(readFileSync(store.path())).toEqual(body);
  expect(existsSync(store.path() + '.part')).toBe(false);
  expect(store.state()).toBe('ready');
});

test('a complete partial that is not the model is downloaded again from the start', async () => {
  const url = await serve();
  const d = dir();
  const store = new ModelStore({ dir: d, spec: { file: 'm.bin', url, size: SIZE, sha256: sha } });
  mkdirSync(d, { recursive: true });
  writeFileSync(store.path() + '.part', randomBytes(SIZE));
  expect(await store.download(() => {})).toBe('ready');
  expect(ranges).toEqual([undefined]);
  expect(readFileSync(store.path())).toEqual(body);
});

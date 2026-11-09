import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fakeRunner, runStore } from './store-exec';

// How main runs atelier-store.exe (node stands in for it here).

const node = (script: string) => ['-e', script];

test('runStore: the output and the exit code; each line handed over as it arrives', async () => {
  const lines: string[] = [];
  const r = await runStore(process.execPath, node("process.stdout.write('progress 0.100\\r\\nprogress 0.5'); setTimeout(() => { process.stdout.write('00\\ndone completed\\n'); }, 50)"), 5_000, (l) => lines.push(l));
  expect(r).toEqual({ code: 0, out: 'progress 0.100\r\nprogress 0.500\ndone completed\n' });
  expect(lines).toEqual(['progress 0.100\r', 'progress 0.500', 'done completed']);
});

test('runStore: a failing helper keeps its code and output', async () => {
  const r = await runStore(process.execPath, node("console.log('error 80073d54 no identity'); process.exit(1)"), 5_000);
  expect(r).toEqual({ code: 1, out: 'error 80073d54 no identity\n' });
});

test('runStore: stopped at the timeout (code null), and when it prints too much', async () => {
  const slow = await runStore(process.execPath, node('setTimeout(() => {}, 10000)'), 200);
  expect(slow.code).toBe(null);
  const loud = await runStore(process.execPath, node("const s = 'x'.repeat(1024); const t = setInterval(() => process.stdout.write(s), 1); setTimeout(() => clearInterval(t), 5000)"), 10_000);
  expect(loud.code).toBe(null);
  expect(loud.out.length).toBeLessThanOrEqual(64 * 1024);
});

test('runStore: a helper that cannot start is a run without answer', async () => {
  expect(await runStore(join(tmpdir(), 'atelier-store-missing.exe'), ['check'], 1_000)).toEqual({ code: null, out: '' });
  // spawn throwing on the spot (here an invalid path; on Windows a launch policy can refuse it): resolved, not rejected.
  expect(await runStore('atelier\0store.exe', ['check'], 1_000)).toEqual({ code: null, out: '' });
});

test('fakeRunner (tests only): checks in order, the last one repeating; the update lines in order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-store-'));
  const file = join(dir, 'store.json');
  writeFileSync(file, JSON.stringify({ checks: ['updates 1', 'updates 0'], update: { lines: ['progress 0.500', 'done completed'], code: 0, intervalMs: 1 } }));
  const r = fakeRunner(file);
  expect((await r.check()).out).toBe('updates 1');
  expect((await r.check()).out).toBe('updates 0');
  expect((await r.check()).out).toBe('updates 0');
  const lines: string[] = [];
  expect(await r.update((l) => lines.push(l))).toEqual({ code: 0, out: 'progress 0.500\ndone completed\n' });
  expect(lines).toEqual(['progress 0.500', 'done completed']);
});

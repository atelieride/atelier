import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';

// atelierd's atomic writes (registry, info, settings) on Windows: a rename over a file another process holds for a
// moment (the app reading the registry, an indexer, an antivirus) fails with EPERM/EBUSY there: retried.

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
const { writeFileAtomic } = await import('./fsutil');

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); held.codes = []; });

test('Windows: a target held for a moment is written on a later try', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-fs-')), 'registry.json');
  held.codes = ['EPERM', 'EBUSY'];
  writeFileAtomic(f, '{"v":1}');
  expect(readFileSync(f, 'utf8')).toBe('{"v":1}');
});

test('macOS: one rename, as before', () => {
  initPlatform('darwin');
  const f = join(mkdtempSync(join(tmpdir(), 'atl-fs-')), 'registry.json');
  held.codes = ['EPERM'];
  expect(() => writeFileAtomic(f, '{"v":1}')).toThrow('EPERM');
});

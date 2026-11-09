import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { expectMode } from '../../tests/support/platform';

// What the atomic write does, in order (fsync before rename: a crash right after the rename never leaves an empty file).
const calls = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync: (fd: number) => { calls.log.push('fsync'); fs.fsyncSync(fd); },
    renameSync: (from: string, to: string) => { calls.log.push('rename'); fs.renameSync(from, to); }
  };
});
const { ensureDir, writeFileAtomic } = await import('./fsutil');

test('atomic write with permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-'));
  const f = join(dir, 'a.json');
  writeFileAtomic(f, '{"x":1}', 0o600);
  expect(readFileSync(f, 'utf8')).toBe('{"x":1}');
  expectMode(f, 0o600);
});
test('the data reaches the disk before the rename puts it in place', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-')), 'a.json');
  calls.log = [];
  writeFileAtomic(f, Buffer.from('bytes'));
  expect(calls.log).toEqual(['fsync', 'rename']);
  expect(readFileSync(f, 'utf8')).toBe('bytes');
});
test('a rename that fails leaves no temporary file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-'));
  // A folder in place of the file: the rename fails.
  mkdirSync(join(dir, 'a.json'));
  expect(() => writeFileAtomic(join(dir, 'a.json'), '{}')).toThrow();
  expect(readdirSync(dir)).toEqual(['a.json']);
});
test('ensureDir enforces permissions even if the directory exists', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'atl-')), 'h');
  ensureDir(dir, 0o755);
  ensureDir(dir, 0o700);
  expectMode(dir, 0o700);
});

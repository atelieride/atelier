import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

// Every file access the reader makes, counted: with no config dir it must make none (no test reads a real ~/.claude).
const fsCalls = vi.hoisted(() => ({ n: 0, reads: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: ((...a: Parameters<typeof fs.readFileSync>) => { fsCalls.n += 1; fsCalls.reads += 1; return fs.readFileSync(...a); }) as typeof fs.readFileSync,
    statSync: ((...a: Parameters<typeof fs.statSync>) => { fsCalls.n += 1; return fs.statSync(...a); }) as typeof fs.statSync,
    existsSync: (p: Parameters<typeof fs.existsSync>[0]) => { fsCalls.n += 1; return fs.existsSync(p); }
  };
});
const { autoContinueAtUsageLimit } = await import('./claude-settings');

// Claude Code's own setting decides whether it waits at a usage limit.

type Cache = Map<string, { mtimeMs: number; value: boolean }>;
const configDir = (settings?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-claude-'));
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), settings);
  return dir;
};

beforeEach(() => { fsCalls.n = 0; fsCalls.reads = 0; });

test('no settings file → Claude Code’s default (true)', () => {
  expect(autoContinueAtUsageLimit(configDir(), new Map())).toBe(true);
});

test('autoContinueAtUsageLimit false → false; true → true', () => {
  expect(autoContinueAtUsageLimit(configDir('{"autoContinueAtUsageLimit":false}'), new Map())).toBe(false);
  expect(autoContinueAtUsageLimit(configDir('{"autoContinueAtUsageLimit":true}'), new Map())).toBe(true);
});

test('any other value, a broken file or something that is not an object → true', () => {
  for (const text of ['{"autoContinueAtUsageLimit":"false"}', '{"autoContinueAtUsageLimit":0}', '{"autoContinueAtUsageLimit":null}', '{', '', 'false', '[false]', 'null', '{"other":false}']) {
    expect(autoContinueAtUsageLimit(configDir(text), new Map()), text).toBe(true);
  }
});

test('a settings.json that is a folder, or a config dir that is gone → true', () => {
  const dir = configDir();
  mkdirSync(join(dir, 'settings.json'));
  expect(autoContinueAtUsageLimit(dir, new Map())).toBe(true);
  expect(autoContinueAtUsageLimit(join(dir, 'gone'), new Map())).toBe(true);
});

test('a settings.json that is no regular file is never read (a FIFO would block atelierd) → true', () => {
  const dir = configDir();
  mkdirSync(join(dir, 'settings.json'));
  expect(autoContinueAtUsageLimit(dir, new Map())).toBe(true);
  expect(fsCalls.reads).toBe(0);
});

test('no config dir → true, without touching the file system', () => {
  expect(autoContinueAtUsageLimit(null, new Map())).toBe(true);
  expect(autoContinueAtUsageLimit(null)).toBe(true);
  expect(fsCalls.n).toBe(0);
});

test('cached by path and mtime: the same file is not read again; a rewrite with a new mtime is', () => {
  const dir = configDir('{"autoContinueAtUsageLimit":false}');
  const file = join(dir, 'settings.json');
  utimesSync(file, 1_000, 1_000);
  const cache: Cache = new Map();
  expect(autoContinueAtUsageLimit(dir, cache)).toBe(false);
  expect(cache.get(file)).toEqual({ mtimeMs: 1_000_000, value: false });
  // The cache answers while the mtime holds, even if the content says otherwise.
  writeFileSync(file, '{"autoContinueAtUsageLimit":true}');
  utimesSync(file, 1_000, 1_000);
  expect(autoContinueAtUsageLimit(dir, cache)).toBe(false);
  utimesSync(file, 2_000, 2_000);
  expect(autoContinueAtUsageLimit(dir, cache)).toBe(true);
  expect(cache.get(file)).toEqual({ mtimeMs: 2_000_000, value: true });
});

test('the default cache is shared across calls', () => {
  const dir = configDir('{"autoContinueAtUsageLimit":false}');
  expect(autoContinueAtUsageLimit(dir)).toBe(false);
  const reads = fsCalls.n;
  expect(autoContinueAtUsageLimit(dir)).toBe(false);
  // Only the stat that checks the mtime: no second read.
  expect(fsCalls.n - reads).toBe(1);
});

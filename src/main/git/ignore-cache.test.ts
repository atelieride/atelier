import { expect, test } from 'vitest';
import { IGNORE_REFRESH_MS, IgnoreCache, LS_IGNORED_ARGS, parseIgnored } from './ignore-cache';
import { validateGitArgs } from './exec';

test('parses ls-files -z output: folders keep their slash, files are exact', () => {
  expect(parseIgnored('out/\0.env\0logs/app/\0')).toEqual(['out/', '.env', 'logs/app/']);
  expect(parseIgnored('')).toEqual([]);
});

test('a repository forgotten (gone from the project) keeps nothing: nothing ignored, listed again when asked', async () => {
  const c = new IgnoreCache(async () => 'out/\0', () => 0);
  await c.refresh('/r');
  expect(c.ignored('/r', 'out/x')).toBe(true);
  expect(c.stale('/r')).toBe(false);
  c.forget('/r');
  expect(c.ignored('/r', 'out/x')).toBe(false);
  expect(c.stale('/r')).toBe(true);
});

test('a path is ignored when it is an ignored file, or sits under an ignored folder (not a prefix of a name)', async () => {
  const c = new IgnoreCache(async () => 'out/\0.env\0', () => 0);
  await c.refresh('/r');
  expect(c.ignored('/r', 'out/main/index.js')).toBe(true);
  expect(c.ignored('/r', 'out')).toBe(true);
  expect(c.ignored('/r', '.env')).toBe(true);
  expect(c.ignored('/r', 'outside.ts')).toBe(false);
  expect(c.ignored('/r', 'src/a.ts')).toBe(false);
  expect(c.ignored('/other', 'out/x')).toBe(false);
});

test('stale: never listed, or listed more than IGNORE_REFRESH_MS ago; a failed listing keeps the previous set', async () => {
  let t = 0;
  let fail = false;
  const c = new IgnoreCache(async () => { if (fail) throw new Error('git gone'); return 'out/\0'; }, () => t);
  expect(c.stale('/r')).toBe(true);
  await c.refresh('/r');
  expect(c.stale('/r')).toBe(false);
  t = IGNORE_REFRESH_MS;
  expect(c.stale('/r')).toBe(true);
  fail = true;
  await c.refresh('/r');
  expect(c.ignored('/r', 'out/x')).toBe(true);
});

test('the listing uses only allowed, read-only git arguments', () => {
  expect(() => validateGitArgs(LS_IGNORED_ARGS)).not.toThrow();
});

test('a folder listed together with entries under it only holds ignored files: it is not ignored itself (git ls-files --directory)', async () => {
  const c = new IgnoreCache(async () => 'logs/\0logs/app.log\0out/\0build/\0build/cache/\0', () => 0);
  await c.refresh('/r');
  expect(c.ignored('/r', 'logs/app.log')).toBe(true);
  expect(c.ignored('/r', 'logs/notes.md')).toBe(false);
  expect(c.ignored('/r', 'out/x.js')).toBe(true);
  expect(c.ignored('/r', 'build/main.js')).toBe(false);
  expect(c.ignored('/r', 'build/cache/a')).toBe(true);
});

test('a listing that changes what is ignored asks for a status (a path un-ignored is shown); the first one and an equal one do not', async () => {
  let out = 'out/\0';
  const changed: string[] = [];
  const c = new IgnoreCache(async () => out, () => 0, (repo) => changed.push(repo));
  await c.refresh('/r');
  await c.refresh('/r');
  expect(changed).toEqual([]);
  out = 'out/\0dist/\0';
  await c.refresh('/r');
  expect(changed).toEqual(['/r']);
});

test('a failed listing waits IGNORE_REFRESH_MS before the next try (no spawn per watcher batch in a heavy repo)', async () => {
  let t = 0;
  const c = new IgnoreCache(async () => { throw new Error('too large'); }, () => t);
  await c.refresh('/r');
  expect(c.stale('/r')).toBe(false);
  t = IGNORE_REFRESH_MS;
  expect(c.stale('/r')).toBe(true);
});

test('a refresh asked while one runs (a .gitignore saved mid-listing) runs again after it, with the new rules', async () => {
  const calls: number[] = [];
  let release!: () => void;
  const c = new IgnoreCache(async () => { calls.push(calls.length); if (calls.length === 1) await new Promise<void>((r) => { release = r; }); return 'out/\0'; }, () => 0);
  const first = c.refresh('/r');
  const second = c.refresh('/r', true);
  const third = c.refresh('/r');
  release();
  await first; await second; await third;
  expect(calls).toHaveLength(2);
});

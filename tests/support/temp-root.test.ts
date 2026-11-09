import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { isWin } from './platform';
import { TEMP_VARS, createRunTemp, removeRunTemp } from './temp-root';

// Each test gets its own base (inside the run's temp root) and restores the temp variables (TMPDIR; TEMP and TMP on
// Windows): createRunTemp changes them.
let base: string;
let saved: (readonly [string, string | undefined])[];
beforeEach(() => {
  saved = TEMP_VARS.map((v) => [v, process.env[v]] as const);
  base = mkdtempSync(join(tmpdir(), 'atl-base-'));
});
afterEach(() => {
  for (const [v, value] of saved) if (value === undefined) delete process.env[v]; else process.env[v] = value;
  rmSync(base, { recursive: true, force: true });
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

test('the test run itself works inside its own atl-run-* temp root', () => {
  // globalSetup (tests/support/global-temp-root.ts) set the temp variables before the forks workers started.
  expect(basename(tmpdir())).toMatch(/^atl-run-[A-Za-z0-9]{6}$/);
});

test('createRunTemp makes an atl-run-* dir directly under the base and points the temp variables at it', () => {
  const dir = createRunTemp(base);
  expect(dirname(dir)).toBe(base);
  expect(basename(dir)).toMatch(/^atl-run-[A-Za-z0-9]{6}$/);
  expect(lstatSync(dir).isDirectory()).toBe(true);
  for (const v of TEMP_VARS) expect(process.env[v]).toBe(dir);
  expect(tmpdir()).toBe(dir);
});

// Windows: the system temp can be an 8.3 short name (GitHub's runner: C:\Users\RUNNER~1\…) while real paths (realpath,
// git) use the long one: a run root in the short form makes every path comparison with a real path fail.
const shortName = (p: string) =>
  spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout.trim();
test.runIf(isWin)('a base given by its 8.3 short name: the run root is the long form, and removing it still works', () => {
  const long = join(base, 'a-folder-name-longer-than-eight');
  mkdirSync(long);
  const short = shortName(long);
  if (!short.includes('~')) return; // 8.3 names are off on this volume: nothing to check.
  const dir = createRunTemp(short);
  expect(dirname(dir)).toBe(realpathSync.native(long));
  expect(dir).not.toContain('~');
  for (const v of TEMP_VARS) expect(process.env[v]).toBe(dir);
  removeRunTemp(dir, short);
  expect(existsSync(dir)).toBe(false);
});

test('removeRunTemp deletes the run root with everything inside', () => {
  const dir = createRunTemp(base);
  mkdirSync(join(dir, 'atl-e2e-abc', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'atl-e2e-abc', 'nested', 'f.txt'), 'x');
  removeRunTemp(dir, base);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(base)).toBe(true);
});

test('removeRunTemp never follows a symlink inside the run root out of it', () => {
  const outside = mkdtempSync(join(base, 'outside-'));
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  const dir = createRunTemp(base);
  symlinkSync(outside, join(dir, 'link'));
  removeRunTemp(dir, base);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
});

test('removeRunTemp refuses a dir that is not a direct child of the base', () => {
  const other = mkdtempSync(join(base, 'other-'));
  const nested = join(other, 'atl-run-abcdef');
  mkdirSync(nested);
  expect(() => removeRunTemp(nested, base)).toThrow(/refus/i);
  expect(existsSync(nested)).toBe(true);
  // A path that climbs out with .. is judged after resolving it.
  const sneaky = join(base, 'atl-run-abcdef', '..', '..', basename(base));
  expect(() => removeRunTemp(sneaky, base)).toThrow(/refus/i);
  expect(existsSync(base)).toBe(true);
});

test('removeRunTemp refuses a dir not named atl-run-*', () => {
  const dir = join(base, 'atl-e2e-abcdef');
  mkdirSync(dir);
  expect(() => removeRunTemp(dir, base)).toThrow(/refus/i);
  expect(existsSync(dir)).toBe(true);
  expect(() => removeRunTemp(base, dirname(base))).toThrow(/refus/i);
  expect(existsSync(base)).toBe(true);
});

test('removeRunTemp refuses an atl-run-* that is a symlink, and leaves its target alone', () => {
  const target = mkdtempSync(join(base, 'target-'));
  writeFileSync(join(target, 'keep.txt'), 'keep');
  const link = join(base, 'atl-run-linked');
  symlinkSync(target, link);
  expect(() => removeRunTemp(link, base)).toThrow(/refus/i);
  expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
});

test('removeRunTemp of a run root already gone is a no-op', () => {
  const dir = createRunTemp(base);
  rmSync(dir, { recursive: true });
  expect(() => removeRunTemp(dir, base)).not.toThrow();
});

test('createRunTemp sweeps only atl-run-* dirs older than 24 h (a younger one may be a concurrent run)', () => {
  const stale = join(base, 'atl-run-stale1');
  const fresh = join(base, 'atl-run-fresh1');
  const looseOld = join(base, 'atl-e2e-old123');
  const staleTarget = mkdtempSync(join(base, 'target-'));
  const staleLink = join(base, 'atl-run-link01');
  for (const d of [stale, fresh, looseOld]) mkdirSync(d);
  writeFileSync(join(stale, 'f.txt'), 'x');
  symlinkSync(staleTarget, staleLink);
  for (const d of [stale, looseOld, staleTarget]) utimesSync(d, hoursAgo(25), hoursAgo(25));
  utimesSync(fresh, hoursAgo(23), hoursAgo(23));

  const dir = createRunTemp(base);

  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(looseOld)).toBe(true); // loose atl-* from before are not this code's business
  expect(lstatSync(staleLink).isSymbolicLink()).toBe(true); // never followed
  expect(existsSync(staleTarget)).toBe(true);
  expect(existsSync(dir)).toBe(true); // the new one is never swept
});

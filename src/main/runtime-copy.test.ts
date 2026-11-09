import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { ensureRuntime, pruneRuntimes } from './runtime-copy';

// atelierd's runtime copy on Windows: the package's folder copied once per daemon fingerprint
// outside the package, so Store updates never touch the files a running atelierd and its terminals hold.

function pkg(): string {
  const d = mkdtempSync(join(tmpdir(), 'atl-pkg-'));
  writeFileSync(join(d, 'Atelier.exe'), 'exe');
  mkdirSync(join(d, 'resources'));
  writeFileSync(join(d, 'resources', 'app.asar'), 'asar');
  return d;
}

test('copied whole, marked complete, then reused as it is', () => {
  const src = pkg();
  const root = join(mkdtempSync(join(tmpdir(), 'atl-rt-')), 'runtime');
  const rt = ensureRuntime(src, root, 'abc123');
  expect(rt).toBe(join(root, 'abc123'));
  expect(readFileSync(join(rt, 'resources', 'app.asar'), 'utf8')).toBe('asar');
  expect(existsSync(join(rt, '.complete'))).toBe(true);
  writeFileSync(join(src, 'Atelier.exe'), 'newer');
  expect(readFileSync(join(ensureRuntime(src, root, 'abc123'), 'Atelier.exe'), 'utf8')).toBe('exe');
  expect(readdirSync(root)).toEqual(['abc123']);
});

test('Windows: a fresh copy held for a moment by an antivirus is renamed on a later try, not thrown away', () => {
  initPlatform('win32');
  try {
    const src = pkg();
    const root = join(mkdtempSync(join(tmpdir(), 'atl-rt-')), 'runtime');
    let calls = 0;
    const rt = ensureRuntime(src, root, 'abc123', { rename: (a, b) => { if (++calls <= 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); renameSync(a, b); } });
    expect(calls).toBe(3);
    expect(existsSync(join(rt, '.complete'))).toBe(true);
  } finally { resetPlatformForTests(); }
});

test('a half copy (no .complete, a crash midway) is replaced, never run', () => {
  const src = pkg();
  const root = join(mkdtempSync(join(tmpdir(), 'atl-rt-')), 'runtime');
  mkdirSync(join(root, 'abc123'), { recursive: true });
  writeFileSync(join(root, 'abc123', 'Atelier.exe'), 'half');
  const rt = ensureRuntime(src, root, 'abc123');
  expect(readFileSync(join(rt, 'Atelier.exe'), 'utf8')).toBe('exe');
  expect(existsSync(join(rt, '.complete'))).toBe(true);
});

test('prune: copies nobody keeps go, the kept ones and fresh temporary copies stay', () => {
  const src = pkg();
  const root = join(mkdtempSync(join(tmpdir(), 'atl-rt-')), 'runtime');
  for (const fp of ['old1', 'live', 'current']) ensureRuntime(src, root, fp);
  mkdirSync(join(root, 'x.tmp-123'));
  mkdirSync(join(root, 'y.tmp-456'));
  const hourAgo = new Date(Date.now() - 2 * 3600_000);
  utimesSync(join(root, 'y.tmp-456'), hourAgo, hourAgo);
  pruneRuntimes(root, ['live', 'current']);
  expect(readdirSync(root).sort()).toEqual(['current', 'live', 'x.tmp-123']);
});

test('prune: a copy that can’t be moved aside (in use on Windows) is left whole', () => {
  const src = pkg();
  const root = join(mkdtempSync(join(tmpdir(), 'atl-rt-')), 'runtime');
  ensureRuntime(src, root, 'busy');
  pruneRuntimes(root, [], { rename: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } });
  expect(readFileSync(join(root, 'busy', 'Atelier.exe'), 'utf8')).toBe('exe');
});

// A field report: sessions with no states on a Store user's PC. A copy marked complete was trusted for good, even once an
// antivirus had quarantined a file atelierd needs from it (the bridge): a copy missing a key file the package has is
// rebuilt.
const KEYS = ['Atelier.exe', join('resources', 'bin', 'atelier-bridge.exe')];

function pkgWithBridge(): string {
  const d = pkg();
  mkdirSync(join(d, 'resources', 'bin'));
  writeFileSync(join(d, 'resources', 'bin', 'atelier-bridge.exe'), 'bridge');
  return d;
}

test('a complete copy that lost a key file the package has is rebuilt, moved aside first', () => {
  const src = pkgWithBridge();
  const root = join(mkdtempSync(join(tmpdir(), 'atl-rt-')), 'runtime');
  const rt = ensureRuntime(src, root, 'abc123', undefined, KEYS);
  rmSync(join(rt, 'resources', 'bin', 'atelier-bridge.exe'));
  const renames: string[][] = [];
  expect(ensureRuntime(src, root, 'abc123', { rename: (a, b) => { renames.push([a, b]); renameSync(a, b); } }, KEYS)).toBe(rt);
  expect(readFileSync(join(rt, 'resources', 'bin', 'atelier-bridge.exe'), 'utf8')).toBe('bridge');
  expect(existsSync(join(rt, '.complete'))).toBe(true);
  expect(renames[0]).toEqual([rt, `${rt}.del-${process.pid}`]);
  expect(readdirSync(root)).toEqual(['abc123']);
});

test('a key file the package itself lacks is not asked of the copy: reused as it is', () => {
  const src = pkg();
  const root = join(mkdtempSync(join(tmpdir(), 'atl-rt-')), 'runtime');
  const rt = ensureRuntime(src, root, 'abc123', undefined, KEYS);
  writeFileSync(join(rt, 'Atelier.exe'), 'kept');
  expect(readFileSync(join(ensureRuntime(src, root, 'abc123', undefined, KEYS), 'Atelier.exe'), 'utf8')).toBe('kept');
});

test('a copy that lost a key file but can’t be moved aside (a process still runs from it) is never half deleted: thrown', () => {
  const src = pkgWithBridge();
  const root = join(mkdtempSync(join(tmpdir(), 'atl-rt-')), 'runtime');
  const rt = ensureRuntime(src, root, 'abc123', undefined, KEYS);
  rmSync(join(rt, 'resources', 'bin', 'atelier-bridge.exe'));
  const busy = () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  expect(() => ensureRuntime(src, root, 'abc123', { rename: busy }, KEYS)).toThrow(/EBUSY/);
  expect(readFileSync(join(rt, 'Atelier.exe'), 'utf8')).toBe('exe');
  expect(existsSync(join(rt, '.complete'))).toBe(true);
});

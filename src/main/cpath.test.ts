import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { posixTest } from '../../tests/support/platform';
import { setTestDefaultPlatform } from '@shared/platform';
import { basename, dirname, extname, isAbsolute, join, normalize, realOut, realOutAsync, relative, resolve, sep, toOut } from './cpath';

// Paths main builds for the renderer: canonical on Windows (C:/…), node:path's own on macOS.

afterEach(() => { setTestDefaultPlatform('darwin'); });

posixTest('macOS: node:path itself', () => {
  expect(join('/p', 'a', '..', 'b.txt')).toBe(path.join('/p', 'a', '..', 'b.txt'));
  expect(resolve('/p', 'x')).toBe('/p/x');
  expect(relative('/p', '/p/a/b')).toBe('a/b');
  expect([dirname('/p/a'), basename('/p/a.ts', '.ts'), extname('/p/a.ts'), normalize('/p//a/../b'), isAbsolute('/p'), sep]).toEqual(['/p', 'a', '.ts', '/p/b', true, '/']);
  expect(toOut('/Users/me')).toBe('/Users/me');
});

test('Windows: the canonical form, whatever the input’s separators', () => {
  setTestDefaultPlatform('win32');
  expect(join('C:/dev/p', 'notes.txt')).toBe('C:/dev/p/notes.txt');
  expect(join('c:\\dev\\p', 'src', '..', 'a.ts')).toBe('C:/dev/p/a.ts');
  expect(resolve('C:/dev/p', 'sub\\x')).toBe('C:/dev/p/sub/x');
  expect(relative('C:/dev/p', 'C:\\dev\\p\\a\\b.ts')).toBe('a/b.ts');
  expect(relative('C:/dev/p', 'D:/x')).toBe('D:/x');
  expect(dirname('C:/dev/p/a.ts')).toBe('C:/dev/p');
  expect(dirname('C:/')).toBe('C:/');
  expect(basename('C:\\dev\\p\\a.ts')).toBe('a.ts');
  expect(normalize('C:\\dev\\.\\p\\')).toBe('C:/dev/p/');
  expect([isAbsolute('C:/x'), isAbsolute('x/y')]).toEqual([true, false]);
  expect(relative('C:/dev/p', 'C:/dev/p/a/b.ts').split(sep).join('/')).toBe('a/b.ts');
  expect(toOut('C:\\Users\\me')).toBe('C:/Users/me');
});

test('realOut, macOS: the native realpath (APFS\'s real spelling), as before', () => {
  const calls: string[] = [];
  const fns = { native: (p: string) => { calls.push('native'); return p.replace('.GIT', '.git'); }, js: (p: string) => { calls.push('js'); return p; } };
  expect(realOut('/p/.GIT', fns)).toBe('/p/.git');
  expect(calls).toEqual(['native']);
});

test('realOut, Windows: the real case on the drive the path was spelled with; a mapped or subst drive stays that drive', () => {
  setTestDefaultPlatform('win32');
  // A local folder: the native realpath's real case.
  expect(realOut('c:\\dev\\API\\a.ts', { native: () => 'C:\\dev\\api\\a.ts', js: () => 'C:\\dev\\API\\a.ts' })).toBe('C:/dev/api/a.ts');
  // A mapped network drive: native gives the share (refused by every IPC path schema); node's own keeps Z:.
  expect(realOut('Z:\\proj\\a.ts', { native: () => '\\\\server\\share\\proj\\a.ts', js: () => 'Z:\\proj\\a.ts' })).toBe('Z:/proj/a.ts');
  // A subst drive: native gives the folder behind it.
  expect(realOut('S:/proj', { native: () => 'C:\\work\\proj', js: () => 'S:\\proj' })).toBe('S:/proj');
});

test('realOutAsync: the same rule without blocking main; macOS native only', async () => {
  const calls: string[] = [];
  const mac = { native: async (p: string) => { calls.push('native'); return p.replace('.GIT', '.git'); }, js: async (p: string) => { calls.push('js'); return p; } };
  expect(await realOutAsync('/p/.GIT', mac)).toBe('/p/.git');
  expect(calls).toEqual(['native']);
  setTestDefaultPlatform('win32');
  expect(await realOutAsync('c:\\dev\\API\\a.ts', { native: async () => 'C:\\dev\\api\\a.ts', js: async () => 'C:\\dev\\API\\a.ts' })).toBe('C:/dev/api/a.ts');
  expect(await realOutAsync('Z:/proj/a.ts', { native: async () => '\\\\server\\share\\proj\\a.ts', js: async () => 'Z:\\proj\\a.ts' })).toBe('Z:/proj/a.ts');
  expect(await realOutAsync('S:/proj', { native: async () => 'C:\\work\\proj', js: async () => 'S:\\proj' })).toBe('S:/proj');
});

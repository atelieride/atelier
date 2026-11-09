import { describe, expect, test } from 'vitest';
import { isCleanAbsPath as cleanPathToday } from './clean-path';
import {
  isAbsPath, isBelow, isCleanAbsPath, isGitDirName, isInside, isRepoRel, isSafeRel, samePath, splitPath, toCanonical, toNative,
  trimOneSep, trimTrailingSep, win32NameProblem
} from './paths';

// POSIX results must be exactly today's: the code each helper replaces is copied here as the
// oracle, and a corpus of awkward strings runs through both.

const SEGMENTS = ['a', 'b c', '', '.', '..', '...', '.git', 'x\u0000', 'x\u001f', 'x\u007f', 'x\u0085', 'x\u009b', 'é', 'e\u0301', 'C:', 'a\\b', '~'];
function corpus(): string[] {
  const out = new Set<string>(['', '/', '//', '///', 'a', 'a/b', '/a/', '/a//b', 'C:/x', 'c:\\x', '\\\\h\\s', '/'.repeat(5), `/${'a'.repeat(4095)}`, `/${'a'.repeat(4096)}`]);
  for (const a of SEGMENTS) for (const b of SEGMENTS) { out.add(`/${a}/${b}`); out.add(`${a}/${b}`); out.add(`/${a}`); }
  return [...out];
}

const todayRelSchema = (r: string) => !r.includes('\0') && !r.startsWith('/') && r.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
const todayIsGitName = (s: string) => s.normalize('NFC').toLowerCase() === '.git';

describe('posix: identical to the code it replaces', () => {
  test('isCleanAbsPath = shared/clean-path.ts', () => {
    for (const p of corpus()) expect(isCleanAbsPath(p, 'posix'), JSON.stringify(p)).toBe(cleanPathToday(p));
    for (const v of [undefined, null, 1, {}, ['/a']]) expect(isCleanAbsPath(v, 'posix')).toBe(cleanPathToday(v));
  });

  test("isAbsPath = startsWith('/')", () => {
    for (const p of corpus()) expect(isAbsPath(p, 'posix')).toBe(p.startsWith('/'));
  });

  test("isBelow = p.startsWith(root + '/'), isInside also accepts the root itself", () => {
    const roots = ['/r', '/r/x', '/', '', '/R'];
    for (const root of roots) for (const p of [...corpus(), '/r', '/r/a', '/rx', '/R/a']) {
      expect(isBelow(root, p, 'posix'), `${root} ${p}`).toBe(p.startsWith(root + '/'));
      expect(isInside(root, p, 'posix'), `${root} ${p}`).toBe(p === root || p.startsWith(root + '/'));
    }
  });

  test('samePath is ===', () => {
    expect(samePath('/a', '/a', 'posix')).toBe(true);
    expect(samePath('/a', '/A', 'posix')).toBe(false);
    expect(samePath('/a/', '/a', 'posix')).toBe(false);
  });

  test("isSafeRel = ipc-schemas' relSchema refinement", () => {
    for (const p of corpus()) expect(isSafeRel(p, 'posix'), JSON.stringify(p)).toBe(todayRelSchema(p));
  });

  test("isRepoRel = the git readers' check (git/compare.ts, history.ts safeRel, service.ts)", () => {
    const today = (rel: string) => !!rel && !rel.startsWith('/') && !rel.split('/').includes('..') && !rel.includes('\0');
    for (const p of corpus()) expect(isRepoRel(p, 'posix'), JSON.stringify(p)).toBe(today(p));
  });

  test("isGitDirName = fs/write.ts' isGitName (NFC, any case)", () => {
    for (const s of [...SEGMENTS, '.GIT', '.Git', '.git.', '.git ', 'git~1', '.gitignore', '.git\u0301']) expect(isGitDirName(s, 'posix'), s).toBe(todayIsGitName(s));
  });

  test('toCanonical and toNative are the identity; splitPath and trimTrailingSep use / only', () => {
    for (const p of corpus()) { expect(toCanonical(p, 'posix')).toBe(p); expect(toNative(p, 'posix')).toBe(p); }
    expect(splitPath('/a\\b/c', 'posix')).toEqual(['', 'a\\b', 'c']);
    expect(trimTrailingSep('/a///', 'posix')).toBe('/a');
    expect(trimTrailingSep('/a\\', 'posix')).toBe('/a\\');
    expect(trimTrailingSep('/', 'posix')).toBe('');
    // A root ending in its separator, as `root.endsWith('/') ? root : root + '/'` saw it: one separator, not all.
    for (const r of ['/a', '/a/', '/a//', '/', '//', '']) expect(trimOneSep(r, 'posix') + '/', r).toBe(r.endsWith('/') ? r : r + '/');
    expect(trimOneSep('/a\\', 'posix')).toBe('/a\\');
  });
});

describe('win32', () => {
  test('isAbsPath: a drive letter and a separator; never relative, drive-relative, UNC or device paths', () => {
    for (const p of ['C:/x', 'c:/x', 'C:\\x', 'z:\\', 'C:/']) expect(isAbsPath(p, 'win32'), p).toBe(true);
    for (const p of ['/x', 'C:', 'C:x', 'x', '\\\\host\\share', '\\\\?\\C:\\x', '//host/share', '1:/x', '']) expect(isAbsPath(p, 'win32'), p).toBe(false);
  });

  test('isCleanAbsPath: clean segments after the drive, no Windows-reserved names or characters', () => {
    for (const p of ['C:/Users/x', 'c:\\Users\\x\\.claude', 'D:/a b/c.d']) expect(isCleanAbsPath(p, 'win32'), p).toBe(true);
    for (const p of [
      'C:/', 'C:', 'C:x', '/Users/x', 'C:/a/../b', 'C:/a/./b', 'C:/a//b', 'C:/a/', 'C:/a:b', 'C:/a/b.', 'C:/a/b ',
      'C:/CON', 'C:/a/nul.txt', 'C:/a/Com1', 'C:/a/lpt9.log', 'C:/a/AUX', 'C:/a/prn.x.y', 'C:/a<b', 'C:/a|b', 'C:/a?b',
      'C:/a*b', 'C:/a"b', 'C:/a\u0000b', 'C:/a\u009bb', `C:/${'a'.repeat(4094)}`, '\\\\host\\share\\x'
    ]) expect(isCleanAbsPath(p, 'win32'), p).toBe(false);
    expect(isCleanAbsPath(42, 'win32')).toBe(false);
  });

  test('containment ignores case and accepts either separator', () => {
    expect(isInside('C:/Proj', 'c:/proj/a', 'win32')).toBe(true);
    expect(isInside('C:\\Proj', 'c:/proj', 'win32')).toBe(true);
    expect(isInside('C:/Proj', 'C:\\PROJ\\a\\b', 'win32')).toBe(true);
    expect(isInside('C:/Proj', 'C:/Proj2/a', 'win32')).toBe(false);
    expect(isBelow('C:/Proj', 'C:/proj', 'win32')).toBe(false);
    expect(isBelow('C:/Proj', 'C:/proj/x', 'win32')).toBe(true);
    expect(isInside('C:/Proj', 'D:/Proj/x', 'win32')).toBe(false);
  });

  test('samePath ignores case and separators', () => {
    expect(samePath('C:\\Users\\X', 'c:/users/x', 'win32')).toBe(true);
    expect(samePath('C:/a', 'C:/b', 'win32')).toBe(false);
  });

  test('isSafeRel also refuses backslashes, colons and reserved names', () => {
    for (const r of ['a/b', 'src/x.ts', '.github/w.yml']) expect(isSafeRel(r, 'win32'), r).toBe(true);
    for (const r of ['a\\b', '..\\x', 'a:b', 'C:x', 'con', 'a/NUL.txt', 'a/b.', 'a/b ', 'a/<b', '../x', 'a//b', '/a']) expect(isSafeRel(r, 'win32'), r).toBe(false);
  });

  test('isRepoRel also refuses backslashes and colons (..\\ and drives)', () => {
    expect(isRepoRel('src/a.ts', 'win32')).toBe(true);
    for (const r of ['..\\x', 'a\\b', 'C:x', 'a:b', '/a', 'a/../b', '']) expect(isRepoRel(r, 'win32'), r).toBe(false);
  });

  test('isGitDirName: the names NTFS resolves to .git too', () => {
    for (const s of ['.git', '.GIT', '.git.', '.git ', '.git. .', 'GIT~1', 'git~1']) expect(isGitDirName(s, 'win32'), s).toBe(true);
    for (const s of ['.gitignore', 'git', '.git~1', 'GIT~2', '.gi t']) expect(isGitDirName(s, 'win32'), s).toBe(false);
  });

  test('canonical form: forward slashes and an upper-case drive; native form: backslashes', () => {
    expect(toCanonical('c:\\Users\\x', 'win32')).toBe('C:/Users/x');
    expect(toCanonical('C:/a\\b', 'win32')).toBe('C:/a/b');
    expect(toCanonical('rel\\x', 'win32')).toBe('rel/x');
    expect(toNative('C:/Users/x', 'win32')).toBe('C:\\Users\\x');
    expect(splitPath('C:\\a/b', 'win32')).toEqual(['C:', 'a', 'b']);
    expect(trimTrailingSep('C:\\a\\/', 'win32')).toBe('C:\\a');
    expect(trimOneSep('C:\\a\\/', 'win32')).toBe('C:\\a\\');
    expect(trimOneSep('C:\\a\\', 'win32')).toBe('C:\\a');
  });

  test('win32NameProblem names what makes a segment unusable', () => {
    expect(win32NameProblem('ok.txt')).toBeNull();
    expect(win32NameProblem('con')).toBe('reserved');
    expect(win32NameProblem('a.')).toBe('trailing');
    expect(win32NameProblem('a ')).toBe('trailing');
    expect(win32NameProblem('a:b')).toBe('character');
    expect(win32NameProblem('a\\b')).toBe('character');
    expect(win32NameProblem('a\u0001')).toBe('character');
  });
});

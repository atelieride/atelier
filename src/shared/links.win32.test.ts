import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { findFileLinks } from './links';
import { linksAt, type Row } from './wrapped-paths';

// Terminal links on Windows: drive paths, backslashes, file:///C:/ URLs. The macOS shapes
// stay pinned by links.test.ts and wrapped-paths.test.ts (the POSIX regexes are the same objects as before).

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

const rows = (text: string): Row[] => text.split('\n').map((t) => ({ text: t, wrapped: false }));
const at = (r: Row[]) => (y: number) => r[y];

describe('findFileLinks', () => {
  test('a drive path with line and column', () => {
    expect(findFileLinks('error at C:\\Users\\x\\proj\\src\\a.ts:12:5 here')).toEqual([
      { start: 9, end: 9 + 'C:\\Users\\x\\proj\\src\\a.ts:12:5'.length, path: 'C:\\Users\\x\\proj\\src\\a.ts', line: 12, col: 5 }
    ]);
  });

  test('forward slashes after a drive, relative backslash paths, and the shapes macOS knows', () => {
    expect(findFileLinks('C:/a/b.ts:3').map((l) => [l.path, l.line])).toEqual([['C:/a/b.ts', 3]]);
    expect(findFileLinks('see src\\b.ts and .\\c.md').map((l) => l.path)).toEqual(['src\\b.ts', '.\\c.md']);
    expect(findFileLinks('see src/b.ts and ~/x.md').map((l) => l.path)).toEqual(['src/b.ts', '~/x.md']);
  });

  test('never a path inside a URL, a version or a sentence end', () => {
    expect(findFileLinks('https://x.dev/C:/a.ts v1.2.3 fine.')).toEqual([]);
  });
});

describe('linksAt', () => {
  test('a file:///C:/ URL is that drive path, percent-decoded', () => {
    expect(linksAt(at(rows('open file:///C:/Users/x/my%20shot.png now')), 0, 80).map((l) => [l.kind, l.path])).toEqual([['file', 'C:/Users/x/my shot.png']]);
  });

  test('an absolute drive folder is a folder link', () => {
    expect(linksAt(at(rows('in C:\\Users\\x\\proj\\ and src\\dir\\ here')), 0, 80).map((l) => [l.kind, l.path])).toEqual([['folder', 'C:\\Users\\x\\proj\\']]);
  });
});

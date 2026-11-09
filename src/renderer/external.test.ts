import { expect, test } from 'vitest';
import { crumbDirs, isExternal, outsideDir } from './external';

test('breadcrumb folders: an absolute path has no empty first step; ~ is one', () => {
  expect(crumbDirs('src/a.ts')).toEqual(['src']);
  expect(crumbDirs('a.ts')).toEqual([]);
  expect(crumbDirs('~/Downloads/x.json')).toEqual(['~', 'Downloads']);
  expect(crumbDirs('/private/var/x.log')).toEqual(['private', 'var']);
});

test('a file outside the project real root is external; project files, untitled tabs and no project are not', () => {
  expect(isExternal('/Users/me/x.json', '/p')).toBe(true);
  expect(isExternal('/p-twin/a.ts', '/p')).toBe(true);
  expect(isExternal('/p/src/a.ts', '/p')).toBe(false);
  expect(isExternal('/p/src/a.ts', '/p/')).toBe(false);
  expect(isExternal('untitled:1', '/p')).toBe(false);
  expect(isExternal('/Users/me/x.json', null)).toBe(false);
});

test("an outside file's tab hint is the folder holding it: ~ for the home, / for the disk root", () => {
  expect(outsideDir('~/Downloads/README.md')).toBe('Downloads');
  expect(outsideDir('~/Documents/repos/shop/README.md')).toBe('shop');
  expect(outsideDir('~/.zshrc')).toBe('~');
  expect(outsideDir('/etc/hosts')).toBe('etc');
  expect(outsideDir('/x.log')).toBe('/');
});

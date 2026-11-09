import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { expandFlags, flagError } from './claude-flags';

// Windows: what PowerShell 5.1, npm's claude.cmd or cmd would change on the way to claude.exe is refused.

afterEach(() => { resetPlatformForTests(); });

test('Windows: no double quote, percent, bang or trailing backslash', () => {
  initPlatform('win32');
  for (const v of ['a"b', '%PATH%', 'hi!', 'C:\\dir\\']) expect(flagError(['--x', v]), v).toBe('chars');
  expect(flagError(['--add-dir', 'C:\\Users\\me\\notes'])).toBeNull();
});

test('macOS: the same values are fine', () => {
  initPlatform('darwin');
  for (const v of ['a"b', '%PATH%', 'hi!', '/dir\\']) expect(flagError(['--x', v]), v).toBeNull();
});

test("Windows: what cmd would read in npm's claude.cmd is refused too", () => {
  initPlatform('win32');
  for (const v of ['C:\\R&D', 'a|b', 'a<b', 'a>b', 'a^b']) expect(flagError(['--x', v]), v).toBe('chars');
});

test('Windows: ~\\ expands like ~/', () => {
  initPlatform('win32');
  expect(expandFlags([['--add-dir', '~\\notes']], 'C:\\Users\\me')).toEqual([['--add-dir', 'C:\\Users\\me\\notes']]);
});

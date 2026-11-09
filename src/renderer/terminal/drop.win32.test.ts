import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { dropText } from './drop';

// Files dropped on a terminal on Windows: quoted for the shell the terminal runs, so nothing in
// a file name is read by it (PowerShell expands $ and ` inside double quotes, cmd expands % and !).

afterEach(() => { resetPlatformForTests(); });

test('Windows, PowerShell (the built-in profiles): native paths in single quotes when needed — $ and ` stay literal', () => {
  initPlatform('win32');
  expect(dropText(['C:\\a b\\x.ts', 'C:/p/y.ts', "C:/p/(1)&x's.ts", 'C:/p/$HOME.txt'], 'powershell'))
    .toBe("'C:\\a b\\x.ts' C:\\p\\y.ts 'C:\\p\\(1)&x''s.ts' 'C:\\p\\$HOME.txt' ");
  expect(dropText(['C:/p/a\nb.ts'], 'powershell')).toBe('');
});

test('Windows, cmd: double quotes; a path cmd would expand (% or !) is left out', () => {
  initPlatform('win32');
  expect(dropText(['C:/a b/x.ts', 'C:/p/%TEMP%.txt', 'C:/p/y.ts'], 'cmd')).toBe('"C:\\a b\\x.ts" C:\\p\\y.ts ');
});

test('Windows, a POSIX shell (Git Bash, WSL): forward slashes, escaped like on macOS', () => {
  initPlatform('win32');
  expect(dropText(['C:\\a b\\x.ts'], 'posix')).toBe('C:/a\\ b/x.ts ');
});

test('macOS: escaped as before', () => {
  initPlatform('darwin');
  expect(dropText(['/a b/x.ts'])).toBe('/a\\ b/x.ts ');
});

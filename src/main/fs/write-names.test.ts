import { expect, test } from 'vitest';
import { entryNameOk } from './write';

// The name of the project entry the writer acts on (security): on Windows a name NTFS reads as
// something else is never one. `.git::$INDEX_ALLOCATION` is the .git folder itself (CVE-2019-1352), `a.ts:x` a hidden
// stream of a.ts, `con` the console. macOS: any name (its .git check is the writer's own, unchanged).

test('Windows: no stream, device, forbidden character or trailing dot in the entry name', () => {
  for (const n of ['.git::$INDEX_ALLOCATION', 'a.ts:x', 'a.ts::$DATA', 'con', 'NUL.txt', 'a?b', 'a.', 'a ']) expect(entryNameOk(n, 'win32'), n).toBe(false);
  for (const n of ['a.ts', '.gitignore', 'con-fig.ts', 'README.md']) expect(entryNameOk(n, 'win32'), n).toBe(true);
});

test('macOS: names as before (a colon is a plain character there)', () => {
  for (const n of ['a.ts:x', 'con', 'a.', 'a?b']) expect(entryNameOk(n, 'posix'), n).toBe(true);
});

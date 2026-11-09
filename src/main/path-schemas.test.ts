import { describe, expect, test } from 'vitest';
import { absPathSchema, filePathKeySchema, gitRelSchema, safeRelSchema } from './path-schemas';

// The path shapes IPC accepts. POSIX: exactly the zod checks ipc-schemas had. Windows: the
// renderer's canonical form (C:/…, forward slashes), never a backslash, a drive-relative path or a UNC share.

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe('posix (as before)', () => {
  test("absPathSchema = z.string().min(min).max(max).startsWith('/')", () => {
    const s = absPathSchema(2, 10, 'posix');
    expect(ok(s, '/a')).toBe(true);
    expect(ok(s, '/')).toBe(false);
    expect(ok(s, 'a/b')).toBe(false);
    expect(ok(s, '/abcdefghij')).toBe(false);
    expect(ok(s, 'C:/x')).toBe(false);
    expect(ok(s, '/a\\b')).toBe(true);
  });

  test('safeRelSchema = the old relSchema; gitRelSchema = the old scmFileSchema.rel', () => {
    for (const [r, safe, git] of [
      ['a/b', true, true], ['a//b', false, true], ['./a', false, true], ['a/../b', false, false], ['/a', false, false],
      ['a\u0000', false, false], ['a\\..\\b', true, true], ['C:x', true, true]
    ] as const) {
      expect(ok(safeRelSchema(4096, 'posix'), r), r).toBe(safe);
      expect(ok(gitRelSchema(4096, 'posix'), r), r).toBe(git);
    }
  });

  test("filePathKeySchema = 'f:' + '/…' (Save As in a pop-out)", () => {
    expect(ok(filePathKeySchema(100, 'posix'), 'f:/a')).toBe(true);
    expect(ok(filePathKeySchema(100, 'posix'), 'f:a')).toBe(false);
    expect(ok(filePathKeySchema(100, 'posix'), 'f:/a\u0000')).toBe(false);
  });
});

describe('win32 (canonical paths only)', () => {
  test('absPathSchema: a drive and forward slashes', () => {
    const s = absPathSchema(2, 4096, 'win32');
    for (const p of ['C:/Users/x', 'd:/a']) expect(ok(s, p), p).toBe(true);
    for (const p of ['/Users/x', 'C:\\Users\\x', 'C:/a\\b', 'C:x', 'C:', '\\\\host\\s', '//host/s', 'C:/a\u0000']) expect(ok(s, p), p).toBe(false);
  });

  test('absPathSchema: no NTFS stream (a colon past the drive) nor device name, which would open something else', () => {
    const s = absPathSchema(2, 4096, 'win32');
    // `.git::$INDEX_ALLOCATION` opens the .git folder (CVE-2019-1352); `a.ts:x` is a hidden stream; `con` the console.
    for (const p of ['C:/r/.git::$INDEX_ALLOCATION', 'C:/r/.git::$INDEX_ALLOCATION/config', 'C:/r/a.ts:x', 'C:/r/a.ts::$DATA', 'C:/r/con', 'C:/r/NUL.txt', 'C:/r/com1/x', 'C:/r/a?b', 'C:/r/a|b']) expect(ok(s, p), p).toBe(false);
    for (const p of ['C:/', 'C:/r/', 'C:/Program Files/Git/bin/bash.exe', 'C:/r/a.b.c', 'C:/r/con-fig.ts', 'C:/r/.git/x', 'C:/r/v2.']) expect(ok(s, p), p).toBe(true);
    expect(ok(filePathKeySchema(100, 'win32'), 'f:C:/r/a.ts:x')).toBe(false);
  });

  test('safeRelSchema and gitRelSchema refuse backslashes and drives; safeRel also reserved names', () => {
    for (const r of ['a\\b', '..\\x', 'C:x', 'a:b']) {
      expect(ok(safeRelSchema(4096, 'win32'), r), r).toBe(false);
      expect(ok(gitRelSchema(4096, 'win32'), r), r).toBe(false);
    }
    expect(ok(safeRelSchema(4096, 'win32'), 'a/CON')).toBe(false);
    expect(ok(safeRelSchema(4096, 'win32'), 'src/a.ts')).toBe(true);
    expect(ok(gitRelSchema(4096, 'win32'), 'src/a.ts')).toBe(true);
  });

  test("filePathKeySchema: 'f:' + a canonical absolute path", () => {
    expect(ok(filePathKeySchema(100, 'win32'), 'f:C:/a')).toBe(true);
    expect(ok(filePathKeySchema(100, 'win32'), 'f:/a')).toBe(false);
    expect(ok(filePathKeySchema(100, 'win32'), 'f:C:\\a')).toBe(false);
  });
});

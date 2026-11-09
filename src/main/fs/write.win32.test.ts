import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { toCanonical } from '@shared/paths';
import { createFileWithContent, entryInfo, renameEntry, renameWithRetry, trashEntry, validName } from './write';

// The project writer's name and path checks on Windows (security). The macOS behaviour stays
// pinned by write.test.ts.

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

describe('validName on Windows', () => {
  test('refuses separators, drives, reserved names and trailing dots or spaces', () => {
    for (const n of ['a\\b', 'a:b', 'C:', 'con', 'NUL.txt', 'com1.log', 'a.', 'a ', 'a<b', 'a|b', 'a?b', 'a*b', 'a"b', '.git.', 'GIT~1']) expect(validName(n), n).toBe(false);
    for (const n of ['a.ts', 'README.md', '.gitignore', 'con-fig.ts']) expect(validName(n), n).toBe(true);
  });
});

describe('Save As paths on Windows', () => {
  test('backslash segments are segments: ..\\ is outside, a drive is absolute, NTFS .git aliases are .git', () => {
    expect(createFileWithContent('C:/nowhere', '..\\x.ts', '')).toEqual({ error: 'outside' });
    expect(createFileWithContent('C:/nowhere', 'a\\..\\..\\x.ts', '')).toEqual({ error: 'outside' });
    expect(createFileWithContent('C:/nowhere', 'C:/x.ts', '')).toEqual({ error: 'absolute' });
    expect(createFileWithContent('C:/nowhere', 'C:\\x.ts', '')).toEqual({ error: 'absolute' });
    expect(createFileWithContent('C:/nowhere', '.GIT./hooks/x', '')).toEqual({ error: 'in-git' });
    expect(createFileWithContent('C:/nowhere', 'git~1\\config', '')).toEqual({ error: 'in-git' });
    expect(createFileWithContent('C:/nowhere', 'a/con.ts', '')).toEqual({ error: 'invalid-name' });
  });
});

describe('NTFS streams', () => {
  test('.git::$INDEX_ALLOCATION (the .git folder itself) and a file\'s stream are never an entry', async () => {
    const root = toCanonical(realpathSync.native(mkdtempSync(join(tmpdir(), 'atl-ads-'))));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'a.ts'), 'x');
    const trashed: string[] = [];
    expect(await trashEntry(root, `${root}/.git::$INDEX_ALLOCATION`, async (p) => void trashed.push(p))).toEqual({ error: 'outside' });
    expect(renameEntry(root, `${root}/.git::$INDEX_ALLOCATION`, 'g')).toEqual({ error: 'outside' });
    expect(entryInfo(root, `${root}/a.ts:hidden`)).toEqual({ error: 'outside' });
    expect(trashed).toEqual([]);
  });
});

describe('renameWithRetry', () => {
  const failing = (codes: string[]) => {
    const calls: string[] = [];
    const rename = (from: string, to: string) => {
      calls.push(`${from}>${to}`);
      const code = codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
    };
    return { calls, rename };
  };

  test('Windows: a file held for a moment by an indexer or antivirus (EPERM, EBUSY, EACCES) is retried', () => {
    const f = failing(['EPERM', 'EBUSY']);
    renameWithRetry('a', 'b', f.rename, () => {});
    expect(f.calls).toHaveLength(3);
  });

  test('Windows: other errors, and a file still held after the last try, throw', () => {
    expect(() => renameWithRetry('a', 'b', failing(['ENOENT']).rename, () => {})).toThrow('ENOENT');
    const held = failing(['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']);
    expect(() => renameWithRetry('a', 'b', held.rename, () => {})).toThrow('EPERM');
    expect(held.calls).toHaveLength(5);
  });

  test('macOS: one rename, no retry (as before)', () => {
    initPlatform('darwin');
    const f = failing(['EPERM']);
    expect(() => renameWithRetry('a', 'b', f.rename, () => {})).toThrow('EPERM');
    expect(f.calls).toHaveLength(1);
  });
});

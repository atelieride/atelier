import { afterEach, describe, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { readContentAt } from './compare';
import { readBlob } from './history';
import { readHeadContent } from './service';
import { validRel } from './write';

// The readers that hand a repository path back to git (`git show <rev>:<rel>`) refuse a path that could leave the
// repository before running anything. The repo doesn't exist: a refusal never reaches git.

const OID = 'a'.repeat(40);
afterEach(() => { resetPlatformForTests(); });

describe('refused before git runs', () => {
  test('macOS: absolute, .., NUL, empty', async () => {
    initPlatform('darwin');
    for (const rel of ['/etc/passwd', '../x', 'a/../../x', 'a\u0000', '']) {
      expect(await readHeadContent('/nowhere', rel), rel).toBeNull();
      expect(await readContentAt('/nowhere', 'HEAD', rel), rel).toBeNull();
      expect(await readBlob('/nowhere', OID, rel), rel).toEqual({ kind: 'missing' });
    }
  });

  test('git writes: validRel refuses backslash and colon paths on Windows (a ..\\ escape, a drive); valid names on macOS', () => {
    initPlatform('darwin');
    expect(validRel('a\\b')).toBe(true);
    initPlatform('win32');
    for (const rel of ['..\\x', 'a\\b', 'C:x', 'a:b']) expect(validRel(rel), rel).toBe(false);
    expect(validRel('src/a.ts')).toBe(true);
  });

  test('Windows: also ..\\ and drives', async () => {
    initPlatform('win32');
    for (const rel of ['..\\x', 'a\\..\\..\\x', 'C:x', 'C:\\x']) {
      expect(await readHeadContent('C:/nowhere', rel), rel).toBeNull();
      expect(await readContentAt('C:/nowhere', 'HEAD', rel), rel).toBeNull();
      expect(await readBlob('C:/nowhere', OID, rel), rel).toEqual({ kind: 'missing' });
    }
  });
});

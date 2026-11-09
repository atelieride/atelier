import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { checkOutsideFile, expandHome } from './outside-read';

// Windows: the page sends C:/… and ~/… (canonical; the schema is pinned in
// ipc-schemas.win32.test.ts).

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

test('~/ under the canonical home; `..` still refused once expanded', async () => {
  expect(expandHome('~/.claude/plans/x.md', 'C:/Users/me')).toBe('C:/Users/me/.claude/plans/x.md');
  expect(await checkOutsideFile('C:/p', '~/../other/x.md', 'C:/Users/me')).toBeNull();
  expect(await checkOutsideFile('C:/p', 'C:/Users/me/a/../x.md', 'C:/Users/me')).toBeNull();
});

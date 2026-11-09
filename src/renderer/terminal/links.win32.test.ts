import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { linkTargets, type TargetDeps } from './links';

// Windows: Claude prints C:\… and ~\… paths; IPC carries the canonical form (C:/…, ~/…),
// which main's schema takes. Sent as written, main's schema refused them and the link never showed.

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

const none: TargetDeps = { resolve: async () => null, claudeResolve: async () => null };
const one = (text: string) => linkTargets(() => ({ text, wrapped: false }), 0, 120, none);

test('an outside path written with backslashes is sent in the canonical form', async () => {
  expect((await one('wrote C:\\Users\\me\\plans\\x.md:4 now')).map((x) => x.target)).toEqual([
    { path: 'C:/Users/me/plans/x.md', rel: '', line: 4, claude: false, outside: true }
  ]);
  expect((await one('see ~\\.claude\\plans\\x.md')).map((x) => x.target.path)).toEqual(['~/.claude/plans/x.md']);
});

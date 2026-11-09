import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { claudeRoots } from '../background-fs';
import { claudeTempRoot } from './claude-images';

// Windows (measured on the test PC): Claude Code's temp root is %TEMP%\claude\<project>\<session>\…, in the user's own
// temp folder. libuv reports every writable folder there as 0o666 and no uid, so the macOS checks (owner, not writable
// by others) would refuse it for good: Background output and Claude's image links stayed dead.

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

test('the temp root is the user\'s temp folder\'s claude', () => {
  const saved = process.env.ATELIER_TEST_CLAUDE_TMP;
  delete process.env.ATELIER_TEST_CLAUDE_TMP;
  try {
    const tmp = claudeRoots().tmp;
    expect(tmp).toMatch(/\/claude$/);
    expect(tmp).toContain(tmpdir().replace(/\\/g, '/').split('/').filter(Boolean).at(-1)!);
  } finally {
    if (saved !== undefined) process.env.ATELIER_TEST_CLAUDE_TMP = saved;
  }
});

test('a folder (never a link, never a file) is trusted whatever its mode bits say', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cimg-win-')));
  const tmp = join(base, 'claude');
  mkdirSync(tmp);
  chmodSync(tmp, 0o777);
  // Canonical, as every path in the app (C:/… on Windows).
  expect(claudeTempRoot(tmp, null)).toBe(tmp.replace(/\\/g, '/'));
  expect(claudeTempRoot(join(base, 'nope'), null)).toBeNull();
});

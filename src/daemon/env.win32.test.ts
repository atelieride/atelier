import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { buildTerminalEnv, inherited } from './env';

// A terminal's environment on Windows: variable names in any case (`Path`), `;` lists. The spelling the system gave
// stays (a second `PATH` beside `Path` would leave the child guessing).

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

test('Path keeps its spelling and loses other terminals’ shims, split on ;', () => {
  const env = buildTerminalEnv({ Path: 'C:\\Users\\x\\AppData\\Local\\Temp\\cmux-cli-shims\\A;C:\\Windows\\system32;;C:\\Tools' }, {});
  expect(env.Path).toBe('C:\\Windows\\system32;C:\\Tools');
  expect(env.PATH).toBeUndefined();
});

test('dropped variables are dropped in any case', () => {
  expect(inherited('Electron_Run_As_Node')).toBe(false);
  expect(inherited('nodefaultcurrentdirectoryinexepath')).toBe(false);
  expect(inherited('ClaudeCode')).toBe(false);
  expect(inherited('UserProfile')).toBe(true);
  const env = buildTerminalEnv({ Git_Editor: 'true', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, {});
  expect(env.Git_Editor).toBeUndefined();
  expect(env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe');
});

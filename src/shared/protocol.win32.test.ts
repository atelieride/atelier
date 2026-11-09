import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { clientRequestSchema } from './protocol';

// Paths on the app ⇄ atelierd protocol: the canonical form, `C:/…` on Windows (the app sends
// what the renderer holds; atelierd converts to the native form only where the OS needs it).

afterEach(() => { resetPlatformForTests(); });

const create = (projectRoot: string, cwd = projectRoot) => clientRequestSchema.safeParse({ t: 'create', rid: 1, projectRoot, cwd, cols: 80, rows: 24 }).success;
const resume = (configDir: string) => clientRequestSchema.safeParse({ t: 'resume', rid: 1, id: 'r', cols: 80, rows: 24, configDir }).success;
const shell = (path: string) => clientRequestSchema.safeParse({ t: 'create', rid: 1, projectRoot: '/p', cwd: '/p', cols: 80, rows: 24, profile: { shell: path } }).success;

test('Windows: canonical drive paths only', () => {
  initPlatform('win32');
  expect(create('C:/Users/mario/proj')).toBe(true);
  expect(create('C:\\Users\\mario\\proj')).toBe(false);
  expect(create('/Users/mario/proj')).toBe(false);
  expect(create('C:/p\u0000x')).toBe(false);
  expect(create('C:/p', 'D:/other')).toBe(true);
  expect(resume('C:/Users/mario/.claude-work')).toBe(true);
  expect(resume('C:/Users/mario/../x')).toBe(false);
  expect(clientRequestSchema.safeParse({ t: 'create', rid: 1, projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, profile: { shell: 'C:/Program Files/PowerShell/7/pwsh.exe' } }).success).toBe(true);
});

test('macOS: as before', () => {
  initPlatform('darwin');
  expect(create('/Users/mario/proj')).toBe(true);
  expect(create('C:/Users/mario/proj')).toBe(false);
  expect(resume('/Users/mario/.claude-work')).toBe(true);
  expect(shell('/bin/bash')).toBe(true);
  expect(shell('bash')).toBe(false);
});

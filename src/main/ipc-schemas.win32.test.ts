import { afterAll, beforeAll, expect, test, vi } from 'vitest';

// ipc-schemas builds its schemas at load for the running platform: on Windows, canonical paths.
// The macOS shapes stay pinned by ipc-schemas.test.ts.

let s: typeof import('./ipc-schemas');
let platform: typeof import('@shared/platform');
beforeAll(async () => {
  // Fresh module instances, the platform forced in the one ipc-schemas will see.
  vi.resetModules();
  platform = await import('@shared/platform');
  platform.initPlatform('win32');
  s = await import('./ipc-schemas');
});
afterAll(() => { platform.resetPlatformForTests(); });

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) => schema.safeParse(v).success;

test('a path a terminal link names: the canonical forms only, C:/… or ~/…', () => {
  expect(ok(s.filesOutsideSchema, 'C:/Users/me/plans/x.md')).toBe(true);
  expect(ok(s.filesOutsideSchema, '~/.claude/plans/x.md')).toBe(true);
  expect(ok(s.filesOutsideSchema, 'C:\\Users\\me\\plans\\x.md')).toBe(false);
  expect(ok(s.filesOutsideSchema, '~\\.claude\\plans\\x.md')).toBe(false);
  expect(ok(s.filesOutsideSchema, '/tmp/x.md')).toBe(false);
});

test('absolute paths: C:/… only', () => {
  expect(ok(s.termCreateSchema, { cwd: 'C:/proj', cols: 80, rows: 24 })).toBe(true);
  expect(ok(s.termCreateSchema, { cwd: '/proj', cols: 80, rows: 24 })).toBe(false);
  expect(ok(s.termCreateSchema, { cwd: 'C:\\proj', cols: 80, rows: 24 })).toBe(false);
  expect(ok(s.attributionResolveSchema, { paths: ['C:/p/a.ts'], terminalId: null })).toBe(true);
  expect(ok(s.attributionResolveSchema, { paths: ['\\\\host\\share\\a.ts'], terminalId: null })).toBe(false);
  expect(ok(s.profileKeySchema, 'C:/Program Files/PowerShell/7/pwsh.exe')).toBe(true);
  expect(ok(s.popoutOpenInMainSchema, { path: 'C:/p/a.ts' })).toBe(true);
  expect(ok(s.popoutRekeySchema, { from: 'f:untitled:1', to: 'f:C:/p/a.ts' })).toBe(true);
  expect(ok(s.popoutRekeySchema, { from: 'f:untitled:1', to: 'f:/p/a.ts' })).toBe(false);
});

test('repository paths: no backslash, drive or .. through Windows separators', () => {
  const file = (rel: string) => ok(s.scmFileSchema, { root: 'C:/r', oid: 'a'.repeat(40), rel });
  expect(file('src/a.ts')).toBe(true);
  expect(file('..\\outside')).toBe(false);
  expect(file('C:x')).toBe(false);
});

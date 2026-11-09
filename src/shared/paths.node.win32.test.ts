import os from 'node:os';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { atelierHome, daemonPaths, isPipePath } from './paths.node';

// atelierd's home and pipe on Windows: %USERPROFILE%\.atelier, never AppData (the
// GUI's AppData writes are virtualized), and a named pipe per home instead of a unix socket.

const saved = process.env.ATELIER_HOME;
beforeEach(() => { initPlatform('win32'); });
afterEach(() => {
  resetPlatformForTests();
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.ATELIER_HOME; else process.env.ATELIER_HOME = saved;
});

test('the home is .atelier in the user profile, unless ATELIER_HOME says otherwise', () => {
  delete process.env.ATELIER_HOME;
  vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\mario');
  expect(atelierHome()).toBe('C:\\Users\\mario\\.atelier');
  process.env.ATELIER_HOME = 'D:\\atl';
  expect(atelierHome()).toBe('D:\\atl');
});

test('the socket is a named pipe named after the home, whatever its case or separators', () => {
  const p = daemonPaths('C:\\Users\\mario\\.atelier');
  expect(p.sock).toMatch(/^\\\\\.\\pipe\\atelier-[0-9a-f]{16}$/);
  expect(daemonPaths('c:/users/MARIO/.atelier/').sock).toBe(p.sock);
  expect(daemonPaths('C:\\Users\\other\\.atelier').sock).not.toBe(p.sock);
  expect(isPipePath(p.sock)).toBe(true);
  expect(isPipePath('/Users/mario/Library/Application Support/Atelier/atelierd.sock')).toBe(false);
});

test('the files sit in the home, with Windows separators', () => {
  const p = daemonPaths('C:\\Users\\mario\\.atelier');
  expect(p.info).toBe('C:\\Users\\mario\\.atelier\\atelierd.json');
  expect(p.log).toBe('C:\\Users\\mario\\.atelier\\logs\\atelierd.log');
  expect(p.settings).toBe('C:\\Users\\mario\\.atelier\\claude-settings.json');
  expect(p.bin).toBe('C:\\Users\\mario\\.atelier\\bin');
});

test('a long home needs no fallback: pipe names have no length problem', () => {
  const home = 'C:\\' + 'a'.repeat(200);
  expect(daemonPaths(home).sock).toMatch(/^\\\\\.\\pipe\\atelier-[0-9a-f]{16}$/);
});

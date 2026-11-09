import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: { fromWebContents: vi.fn() }, dialog: {}, app: {}, shell: {} }));
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { holds } from './open-paths';
import { underPrefix } from './terminal-hub';

// Main's "inside the project" checks with a trailing-slash prefix: the POSIX results are the
// old string checks, Windows compares any case and either separator.

afterEach(() => { resetPlatformForTests(); });

describe('macOS: the old string checks', () => {
  beforeEach(() => { initPlatform('darwin'); });

  test("holds = path === root || path.startsWith(root ending in '/')", () => {
    const old = (root: string, path: string) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/');
    for (const root of ['/p', '/p/', '/p//', '/', '//']) for (const path of ['/p', '/p/', '/p/a', '/p//a', '/pa', '/', '/P/a']) expect(holds(root, path), `${root} ${path}`).toBe(old(root, path));
  });

  test('underPrefix = p.startsWith(prefix)', () => {
    for (const prefix of ['/p/', '/p//', '/', '//']) for (const p of ['/p/a', '/p//a', '/p', '/pa', '/P/a', '/x']) expect(underPrefix(prefix, p), `${prefix} ${p}`).toBe(p.startsWith(prefix));
  });
});

describe('Windows', () => {
  test('any case, either separator', () => {
    initPlatform('win32');
    expect(holds('C:\\Proj', 'c:/proj/a.ts')).toBe(true);
    expect(holds('C:/Proj/', 'C:\\PROJ')).toBe(false);
    expect(holds('C:/Proj', 'C:/Proj2/a')).toBe(false);
    expect(underPrefix('C:\\Users\\x\\proj/', 'c:/users/X/Proj/src/a.ts')).toBe(true);
    expect(underPrefix('C:\\Users\\x\\proj/', 'C:/Users/x/proj2/a.ts')).toBe(false);
  });
});

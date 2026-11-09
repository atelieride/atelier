import { afterEach, expect, test, vi } from 'vitest';

// On Windows the strings go through windowsWords; none may still name a Mac place or tool.

afterEach(() => { vi.resetModules(); });

function leaves(v: unknown, path: string, out: [string, string][]): void {
  if (typeof v === 'string') out.push([path, v]);
  else if (typeof v === 'function') {
    try { leaves((v as (...a: unknown[]) => unknown)('X', 'Y', 'Z', 2), path, out); } catch { /* needs real arguments */ }
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out);
}

test('on Windows no string of the interface names a Mac place or tool', async () => {
  vi.resetModules();
  (await import('@shared/platform')).initPlatform('win32');
  const { t } = await import('./en');
  const all: [string, string][] = [];
  leaves(t, 't', all);
  expect(all.length).toBeGreaterThan(500);
  expect(all.filter(([, s]) => /\b(Mac|macOS|Finder|Dock|Keychain|Trash)\b/.test(s)).map(([p, s]) => `${p}: ${s}`)).toEqual([]);
});

test('the Databases view\'s strings (loaded with its chunk) follow too: the Keychain is Windows\' own there', async () => {
  vi.resetModules();
  (await import('@shared/platform')).initPlatform('win32');
  const { tdb } = await import('./db');
  const all: [string, string][] = [];
  leaves(tdb, 'tdb', all);
  expect(all.length).toBeGreaterThan(40);
  expect(all.filter(([, s]) => /\b(Mac|macOS|Finder|Dock|Keychain|Trash)\b/.test(s)).map(([p, s]) => `${p}: ${s}`)).toEqual([]);
});

test('a table tab\'s strings (loaded with its chunk) follow too', async () => {
  vi.resetModules();
  (await import('@shared/platform')).initPlatform('win32');
  const { tdt } = await import('./db-table');
  const all: [string, string][] = [];
  leaves(tdt, 'tdt', all);
  expect(all.length).toBeGreaterThan(30);
  expect(all.filter(([, s]) => /\b(Mac|macOS|Finder|Dock|Keychain|Trash)\b|[⌘⌥⌃]/.test(s)).map(([p, s]) => `${p}: ${s}`)).toEqual([]);
});

test('a launch flag refused for its characters names the ones refused on that platform', async () => {
  vi.resetModules();
  (await import('@shared/platform')).initPlatform('win32');
  const win = (await import('./en')).t.flags.errors.chars('--x');
  for (const c of ['"', '%', '!', '&', '|', '<', '>', '^']) expect(win).toContain(c);
  vi.resetModules();
  (await import('@shared/platform')).initPlatform('darwin');
  const mac = (await import('./en')).t.flags.errors.chars('--x');
  expect(mac).not.toMatch(/Windows|%/);
});

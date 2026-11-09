import { afterEach, expect, test, vi } from 'vitest';

// The overview's strings (loaded with the table tab's chunk) go through windowsWords on Windows
// too; none names a Mac place or tool, nor a Mac key glyph. Counts read in the singular when there is one.

afterEach(() => { vi.resetModules(); });

function leaves(v: unknown, path: string, out: [string, string][]): void {
  if (typeof v === 'string') out.push([path, v]);
  else if (typeof v === 'function') {
    try { leaves((v as (...a: unknown[]) => unknown)('X', 2, 3), path, out); } catch { /* needs real arguments */ }
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out);
}

test('on Windows the overview\'s strings name no Mac place, tool or key', async () => {
  vi.resetModules();
  (await import('@shared/platform')).initPlatform('win32');
  const { tov } = await import('./db-overview');
  const all: [string, string][] = [];
  leaves(tov, 'tov', all);
  expect(all.length).toBeGreaterThan(40);
  expect(all.filter(([, s]) => /\b(Mac|macOS|Finder|Dock|Keychain|Trash)\b|[⌘⌥⌃]/.test(s)).map(([p, s]) => `${p}: ${s}`)).toEqual([]);
});

test('one of a thing reads in the singular', async () => {
  const { tov } = await import('./db-overview');
  expect(tov.tables(1)).toBe('1 table');
  expect(tov.tables(1234)).toBe('1,234 tables');
  expect(tov.sessions(1)).toBe('1 session');
  expect(tov.tiles.sizeSub(1, 1)).toBe('1 table · 1 view');
  expect(tov.tiles.sizeSub(3, 0)).toBe('3 tables');
  expect(tov.schemaSub('8 KB', 1, 0)).toBe('8 KB · 1 table');
  expect(tov.tiles.spark(30)).toBe('Transactions per second, the last 30 samples');
});

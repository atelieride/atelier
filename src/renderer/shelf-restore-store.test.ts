import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { RestoredTabs, SavedTabs } from '@shared/tabs-state';
import type { TerminalInfo } from '@shared/protocol';

// The Shelf's outside files across launches: main grants them again with the tabs; the ones it
// didn't are missing; the shelf's outside files ride along with every tabs save.
const saves: SavedTabs[] = [];
let restored: RestoredTabs | null = null;
const saved = new Map<string, string>();
const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  g.window = { addEventListener: () => {}, atelier: { tabs: { restore: async () => restored, save: async (t: SavedTabs) => { saves.push(t); } } } };
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

const term = (id: string) => ({ id, createdAt: 1, projectRoot: '/p', cwd: '/p', title: id }) as unknown as TerminalInfo;

test('outside shelf files main granted again stay; the others show as missing until opened again; saves carry them', async () => {
  vi.useFakeTimers();
  saved.set('atelier.shelf', JSON.stringify({ '/p': [{ path: '/p/a.ts', rel: 'a.ts' }, { path: '/h/dump.sql', rel: '~/dump.sql' }, { path: '/h/gone.sql', rel: '~/gone.sql' }, { path: '/h/tab.json', rel: '~/tab.json' }] }));
  // tab.json came back as a tab (granted) though not in the saved shelf (a quit inside the save's debounce).
  restored = { files: [{ path: '/h/tab.json', rel: '~/tab.json', external: true }], order: ['f:/h/tab.json'], active: null, shelf: [{ path: '/h/dump.sql', rel: '~/dump.sql', external: true }] };
  const { useApp, TABS_SAVE_MS } = await import('./store');
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  useApp.getState().setTerminals([term('a')]);
  useApp.getState().setDaemon({ ...useApp.getState().daemon, connected: true, listed: true });
  await vi.runAllTimersAsync();
  expect(useApp.getState().tabsRestored).toBe(true);
  expect(useApp.getState().shelfUngranted).toEqual(['/h/gone.sql']);

  saves.length = 0;
  useApp.getState().removeFromShelf('/p/a.ts');
  await vi.advanceTimersByTimeAsync(TABS_SAVE_MS);
  expect(saves.at(-1)?.shelf).toEqual(['/h/dump.sql', '/h/gone.sql', '/h/tab.json']);

  // Opened again from Finder (a gesture granted it) and put back: no longer missing.
  useApp.getState().addToShelf('/h/gone.sql', '~/gone.sql');
  expect(useApp.getState().shelfUngranted).toEqual([]);
  vi.useRealTimers();
});

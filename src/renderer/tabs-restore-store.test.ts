import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { RestoredTabs, SavedTabs } from '@shared/tabs-state';
import type { TerminalInfo } from '@shared/protocol';

// The store restores a project's tabs once (after the project and the first terminal list), then saves them as they change.
const saves: SavedTabs[] = [];
let restored: RestoredTabs | null = null;
const g = globalThis as { window?: unknown };
let had: unknown;
beforeAll(() => {
  had = g.window;
  g.window = {
    addEventListener: () => {},
    atelier: { tabs: { restore: async () => restored, save: async (t: SavedTabs) => { saves.push(t); } } }
  };
});
afterAll(() => { g.window = had; });

const term = (id: string, createdAt: number) => ({ id, createdAt, projectRoot: '/p', cwd: '/p', title: id }) as unknown as TerminalInfo;

test('restored files open in the saved order, the saved tab comes to the front; later changes are saved', async () => {
  vi.useFakeTimers();
  const { useApp, TABS_SAVE_MS } = await import('./store');
  restored = {
    files: [{ path: '/p/x.ts', rel: 'x.ts', external: false }, { path: '/h/y.json', rel: '~/y.json', external: true }],
    order: ['f:/p/x.ts', 't:a', 'f:/h/y.json'],
    active: 'f:/h/y.json'
  };
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  // Before atelierd sent its list, main answers an empty one: no restore against it (the saved terminals would be lost).
  useApp.getState().setTerminals([]);
  useApp.getState().setDaemon({ ...useApp.getState().daemon, connected: true });
  await vi.runAllTimersAsync();
  expect(useApp.getState().tabsRestored).toBe(false);
  expect(useApp.getState().openFiles).toEqual([]);
  // The real list, then main says atelierd has listed.
  useApp.getState().setTerminals([term('a', 1), term('b', 2)]);
  useApp.getState().setDaemon({ ...useApp.getState().daemon, connected: true, listed: true });
  await vi.runAllTimersAsync();
  const st = useApp.getState();
  expect(st.openFiles.map((f) => [f.path, f.rel])).toEqual([['/p/x.ts', 'x.ts'], ['/h/y.json', '~/y.json']]);
  expect(st.tabOrder).toEqual(['f:/p/x.ts', 't:a', 'f:/h/y.json', 't:b']);
  expect(st.activeTab).toBe('/h/y.json');
  expect(st.tabsRestored).toBe(true);

  saves.length = 0;
  useApp.getState().activate('t:a');
  await vi.advanceTimersByTimeAsync(TABS_SAVE_MS);
  expect(saves.at(-1)).toEqual({ files: ['/p/x.ts', '/h/y.json'], order: ['f:/p/x.ts', 't:a', 'f:/h/y.json', 't:b'], active: 't:a' });

  // Restored once only: a later terminal list does not bring closed tabs back.
  useApp.getState().closeTab('/p/x.ts');
  useApp.getState().setTerminals([term('a', 1), term('b', 2)]);
  await vi.runAllTimersAsync();
  expect(useApp.getState().openFiles.map((f) => f.path)).toEqual(['/h/y.json']);
  vi.useRealTimers();
});

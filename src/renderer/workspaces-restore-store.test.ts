import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { RestoredTabs, SavedTabs } from '@shared/tabs-state';
import type { TerminalInfo } from '@shared/protocol';
import type { WorkspacesState } from './workspaces';

// A window opening on a project with workspaces: the workspaces come from localStorage
// before the first terminal list is placed; tabs.json holds every workspace's tabs; the strip is the active one's.

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

const term = (id: string, createdAt: number) => ({ id, createdAt, projectRoot: '/p', cwd: '/p', title: id, session: null }) as unknown as TerminalInfo;
const WS: WorkspacesState = {
  on: true, active: 'B',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:auth', 'f:/p/x.ts'], active: 'f:/p/x.ts', layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: ['f:/p/y.ts', 't:bill'], active: 'f:/p/y.ts', layout: null }
  ],
  members: { auth: 'A', bill: 'B' }
};

test('the active workspace\'s tabs come back in its order with its front; the others wait; saves keep every workspace', async () => {
  vi.useFakeTimers();
  saved.set('atelier.workspaces', JSON.stringify({ '/p': WS }));
  restored = { files: [{ path: '/p/x.ts', rel: 'x.ts' }, { path: '/p/y.ts', rel: 'y.ts' }], order: ['t:auth', 'f:/p/x.ts', 'f:/p/y.ts', 't:bill'], active: 'f:/p/y.ts' } as RestoredTabs;
  const { useApp, TABS_SAVE_MS, WS_SAVE_MS } = await import('./store');
  const st = () => useApp.getState();
  st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  expect(st().ws?.active).toBe('B');
  st().setTerminals([term('auth', 1), term('bill', 2)]);
  // Before the tabs are restored the strip already holds only the active workspace's terminal.
  expect(st().tabOrder).toEqual(['t:bill']);
  st().setDaemon({ ...st().daemon, connected: true, listed: true });
  await vi.runAllTimersAsync();
  expect(st().tabsRestored).toBe(true);
  expect(st().tabOrder).toEqual(['f:/p/y.ts', 't:bill']);
  expect(st().activeKey()).toBe('f:/p/y.ts');
  expect(st().openFiles.map((f) => f.path).sort()).toEqual(['/p/x.ts', '/p/y.ts']);

  st().switchWorkspace('A');
  expect(st().tabOrder).toEqual(['t:auth', 'f:/p/x.ts']);
  expect(st().activeKey()).toBe('f:/p/x.ts');

  saves.length = 0;
  await vi.advanceTimersByTimeAsync(Math.max(TABS_SAVE_MS, WS_SAVE_MS) + 10);
  // tabs.json: every workspace's tabs (files come back next time); localStorage: the active one is now A.
  expect(saves.at(-1)?.order).toEqual(['t:auth', 'f:/p/x.ts', 'f:/p/y.ts', 't:bill']);
  expect(saves.at(-1)?.files.sort()).toEqual(['/p/x.ts', '/p/y.ts']);
  const back = JSON.parse(saved.get('atelier.workspaces')!)['/p'] as WorkspacesState;
  expect(back.active).toBe('A');
  expect(back.list[1]).toMatchObject({ order: ['f:/p/y.ts', 't:bill'], active: 'f:/p/y.ts' });
  vi.useRealTimers();
});

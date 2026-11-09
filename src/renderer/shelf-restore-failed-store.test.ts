import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';

// The Shelf's outside files when main's restore fails: none of them is granted, so all are
// missing, never rows that look fine and don't open.
const saved = new Map<string, string>();
const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  g.window = { addEventListener: () => {}, atelier: { tabs: { restore: async () => { throw new Error('gone'); }, save: async () => {} } } };
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

test('a failed restore leaves every outside shelf file missing (the project ones are fine)', async () => {
  vi.useFakeTimers();
  saved.set('atelier.shelf', JSON.stringify({ '/p': [{ path: '/p/a.ts', rel: 'a.ts' }, { path: '/h/dump.sql', rel: '~/dump.sql' }] }));
  const { useApp } = await import('./store');
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  useApp.getState().setTerminals([{ id: 'a', createdAt: 1, projectRoot: '/p', cwd: '/p', title: 'a' } as unknown as TerminalInfo]);
  useApp.getState().setDaemon({ ...useApp.getState().daemon, connected: true, listed: true });
  await vi.runAllTimersAsync();
  expect(useApp.getState().tabsRestored).toBe(true);
  expect(useApp.getState().shelfUngranted).toEqual(['/h/dump.sql']);
  vi.useRealTimers();
});

import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { RestoredTabs, SavedTabs } from '@shared/tabs-state';
import type { TerminalInfo } from '@shared/protocol';
import { EMPTY_DB_SNAPSHOT, type DbConnView, type DbSnapshot } from '@shared/databases';
import type { ProjectInfo } from '@shared/api';
import { useApp, TABS_SAVE_MS } from '../store';
import { single } from '../split';
import { emptyViews } from '../spaces';
import { useDb } from './store';

// Table tabs across restarts: their keys come back with the project's tabs — in their pane
// too — and, once main's first snapshot is in, those whose connection is gone are dropped. Never before it: the
// snapshot arrives after the tabs do.

const C = 'c0123456789ab';
const GONE = 'c99999999999f';
const ORDERS = `db:${C}/public/orders`;
const OLD = `db:${GONE}/public/old`;
const OVERVIEW = `db:${C}`;

const saves: SavedTabs[] = [];
let restored: RestoredTabs | null = null;
let stored: Map<string, string>;
const g = globalThis as { window?: unknown; localStorage?: unknown };
let hadWindow: unknown;
let hadStorage: unknown;
beforeAll(() => {
  hadWindow = g.window;
  hadStorage = g.localStorage;
  g.window = { addEventListener: () => {}, atelier: { tabs: { restore: async () => restored, save: async (t: SavedTabs) => { saves.push(t); } } } };
});
afterAll(() => { g.window = hadWindow; g.localStorage = hadStorage; });
beforeEach(() => {
  stored = new Map();
  g.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) };
});

const term = (id: string, createdAt: number) => ({ id, createdAt, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', session: null }) as unknown as TerminalInfo;
const project = { root: '/p', realRoot: '/p', name: 'p' } as unknown as ProjectInfo;
const conn = (id: string) => ({ conn: { id, name: id, env: 'local', scope: { kind: 'all' } }, state: 'idle', problem: null, server: null, hasPassword: false, provider: null }) as unknown as DbConnView;
const snap = (...ids: string[]): DbSnapshot => ({ ...EMPTY_DB_SNAPSHOT, connections: ids.map(conn) });
const st = () => useApp.getState();
const tabs = () => st().split.panes.map((p) => p.tabs);
const layout = (panes: string[][], fronts: string[], focus: number) => stored.set('atelier.splitLayout', JSON.stringify({ '/p': { v: 2, panes: panes.map((t, i) => ({ tabs: t, front: fronts[i] })), fractions: panes.map(() => 1 / panes.length), focus } }));

test('an older save (tables among the terminals, one in front, in the panes): the tables come back in Databases, Sessions without them', async () => {
  restored = { files: [], order: ['t:a', ORDERS, OLD, OVERVIEW, 't:b'], active: ORDERS };
  layout([['t:a', ORDERS, OLD], [OVERVIEW, 't:b']], [ORDERS, OVERVIEW], 0);
  st().setProject(project);
  st().setDaemon({ ...st().daemon, connected: true, listed: true });
  st().setTerminals([term('a', 1), term('b', 2)]);
  await vi.waitFor(() => expect(st().tabsRestored).toBe(true));
  expect(st().dbTabs).toEqual([
    { key: ORDERS, connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'data' },
    { key: OLD, connId: GONE, schema: 'public', name: 'old', kind: 'table', view: 'data' },
    { key: OVERVIEW, connId: C, schema: '', name: '', kind: 'overview', view: 'data' }
  ]);
  // The window opens on Sessions: its panes keep their terminals, no table among them.
  expect(st().space).toBe('sessions');
  expect(tabs()).toEqual([['t:a'], ['t:b']]);
  // Restored tabs are kept tabs: no preview comes back.
  expect(st().dbPreview).toBeNull();

  // Main's first snapshot: OLD's connection isn't in it (removed, or another project's).
  useDb.getState().setSnap(snap(C));
  expect(st().dbTabs.map((r) => r.key)).toEqual([ORDERS, OVERVIEW]);
  expect(tabs()).toEqual([['t:a'], ['t:b']]);

  // A later snapshot without C (a connection removed meanwhile) closes nothing: its tabs say it isn't available.
  useDb.getState().setSnap(snap());
  expect(st().dbTabs.map((r) => r.key)).toEqual([ORDERS, OVERVIEW]);

  // Databases: the tables in their order, the one in front then (the older save's tab in front) still in front.
  st().setActivity('databases');
  expect(st().tabOrder).toEqual([ORDERS, OVERVIEW]);
  expect(st().activeKey()).toBe(ORDERS);

  // Saved: Sessions' tabs, then the tables; each space's tab in front.
  saves.length = 0;
  st().activate(OVERVIEW);
  await vi.waitFor(() => expect(saves.length).toBeGreaterThan(0), { timeout: TABS_SAVE_MS * 4 });
  expect(saves.at(-1)).toEqual({ files: [], order: ['t:a', 't:b', ORDERS, OVERVIEW], active: 't:a', dbActive: OVERVIEW });
  // Saved the same from Sessions or from Docker: never another space's keys as Sessions' tabs.
  saves.length = 0;
  st().activate('t:b');
  await vi.waitFor(() => expect(saves.length).toBeGreaterThan(0), { timeout: TABS_SAVE_MS * 4 });
  expect(saves.at(-1)).toEqual({ files: [], order: ['t:a', 't:b', ORDERS, OVERVIEW], active: 't:b', dbActive: OVERVIEW });
  saves.length = 0;
  st().openDocker({ kind: 'overview' });
  await vi.waitFor(() => expect(saves.length).toBeGreaterThan(0), { timeout: TABS_SAVE_MS * 4 });
  expect(st().space).toBe('docker');
  expect(saves.at(-1)).toEqual({ files: [], order: ['t:a', 't:b', ORDERS, OVERVIEW], active: 't:b', dbActive: OVERVIEW });
});

test('restored while another space is in front: each space gets its own tabs and its tab in front, nothing comes forward', async () => {
  useApp.setState({ tabsRestored: false, layoutRestored: false, tabOrder: ['t:a', 't:b'], openFiles: [], dbTabs: [], dbPreview: null, dockerTabs: [], dockerPreview: null, activeTab: 'term', selectedId: 'a', split: single(), space: 'sessions', spaceViews: emptyViews(), activity: 'sessions' });
  useDb.getState().setSnap(snap(C));
  restored = { files: [{ path: '/p/x.ts', rel: 'x.ts', external: false }], order: ['t:a', 'f:/p/x.ts', 't:b', ORDERS, OVERVIEW], active: 'f:/p/x.ts', dbActive: OVERVIEW };
  st().openDocker({ kind: 'overview' });
  const spaces = new Set<string>();
  const off = useApp.subscribe((s) => { spaces.add(s.space); });
  st().setTerminals([term('a', 1), term('b', 2)]);
  await vi.waitFor(() => expect(st().tabsRestored).toBe(true));
  off();
  expect([...spaces]).toEqual(['docker']);
  expect(st().tabOrder).toEqual(['dk:overview']);
  st().setActivity('sessions');
  expect(st().tabOrder).toEqual(['t:a', 'f:/p/x.ts', 't:b']);
  expect(st().activeKey()).toBe('f:/p/x.ts');
  st().setActivity('databases');
  expect(st().tabOrder).toEqual([ORDERS, OVERVIEW]);
  expect(st().activeKey()).toBe(OVERVIEW);
});

test('restored while Databases is in front: its tables arrive in the strip, the one saved in front in front', async () => {
  useApp.setState({ tabsRestored: false, layoutRestored: false, tabOrder: ['t:a', 't:b'], openFiles: [], dbTabs: [], dbPreview: null, activeTab: 'term', selectedId: 'a', split: single(), space: 'sessions', spaceViews: emptyViews(), activity: 'sessions' });
  useDb.getState().setSnap(snap(C));
  restored = { files: [], order: ['t:a', 't:b', ORDERS, OVERVIEW], active: 't:b', dbActive: OVERVIEW };
  st().setActivity('databases');
  expect(st().tabOrder).toEqual([]);
  st().setTerminals([term('a', 1), term('b', 2)]);
  await vi.waitFor(() => expect(st().tabsRestored).toBe(true));
  expect(st().space).toBe('databases');
  expect(st().tabOrder).toEqual([ORDERS, OVERVIEW]);
  expect(st().activeKey()).toBe(OVERVIEW);
  st().setActivity('sessions');
  expect(st().activeKey()).toBe('t:b');
});

test('a snapshot already in when the tabs come back: the gone ones never reach Databases; its tab in front as saved', async () => {
  useApp.setState({ tabsRestored: false, layoutRestored: false, tabOrder: ['t:a', 't:b'], dbTabs: [], dbPreview: null, activeTab: 'term', selectedId: 'a', split: single(), space: 'sessions', spaceViews: emptyViews(), activity: 'sessions' });
  useDb.getState().setSnap(snap(C));
  restored = { files: [], order: ['t:a', 't:b', OLD, ORDERS, OVERVIEW], active: 't:b', dbActive: OVERVIEW };
  st().setTerminals([term('a', 1), term('b', 2)]);
  await vi.waitFor(() => expect(st().tabsRestored).toBe(true));
  expect(st().dbTabs.map((r) => r.key)).toEqual([ORDERS, OVERVIEW]);
  expect(st().tabOrder).toEqual(['t:a', 't:b']);
  st().setActivity('databases');
  expect(st().tabOrder).toEqual([ORDERS, OVERVIEW]);
  expect(st().activeKey()).toBe(OVERVIEW);
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbSnapshot } from '@shared/databases';
import { useApp } from '../store';
import { installDatabases, leaveDatabases } from './install';
import { useDb } from './store';

/** A fake window.atelier: the snapshot reply waits for `answer`, `push` plays main's event. */
function fakeBridge() {
  let listener: ((s: DbSnapshot) => void) | null = null;
  let answer!: (s: DbSnapshot) => void;
  const reply = new Promise<DbSnapshot>((r) => { answer = r; });
  const off = vi.fn(() => { listener = null; });
  const calls: string[] = [];
  // Every other method of the API records its call: installing must not select, connect or send anything.
  const databases = new Proxy({ snapshot: vi.fn(() => reply) } as Record<string, unknown>, {
    get: (o, k: string) => o[k] ?? ((..._a: unknown[]) => { calls.push(k); return Promise.resolve(); })
  });
  vi.stubGlobal('window', { atelier: { databases, on: { databases: (cb: (s: DbSnapshot) => void) => { listener = cb; return off; } } } });
  return { answer, push: (s: DbSnapshot) => listener?.(s), off, calls, listening: () => listener !== null };
}

const snap = (o: Partial<DbSnapshot>): DbSnapshot => ({ ...EMPTY_DB_SNAPSHOT, ...o });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => useDb.setState({ snap: EMPTY_DB_SNAPSHOT }));
afterEach(() => { vi.unstubAllGlobals(); });

test('the window asks main for its snapshot at start and keeps every one main sends after', async () => {
  const b = fakeBridge();
  installDatabases();
  const first = snap({ selected: 'c00000000000f' });
  b.answer(first);
  await settle();
  expect(useDb.getState().snap).toBe(first);
  const next = snap({ selected: 'c0123456789ab' });
  b.push(next);
  expect(useDb.getState().snap).toBe(next);
});

test('a snapshot main sent before the first reply came back is newer: the late reply is dropped', async () => {
  const b = fakeBridge();
  installDatabases();
  const pushed = snap({ selected: 'c0123456789ab' });
  b.push(pushed);
  b.answer(snap({}));
  await settle();
  expect(useDb.getState().snap).toBe(pushed);
});

test('uninstalled: no more snapshots, not even the first reply arriving late', async () => {
  const b = fakeBridge();
  const dispose = installDatabases();
  dispose();
  expect(b.off).toHaveBeenCalledOnce();
  expect(b.listening()).toBe(false);
  b.answer(snap({ selected: 'c00000000000f' }));
  await settle();
  expect(useDb.getState().snap).toBe(EMPTY_DB_SNAPSHOT);
});

test('installing connects nothing: a remembered pick shows selected, not connected', async () => {
  const b = fakeBridge();
  installDatabases();
  b.answer(snap({ selected: 'c0123456789ab' }));
  await settle();
  expect(b.calls).toEqual([]);
});

test('Never: the view goes at once, the sidebar shows Sessions instead', () => {
  useApp.getState().setActivity('databases');
  leaveDatabases();
  expect(useApp.getState().activity).toBe('sessions');
});

const ORDERS = { key: 'db:c0123456789ab/public/orders' as const, connId: 'c0123456789ab', schema: 'public', name: 'orders', kind: 'table' as const, view: 'data' as const };
const OVERVIEW = { key: 'db:c0123456789ab' as const, connId: 'c0123456789ab', schema: '', name: '', kind: 'overview' as const, view: 'data' as const };

test('Never: every table tab closes too, with its state (the one place the view is taken away); other tabs stay', () => {
  useApp.setState({ popout: null, ws: null, dbTabs: [ORDERS, OVERVIEW], dbPreview: ORDERS.key, tabOrder: ['f:/p/a.ts', ORDERS.key, OVERVIEW.key], activeTab: ORDERS.key, openFiles: [{ path: '/p/a.ts', rel: 'a.ts', line: null, nonce: 1, mode: 'margin' }] });
  useDb.getState().patchTab(ORDERS.key, { wrap: true });
  leaveDatabases();
  expect(useApp.getState().dbTabs).toEqual([]);
  expect(useApp.getState().dbPreview).toBeNull();
  expect(useApp.getState().tabOrder).toEqual(['f:/p/a.ts']);
  expect(useApp.getState().activeTab).toBe('/p/a.ts');
  expect(useDb.getState().tabs).toEqual({});
});

test('Never in a pop-out holding a table tab (no activity bar there): its tab goes, so the window gives it back', () => {
  fakeBridge();
  const settings = useApp.getState().settings;
  useApp.setState({ popout: { key: ORDERS.key }, ws: null, dbTabs: [ORDERS], dbPreview: null, tabOrder: [ORDERS.key], activeTab: ORDERS.key, settings: { ...settings, showDatabases: 'auto' } });
  const dispose = installDatabases();
  try {
    useApp.getState().setSettings({ ...settings, showDatabases: 'always' });
    expect(useApp.getState().dbTabs).toEqual([ORDERS]);
    useApp.getState().setSettings({ ...settings, showDatabases: 'never' });
    expect(useApp.getState().dbTabs).toEqual([]);
    expect(useApp.getState().tabOrder).toEqual([]);
  } finally {
    dispose();
    useApp.setState({ popout: null, settings });
  }
});

test('Never while another view shows: that view stays', () => {
  useApp.getState().setActivity('scm');
  leaveDatabases();
  expect(useApp.getState().activity).toBe('scm');
});

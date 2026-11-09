import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbSnapshot } from '@shared/databases';
import { DEFAULT_TAB, selectTab, useDb, useDbTab } from './store';
import { renderLive as live } from './test-render';

const KEY = 'db:c0123456789ab/public/orders';

beforeEach(() => useDb.setState({ snap: EMPTY_DB_SNAPSHOT, tabs: {}, sheet: null, folds: {}, filter: '' }));
afterEach(() => { useDb.setState(useDb.getInitialState(), true); });

test('the defaults are frozen all the way down: a slip that writes into them throws instead of changing every tab', () => {
  const nested = Object.entries(DEFAULT_TAB).filter(([, v]) => v !== null && typeof v === 'object');
  expect(nested.map(([k]) => k).sort()).toEqual(['derived', 'filters', 'rows', 'selection', 'sort', 'widths']);
  expect(Object.isFrozen(DEFAULT_TAB)).toBe(true);
  for (const [k, v] of nested) expect(Object.isFrozen(v), k).toBe(true);
  const tab = useDb.getState().tab(KEY);
  // @ts-expect-error: a tab's collections are read-only (a new array goes through patchTab)
  expect(() => tab.rows.push([])).toThrow(TypeError);
  // @ts-expect-error: and so are its fields
  expect(() => { tab.loading = true; }).toThrow(TypeError);
  expect(DEFAULT_TAB.rows).toEqual([]);
  expect(DEFAULT_TAB.loading).toBe(false);
});

test('selectTab: the defaults for a tab with no state, its own state once patched, unchanged by another tab\'s patch', () => {
  const select = selectTab(KEY);
  expect(select(useDb.getState())).toBe(DEFAULT_TAB);
  useDb.getState().patchTab('db:c0123456789ab/public/customers', { wrap: true });
  // Another tab changed: the same object, so a component showing this tab doesn't re-render.
  expect(select(useDb.getState())).toBe(DEFAULT_TAB);
  useDb.getState().patchTab(KEY, { estimate: 2300 });
  const patched = select(useDb.getState());
  expect(patched).toEqual({ ...DEFAULT_TAB, estimate: 2300 });
  useDb.getState().patchTab('db:c0123456789ab/public/customers', { wrap: false });
  expect(select(useDb.getState())).toBe(patched);
});

test('useDbTab: a component reads its tab, and the new state once patched', () => {
  const Estimate = () => createElement('i', null, String(useDbTab(KEY).estimate));
  expect(live(Estimate)).toBe('<i>null</i>');
  useDb.getState().patchTab(KEY, { estimate: 2300 });
  expect(live(Estimate)).toBe('<i>2300</i>');
});

test('a tab starts from the defaults: nothing filtered, sorted or loaded, the inspector closed', () => {
  expect(DEFAULT_TAB).toEqual({
    filters: [], sort: [], columns: null, derived: [], rows: [], more: 'idle', moreProblem: null, data: null, loading: false, problem: null,
    estimate: null, exact: null, selection: [], focus: null, inspector: false, json: null, wrap: false, widths: {}, reqId: 0, at: null
  });
  // First widths come with the grid (lazy): none in the defaults, the first paint carries nothing of them.
  expect('autoWidths' in DEFAULT_TAB).toBe(false);
});

test('an unknown tab reads as the defaults, the same object every time (a selector never loops)', () => {
  expect(useDb.getState().tab(KEY)).toBe(DEFAULT_TAB);
  expect(useDb.getState().tab(KEY)).toBe(useDb.getState().tab(KEY));
  expect(useDb.getState().tabs).toEqual({});
});

test('patchTab creates the tab from the defaults, then merges into it', () => {
  useDb.getState().patchTab(KEY, { loading: true, reqId: 1 });
  expect(useDb.getState().tab(KEY)).toEqual({ ...DEFAULT_TAB, loading: true, reqId: 1 });
  useDb.getState().patchTab(KEY, { loading: false, estimate: 2300 });
  expect(useDb.getState().tab(KEY)).toEqual({ ...DEFAULT_TAB, loading: false, reqId: 1, estimate: 2300 });
});

test('patchTab leaves the defaults and the other tabs alone', () => {
  const other = 'db:c0123456789ab/public/customers';
  useDb.getState().patchTab(other, { wrap: true });
  const before = useDb.getState().tab(other);
  useDb.getState().patchTab(KEY, { filters: [{ column: 'status', op: 'eq', values: ['paid'] }], widths: { id: 80 } });
  expect(useDb.getState().tab(other)).toBe(before);
  expect(DEFAULT_TAB.filters).toEqual([]);
  expect(DEFAULT_TAB.widths).toEqual({});
});

test('dropTab removes the tab\'s state (it reads as the defaults again); an unknown key changes nothing', () => {
  useDb.getState().patchTab(KEY, { inspector: true });
  useDb.getState().patchTab('db:c0123456789ab', { loading: true });
  useDb.getState().dropTab(KEY);
  expect(Object.keys(useDb.getState().tabs)).toEqual(['db:c0123456789ab']);
  expect(useDb.getState().tab(KEY)).toBe(DEFAULT_TAB);
  const tabs = useDb.getState().tabs;
  useDb.getState().dropTab('db:nothing');
  expect(useDb.getState().tabs).toBe(tabs);
});

test('setSnap and setSheet replace what they hold', () => {
  const s: DbSnapshot = { ...EMPTY_DB_SNAPSHOT, selected: 'c00000000000f' };
  useDb.getState().setSnap(s);
  expect(useDb.getState().snap).toBe(s);
  useDb.getState().setSheet({ kind: 'add', step: 1 });
  expect(useDb.getState().sheet).toEqual({ kind: 'add', step: 1 });
  useDb.getState().setSheet(null);
  expect(useDb.getState().sheet).toBeNull();
});

test('loaded: false until main\'s first snapshot, true from then on — an empty one is an answer too', async () => {
  vi.resetModules();
  const { useDb: fresh } = await import('./store');
  expect(fresh.getState().loaded).toBe(false);
  fresh.getState().setSnap(EMPTY_DB_SNAPSHOT);
  expect(fresh.getState().loaded).toBe(true);
  fresh.getState().setSnap({ ...EMPTY_DB_SNAPSHOT, selected: 'c00000000000f' });
  expect(fresh.getState().loaded).toBe(true);
});

test('before main answers, the snapshot is the empty one (nothing shown, nothing selected)', async () => {
  vi.resetModules();
  const { useDb: fresh } = await import('./store');
  expect(fresh.getState().snap).toEqual(EMPTY_DB_SNAPSHOT);
  expect(fresh.getState().sheet).toBeNull();
  expect(fresh.getState().filter).toBe('');
  expect(fresh.getState().folds).toEqual({});
});

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DbFilter } from '@shared/databases-filters';
import { useApp } from '../store';
import {
  addDerived, addFilterKeepingRow, applyHandoff, clearDerived, inspectedPick, openFilterAt, removeDerived, setColumns, setFilters, sortBy, toggleColumns, useFilterUi
} from './filter-actions';
import { addFilter } from './filters';
import { useDb } from './store';
import { useTableUi } from './table-view';

// The filter bar's actions: a change reloads from the top (TableView
// watches the request) and keeps the preview; one popover at a time in a tab; nothing opens before the columns are known.

const KEY = 'db:c0123456789ab/public/orders';
const f = (column: string, op: DbFilter['op'], values: string[] = []): DbFilter => ({ column, op, values });
let toast: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toast = vi.fn();
  useApp.setState({ showToast: toast as never });
});
afterEach(() => {
  useDb.setState(useDb.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
  useFilterUi.setState(useFilterUi.getInitialState(), true);
  useTableUi.setState(useTableUi.getInitialState(), true);
});

describe('opened on a key: the handoff\'s filters become the tab\'s', () => {
  const KEYF = [f('id', 'eq', ['2041'])];

  test('a tab without filters: the key\'s, its first row picked, the inspector when asked; no toast; the preview stays one', () => {
    useApp.setState({ dbPreview: KEY as never });
    useDb.getState().patchTab(KEY, { handoff: { filters: KEYF, inspector: true } });
    applyHandoff(KEY);
    expect(useDb.getState().tab(KEY)).toMatchObject({ filters: KEYF, pick: true, inspector: true, handoff: undefined });
    expect(toast).not.toHaveBeenCalled();
    expect(useApp.getState().dbPreview).toBe(KEY);
    // Nothing handed over: nothing changes.
    const now = useDb.getState().tab(KEY);
    applyHandoff(KEY);
    expect(useDb.getState().tab(KEY)).toBe(now);
  });

  test('a tab with its own filters: replaced, a toast "Filters replaced" with Undo, which brings back its filters, sort and columns', () => {
    const own = { filters: [f('status', 'in', ['paid'])], sort: [{ column: 'total', dir: 'desc' as const }], columns: ['id', 'total'] };
    useApp.setState({ dbTabs: [{ key: KEY } as never] });
    useDb.getState().patchTab(KEY, { ...own, handoff: { filters: KEYF } });
    applyHandoff(KEY);
    expect(useDb.getState().tab(KEY).filters).toEqual(KEYF);
    expect(toast).toHaveBeenCalledWith('Filters replaced', { label: 'Undo', run: expect.any(Function) }, 'info');
    (toast.mock.calls[0]![1] as { run: () => void }).run();
    expect(useDb.getState().tab(KEY)).toMatchObject(own);
  });

  const undo = () => (toast.mock.calls.find((c) => c[0] === 'Filters replaced')![1] as { run: () => void }).run();

  test('Undo once the tab moved on (its filters, sort or columns changed) or closed does nothing — "Nothing to undo"', () => {
    useApp.setState({ dbTabs: [{ key: KEY } as never] });
    useDb.getState().patchTab(KEY, { filters: [f('status', 'in', ['paid'])], handoff: { filters: KEYF } });
    applyHandoff(KEY);
    // Sorted since: the handed-over state is gone.
    useDb.getState().patchTab(KEY, { sort: [{ column: 'total', dir: 'asc' }] });
    undo();
    expect(useDb.getState().tab(KEY).filters).toEqual(KEYF);
    expect(toast).toHaveBeenLastCalledWith('Nothing to undo', undefined, 'info');
    // Closed: nothing either.
    toast.mockClear();
    useDb.getState().patchTab(KEY, { sort: [], filters: [f('status', 'in', ['paid'])], handoff: { filters: KEYF } });
    applyHandoff(KEY);
    useApp.setState({ dbTabs: [] });
    undo();
    expect(useDb.getState().tab(KEY).filters).not.toEqual([f('status', 'in', ['paid'])]);
    expect(toast).toHaveBeenLastCalledWith('Nothing to undo', undefined, 'info');
  });

  test('walking Open › through a chain replaces a handoff\'s filters quietly; filters of their own are what the toast is for', () => {
    useDb.getState().patchTab(KEY, { handoff: { filters: KEYF } });
    applyHandoff(KEY);
    useDb.getState().patchTab(KEY, { handoff: { filters: [f('id', 'eq', ['7'])] } });
    applyHandoff(KEY);
    expect(toast).not.toHaveBeenCalled();
    // The user changes them: their own now.
    setFilters(KEY, [f('id', 'eq', ['7']), f('status', 'in', ['paid'])]);
    useDb.getState().patchTab(KEY, { handoff: { filters: KEYF } });
    applyHandoff(KEY);
    expect(toast).toHaveBeenCalledWith('Filters replaced', expect.anything(), 'info');
  });
});

describe('setFilters, setColumns', () => {
  test('setFilters: the tab\'s filters, the preview kept; the same list again changes nothing', () => {
    useApp.setState({ dbPreview: KEY as never });
    const next = addFilter(useDb.getState().tab(KEY).filters, f('email', 'eq', ['a']));
    setFilters(KEY, next);
    expect(useDb.getState().tab(KEY).filters).toEqual([f('email', 'eq', ['a'])]);
    expect(useApp.getState().dbPreview).toBeNull();
    useApp.setState({ dbPreview: KEY as never });
    const before = useDb.getState().tab(KEY);
    setFilters(KEY, before.filters);
    expect(useDb.getState().tab(KEY)).toBe(before);
    expect(useApp.getState().dbPreview).toBe(KEY);
  });

  test('setColumns: the chosen columns, the preview kept; the same choice again changes nothing; never none', () => {
    useApp.setState({ dbPreview: KEY as never });
    setColumns(KEY, ['id', 'email']);
    expect(useDb.getState().tab(KEY).columns).toEqual(['id', 'email']);
    expect(useApp.getState().dbPreview).toBeNull();
    useApp.setState({ dbPreview: KEY as never });
    const before = useDb.getState().tab(KEY);
    setColumns(KEY, ['id', 'email']);
    setColumns(KEY, []);
    expect(useDb.getState().tab(KEY)).toBe(before);
    expect(useApp.getState().dbPreview).toBe(KEY);
    setColumns(KEY, null);
    expect(useDb.getState().tab(KEY).columns).toBeNull();
  });
});

describe('openFilterAt: a chip, "+ Filter", a "+N more" entry', () => {
  test('the columns not known yet: a quiet toast, nothing opened, nothing marked open', () => {
    openFilterAt(KEY, { anchor: 'chip-0', edit: 0 }, { ready: false, toggle: true });
    expect(useFilterUi.getState().pop).toBeNull();
    expect(toast).toHaveBeenCalledWith('Columns load with the table — try again once it has loaded', undefined, 'info');
  });

  test('opens it — the statement\'s popover goes (one at a time) —; the same chip again closes it', () => {
    useTableUi.setState({ sql: KEY });
    openFilterAt(KEY, { anchor: 'chip-0', edit: 0 }, { ready: true, toggle: true });
    expect(useFilterUi.getState().pop).toEqual({ key: KEY, anchor: 'chip-0', edit: 0, target: null });
    expect(useTableUi.getState().sql).toBeNull();
    openFilterAt(KEY, { anchor: 'chip-0', edit: 0 }, { ready: true, toggle: true });
    expect(useFilterUi.getState().pop).toBeNull();
  });

  test('a "+N more" entry for the filter being edited opens it — never a toggle closing it', () => {
    openFilterAt(KEY, { anchor: 'more', edit: 4 }, { ready: true, toggle: false });
    openFilterAt(KEY, { anchor: 'more', edit: 4 }, { ready: true, toggle: false });
    expect(useFilterUi.getState().pop).toEqual({ key: KEY, anchor: 'more', edit: 4, target: null });
  });

  test('a column to start from (the header\'s Filter…)', () => {
    openFilterAt(KEY, { anchor: 'add', edit: null, target: 'status' }, { ready: true, toggle: false });
    expect(useFilterUi.getState().pop).toEqual({ key: KEY, anchor: 'add', edit: null, target: 'status' });
  });
});

describe('toggleColumns: the Columns chip', () => {
  test('opens its checklist and closes the others in the tab (the statement\'s, the filter\'s); again: closes it', () => {
    useTableUi.setState({ sql: KEY });
    useFilterUi.setState({ pop: { key: KEY, anchor: 'add', edit: null, target: null } });
    toggleColumns(KEY);
    expect(useFilterUi.getState()).toMatchObject({ cols: KEY, pop: null });
    expect(useTableUi.getState().sql).toBeNull();
    toggleColumns(KEY);
    expect(useFilterUi.getState().cols).toBeNull();
  });
});

// The JSON tools change the request too — a JSON column added (the key profile's and the JSON view's + Column)
// or removed (its header's Remove Column), a sort by key — each keeping the preview; the tab reads again.
describe('JSON columns and sorts by key', () => {
  const D = { column: 'payload', path: ['data', 'object', 'status'] };

  test('addDerived: appended (a copy), the preview kept; the same one again or past main\'s 20: nothing, false', () => {
    useApp.setState({ dbPreview: KEY as never });
    expect(addDerived(KEY, D)).toBe(true);
    const st = useDb.getState().tab(KEY);
    expect(st.derived).toEqual([D]);
    expect(st.derived[0]).not.toBe(D);
    expect(st.derived[0]!.path).not.toBe(D.path);
    expect(st.pick).toBeUndefined();
    expect(useApp.getState().dbPreview).toBeNull();
    expect(addDerived(KEY, { column: 'payload', path: ['data', 'object', 'status'] })).toBe(false);
    expect(useDb.getState().tab(KEY).derived).toHaveLength(1);
    useDb.getState().patchTab(KEY, { derived: Array.from({ length: 20 }, (_, i) => ({ column: 'payload', path: [`k${i}`] })) });
    expect(addDerived(KEY, { column: 'payload', path: ['more'] })).toBe(false);
    expect(useDb.getState().tab(KEY).derived).toHaveLength(20);
  });

  test('addDerived from the JSON view: its row picked again by its key when the rows come — only when it reloads', () => {
    addDerived(KEY, D, { pick: { key: { id: '7' } } });
    expect(useDb.getState().tab(KEY).pick).toEqual({ key: { id: '7' } });
    useDb.getState().patchTab(KEY, { pick: undefined });
    // The same column again: nothing reloads, nothing picked later by surprise.
    expect(addDerived(KEY, D, { pick: { key: { id: '7' } } })).toBe(false);
    expect(useDb.getState().tab(KEY).pick).toBeUndefined();
  });

  test('the key profile\'s + Column picks the inspected row again, as the JSON view does; without the inspector, none', () => {
    const page = { columns: [{ name: 'id' }, { name: 'payload' }], rowKey: ['id'] } as never;
    const rows = [[{ v: '1' }, { v: '{}' }], [{ v: '7' }, { v: '{}' }]] as never;
    const st = { inspector: true, data: page, rows, focus: { row: 1, col: 0 }, selection: [1] };
    expect(inspectedPick(st)).toEqual({ key: { id: '7' } });
    expect(inspectedPick({ ...st, inspector: false })).toBeUndefined();
    expect(inspectedPick({ ...st, focus: null, selection: [] })).toBeUndefined();
    // A row without a key to name it: the first row, as the JSON view's.
    expect(inspectedPick({ ...st, data: { ...(page as object), rowKey: [] } as never })).toBe(true);
  });

  test('addFilterKeepingRow (the JSON view\'s Filter): the filter added, its row picked again by its key; already there: nothing, no pick', () => {
    const fl: DbFilter = { column: 'payload', path: ['status'], op: 'pathEq', values: ['paid'] };
    useApp.setState({ dbPreview: KEY as never });
    expect(addFilterKeepingRow(KEY, fl, { id: '7' })).toBe(true);
    expect(useDb.getState().tab(KEY)).toMatchObject({ filters: [fl], pick: { key: { id: '7' } } });
    expect(useApp.getState().dbPreview).toBeNull();
    useDb.getState().patchTab(KEY, { pick: undefined });
    expect(addFilterKeepingRow(KEY, fl, { id: '7' })).toBe(false);
    expect(useDb.getState().tab(KEY).pick).toBeUndefined();
    // No key to find the row by: the first row.
    expect(addFilterKeepingRow(KEY, { ...fl, values: ['open'] }, null)).toBe(true);
    expect(useDb.getState().tab(KEY).pick).toBe(true);
    // Main's 30 reached: nothing.
    useDb.getState().patchTab(KEY, { filters: Array.from({ length: 30 }, (_, i) => f('c', 'eq', [String(i)])), pick: undefined });
    expect(addFilterKeepingRow(KEY, fl, { id: '7' })).toBe(false);
    expect(useDb.getState().tab(KEY).pick).toBeUndefined();
  });

  test('removeDerived: that one goes (by column and path), the preview kept; one not there: nothing', () => {
    useDb.getState().patchTab(KEY, { derived: [D, { column: 'payload', path: ['id'] }] });
    useApp.setState({ dbPreview: KEY as never });
    removeDerived(KEY, { column: 'payload', path: ['data', 'object', 'status'] });
    expect(useDb.getState().tab(KEY).derived).toEqual([{ column: 'payload', path: ['id'] }]);
    expect(useApp.getState().dbPreview).toBeNull();
    const now = useDb.getState().tab(KEY);
    removeDerived(KEY, D);
    expect(useDb.getState().tab(KEY)).toBe(now);
  });

  test('clearDerived: every JSON column goes (the error card\'s Remove JSON Columns, item 4), the preview kept', () => {
    useDb.getState().patchTab(KEY, { derived: [D, { column: 'payload', path: ['id'] }] });
    useApp.setState({ dbPreview: KEY as never });
    clearDerived(KEY);
    expect(useDb.getState().tab(KEY).derived).toEqual([]);
    expect(useApp.getState().dbPreview).toBeNull();
    const now = useDb.getState().tab(KEY);
    clearDerived(KEY);
    expect(useDb.getState().tab(KEY)).toBe(now);
  });

  test('sortBy: that column (a JSON key by its path) alone, either way, the preview kept', () => {
    useApp.setState({ dbPreview: KEY as never });
    sortBy(KEY, 'payload', 'desc', ['data', 'created']);
    expect(useDb.getState().tab(KEY).sort).toEqual([{ column: 'payload', path: ['data', 'created'], dir: 'desc' }]);
    expect(useApp.getState().dbPreview).toBeNull();
    sortBy(KEY, 'total', 'asc');
    expect(useDb.getState().tab(KEY).sort).toEqual([{ column: 'total', dir: 'asc' }]);
  });
});

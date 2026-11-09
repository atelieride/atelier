import { afterEach, describe, expect, test } from 'vitest';
import type { DbCell, DbPage } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { closeRecord, moveRecord, openRecord, openRow, recordKey, recordRow, stepRow, takeKeys, wantsMore } from './record';
import { DEFAULT_TAB, useDb } from './store';

// The record view (Tab on a row): its keys, the row it shows, where ↑/↓ go, when it asks for more rows,
// and the tab state it keeps (read-only: every change through patchTab). The markup: record-markup.test.ts.

const KEY = 'db:c0123456789ab/public/orders';
const rows = (n: number): DbCell[][] => Array.from({ length: n }, (_, i) => [{ v: String(i + 1) }]);
const col = (name: string): DbColumn => ({ name, type: 'int8', typeSchema: 'pg_catalog', typeName: 'int8', typeCat: 'N', isArray: false, nullable: false, isPk: name === 'id', isKey: name === 'id' });
const page = (n: number, o: Partial<DbPage> = {}): DbPage => ({
  columns: [col('id'), col('total')], hidden: [], derived: [], rows: rows(n), ms: 1, sql: 'SELECT 1', pk: ['id'], rowKey: ['id'], kind: 'table', ...o
});

afterEach(() => { useDb.setState(useDb.getInitialState(), true); });

describe('recordKey: the record view\'s own keys, nothing else', () => {
  const k = (key: string, o: Partial<{ shift: boolean; mod: boolean; alt: boolean; ctrl: boolean }> = {}) =>
    ({ key, shift: o.shift ?? false, mod: o.mod ?? false, alt: o.alt ?? false, ctrl: o.ctrl ?? false });

  test('↑/↓ the previous and next row; Tab or Esc back to the grid', () => {
    expect(recordKey(k('ArrowUp'), false)).toBe('prev');
    expect(recordKey(k('ArrowDown'), false)).toBe('next');
    expect(recordKey(k('Tab'), false)).toBe('back');
    expect(recordKey(k('Escape'), false)).toBe('back');
  });

  test('Shift+Tab moves the focus as the browser does (nothing trapped); chords and other keys are someone else\'s', () => {
    expect(recordKey(k('Tab', { shift: true }), false)).toBeNull();
    for (const m of [{ mod: true }, { alt: true }, { ctrl: true }]) {
      for (const key of ['Tab', 'Escape', 'ArrowUp', 'ArrowDown']) expect(recordKey(k(key, m), false), `${key} ${JSON.stringify(m)}`).toBeNull();
    }
    // ⇧↑/⇧↓ extend a text selection; PageUp/PageDown, Home/End, Space scroll the record (only ↑/↓ move rows).
    for (const key of ['ArrowUp', 'ArrowDown']) expect(recordKey(k(key, { shift: true }), false)).toBeNull();
    for (const key of ['PageUp', 'PageDown', 'Home', 'End', ' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'c']) expect(recordKey(k(key), false), key).toBeNull();
  });

  test('never a key typed into a field', () => {
    for (const key of ['Tab', 'Escape', 'ArrowUp', 'ArrowDown']) expect(recordKey(k(key), true), key).toBeNull();
  });
});

describe('the row it shows, ↑/↓, the next fetch', () => {
  test('recordRow: its index within the rows loaded (none kept: the first); null without rows', () => {
    expect(recordRow({ record: 3, rows: rows(10) })).toBe(3);
    expect(recordRow({ rows: rows(10) })).toBe(0);
    // A new first page came with fewer rows (a filter, a Refresh): its last one.
    expect(recordRow({ record: 40, rows: rows(3) })).toBe(2);
    expect(recordRow({ record: 2, rows: [] })).toBeNull();
  });

  test('openRow (the toolbar\'s Record): the focused row, else the last selected, else the first wholly on screen', () => {
    expect(openRow({ focus: { row: 4, col: 0 }, selection: [2, 9], rows: rows(20) }, 12)).toBe(4);
    expect(openRow({ focus: null, selection: [2, 9], rows: rows(20) }, 12)).toBe(9);
    expect(openRow({ focus: null, selection: [], rows: rows(20) }, 12)).toBe(12);
    // Within the rows loaded.
    expect(openRow({ focus: null, selection: [], rows: rows(5) }, 12)).toBe(4);
    expect(openRow({ focus: { row: 30, col: 0 }, selection: [], rows: rows(5) }, 0)).toBe(4);
    expect(openRow({ focus: null, selection: [], rows: [] }, 3)).toBe(0);
  });

  test('stepRow: the previous or next row; at either end it stays (null)', () => {
    expect(stepRow({ record: 3, rows: rows(10) }, 1)).toBe(4);
    expect(stepRow({ record: 3, rows: rows(10) }, -1)).toBe(2);
    expect(stepRow({ record: 0, rows: rows(10) }, -1)).toBeNull();
    expect(stepRow({ record: 9, rows: rows(10) }, 1)).toBeNull();
    expect(stepRow({ rows: [] }, 1)).toBeNull();
  });

  test('wantsMore: on the last row loaded, only while the next fetch is idle (never after an error, nor at the end or the cap)', () => {
    expect(wantsMore(99, 100, 'idle')).toBe(true);
    expect(wantsMore(98, 100, 'idle')).toBe(false);
    for (const more of ['loading', 'end', 'cap', 'error'] as const) expect(wantsMore(99, 100, more), more).toBe(false);
    expect(wantsMore(null, 0, 'idle')).toBe(false);
  });
});

describe('the tab\'s state (read-only: every change a new value through patchTab)', () => {
  test('openRecord: the record view on that row; the grid\'s selection and focus stay as they were', () => {
    useDb.getState().patchTab(KEY, { data: page(10), rows: page(10).rows, selection: [1, 2], focus: { row: 2, col: 1 } });
    openRecord(KEY, 2);
    const st = useDb.getState().tab(KEY);
    expect(st.view).toBe('record');
    expect(st.record).toBe(2);
    expect(st.selection).toEqual([1, 2]);
    expect(st.focus).toEqual({ row: 2, col: 1 });
    // The shared defaults are never written into.
    expect(DEFAULT_TAB.view).toBeUndefined();
    expect(DEFAULT_TAB.record).toBeUndefined();
  });

  test('moveRecord: ↑/↓ move the record only (the grid follows when it comes back); at an end it stays', () => {
    useDb.getState().patchTab(KEY, { data: page(3), rows: page(3).rows, selection: [0], focus: { row: 0, col: 1 } });
    openRecord(KEY, 0);
    moveRecord(KEY, 1);
    moveRecord(KEY, 1);
    expect(useDb.getState().tab(KEY).record).toBe(2);
    const before = useDb.getState().tab(KEY);
    moveRecord(KEY, 1);
    expect(useDb.getState().tab(KEY)).toBe(before);
    moveRecord(KEY, -1);
    expect(useDb.getState().tab(KEY).record).toBe(1);
    expect(useDb.getState().tab(KEY).selection).toEqual([0]);
  });

  test('closeRecord: the grid again, the record\'s row focused (its column kept) and selected alone', () => {
    useDb.getState().patchTab(KEY, { data: page(10), rows: page(10).rows, selection: [1, 2], focus: { row: 2, col: 1 } });
    openRecord(KEY, 2);
    moveRecord(KEY, 1);
    moveRecord(KEY, 1);
    closeRecord(KEY);
    const st = useDb.getState().tab(KEY);
    expect(st.view).toBe('grid');
    expect(st.selection).toEqual([4]);
    expect(st.focus).toEqual({ row: 4, col: 1 });
  });

  test('closeRecord with nothing focused before: the row\'s first column shown (a key main added only to name the row is not one)', () => {
    const p = page(5, { columns: [col('id'), col('total')], hidden: ['id'] });
    useDb.getState().patchTab(KEY, { data: p, rows: p.rows });
    openRecord(KEY, 3);
    closeRecord(KEY);
    expect(useDb.getState().tab(KEY).focus).toEqual({ row: 3, col: 1 });
    expect(useDb.getState().tab(KEY).selection).toEqual([3]);
  });

  test('closeRecord without rows: the grid again, nothing selected that isn\'t there', () => {
    openRecord(KEY, 0);
    closeRecord(KEY);
    const st = useDb.getState().tab(KEY);
    expect(st.view).toBe('grid');
    expect(st.selection).toEqual([]);
    expect(st.focus).toBeNull();
  });

  test('takeKeys: the keyboard goes where the key asked for it, once (a click on the toolbar\'s toggle keeps it on the toggle)', () => {
    useDb.getState().patchTab(KEY, { data: page(3), rows: page(3).rows });
    openRecord(KEY, 1);
    expect(takeKeys(KEY, 'record')).toBe(false);
    openRecord(KEY, 1, true);
    expect(takeKeys(KEY, 'grid')).toBe(false);
    expect(takeKeys(KEY, 'record')).toBe(true);
    expect(takeKeys(KEY, 'record')).toBe(false);
    closeRecord(KEY, true);
    expect(takeKeys(KEY, 'grid')).toBe(true);
    expect(takeKeys(KEY, 'grid')).toBe(false);
  });
});

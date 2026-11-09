import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DbPage } from '@shared/databases';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { tdt } from '../i18n/db-table';
import type { MenuItem } from '../menu-model';
import { DEFAULT_TAB } from './store';
import {
  agoText, foldOpen, isRefreshKey, onConnect, planLoad, progressCycles, reconnectStep, refreshKeyAction, requestDeps, shouldLoad, sqlFor, sqlShown, tableBody,
  toolbarMenu, useTableUi
} from './table-view';

// A table tab's view decisions: pure, lazy with
// the table's chunk. The markup itself: table-markup.test.ts.

const page = (n: number): DbPage => ({ columns: [], hidden: [], derived: [], rows: Array.from({ length: n }, () => []), ms: 1, sql: 'SELECT 1', pk: [], rowKey: [], kind: 'table' });

afterEach(() => {
  resetPlatformForTests();
  useTableUi.setState(useTableUi.getInitialState(), true);
});

describe('what the body shows', () => {
  test('tableBody: nothing for 150 ms, then skeleton rows; the error, the empty state, the rows (kept through a refresh)', () => {
    expect(tableBody(DEFAULT_TAB, false)).toBe('wait');
    expect(tableBody(DEFAULT_TAB, true)).toBe('skeleton');
    expect(tableBody({ ...DEFAULT_TAB, loading: true }, true)).toBe('skeleton');
    expect(tableBody({ ...DEFAULT_TAB, problem: { kind: 'canceled', message: 'Stopped after 15 s' } }, true)).toBe('error');
    expect(tableBody({ ...DEFAULT_TAB, data: page(0), more: 'end' }, true)).toBe('empty');
    expect(tableBody({ ...DEFAULT_TAB, data: page(3), rows: page(3).rows }, false)).toBe('rows');
    expect(tableBody({ ...DEFAULT_TAB, data: page(3), rows: page(3).rows, loading: true }, true)).toBe('rows');
  });

  test('a connection the user disconnected: the calm card instead of a load — rows already here stay', () => {
    expect(tableBody(DEFAULT_TAB, true, true)).toBe('disconnected');
    expect(tableBody({ ...DEFAULT_TAB, problem: { kind: 'lost', message: 'x' } }, true, true)).toBe('disconnected');
    expect(tableBody({ ...DEFAULT_TAB, loading: true }, true, true)).toBe('skeleton');
    expect(tableBody({ ...DEFAULT_TAB, data: page(3), rows: page(3).rows }, true, true)).toBe('rows');
    expect(tableBody({ ...DEFAULT_TAB, data: page(0), more: 'end' }, true, true)).toBe('empty');
  });

  test('a read main answered "held" (another window disconnected it meanwhile): the calm card, never an error', () => {
    const held = { ...DEFAULT_TAB, problem: { kind: 'held' as const, message: 'Disconnected' } };
    expect(tableBody(held, true)).toBe('disconnected');
    expect(tableBody(held, false, false)).toBe('disconnected');
    // Another kind stays the error card.
    expect(tableBody({ ...held, problem: { kind: 'lost', message: 'x' } }, true)).toBe('error');
  });
});

describe('when it loads', () => {
  const req = requestDeps(DEFAULT_TAB);
  const base = { visible: true, view: 'data' as const, ready: true, held: false, last: null, req };

  test('shouldLoad: when first shown, and again from the top when the request changed — never while hidden', () => {
    expect(shouldLoad(base)).toBe(true);
    expect(shouldLoad({ ...base, visible: false })).toBe(false);
    expect(shouldLoad({ ...base, view: 'structure' })).toBe(false);
    expect(shouldLoad({ ...base, ready: false })).toBe(false);
    expect(shouldLoad({ ...base, last: req })).toBe(false);
    expect(shouldLoad({ ...base, last: [...req] })).toBe(false);
    expect(shouldLoad({ ...base, last: [[], req[1], req[2], req[3]] })).toBe(true);
    expect(shouldLoad({ ...base, last: [req[0], req[1], ['id'], req[3]] })).toBe(true);
  });

  test('a connection the user disconnected this session: not on first show — a request the user changes still reads', () => {
    expect(shouldLoad({ ...base, held: true })).toBe(false);
    expect(shouldLoad({ ...base, held: true, last: [[], req[1], req[2], req[3]] })).toBe(true);
    expect(shouldLoad({ ...base, held: true, last: req })).toBe(false);
  });

  test('planLoad: one read when a hidden tab is shown with its request changed and a reconnect pending', () => {
    const changed = [[], req[1], req[2], req[3]] as const;
    const hidden = { visible: false, view: 'data' as const, ready: true, held: false, last: req, req: changed, pending: false, prev: 'password' as const, cur: 'connected' as const, failed: true };
    // Hidden: nothing read, the reconnect remembered.
    const h = planLoad(hidden);
    expect(h).toEqual({ load: false, pending: true, last: req });
    // Shown: one read, for the request as it is now; the pending reconnect is satisfied by it.
    const s = planLoad({ ...hidden, visible: true, pending: h.pending, prev: 'connected' });
    expect(s).toEqual({ load: true, pending: false, last: changed });
    // Then nothing more for the same state.
    expect(planLoad({ ...hidden, visible: true, pending: s.pending, last: s.last, prev: 'connected' }).load).toBe(false);
    // A reconnect alone (the request unchanged) reads too, once.
    expect(planLoad({ ...hidden, visible: true, req, prev: 'password' })).toEqual({ load: true, pending: false, last: req });
    // First show: the read, nothing pending.
    expect(planLoad({ ...hidden, visible: true, last: null, failed: false, prev: 'idle', cur: 'idle' })).toEqual({ load: true, pending: false, last: changed });
  });

  test('onConnect: one call to main — a tab that never tried connects (main lets the hold go, its first show reads); one that tried reads, which connects first', () => {
    const calls: string[] = [];
    const act = { connect: () => calls.push('connect'), refresh: () => calls.push('refresh') };
    onConnect(false, act);
    expect(calls).toEqual(['connect']);
    calls.length = 0;
    onConnect(true, act);
    expect(calls).toEqual(['refresh']);
  });

  test('reconnectStep: a failed tab reads again once its connection is back — at once in front, when shown if hidden', () => {
    const ev = { prev: 'password' as const, cur: 'connected' as const, failed: true, visible: true, view: 'data' as const };
    expect(reconnectStep(false, ev)).toEqual({ pending: false, load: true });
    // Hidden when it came back: remembered, read when shown.
    const hidden = reconnectStep(false, { ...ev, visible: false });
    expect(hidden).toEqual({ pending: true, load: false });
    expect(reconnectStep(hidden.pending, { ...ev, prev: 'connected', visible: true })).toEqual({ pending: false, load: true });
    expect(reconnectStep(true, { ...ev, prev: 'connected', view: 'structure' })).toEqual({ pending: true, load: false });
    // No failure (any more): nothing to read again.
    expect(reconnectStep(false, { ...ev, failed: false })).toEqual({ pending: false, load: false });
    expect(reconnectStep(true, { ...ev, prev: 'connected', failed: false })).toEqual({ pending: false, load: false });
    expect(reconnectStep(false, { ...ev, prev: 'connected', cur: 'connected' })).toEqual({ pending: false, load: false });
  });
});

describe('the toolbar', () => {
  test('agoText: Refresh\'s "Updated 12 s ago"', () => {
    const now = 1_000_000;
    expect(agoText(null, now)).toBe('');
    expect(agoText(now - 2_000, now)).toBe('just now');
    expect(agoText(now - 12_000, now)).toBe('12 s ago');
    expect(agoText(now - 90_000, now)).toBe('1 min ago');
    expect(agoText(now - 2 * 3_600_000 - 5, now)).toBe('2 h ago');
  });

  test('isRefreshKey: ⌘R on macOS, Ctrl+R on Windows; with another modifier it is someone else\'s', () => {
    const e = (o: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) =>
      ({ key: 'r', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
    expect(isRefreshKey(e({ metaKey: true }))).toBe(true);
    expect(isRefreshKey(e({ key: 'R', metaKey: true }))).toBe(true);
    expect(isRefreshKey(e({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isRefreshKey(e({ metaKey: true, altKey: true }))).toBe(false);
    expect(isRefreshKey(e({ ctrlKey: true }))).toBe(false);
    expect(isRefreshKey(e({}))).toBe(false);
    initPlatform('win32');
    expect(isRefreshKey(e({ ctrlKey: true }))).toBe(true);
    expect(isRefreshKey(e({ metaKey: true }))).toBe(false);
  });

  test('refreshKeyAction: ⌘R reads once; held down, its repeats are taken (nothing else hears them) but read nothing', () => {
    const e = (o: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean }>) =>
      ({ key: 'r', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, ...o });
    expect(refreshKeyAction(e({ metaKey: true }))).toBe('run');
    expect(refreshKeyAction(e({ metaKey: true, repeat: true }))).toBe('hold');
    expect(refreshKeyAction(e({ metaKey: true, shiftKey: true }))).toBeNull();
    expect(refreshKeyAction(e({ key: 'x', metaKey: true, repeat: true }))).toBeNull();
  });

  test('toolbarMenu (the ⋯ button when narrow, and right-click or Shift+F10 on the bar): every toolbar action, Title Case', () => {
    const act = { view: vi.fn(), mask: vi.fn(), refresh: vi.fn(), showSql: vi.fn(), copySql: vi.fn() };
    const items = toolbarMenu({ view: 'structure', masked: true, canMask: true, hasSql: true }, act);
    const real = items.filter((x): x is Exclude<MenuItem, 'sep'> => x !== 'sep');
    expect(items.map((x) => (x === 'sep' ? '—' : x.label))).toEqual(['Data', 'Structure', 'Relations', '—', 'Mask Values', 'Refresh', '—', 'Show SQL', 'Copy SQL']);
    expect(real.filter((x) => x.radio).map((x) => [x.id, x.checked])).toEqual([['view-data', false], ['view-structure', true], ['view-relations', false]]);
    expect(real.find((x) => x.id === 'mask')).toMatchObject({ checked: true });
    expect(real.find((x) => x.id === 'refresh')?.hint).toBe('⌘R');
    for (const x of real) x.run();
    expect(act.view.mock.calls.map((c) => c[0])).toEqual(['data', 'structure', 'relations']);
    for (const f of [act.mask, act.refresh, act.showSql, act.copySql]) expect(f).toHaveBeenCalledTimes(1);
  });

  test('toolbarMenu on Data: Record View (⇥) and Row Inspector (⏎) as checkboxes after the views — the Grid / Record toggle folds into ⋯ with them', () => {
    const act = { view: vi.fn(), mask: vi.fn(), refresh: vi.fn(), showSql: vi.fn(), copySql: vi.fn(), record: vi.fn(), inspector: vi.fn() };
    const items = toolbarMenu({ view: 'data', masked: false, canMask: true, hasSql: true, record: false, inspector: true }, act);
    expect(items.map((x) => (x === 'sep' ? '—' : x.label))).toEqual(['Data', 'Structure', 'Relations', '—', 'Record View', 'Row Inspector', '—', 'Mask Values', 'Refresh', '—', 'Show SQL', 'Copy SQL']);
    const real = items.filter((x): x is Exclude<MenuItem, 'sep'> => x !== 'sep');
    expect(real.find((x) => x.id === 'record')).toMatchObject({ checked: false, hint: '⇥' });
    expect(real.find((x) => x.id === 'record')?.radio).toBeUndefined();
    expect(real.find((x) => x.id === 'inspector')).toMatchObject({ checked: true, hint: '⏎' });
    real.find((x) => x.id === 'record')!.run();
    real.find((x) => x.id === 'inspector')!.run();
    expect(act.record).toHaveBeenCalledTimes(1);
    expect(act.inspector).toHaveBeenCalledTimes(1);
    // The record view showing: checked; the inspector hides while it does (it would show the same row twice).
    const rec = toolbarMenu({ view: 'data', masked: false, canMask: true, hasSql: true, record: true, inspector: true }, act).filter((x): x is Exclude<MenuItem, 'sep'> => x !== 'sep');
    expect(rec.find((x) => x.id === 'record')?.checked).toBe(true);
    expect(rec.find((x) => x.id === 'inspector')).toMatchObject({ disabled: true });
    // Structure and Relations have no rows to show either way.
    for (const view of ['structure', 'relations'] as const) {
      const ids = toolbarMenu({ view, masked: false, canMask: true, hasSql: true, record: true, inspector: true }, act).map((x) => (x === 'sep' ? '—' : x.id));
      expect(ids, view).not.toContain('record');
      expect(ids, view).not.toContain('inspector');
    }
  });

  test('toolbarMenu: no connection, no Mask; no statement yet, no SQL', () => {
    const act = { view: vi.fn(), mask: vi.fn(), refresh: vi.fn(), showSql: vi.fn(), copySql: vi.fn() };
    const real = toolbarMenu({ view: 'data', masked: false, canMask: false, hasSql: false }, act).filter((x): x is Exclude<MenuItem, 'sep'> => x !== 'sep');
    expect(real.filter((x) => x.disabled).map((x) => x.id)).toEqual(['mask', 'sql', 'copy-sql']);
    expect(real.find((x) => x.id === 'mask')?.checked).toBe(false);
  });

  test('the SQL popover shows for its tab only while that tab is in front, with a statement', () => {
    const K = 'db:c0123456789ab/public/orders';
    expect(sqlShown(K, K, true, 'SELECT 1')).toBe(true);
    expect(sqlShown(K, K, false, 'SELECT 1')).toBe(false);
    expect(sqlShown(K, 'db:c0123456789ab/public/other', true, 'SELECT 1')).toBe(false);
    expect(sqlShown(null, K, true, 'SELECT 1')).toBe(false);
    expect(sqlShown(K, K, true, null)).toBe(false);
    useTableUi.getState().openSql(K);
    expect(useTableUi.getState().sql).toBe(K);
    useTableUi.getState().closeSql(K);
    expect(useTableUi.getState().sql).toBeNull();
    // Closing another tab's leaves this one's alone.
    useTableUi.getState().openSql(K);
    useTableUi.getState().closeSql('db:c0123456789ab/public/other');
    expect(useTableUi.getState().sql).toBe(K);
  });

  test('the popover never outlives its tab in front or its statement: sync closes it hidden or without SQL', () => {
    const K = 'db:c0123456789ab/public/orders';
    const O = 'db:c0123456789ab/public/other';
    const ui = useTableUi.getState();
    ui.openSql(K);
    ui.sync(K, true, 'SELECT 1');
    expect(useTableUi.getState().sql).toBe(K);
    ui.sync(O, false, null);
    expect(useTableUi.getState().sql).toBe(K);
    ui.sync(K, true, null);
    expect(useTableUi.getState().sql).toBeNull();
    ui.openSql(K);
    ui.sync(K, false, 'SELECT 1');
    expect(useTableUi.getState().sql).toBeNull();
    // Nothing open: nothing to tell anyone.
    const seen = vi.fn();
    const off = useTableUi.subscribe(seen);
    ui.sync(K, false, null);
    ui.closeSql(K);
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  test('foldOpen: the ⋯ button reads open while the store\'s menu is the one it opened', () => {
    const K = 'db:c0123456789ab/public/orders';
    const mine = { x: 1, y: 2, items: [] };
    expect(foldOpen(mine, { key: K, menu: mine }, K)).toBe(true);
    expect(foldOpen({ ...mine }, { key: K, menu: mine }, K)).toBe(false);
    expect(foldOpen(null, { key: K, menu: mine }, K)).toBe(false);
    expect(foldOpen(mine, { key: 'db:c0123456789ab/public/other', menu: mine }, K)).toBe(false);
    expect(foldOpen(mine, null, K)).toBe(false);
  });

  test('progressCycles: the refresh bar keeps moving for a whole load, up to the query timeout — a finite count', () => {
    for (const sec of [5, 15, 60, 120]) {
      const n = progressCycles(sec);
      expect(Number.isInteger(n)).toBe(true);
      expect(n * 1100).toBeGreaterThanOrEqual(sec * 1000);
      expect(n).toBeLessThan(200);
    }
  });
});

describe('Mask values in the statement: the SQL popover and Copy SQL show each inlined filter value as dots', () => {
  // As main's displaySql prints a page with every kind of filter (values inlined, pg_catalog names short).
  const SQL = `SELECT "id", "it's" FROM "public"."orders" WHERE "email" = 'a@acme.test'::text AND "note"::text ILIKE '%x''y%' ESCAPE E'\\\\' `
    + `AND ("payload" #>> ARRAY['data', 'status']::text[]) = 'paid' AND "status" = ANY(ARRAY['paid', 'shipped']::text[]::"public"."order_status"[]) `
    + `AND "created_at" >= now() - make_interval(days => '7'::int4) AND "total" BETWEEN '1'::numeric AND '9'::numeric `
    + `AND ("payload" #> ARRAY['refund']::text[]) IS NOT NULL AND 'vip'::text = ANY("tags") ORDER BY ("payload" #>> ARRAY['n']::text[]) ASC LIMIT 100 OFFSET 0`;

  test('every value as \'••••\' (an array\'s each), the paths, the names, LIKE\'s escape and the paging as they are', () => {
    expect(sqlFor(SQL, true)).toBe(
      `SELECT "id", "it's" FROM "public"."orders" WHERE "email" = '••••'::text AND "note"::text ILIKE '••••' ESCAPE E'\\\\' `
      + `AND ("payload" #>> ARRAY['data', 'status']::text[]) = '••••' AND "status" = ANY(ARRAY['••••', '••••']::text[]::"public"."order_status"[]) `
      + `AND "created_at" >= now() - make_interval(days => '••••'::int4) AND "total" BETWEEN '••••'::numeric AND '••••'::numeric `
      + `AND ("payload" #> ARRAY['refund']::text[]) IS NOT NULL AND '••••'::text = ANY("tags") ORDER BY ("payload" #>> ARRAY['n']::text[]) ASC LIMIT 100 OFFSET 0`
    );
    for (const v of ['a@acme.test', "x''y", "'paid'", 'shipped', "'7'", "'1'", "'9'", 'vip']) expect(sqlFor(SQL, true)).not.toContain(v);
  });

  test('Mask values off: the statement as main printed it', () => {
    expect(sqlFor(SQL, false)).toBe(SQL);
  });

  test('the popover says what it shows — the read as you would run it — and that values over 64 KB reach Atelier cut', () => {
    expect(tdt.sqlTip).toBe('The read, as you would run it');
    expect(tdt.sqlNote).toContain('as you would run it');
    expect(tdt.sqlNote).toContain('values over 64 KB');
    expect(tdt.sqlNote).not.toMatch(/exact/i);
  });

  test("a value with a backslash, which main prints as an escape string (E'…'), is masked like any other", () => {
    const sql = `SELECT "id" FROM "t" WHERE ("note" = E'C:\\\\temp'::text) IS NOT TRUE AND "tags" = ANY(ARRAY[E'a\\\\b', 'c']::text[]) AND "x" ILIKE '%y%' ESCAPE E'\\\\'`;
    expect(sqlFor(sql, true)).toBe(`SELECT "id" FROM "t" WHERE ("note" = '••••'::text) IS NOT TRUE AND "tags" = ANY(ARRAY['••••', '••••']::text[]) AND "x" ILIKE '••••' ESCAPE E'\\\\'`);
    expect(sqlFor(sql, true)).not.toContain('temp');
  });
});

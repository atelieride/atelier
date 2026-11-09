import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DB_SLOT_MAX, EMPTY_DB_SNAPSHOT, type DbConnView, type DbConnection, type DbFilteredRef, type DbPage, type DbPageRequest, type DbProblem, type DbResult,
  type DbServerInfo
} from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { useApp } from '../store';
import {
  MAX_LOADED_BYTES, MAX_LOADED_ROWS, capMessage, countExactly, fetchSize, filteredRef, loadFirst, loadMore, needsMore, pageRequest, pickedRow, rowsLabel,
  setDbKind, valueBytes
} from './data';
import { heldIn, isHeld } from './hold';
import { DEFAULT_TAB, useDb, type DbTabState } from './store';
import type { DbTabRef } from './tabs';

// A table tab's rows: the first fetch, then one more each time the scroll nears the
// last loaded row (one in flight, never past 10,000), every reply for an older request dropped, never a count(*) unless
// asked; the labels and states the toolbar and the footer show.

const C = 'c0123456789ab';
const KEY = `db:${C}/public/orders`;
const REF: DbTabRef = { key: KEY as DbTabRef['key'], connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'data' };

const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const COLS = [col('id', 'int8', 'N', { isPk: true, isKey: true, nullable: false }), col('status', 'text', 'S')];

/** A reply of `n` rows numbered from `from + 1`. */
function page(n: number, from = 0, o: Partial<DbPage> = {}): DbPage {
  return {
    columns: COLS, hidden: [], derived: [], rows: Array.from({ length: n }, (_, i) => [{ v: String(from + i + 1) }, { v: 'paid' }]), ms: 14,
    sql: `SELECT * FROM public.orders ORDER BY id LIMIT ${n} OFFSET ${from}`, pk: ['id'], kind: 'table', ...o, rowKey: o.rowKey ?? o.pk ?? ['id']
  };
}
const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const bad = (problem: DbProblem): DbResult<never> => ({ ok: false, problem });
const ids = (st: DbTabState) => st.rows.map((r) => r[0]!.v);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let api: { page: ReturnType<typeof vi.fn>; estimate: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> };
const tab = () => useDb.getState().tab(KEY);
const pageCalls = (): DbPageRequest[] => api.page.mock.calls.map((c) => c[0] as DbPageRequest);
const setSize = (s: '50' | '100' | '250' | '500') => useApp.setState({ settings: { ...useApp.getState().settings, dbPageSize: s } });
const SERVER: DbServerInfo = { version: '17.2', versionNum: 170002, tls: false, role: 'app', canWrite: false, latencyMs: 3 };

beforeEach(() => {
  api = {
    page: vi.fn(async () => ok(page(100))), estimate: vi.fn(async () => ok(2300)), count: vi.fn(async () => ok(2318)), connect: vi.fn(async () => ok(SERVER))
  };
  vi.stubGlobal('window', { atelier: { databases: api } });
  useApp.setState({ dbTabs: [REF], showToast: vi.fn() });
  setSize('100');
});
afterEach(() => {
  vi.unstubAllGlobals();
  useApp.setState(useApp.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
});

describe('pageRequest', () => {
  test('exactly the shape main\'s strict schema takes: the names only, every column as [], copies of what the tab holds', () => {
    const r = pageRequest(REF, DEFAULT_TAB, 100, 0);
    expect(r).toEqual({ ref: { connId: C, schema: 'public', name: 'orders' }, columns: [], derived: [], filters: [], sort: [], page: 0, size: 100, slot: KEY });
    expect(Object.keys(r.ref).sort()).toEqual(['connId', 'name', 'schema']);
  });

  test('hidden columns: the chosen ones as an explicit list, in order; filters, sorts and JSON columns copied key for key', () => {
    const st: DbTabState = {
      ...DEFAULT_TAB,
      columns: Object.freeze(['status', 'id']),
      filters: Object.freeze([{ column: 'status', op: 'in', values: ['paid', 'shipped'] }, { column: 'meta', path: ['a', 0], op: 'pathExists', values: [] }]),
      sort: Object.freeze([{ column: 'created_at', dir: 'desc' }, { column: 'meta', path: ['b'], dir: 'asc' }]),
      derived: Object.freeze([{ column: 'meta', path: ['user', 'email'] }])
    } as DbTabState;
    const r = pageRequest(REF, st, 250, 3);
    expect(r).toEqual({
      ref: { connId: C, schema: 'public', name: 'orders' }, columns: ['status', 'id'], derived: [{ column: 'meta', path: ['user', 'email'] }],
      filters: [{ column: 'status', op: 'in', values: ['paid', 'shipped'] }, { column: 'meta', path: ['a', 0], op: 'pathExists', values: [] }],
      sort: [{ column: 'created_at', dir: 'desc' }, { column: 'meta', path: ['b'], dir: 'asc' }], page: 3, size: 250, slot: KEY
    });
    // No `path: undefined` key: a strict schema reads a key that is there.
    expect(Object.keys(r.filters[0]!)).toEqual(['column', 'op', 'values']);
    expect(Object.keys(r.sort[0]!)).toEqual(['column', 'dir']);
    // Copies: main's schemas take mutable shapes, the tab's are frozen.
    expect(r.columns).not.toBe(st.columns);
    expect(r.filters[0]!.values).not.toBe(st.filters[0]!.values);
    expect(r.derived[0]!.path).not.toBe(st.derived[0]!.path);
    expect(Object.isFrozen(r.columns)).toBe(false);
  });

  test('filteredRef: the names and the filters, nothing else (estimate, count)', () => {
    const st = { ...DEFAULT_TAB, filters: [{ column: 'status', op: 'eq', values: ['paid'] }], sort: [{ column: 'id', dir: 'desc' }] } as DbTabState;
    const f: DbFilteredRef = filteredRef(REF, st);
    expect(f).toEqual({ ref: { connId: C, schema: 'public', name: 'orders' }, filters: [{ column: 'status', op: 'eq', values: ['paid'] }], slot: KEY });
    expect(f.filters).not.toBe(st.filters);
  });

  test('the slot: the tab\'s key, so main drops a request of this tab a newer one replaced; a key past DB_SLOT_MAX sends none', () => {
    expect(DB_SLOT_MAX).toBe(300);
    const at = (n: number): DbTabRef => ({ ...REF, key: `db:${C}/public/${'t'.repeat(n - `db:${C}/public/`.length)}` as DbTabRef['key'] });
    const edge = at(DB_SLOT_MAX);
    expect(edge.key).toHaveLength(300);
    expect(pageRequest(edge, DEFAULT_TAB, 100, 0).slot).toBe(edge.key);
    expect(filteredRef(edge, DEFAULT_TAB).slot).toBe(edge.key);
    // Never `slot: undefined` (main's schemas are strict): no key at all.
    expect('slot' in pageRequest(at(301), DEFAULT_TAB, 100, 0)).toBe(false);
    expect('slot' in filteredRef(at(301), DEFAULT_TAB)).toBe(false);
  });

  test('fetchSize: Settings › Rows per fetch, 100 for anything else', () => {
    expect(['50', '100', '250', '500', 'x'].map(fetchSize)).toEqual([50, 100, 250, 500, 100]);
  });
});

describe('loadFirst', () => {
  test('opened on a key (Open ›, "N rows ›"): the first row selected and focused on its first shown column, once', async () => {
    useDb.getState().patchTab(KEY, { pick: true, selection: [5], focus: { row: 5, col: 1 } });
    api.page.mockResolvedValueOnce(ok(page(3, 0, { columns: [COLS[1]!, COLS[0]!], hidden: [] })));
    await loadFirst(KEY);
    expect(tab()).toMatchObject({ selection: [0], focus: { row: 0, col: 0 }, pick: false });
    // A key column main added only to name the row isn't shown: the focus goes to the first one that is.
    useDb.getState().patchTab(KEY, { pick: true });
    api.page.mockResolvedValueOnce(ok(page(3, 0, { hidden: ['id'] })));
    await loadFirst(KEY);
    expect(tab().focus).toEqual({ row: 0, col: 1 });
    // The next page from the top (a sort, Refresh) selects nothing by itself.
    await loadFirst(KEY);
    expect(tab()).toMatchObject({ selection: [], focus: null });
  });

  test('a pick by a row\'s key (the JSON view\'s Filter, + Column): that row again when it is in the page, else the first', async () => {
    useDb.getState().patchTab(KEY, { pick: { key: { id: '3' } } });
    api.page.mockResolvedValueOnce(ok(page(5)));
    await loadFirst(KEY);
    expect(tab()).toMatchObject({ selection: [2], focus: { row: 2, col: 0 }, pick: false });
    useDb.getState().patchTab(KEY, { pick: { key: { id: '42' } } });
    api.page.mockResolvedValueOnce(ok(page(5)));
    await loadFirst(KEY);
    expect(tab()).toMatchObject({ selection: [0], focus: { row: 0, col: 0 }, pick: false });
  });

  test('pickedRow: every column of the row key equal; no key, the first row', () => {
    const p = page(4, 0, { columns: [...COLS, col('code', 'text', 'S')], rowKey: ['id', 'code'], rows: [1, 2, 3].map((i) => [{ v: String(i) }, { v: 'paid' }, { v: i === 2 ? 'B' : 'A' }]) });
    expect(pickedRow(p, { id: '2', code: 'B' })).toBe(1);
    expect(pickedRow(p, { id: '2', code: 'A' })).toBe(0);
    expect(pickedRow(p, null)).toBe(0);
    expect(pickedRow({ ...p, rowKey: [] }, { id: '2' })).toBe(0);
  });

  test('opened on a key that matches nothing, or failing: nothing selected, the pick spent', async () => {
    useDb.getState().patchTab(KEY, { pick: true });
    api.page.mockResolvedValueOnce(ok(page(0)));
    await loadFirst(KEY);
    expect(tab()).toMatchObject({ selection: [], focus: null, pick: false });
    useDb.getState().patchTab(KEY, { pick: true });
    api.page.mockResolvedValueOnce(bad({ kind: 'other', message: 'boom' }));
    await loadFirst(KEY);
    expect(tab()).toMatchObject({ selection: [], focus: null, pick: false });
  });

  test('page 0 at Settings › Rows per fetch, then the estimate; the reply becomes the rows; never a count', async () => {
    setSize('250');
    api.page.mockResolvedValueOnce(ok(page(250)));
    await loadFirst(KEY);
    expect(pageCalls()).toEqual([pageRequest(REF, DEFAULT_TAB, 250, 0)]);
    const st = tab();
    expect(st.rows).toHaveLength(250);
    expect(st.data?.sql).toContain('LIMIT 250');
    expect(st).toMatchObject({ loading: false, problem: null, more: 'idle', moreProblem: null, estimate: 2300 });
    expect(typeof st.at).toBe('number');
    expect(api.estimate).toHaveBeenCalledWith({ ref: { connId: C, schema: 'public', name: 'orders' }, filters: [], slot: KEY });
    expect(api.estimate.mock.invocationCallOrder[0]).toBeGreaterThan(api.page.mock.invocationCallOrder[0]!);
    expect(api.count).not.toHaveBeenCalled();
  });

  test('while it loads: loading, the problem cleared, the exact count forgotten (the request may have changed)', async () => {
    useDb.getState().patchTab(KEY, { problem: { kind: 'other', message: 'x' }, exact: 2318 });
    const d = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(d.promise);
    const done = loadFirst(KEY);
    expect(tab()).toMatchObject({ loading: true, problem: null, exact: null, more: 'idle' });
    d.resolve(ok(page(100)));
    await done;
    expect(tab().loading).toBe(false);
  });

  test('a stale reply is dropped: two loads, the first answering last', async () => {
    const first = deferred<DbResult<DbPage>>();
    const second = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = loadFirst(KEY);
    useDb.getState().patchTab(KEY, { filters: [{ column: 'status', op: 'eq', values: ['paid'] }] });
    const b = loadFirst(KEY);
    second.resolve(ok(page(5, 900)));
    await b;
    first.resolve(ok(page(100)));
    await a;
    expect(ids(tab())).toEqual(['901', '902', '903', '904', '905']);
    expect(tab().more).toBe('end');
    expect(tab().loading).toBe(false);
    // The dropped reply asked nothing more (its estimate would be for the old filters).
    expect(api.estimate).not.toHaveBeenCalled();
  });

  test('a stale estimate is dropped too', async () => {
    const est = deferred<DbResult<number | null>>();
    api.estimate.mockReturnValueOnce(est.promise);
    const a = loadFirst(KEY);
    await vi.waitFor(() => expect(api.estimate).toHaveBeenCalledTimes(1));
    api.page.mockResolvedValueOnce(ok(page(100)));
    api.estimate.mockResolvedValueOnce(ok(40));
    await loadFirst(KEY);
    est.resolve(ok(999_999));
    await a;
    expect(tab().estimate).toBe(40);
  });

  test('the first fetch shorter than a fetch: the end, all rows here — no estimate asked', async () => {
    api.page.mockResolvedValueOnce(ok(page(40)));
    await loadFirst(KEY);
    expect(tab().more).toBe('end');
    expect(api.estimate).not.toHaveBeenCalled();
  });

  test('a refresh keeps the rows on screen until the new ones arrive; the selection goes with them', async () => {
    await loadFirst(KEY);
    useDb.getState().patchTab(KEY, { selection: [3], focus: { row: 3, col: 1 } });
    const d = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(d.promise);
    const done = loadFirst(KEY);
    expect(tab().rows).toHaveLength(100);
    expect(tab().selection).toEqual([3]);
    d.resolve(ok(page(100, 5000)));
    await done;
    expect(ids(tab())[0]).toBe('5001');
    expect(tab().selection).toEqual([]);
    expect(tab().focus).toBeNull();
  });

  test('a timeout says so, and the next request still works', async () => {
    const stopped: DbProblem = { kind: 'canceled', message: 'Stopped after 15 s', code: '57014' };
    api.page.mockResolvedValueOnce(bad(stopped));
    await loadFirst(KEY);
    expect(tab()).toMatchObject({ loading: false, problem: stopped, rows: [], data: null });
    expect(api.estimate).not.toHaveBeenCalled();
    await loadFirst(KEY);
    expect(tab().problem).toBeNull();
    expect(tab().rows).toHaveLength(100);
  });

  test('the connection lost after main\'s own retry: the problem, for Try Again', async () => {
    const lost: DbProblem = { kind: 'lost', message: 'The connection was lost' };
    api.page.mockResolvedValueOnce(bad(lost));
    await loadFirst(KEY);
    expect(tab().problem).toEqual(lost);
  });

  test('a call that never reaches main (rejected) is a problem, not a spinner forever', async () => {
    api.page.mockRejectedValueOnce(new Error('ipc'));
    await loadFirst(KEY);
    expect(tab().loading).toBe(false);
    expect(tab().problem?.kind).toBe('other');
    expect(tab().problem?.message).toBeTruthy();
  });

  test('a restored tab\'s kind is corrected from the reply', async () => {
    api.page.mockResolvedValueOnce(ok(page(10, 0, { kind: 'view' })));
    await loadFirst(KEY);
    expect(useApp.getState().dbTabs[0]!.kind).toBe('view');
  });

  test('the table\'s columns (the filter popover and the Columns chip list them all) come from a read of every column', async () => {
    await loadFirst(KEY);
    expect(tab().tableCols).toEqual(COLS);
    // Chosen columns read a subset (and the hidden keys): the table's list stays the one read whole — a failed read too.
    useDb.getState().patchTab(KEY, { columns: ['status'] });
    api.page.mockResolvedValueOnce(ok(page(10, 0, { columns: [COLS[1]!, COLS[0]!], hidden: ['id'] })));
    await loadFirst(KEY);
    expect(tab().tableCols).toEqual(COLS);
    api.page.mockResolvedValueOnce(bad({ kind: 'other', message: 'no' }));
    await loadFirst(KEY);
    expect(tab().tableCols).toEqual(COLS);
  });

  test('a key that isn\'t an open table tab loads nothing (the overview, a closed tab)', async () => {
    useApp.setState({ dbTabs: [{ ...REF, key: `db:${C}` as DbTabRef['key'], schema: '', name: '', kind: 'overview' }] });
    await loadFirst(`db:${C}`);
    await loadFirst(KEY);
    expect(api.page).not.toHaveBeenCalled();
    expect(useDb.getState().tabs).toEqual({});
  });
});

describe('setDbKind', () => {
  test('only a change sets the store: no re-render for a kind already right, an unknown key or the overview', () => {
    const OVER: DbTabRef = { ...REF, key: `db:${C}` as DbTabRef['key'], schema: '', name: '', kind: 'overview' };
    useApp.setState({ dbTabs: [REF, OVER] });
    const seen = vi.fn();
    const off = useApp.subscribe(seen);
    setDbKind(KEY, 'table');
    setDbKind('db:cffffffffffff/public/x', 'view');
    setDbKind(OVER.key, 'view');
    expect(seen).not.toHaveBeenCalled();
    setDbKind(KEY, 'matview');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(useApp.getState().dbTabs.map((r) => r.kind)).toEqual(['matview', 'overview']);
    off();
  });
});

describe('loadMore', () => {
  test('appends page 1 after page 0, at the first fetch\'s size even if the setting changed since', async () => {
    await loadFirst(KEY);
    setSize('50');
    api.page.mockResolvedValueOnce(ok(page(100, 100, { ms: 9, sql: 'SELECT … OFFSET 100' })));
    await loadMore(KEY);
    expect(pageCalls()[1]).toEqual(pageRequest(REF, tab(), 100, 1));
    expect(ids(tab())).toEqual(Array.from({ length: 200 }, (_, i) => String(i + 1)));
    expect(tab().more).toBe('idle');
    // The footer's time and the SQL popover follow the last fetch; the columns stay the first's.
    expect(tab().data?.ms).toBe(9);
    expect(tab().data?.sql).toBe('SELECT … OFFSET 100');
    expect(tab().data?.columns).toBe(COLS);
    expect(api.count).not.toHaveBeenCalled();
  });

  test('one in flight at a time: a second call while the first is out does nothing', async () => {
    await loadFirst(KEY);
    const d = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(d.promise);
    const a = loadMore(KEY);
    expect(tab().more).toBe('loading');
    await loadMore(KEY);
    await loadMore(KEY);
    expect(api.page).toHaveBeenCalledTimes(2);
    d.resolve(ok(page(100, 100)));
    await a;
    expect(tab().rows).toHaveLength(200);
  });

  test('the end: a fetch shorter than the size stops it, and nothing more is asked', async () => {
    await loadFirst(KEY);
    api.page.mockResolvedValueOnce(ok(page(18, 100)));
    await loadMore(KEY);
    expect(tab().rows).toHaveLength(118);
    expect(tab().more).toBe('end');
    await loadMore(KEY);
    expect(api.page).toHaveBeenCalledTimes(2);
  });

  test(`the cap: ${MAX_LOADED_ROWS.toLocaleString('en-US')} rows loaded, then nothing more`, async () => {
    setSize('500');
    api.page.mockResolvedValueOnce(ok(page(500)));
    await loadFirst(KEY);
    for (let i = 1; i < MAX_LOADED_ROWS / 500; i++) {
      api.page.mockResolvedValueOnce(ok(page(500, i * 500)));
      await loadMore(KEY);
    }
    expect(tab().rows).toHaveLength(MAX_LOADED_ROWS);
    expect(tab().more).toBe('cap');
    // The 20th fetch was full: one small probe past row 10,000 — there are more (the default reply), so the cap.
    expect(pageCalls().at(-2)?.page).toBe(19);
    // The probe is the tab's page too (its slot): a newer page of this tab replaces it if it waits.
    expect(pageCalls().at(-1)).toMatchObject({ page: 200, size: 50, slot: KEY });
    expect(pageCalls().every((c) => c.slot === KEY)).toBe(true);
    await loadMore(KEY);
    expect(api.page).toHaveBeenCalledTimes(21);
    expect(MAX_LOADED_ROWS).toBe(10_000);
  });

  test('the cap with 50-row fetches too', async () => {
    setSize('50');
    api.page.mockResolvedValueOnce(ok(page(50)));
    await loadFirst(KEY);
    useDb.getState().patchTab(KEY, { rows: page(9950).rows });
    api.page.mockResolvedValueOnce(ok(page(50, 9950)));
    await loadMore(KEY);
    expect(pageCalls().at(-2)).toMatchObject({ page: 199, size: 50 });
    expect(tab().more).toBe('cap');
  });

  test('a filter change during a loadMore drops its reply (the new first fetch stands)', async () => {
    await loadFirst(KEY);
    const more = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(more.promise);
    const m = loadMore(KEY);
    useDb.getState().patchTab(KEY, { filters: [{ column: 'status', op: 'eq', values: ['refunded'] }] });
    api.page.mockResolvedValueOnce(ok(page(100, 7000)));
    await loadFirst(KEY);
    more.resolve(ok(page(100, 100)));
    await m;
    expect(tab().rows).toHaveLength(100);
    expect(ids(tab())[0]).toBe('7001');
    expect(tab().more).toBe('idle');
  });

  test('a fetch that fails: an error row with its problem; Retry asks the same page again', async () => {
    await loadFirst(KEY);
    const lost: DbProblem = { kind: 'lost', message: 'The connection was lost' };
    api.page.mockResolvedValueOnce(bad(lost));
    await loadMore(KEY);
    expect(tab()).toMatchObject({ more: 'error', moreProblem: lost });
    expect(tab().rows).toHaveLength(100);
    api.page.mockResolvedValueOnce(ok(page(100, 100)));
    await loadMore(KEY);
    expect(pageCalls().slice(1).map((r) => r.page)).toEqual([1, 1]);
    expect(tab()).toMatchObject({ more: 'idle', moreProblem: null });
    expect(tab().rows).toHaveLength(200);
  });

  test('a fetch that times out says so on its row, and the next one still works', async () => {
    await loadFirst(KEY);
    api.page.mockResolvedValueOnce(bad({ kind: 'canceled', message: 'Stopped after 15 s' }));
    await loadMore(KEY);
    expect(tab().moreProblem?.kind).toBe('canceled');
    await loadMore(KEY);
    expect(tab().rows).toHaveLength(200);
  });

  test('nothing to append to: before any fetch, while the first one is out, after it failed', async () => {
    await loadMore(KEY);
    expect(api.page).not.toHaveBeenCalled();
    const d = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(d.promise);
    const first = loadFirst(KEY);
    await loadMore(KEY);
    expect(api.page).toHaveBeenCalledTimes(1);
    d.resolve(bad({ kind: 'other', message: 'boom' }));
    await first;
    await loadMore(KEY);
    expect(api.page).toHaveBeenCalledTimes(1);
  });
});

describe('needsMore', () => {
  // 100 rows of 30 px = 3,000 px; a 600 px viewport: more within 2 viewports (1,200 px) of the last row's bottom.
  test('within two viewports of the last loaded row, not before', () => {
    expect(needsMore(1199, 600, 30, 100)).toBe(false);
    expect(needsMore(1200, 600, 30, 100)).toBe(true);
    expect(needsMore(2400, 600, 30, 100)).toBe(true);
    expect(needsMore(0, 600, 30, 100)).toBe(false);
  });

  test('a short first fetch in a tall viewport asks at once; a hidden grid (no height) never does', () => {
    expect(needsMore(0, 900, 30, 50)).toBe(true);
    expect(needsMore(0, 0, 30, 100)).toBe(false);
  });
});

describe('countExactly', () => {
  test('count(*) with the filters replaces the estimate', async () => {
    await loadFirst(KEY);
    useDb.getState().patchTab(KEY, { filters: [{ column: 'status', op: 'eq', values: ['paid'] }] });
    expect(await countExactly(KEY)).toBeNull();
    expect(api.count).toHaveBeenCalledWith({ ref: { connId: C, schema: 'public', name: 'orders' }, filters: [{ column: 'status', op: 'eq', values: ['paid'] }], slot: KEY });
    expect(tab().exact).toBe(2318);
  });

  test('pressed twice while the first waited in main\'s line: the first answers Superseded — nothing to say, the second counts', async () => {
    await loadFirst(KEY);
    api.count.mockResolvedValueOnce(bad({ kind: 'canceled', message: 'Superseded' }));
    expect(await countExactly(KEY)).toBeNull();
    expect(tab().exact).toBeNull();
    expect(await countExactly(KEY)).toBeNull();
    expect(tab().exact).toBe(2318);
    // A real cancel (statement_timeout) is still said.
    api.count.mockResolvedValueOnce(bad({ kind: 'canceled', message: 'Stopped after 15 s' }));
    expect((await countExactly(KEY))?.message).toBe('Stopped after 15 s');
  });

  test('an answer for an older request is dropped; a failure is returned to say', async () => {
    await loadFirst(KEY);
    const d = deferred<DbResult<number>>();
    api.count.mockReturnValueOnce(d.promise);
    const c = countExactly(KEY);
    await loadFirst(KEY);
    d.resolve(ok(5));
    await c;
    expect(tab().exact).toBeNull();
    const stopped: DbProblem = { kind: 'canceled', message: 'Stopped after 15 s' };
    api.count.mockResolvedValueOnce(bad(stopped));
    expect(await countExactly(KEY)).toEqual(stopped);
    expect(tab().exact).toBeNull();
    api.count.mockRejectedValueOnce(new Error('ipc'));
    expect((await countExactly(KEY))?.kind).toBe('other');
  });
});

describe('rowsLabel', () => {
  const st = (o: Partial<DbTabState>): DbTabState => ({ ...DEFAULT_TAB, data: page(0), ...o });
  const rows = (n: number) => page(n).rows;

  test('the footer\'s cases', () => {
    expect(rowsLabel(DEFAULT_TAB)).toBe('');
    expect(rowsLabel(st({ rows: [] , more: 'end' }))).toBe('No rows');
    expect(rowsLabel(st({ rows: rows(300), estimate: 2300 }))).toBe('300 loaded of ~2,300');
    expect(rowsLabel(st({ rows: rows(2318), more: 'end', estimate: 2300 }))).toBe('all 2,318 loaded');
    expect(rowsLabel(st({ rows: rows(10_000), more: 'cap', estimate: 1_234_567 }))).toBe('10,000 loaded of ~1.2M');
  });

  test('Count exactly\'s answer replaces the estimate; an estimate below what is loaded (old statistics) is left out', () => {
    expect(rowsLabel(st({ rows: rows(300), estimate: 2300, exact: 2318 }))).toBe('300 loaded of 2,318');
    expect(rowsLabel(st({ rows: rows(300), estimate: 120 }))).toBe('300 loaded');
    expect(rowsLabel(st({ rows: rows(300), estimate: null }))).toBe('300 loaded');
    expect(rowsLabel(st({ rows: rows(300), exact: 300 }))).toBe('all 300 loaded');
  });

  test('one row reads as one; a problem leaves the label empty (the grid says it)', () => {
    expect(rowsLabel(st({ rows: rows(1), more: 'end' }))).toBe('1 row');
    expect(rowsLabel(st({ rows: [], data: null, problem: { kind: 'other', message: 'x' } }))).toBe('');
  });
});

describe('a tab closed and opened again', () => {
  test('never takes the old tab\'s replies: run ids only go up, so pages stay contiguous', async () => {
    // The old tab: its first page in, its next fetch out when the tab closes (its state dropped).
    await loadFirst(KEY);
    const oldMore = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(oldMore.promise);
    const m = loadMore(KEY);
    const oldFirst = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(oldFirst.promise);
    const f = loadFirst(KEY);
    useDb.getState().dropTab(KEY);
    // Opened again: a new first fetch and its next one.
    const newFirst = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(newFirst.promise);
    const g = loadFirst(KEY);
    oldFirst.resolve(ok(page(100, 5000)));
    await f;
    newFirst.resolve(ok(page(100)));
    await g;
    expect(ids(tab())[0]).toBe('1');
    const newMore = deferred<DbResult<DbPage>>();
    api.page.mockReturnValueOnce(newMore.promise);
    const n = loadMore(KEY);
    oldMore.resolve(ok(page(100, 100)));
    await m;
    newMore.resolve(ok(page(100, 100)));
    await n;
    api.page.mockResolvedValueOnce(ok(page(100, 200)));
    await loadMore(KEY);
    const got = ids(tab());
    expect(new Set(got).size).toBe(got.length);
    expect(got).toEqual(Array.from({ length: 300 }, (_, i) => String(i + 1)));
    expect(pageCalls().slice(-2).map((r) => r.page)).toEqual([1, 2]);
  });

  test('an old count or estimate never lands on the tab opened again', async () => {
    await loadFirst(KEY);
    const oldCount = deferred<DbResult<number>>();
    api.count.mockReturnValueOnce(oldCount.promise);
    const c = countExactly(KEY);
    const oldEst = deferred<DbResult<number | null>>();
    api.page.mockResolvedValueOnce(ok(page(100)));
    api.estimate.mockReturnValueOnce(oldEst.promise);
    const f = loadFirst(KEY);
    await vi.waitFor(() => expect(api.estimate).toHaveBeenCalledTimes(2));
    useDb.getState().dropTab(KEY);
    api.estimate.mockResolvedValueOnce(ok(40));
    await loadFirst(KEY);
    oldCount.resolve(ok(999));
    oldEst.resolve(ok(888));
    await c;
    await f;
    expect(tab().exact).toBeNull();
    expect(tab().estimate).toBe(40);
  });
});

describe('a read the user causes on a connection main holds', () => {
  const OTHER = 'cffffffffffff';
  const viewOf = (id: string, held: boolean): DbConnView => ({ conn: { id } as DbConnection, state: 'idle', problem: null, server: null, hasPassword: false, provider: null, held });
  /** Main's snapshot with these connections held (an explicit Disconnect, in this window or another). */
  const holding = (...held: string[]) => useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: [C, OTHER].map((id) => viewOf(id, held.includes(id))) } });

  test('the hold is main\'s, one truth for every window: heldIn and isHeld read DbConnView.held, nothing else', () => {
    holding(OTHER);
    expect(heldIn(useDb.getState().snap, OTHER)).toBe(true);
    expect(heldIn(useDb.getState().snap, C)).toBe(false);
    expect(isHeld(OTHER)).toBe(true);
    expect(isHeld('cnotlisted000')).toBe(false);
    expect('disconnected' in useDb.getState()).toBe(false);
  });

  test('connects it first — first fetch, next fetch, count —, then reads; main lets the hold go (its snapshot comes before the reply)', async () => {
    const order: string[] = [];
    api.connect.mockImplementation(async (id: string) => { order.push(`connect ${id}`); holding(); return ok(SERVER); });
    api.page.mockImplementation(async () => { order.push('page'); return ok(page(100)); });
    api.count.mockImplementation(async () => { order.push('count'); return ok(7); });
    holding(C, OTHER);
    await loadFirst(KEY);
    expect(order).toEqual([`connect ${C}`, 'page']);
    holding(C);
    await loadMore(KEY);
    holding(C);
    await countExactly(KEY);
    expect(order).toEqual([`connect ${C}`, 'page', `connect ${C}`, 'page', `connect ${C}`, 'count']);
  });

  test('not held: no connect, the read goes alone (main connects on demand)', async () => {
    holding(OTHER);
    await loadFirst(KEY);
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.page).toHaveBeenCalledTimes(1);
  });

  test('a read the app makes by itself — the estimate after a page, the probe past 10,000 rows — never connects a held connection; main\'s "held" answer is dropped quietly', async () => {
    holding();
    useDb.getState().patchTab(KEY, { estimate: 999 });
    // The user disconnects while the page is on its way back: the estimate that follows is no read of theirs.
    api.page.mockImplementationOnce(async () => { holding(C); return ok(page(100)); });
    api.estimate.mockResolvedValueOnce(bad({ kind: 'held', message: 'Disconnected' }));
    await loadFirst(KEY);
    expect(api.estimate).toHaveBeenCalledTimes(1);
    expect(api.connect).not.toHaveBeenCalled();
    expect(tab().estimate).toBe(999);
    expect(tab().problem).toBeNull();
    expect(useApp.getState().showToast).not.toHaveBeenCalled();
    // The probe: their scroll fetched the rows (connecting first), the probe after them is the app's.
    holding();
    setSize('500');
    api.page.mockResolvedValueOnce(ok(page(500)));
    await loadFirst(KEY);
    useDb.getState().patchTab(KEY, { rows: page(9500).rows });
    api.page.mockImplementationOnce(async () => { holding(C); return ok(page(500, 9500)); }).mockResolvedValueOnce(bad({ kind: 'held', message: 'Disconnected' }));
    await loadMore(KEY);
    expect(api.connect).not.toHaveBeenCalled();
    expect(tab().more).toBe('cap');
    expect(tab().moreProblem).toBeNull();
  });

  test('a connect that fails answers for the read: nothing sent behind it (one attempt), the tab says why', async () => {
    holding(C);
    api.connect.mockResolvedValueOnce(bad({ kind: 'password', message: 'Password needed' }));
    await loadFirst(KEY);
    expect(api.page).not.toHaveBeenCalled();
    expect(tab().problem).toEqual({ kind: 'password', message: 'Password needed' });
    api.connect.mockRejectedValueOnce(new Error('ipc'));
    await loadFirst(KEY);
    expect(api.page).not.toHaveBeenCalled();
    expect(tab().problem?.kind).toBe('other');
  });
});

describe('the values budget', () => {
  const big = 'x'.repeat(65_536);
  const heavy = (n: number, from = 0): DbPage => ({ ...page(n, from), rows: Array.from({ length: n }, (_, i) => [{ v: String(from + i + 1) }, { v: big }]) });

  test('valueBytes: the cells\' text as UTF-16 (2 bytes a character), NULLs free', () => {
    expect(valueBytes([[{ v: 'ab' }, { v: null }], [{ v: 'c' }, { v: '' }]])).toBe(6);
    expect(MAX_LOADED_BYTES).toBe(64 * 1024 * 1024);
  });

  test('a page of large cells hits 64 MB before 10,000 rows: the cap, its own message, nothing more asked', async () => {
    api.page.mockResolvedValueOnce(ok(heavy(100)));
    await loadFirst(KEY);
    for (let i = 1; i < 6; i++) {
      api.page.mockResolvedValueOnce(ok(heavy(100, i * 100)));
      await loadMore(KEY);
    }
    // 100 rows × 64 Ki characters × 2 bytes = 12.5 MiB a fetch: the sixth crosses 64 MiB.
    expect(tab().rows).toHaveLength(600);
    expect(tab().more).toBe('cap');
    const calls = api.page.mock.calls.length;
    await loadMore(KEY);
    expect(api.page).toHaveBeenCalledTimes(calls);
    expect(capMessage(600)).toBe('600 rows loaded (64 MB of values). Add a filter or choose fewer columns to see others.');
    expect(capMessage(MAX_LOADED_ROWS)).toBe('10,000 rows loaded. Add a filter or a sort to see others.');
  });

  test('a short fetch is the end even past the budget: every row is here', async () => {
    api.page.mockResolvedValueOnce(ok(heavy(100)));
    await loadFirst(KEY);
    useDb.getState().patchTab(KEY, { rows: heavy(500).rows });
    api.page.mockResolvedValueOnce(ok(heavy(30, 500)));
    await loadMore(KEY);
    expect(tab().more).toBe('end');
  });
});

describe('the probe at 10,000 rows', () => {
  async function toCap(): Promise<void> {
    setSize('500');
    api.page.mockResolvedValueOnce(ok(page(500)));
    await loadFirst(KEY);
    useDb.getState().patchTab(KEY, { rows: page(9500).rows });
  }

  test('nothing past row 10,000: the end, all of them loaded (an exact label)', async () => {
    await toCap();
    api.page.mockResolvedValueOnce(ok(page(500, 9500))).mockResolvedValueOnce(ok(page(0)));
    await loadMore(KEY);
    expect(pageCalls().at(-1)).toMatchObject({ page: 200, size: 50 });
    expect(tab().rows).toHaveLength(MAX_LOADED_ROWS);
    expect(tab().more).toBe('end');
    expect(rowsLabel(tab())).toBe('all 10,000 loaded');
  });

  test('more past it: the cap; a probe that fails says cap too', async () => {
    await toCap();
    api.page.mockResolvedValueOnce(ok(page(500, 9500))).mockResolvedValueOnce(ok(page(3, 10_000)));
    await loadMore(KEY);
    expect(tab().more).toBe('cap');
    expect(tab().rows).toHaveLength(MAX_LOADED_ROWS);
    await toCap();
    api.page.mockResolvedValueOnce(ok(page(500, 9500))).mockResolvedValueOnce(bad({ kind: 'canceled', message: 'Stopped after 15 s' }));
    await loadMore(KEY);
    expect(tab().more).toBe('cap');
    expect(tab().moreProblem).toBeNull();
  });

  test('while the probe is out the rows are shown and the bottom row still loads', async () => {
    await toCap();
    const probe = deferred<DbResult<DbPage>>();
    api.page.mockResolvedValueOnce(ok(page(500, 9500))).mockReturnValueOnce(probe.promise);
    const m = loadMore(KEY);
    await vi.waitFor(() => expect(api.page).toHaveBeenCalledTimes(3));
    expect(tab().rows).toHaveLength(MAX_LOADED_ROWS);
    expect(tab().more).toBe('loading');
    probe.resolve(ok(page(0)));
    await m;
    expect(tab().more).toBe('end');
  });
});

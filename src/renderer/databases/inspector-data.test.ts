import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DbFk, DbPage, DbPeek, DbProblem, DbRefCount, DbRelations, DbResult } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { useApp } from '../store';
import { loadFirst } from './data';
import { canOpenReferenced, forgetReads, openReferenced, readFull, readMore, readPeek, readRefs, readRels, readsGen, rowReads, useInsp } from './inspector-data';
import { useDb } from './store';
import type { DbTabRef } from './tabs';

// The row inspector's reads: cached per (tab, row key), dropped when a new first page
// lands (a reload), a reply for an older read dropped (monotonic ids, as data.ts), each section's failure its own.

const C = 'c0123456789ab';
const KEY = `db:${C}/public/orders`;
const REF: DbTabRef = { key: KEY as DbTabRef['key'], connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'data' };
const NAMES = { connId: C, schema: 'public', name: 'orders' };
const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const ID = col('id', 'int8', 'N', { isPk: true, isKey: true, nullable: false });
const CUSTOMER = col('customer_id', 'int8', 'N', { isKey: true, fk: { schema: 'public', table: 'customers', column: 'id' } });
const FK: DbFk = { name: 'orders_customer_id_fkey', from: { schema: 'public', table: 'orders', columns: ['customer_id'] }, to: { schema: 'public', table: 'customers', columns: ['id'] }, indexed: true };
const page = (): DbPage => ({ columns: [ID, CUSTOMER], hidden: [], derived: [], rows: [[{ v: '1' }, { v: '2041' }]], ms: 1, sql: '', pk: ['id'], rowKey: ['id'], kind: 'table' });
const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const bad = (problem: DbProblem): DbResult<never> => ({ ok: false, problem });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let api: Record<string, ReturnType<typeof vi.fn>>;
const REFS: DbRefCount[] = [{ fk: { ...FK, name: 'items', from: { schema: 'public', table: 'order_items', columns: ['order_id'] }, to: { schema: 'public', table: 'orders', columns: ['id'] } }, count: 3 }];
const PEEK: DbPeek = { columns: [ID, col('name', 'text', 'S')], row: [{ v: '2041' }, { v: 'Mara Lindqvist' }] };
const RELS: DbRelations = { out: [FK], in: [] };

beforeEach(() => {
  api = {
    refs: vi.fn(async () => ok(REFS)), peek: vi.fn(async () => ok(PEEK)), relations: vi.fn(async () => ok(RELS)), full: vi.fn(async () => ok('x'.repeat(100_000))),
    page: vi.fn(async () => ok(page())), estimate: vi.fn(async () => ok(10))
  };
  vi.stubGlobal('window', { atelier: { databases: api } });
  useApp.setState({ dbTabs: [REF], showToast: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useInsp.setState(useInsp.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
});

const refsReq = { ref: NAMES, key: { id: '1', customer_id: '2041' } };

describe('cached per (tab, row key)', () => {
  test('a row read once: shown again (↑ then ↓), nothing more asked; another row asks for itself', async () => {
    await readRefs(KEY, '{"id":"1"}', refsReq);
    expect(rowReads(KEY, '{"id":"1"}')?.refs).toMatchObject({ s: 'ok', v: REFS });
    await readRefs(KEY, '{"id":"1"}', refsReq);
    expect(api.refs).toHaveBeenCalledTimes(1);
    expect(api.refs).toHaveBeenCalledWith(refsReq);
    await readRefs(KEY, '{"id":"2"}', { ...refsReq, key: { id: '2', customer_id: null } });
    expect(api.refs).toHaveBeenCalledTimes(2);
    // Another tab has its own.
    await readRefs('db:other', '{"id":"1"}', refsReq);
    expect(api.refs).toHaveBeenCalledTimes(3);
  });

  test('one read in flight at a time per section: asking again while it waits asks nothing, it waits on that read', async () => {
    const d = deferred<DbResult<DbRefCount[]>>();
    api.refs!.mockReturnValueOnce(d.promise);
    const first = readRefs(KEY, 'r1', refsReq);
    expect(rowReads(KEY, 'r1')?.refs?.s).toBe('wait');
    const second = readRefs(KEY, 'r1', refsReq);
    expect(api.refs).toHaveBeenCalledTimes(1);
    d.resolve(ok(REFS));
    expect(await second).toMatchObject({ s: 'ok', v: REFS });
    await first;
    expect(rowReads(KEY, 'r1')?.refs?.s).toBe('ok');
  });

  test('the table\'s foreign keys: once per tab, whatever the row', async () => {
    await readRels(KEY, NAMES);
    await readRels(KEY, NAMES);
    expect(api.relations).toHaveBeenCalledTimes(1);
    expect(api.relations).toHaveBeenCalledWith(NAMES);
    expect(useInsp.getState().tabs[KEY]?.rels).toMatchObject({ s: 'ok', v: RELS });
  });
});

describe('dropped on reload, stale replies dropped', () => {
  test('a new first page drops every read of the tab (data.ts loadFirst); a reply for the old page lands nowhere', async () => {
    const d = deferred<DbResult<DbRefCount[]>>();
    api.refs!.mockReturnValueOnce(d.promise);
    await readPeek(KEY, 'r1', FK.name, { ref: { connId: C, schema: 'public', name: 'customers' }, cols: ['id'], values: ['2041'] });
    const pending = readRefs(KEY, 'r1', refsReq);
    await loadFirst(KEY);
    expect(useInsp.getState().tabs[KEY]?.rows ?? {}).toEqual({});
    d.resolve(ok(REFS));
    await pending;
    expect(rowReads(KEY, 'r1')).toBeUndefined();
    // Read again from scratch.
    await readRefs(KEY, 'r1', refsReq);
    expect(api.refs).toHaveBeenCalledTimes(2);
  });

  test('Retry: a newer read wins, the older reply is dropped whenever it comes', async () => {
    const first = deferred<DbResult<DbRefCount[]>>();
    api.refs!.mockReturnValueOnce(first.promise).mockResolvedValueOnce(bad({ kind: 'canceled', message: 'slow' }));
    const a = readRefs(KEY, 'r1', refsReq);
    await readRefs(KEY, 'r1', refsReq, true);
    expect(rowReads(KEY, 'r1')?.refs).toMatchObject({ s: 'err', p: { message: 'slow' } });
    first.resolve(ok(REFS));
    await a;
    expect(rowReads(KEY, 'r1')?.refs).toMatchObject({ s: 'err' });
  });

  test('forgetReads (the tab closed): its reads go', async () => {
    await readRefs(KEY, 'r1', refsReq);
    forgetReads(KEY);
    expect(useInsp.getState().tabs[KEY]).toBeUndefined();
  });

  test('every new first page is a new generation of reads — what the inspector\'s reads wait on, even when nothing was read in between', async () => {
    const before = readsGen(KEY)(useInsp.getState());
    await loadFirst(KEY);
    const first = readsGen(KEY)(useInsp.getState());
    expect(first).not.toBe(before);
    await loadFirst(KEY);
    expect(readsGen(KEY)(useInsp.getState())).not.toBe(first);
    // The same row of the new page is read again.
    await readMore(KEY, 'r1', { ref: NAMES, cols: ['id'], values: ['1'] });
    await loadFirst(KEY);
    await readMore(KEY, 'r1', { ref: NAMES, cols: ['id'], values: ['1'] });
    expect(api.peek).toHaveBeenCalledTimes(2);
  });
});

describe('Load full value keeps the last 3 values of a tab', () => {
  test('a 4th drops the oldest; a new first page drops them all', async () => {
    const req = (row: string) => ({ ref: NAMES, key: { id: row }, column: 'notes' });
    for (const r of ['1', '2', '3', '4']) await readFull(KEY, r, 'notes', req(r));
    expect(rowReads(KEY, '1')?.full.notes).toBeUndefined();
    for (const r of ['2', '3', '4']) expect(rowReads(KEY, r)?.full.notes?.s).toBe('ok');
    // Read again: the most recent one now; 2 is the oldest.
    await readFull(KEY, '1', 'notes', req('1'));
    expect(rowReads(KEY, '2')?.full.notes).toBeUndefined();
    expect(rowReads(KEY, '1')?.full.notes?.s).toBe('ok');
    await loadFirst(KEY);
    expect(rowReads(KEY, '1')).toBeUndefined();
  });
});

describe('each section\'s failure is its own (never a global error)', () => {
  test('Referenced by failing leaves the peek as it is; a failed section is kept until Retry', async () => {
    api.refs!.mockResolvedValueOnce(bad({ kind: 'lost', message: 'The connection was lost' }));
    await readPeek(KEY, 'r1', FK.name, { ref: { connId: C, schema: 'public', name: 'customers' }, cols: ['id'], values: ['2041'] });
    await readRefs(KEY, 'r1', refsReq);
    const r = rowReads(KEY, 'r1')!;
    expect(r.refs).toMatchObject({ s: 'err', p: { kind: 'lost' } });
    expect(r.peeks[FK.name]).toMatchObject({ s: 'ok', v: PEEK });
    await readRefs(KEY, 'r1', refsReq);
    expect(api.refs).toHaveBeenCalledTimes(1);
    await readRefs(KEY, 'r1', refsReq, true);
    expect(api.refs).toHaveBeenCalledTimes(2);
    expect(rowReads(KEY, 'r1')?.refs?.s).toBe('ok');
  });

  test('a call that never reached main answers as a problem: nothing waits forever', async () => {
    api.peek!.mockRejectedValueOnce(new Error('ipc'));
    await readMore(KEY, 'r1', { ref: NAMES, cols: ['id'], values: ['1'] });
    expect(rowReads(KEY, 'r1')?.more).toMatchObject({ s: 'err' });
  });

  test('Load full value: by the row\'s key and the column, its text kept for the row', async () => {
    const req = { ref: NAMES, key: { id: '1' }, column: 'notes' };
    const r = await readFull(KEY, 'r1', 'notes', req);
    expect(api.full).toHaveBeenCalledWith(req);
    expect(r).toMatchObject({ s: 'ok' });
    expect(rowReads(KEY, 'r1')?.full.notes).toMatchObject({ s: 'ok' });
  });
});

describe('Open Referenced Row (the cell menu)', () => {
  test('reads the table\'s foreign keys, then opens the referenced table as a preview filtered on the key, its first row selected', async () => {
    const open = vi.fn();
    useApp.setState({ openDbTab: open });
    await openReferenced(KEY, NAMES, page(), [{ v: '1' }, { v: '2041' }], 'customer_id');
    expect(open).toHaveBeenCalledWith(
      { connId: C, schema: 'public', name: 'customers', kind: 'table', view: 'data' },
      { preview: true, filters: [{ column: 'id', op: 'eq', values: ['2041'] }] }
    );
  });

  test('the foreign keys still being read — the open waits for them, then happens', async () => {
    const open = vi.fn();
    useApp.setState({ openDbTab: open });
    const d = deferred<DbResult<DbRelations>>();
    api.relations!.mockReturnValueOnce(d.promise);
    const first = readRels(KEY, NAMES);
    const opening = openReferenced(KEY, NAMES, page(), [{ v: '1' }, { v: '2041' }], 'customer_id');
    expect(open).not.toHaveBeenCalled();
    d.resolve(ok(RELS));
    await first;
    await opening;
    expect(open).toHaveBeenCalledTimes(1);
    expect(api.relations).toHaveBeenCalledTimes(1);
  });

  test('the cell menu offers it only when a filter can name the key (known foreign keys exactly; else this column alone)', async () => {
    const fields = [{ v: '1' }, { v: '2041' }];
    expect(canOpenReferenced(KEY, page(), fields, 'customer_id')).toBe(true);
    expect(canOpenReferenced(KEY, page(), [{ v: '1' }, { v: null }], 'customer_id')).toBe(false);
    expect(canOpenReferenced(KEY, page(), [{ v: '1' }, { v: '9'.repeat(10_001) }], 'customer_id')).toBe(false);
    expect(canOpenReferenced(KEY, page(), fields, 'id')).toBe(false);
    // Known: a composite key needs all its columns.
    const ITEM: DbFk = { name: 'item', from: { schema: 'public', table: 'orders', columns: ['customer_id', 'id'] }, to: { schema: 'public', table: 'x', columns: ['a', 'b'] }, indexed: true };
    api.relations!.mockResolvedValueOnce(ok({ out: [ITEM], in: [] }));
    await readRels(KEY, NAMES);
    expect(canOpenReferenced(KEY, page(), fields, 'customer_id')).toBe(true);
    expect(canOpenReferenced(KEY, page(), [{ v: null }, { v: '2041' }], 'customer_id')).toBe(false);
  });

  test('a NULL foreign key: nothing to open', async () => {
    const open = vi.fn();
    useApp.setState({ openDbTab: open });
    await openReferenced(KEY, NAMES, page(), [{ v: '1' }, { v: null }], 'customer_id');
    expect(open).not.toHaveBeenCalled();
  });

  test('a composite key opens on every column of it (item_notes → order_items)', async () => {
    const open = vi.fn();
    useApp.setState({ openDbTab: open });
    const ITEM: DbFk = { name: 'item_notes_item_fkey', from: { schema: 'public', table: 'item_notes', columns: ['item_line', 'item_order'] }, to: { schema: 'public', table: 'order_items', columns: ['line', 'order_id'] }, indexed: true };
    api.relations!.mockResolvedValueOnce(ok({ out: [ITEM], in: [] }));
    const cols = [col('id', 'int4', 'N', { isPk: true }), col('item_line', 'int4', 'N', { fk: { schema: 'public', table: 'order_items', column: 'line' } }), col('item_order', 'int8', 'N', { fk: { schema: 'public', table: 'order_items', column: 'order_id' } })];
    const notes = { connId: C, schema: 'public', name: 'item_notes' };
    await openReferenced('db:notes', notes, { columns: cols }, [{ v: '9' }, { v: '2' }, { v: '1' }], 'item_order');
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ name: 'order_items' }), {
      preview: true, filters: [{ column: 'line', op: 'eq', values: ['2'] }, { column: 'order_id', op: 'eq', values: ['1'] }]
    });
  });

  test('the foreign keys can\'t be read: said, nothing opened', async () => {
    const open = vi.fn();
    const showToast = vi.fn();
    useApp.setState({ openDbTab: open, showToast });
    api.relations!.mockResolvedValueOnce(bad({ kind: 'denied', message: 'This role can’t read pg_constraint' }));
    await openReferenced(KEY, NAMES, page(), [{ v: '1' }, { v: '2041' }], 'customer_id');
    expect(open).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('This role can’t read pg_constraint');
  });
});

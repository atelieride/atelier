import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbConnection, type DbProblem, type DbRelations, type DbResult, type DbStructure } from '@shared/databases';
import { useApp } from '../store';
import { useDb } from './store';
import { forgetStruct, partsOf, readPart, refreshFor, refreshView, showView, useStruct, viewAt, viewMissing, wireStructure } from './structure-data';
import type { DbTabRef } from './tabs';

// A table tab's Structure and Relations reads: what each view reads, once per
// tab — shown again, nothing asked —, Refresh (⌘R) reading the visible view again, a reply for an older read dropped,
// each part's failure its own (Retry, and read again when the connection comes back), dropped with the tab.

const C = 'c0123456789ab';
const KEY = `db:${C}/public/orders`;
const TAB: DbTabRef = { key: KEY as DbTabRef['key'], connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'structure' };
const NAMES = { connId: C, schema: 'public', name: 'orders' };
const ok = <T>(value: T): DbResult<T> => ({ ok: true, value });
const bad = (problem: DbProblem): DbResult<never> => ({ ok: false, problem });
const STRUCT = { schema: 'public', name: 'orders', kind: 'matview' } as DbStructure;
const RELS: DbRelations = { out: [], in: [] };
const DDL = 'CREATE TABLE public.orders ();\n';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

type Fn = ReturnType<typeof vi.fn>;
let api: { structure: Fn; relations: Fn; ddl: Fn; page: Fn; connect: Fn };
/** Main's snapshot: the connection held by an explicit Disconnect, or not. */
const holding = (held: boolean) => useDb.setState({
  snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ conn: { id: C } as DbConnection, state: 'idle', problem: null, server: null, hasPassword: false, provider: null, held }] }
});
beforeEach(() => {
  api = {
    structure: vi.fn(async () => ok(STRUCT)), relations: vi.fn(async () => ok(RELS)), ddl: vi.fn(async () => ok(DDL)), page: vi.fn(),
    connect: vi.fn(async () => { holding(false); return ok({}); })
  };
  vi.stubGlobal('window', { atelier: { databases: api } });
  useApp.setState({ dbTabs: [{ ...TAB, kind: 'table' }] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useStruct.setState(useStruct.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
});
const part = (p: 'structure' | 'relations' | 'ddl') => useStruct.getState().tabs[KEY]?.[p];

describe('what each view reads', () => {
  test('Structure: the structure, the relations (its card) and the DDL; Relations: the relations; Data: none of them', () => {
    expect(partsOf('structure')).toEqual(['structure', 'relations', 'ddl']);
    expect(partsOf('relations')).toEqual(['relations']);
    expect(partsOf('data')).toEqual([]);
  });

  test('shown: each part read once, by the table\'s names only (main\'s schema is strict); shown again, nothing asked', async () => {
    showView(KEY, TAB, 'structure', { back: false });
    await settle();
    expect(api.structure).toHaveBeenCalledWith(NAMES);
    expect(api.relations).toHaveBeenCalledWith(NAMES);
    expect(api.ddl).toHaveBeenCalledWith(NAMES);
    expect(part('structure')).toMatchObject({ loading: false, v: STRUCT });
    expect(part('ddl')).toMatchObject({ loading: false, v: DDL });
    expect(part('ddl')!.at).toBeGreaterThan(0);
    showView(KEY, TAB, 'structure', { back: false });
    showView(KEY, TAB, 'relations', { back: false });
    await settle();
    for (const f of [api.structure, api.relations, api.ddl]) expect(f).toHaveBeenCalledTimes(1);
    expect(api.page).not.toHaveBeenCalled();
  });

  test('Relations shown first reads only the relations; Structure later reads the rest', async () => {
    showView(KEY, TAB, 'relations', { back: false });
    await settle();
    expect(api.relations).toHaveBeenCalledTimes(1);
    expect(api.structure).not.toHaveBeenCalled();
    showView(KEY, TAB, 'structure', { back: false });
    await settle();
    expect(api.relations).toHaveBeenCalledTimes(1);
    expect(api.structure).toHaveBeenCalledTimes(1);
    expect(api.ddl).toHaveBeenCalledTimes(1);
  });

  test('the structure corrects a restored tab\'s kind', async () => {
    await readPart(KEY, TAB, 'structure');
    expect(useApp.getState().dbTabs[0]!.kind).toBe('matview');
  });
});

describe('Refresh (⌘R) reads the visible view again', () => {
  test('Structure: its three parts again, the old ones shown meanwhile; Relations: only the relations', async () => {
    showView(KEY, TAB, 'structure', { back: false });
    await settle();
    const next = deferred<DbResult<DbStructure>>();
    api.structure.mockImplementationOnce(() => next.promise);
    refreshView(KEY, TAB, 'structure');
    expect(part('structure')).toMatchObject({ loading: true, v: STRUCT });
    const fresh = { ...STRUCT, comment: 'fresh' };
    next.resolve(ok(fresh));
    await settle();
    expect(part('structure')).toMatchObject({ loading: false, v: fresh });
    for (const f of [api.structure, api.relations, api.ddl]) expect(f).toHaveBeenCalledTimes(2);
    refreshView(KEY, TAB, 'relations');
    await settle();
    expect(api.relations).toHaveBeenCalledTimes(3);
    expect(api.structure).toHaveBeenCalledTimes(2);
    expect(api.ddl).toHaveBeenCalledTimes(2);
    // Data's Refresh is the rows' (TableView): nothing of these.
    refreshView(KEY, TAB, 'data');
    await settle();
    expect(api.relations).toHaveBeenCalledTimes(3);
  });

  test('a part still being read isn\'t asked twice (⌘R pressed again, the button clicked twice); once back, Refresh reads it', async () => {
    const slow = deferred<DbResult<DbStructure>>();
    api.structure.mockImplementationOnce(() => slow.promise);
    showView(KEY, TAB, 'structure', { back: false });
    await settle();
    // The relations and the DDL are back, the structure still on its way: two Refreshes read those two once more.
    refreshView(KEY, TAB, 'structure');
    refreshView(KEY, TAB, 'structure');
    expect(api.structure).toHaveBeenCalledTimes(1);
    expect(api.relations).toHaveBeenCalledTimes(2);
    expect(api.ddl).toHaveBeenCalledTimes(2);
    slow.resolve(ok(STRUCT));
    await settle();
    refreshView(KEY, TAB, 'structure');
    expect(api.structure).toHaveBeenCalledTimes(2);
  });

  test('refreshFor: Structure and Relations read what they show again (true); Data\'s Refresh is the rows\' (false, nothing read here)', async () => {
    expect(refreshFor(KEY, TAB, 'relations')).toBe(true);
    expect(refreshFor(KEY, TAB, 'data')).toBe(false);
    await settle();
    expect(api.relations).toHaveBeenCalledTimes(1);
    expect(api.structure).not.toHaveBeenCalled();
    expect(refreshFor(KEY, TAB, 'structure')).toBe(true);
    await settle();
    expect(api.structure).toHaveBeenCalledTimes(1);
    expect(api.page).not.toHaveBeenCalled();
  });

  test('a reply for an older read is dropped: the newer read wins whatever order they come back in', async () => {
    const first = deferred<DbResult<string>>();
    const second = deferred<DbResult<string>>();
    api.ddl.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    void readPart(KEY, TAB, 'ddl', true);
    void readPart(KEY, TAB, 'ddl', true);
    second.resolve(ok('new'));
    await settle();
    first.resolve(ok('old'));
    await settle();
    expect(part('ddl')).toMatchObject({ loading: false, v: 'new' });
  });
});

describe('failures, each in its place', () => {
  const denied: DbProblem = { kind: 'denied', message: 'This role can\'t read public.orders', code: '42501' };

  test('one part fails, the others show; shown again it isn\'t read again (Retry is the user\'s), a Retry reads it', async () => {
    api.ddl.mockResolvedValueOnce(bad(denied));
    showView(KEY, TAB, 'structure', { back: false });
    await settle();
    expect(part('ddl')).toEqual({ id: expect.any(Number), loading: false, p: denied });
    expect(part('structure')).toMatchObject({ v: STRUCT });
    showView(KEY, TAB, 'structure', { back: false });
    await settle();
    expect(api.ddl).toHaveBeenCalledTimes(1);
    await readPart(KEY, TAB, 'ddl', true);
    expect(part('ddl')).toMatchObject({ loading: false, v: DDL });
    expect(part('ddl')!.p).toBeUndefined();
  });

  test('the connection back (a password typed, the server up): the failed parts read again, the others not', async () => {
    api.structure.mockResolvedValueOnce(bad({ kind: 'refused', message: 'Can\'t connect' }));
    showView(KEY, TAB, 'structure', { back: false });
    await settle();
    showView(KEY, TAB, 'structure', { back: true });
    await settle();
    expect(api.structure).toHaveBeenCalledTimes(2);
    expect(api.relations).toHaveBeenCalledTimes(1);
    expect(part('structure')).toMatchObject({ v: STRUCT });
  });

  test('a call that never reached main: a problem in its place, never a stuck wait', async () => {
    api.relations.mockRejectedValueOnce(new Error('ipc'));
    await readPart(KEY, TAB, 'relations');
    expect(part('relations')).toMatchObject({ loading: false, p: { kind: 'other', message: 'Couldn’t read the table' } });
  });

  test('a read is theirs to cause: on a connection main holds it connects first, then reads (as Data\'s reads)', async () => {
    holding(true);
    await readPart(KEY, TAB, 'relations');
    expect(api.connect).toHaveBeenCalledWith(C);
    expect(api.connect.mock.invocationCallOrder[0]).toBeLessThan(api.relations.mock.invocationCallOrder[0]!);
    expect(part('relations')).toMatchObject({ v: RELS });
  });

  test('a part main answered "held" (another window disconnected it meanwhile) is not kept: the view stays missing — the Disconnected card, never an error', async () => {
    api.relations.mockResolvedValueOnce(bad({ kind: 'held', message: 'Disconnected' }));
    await readPart(KEY, TAB, 'relations');
    expect(part('relations')).toBeUndefined();
    expect(viewMissing(useStruct.getState().tabs[KEY], 'relations')).toBe(true);
  });
});

describe('wireStructure: TableView\'s effect as one step (what it calls whenever its inputs change)', () => {
  const on = { visible: true, view: 'structure', ready: true, held: false, connState: 'connected' } as const;
  const none = { back: false, conn: 'connected' } as const;
  const calls = () => [api.structure.mock.calls.length, api.relations.mock.calls.length, api.ddl.mock.calls.length];

  test('shown — in front, on Structure or Relations, its connection known, not held — the view reads; otherwise nothing', async () => {
    let w = wireStructure(KEY, TAB, none, { ...on, visible: false });
    w = wireStructure(KEY, TAB, w, { ...on, view: 'data' });
    w = wireStructure(KEY, TAB, w, { ...on, ready: false });
    w = wireStructure(KEY, TAB, w, { ...on, held: true });
    await settle();
    expect(calls()).toEqual([0, 0, 0]);
    w = wireStructure(KEY, TAB, w, { ...on, view: 'relations' });
    await settle();
    expect(calls()).toEqual([0, 1, 0]);
    wireStructure(KEY, TAB, w, on);
    await settle();
    expect(calls()).toEqual([1, 1, 1]);
  });

  test('held: nothing read by itself; main lets the hold go (their Connect) and the view reads, connecting nothing more', async () => {
    holding(true);
    const w = wireStructure(KEY, TAB, none, { ...on, held: true });
    await settle();
    expect(calls()).toEqual([0, 0, 0]);
    holding(false);
    wireStructure(KEY, TAB, w, on);
    await settle();
    expect(calls()).toEqual([1, 1, 1]);
    expect(api.connect).not.toHaveBeenCalled();
  });

  test('the connection back — even while the tab was hidden — reads the failed parts again once shown, the others not', async () => {
    api.structure.mockResolvedValueOnce(bad({ kind: 'refused', message: 'Can\'t connect' }));
    let w = wireStructure(KEY, TAB, none, on);
    await settle();
    w = wireStructure(KEY, TAB, w, { ...on, connState: 'error' });
    w = wireStructure(KEY, TAB, w, { ...on, visible: false, connState: 'error' });
    w = wireStructure(KEY, TAB, w, { ...on, visible: false, connState: 'connected' });
    await settle();
    expect(w.back).toBe(true);
    expect(calls()).toEqual([1, 1, 1]);
    w = wireStructure(KEY, TAB, w, on);
    await settle();
    expect(w.back).toBe(false);
    expect(calls()).toEqual([2, 1, 1]);
    expect(part('structure')).toMatchObject({ v: STRUCT });
  });
});

test('the tab closed: its reads go, a reply still on its way finds nothing to fill', async () => {
  const late = deferred<DbResult<DbRelations>>();
  api.relations.mockImplementationOnce(() => late.promise);
  void readPart(KEY, TAB, 'relations');
  forgetStruct(KEY);
  late.resolve(ok(RELS));
  await settle();
  expect(useStruct.getState().tabs[KEY]).toBeUndefined();
});

test('a view with a part never asked for (a held connection shows its Disconnected card then)', () => {
  expect(viewMissing(undefined, 'relations')).toBe(true);
  const t = { relations: { id: 1, loading: false, v: RELS, at: 1 } };
  expect(viewMissing(t, 'relations')).toBe(false);
  expect(viewMissing(t, 'structure')).toBe(true);
  // A failure was asked for: the view shows it with its Retry.
  expect(viewMissing({ ...t, structure: { id: 2, loading: false, p: { kind: 'other', message: 'x' } }, ddl: { id: 3, loading: true } }, 'structure')).toBe(false);
  expect(viewMissing(undefined, 'data')).toBe(false);
});

test('"Updated 12 s ago": the oldest part the view shows (none until each came back)', async () => {
  expect(viewAt(undefined, 'structure')).toBeNull();
  useStruct.setState({ tabs: { [KEY]: { structure: { id: 1, loading: false, v: STRUCT, at: 5000 }, relations: { id: 2, loading: false, v: RELS, at: 7000 } } } });
  expect(viewAt(useStruct.getState().tabs[KEY], 'relations')).toBe(7000);
  // The DDL not back yet: no time for Structure.
  expect(viewAt(useStruct.getState().tabs[KEY], 'structure')).toBeNull();
  useStruct.setState({ tabs: { [KEY]: { ...useStruct.getState().tabs[KEY], ddl: { id: 3, loading: false, v: DDL, at: 6000 } } } });
  expect(viewAt(useStruct.getState().tabs[KEY], 'structure')).toBe(5000);
});

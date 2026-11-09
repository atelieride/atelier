// The Databases view's IPC (src/main/databases/ipc.ts) with a fake ipcMain and a fake
// hub: every channel checks the sender (a trusted app page of a project window) before it reads its input, parses the
// input strictly, and hands the hub the sender's webContents id first (the hub decides which connections it may use).
import { beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';

type Handler = (e: unknown, arg?: unknown) => unknown;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: Handler) => { handlers.set(channel, fn); } } }));

import { IPC, type AtelierApi } from '../../src/shared/api';
import { DB_CHANNELS, type DbHub } from '../../src/main/databases/hub';
import { installDbIpc, type DbIpcHub } from '../../src/main/databases/ipc';

/** window.atelier.databases' methods and the hub's: the same name (snapshot is the hub's snapshotFor). */
type Api = AtelierApi['databases'];
type HubOf<K extends keyof Api> = K extends 'snapshot' ? DbHub['snapshotFor'] : K extends keyof DbHub ? DbHub[K] : never;
type Reply<F> = F extends (...a: never[]) => infer R ? Awaited<R> : never;
/** A hub method's arguments after the sender's webContents id. */
type HubArgs<F> = F extends (wcId: number, ...a: infer A) => unknown ? A : never;

const ID = 'c0123456789ab';
const SUGGESTION = 's0123456789ab';
const ref = { connId: ID, schema: 'public', name: 'orders' };
const form = { name: 'acme_dev', engine: 'postgres', env: 'local', host: '127.0.0.1', port: 5432, database: 'acme_dev', user: 'acme', tls: 'prefer', ssh: null, scope: { kind: 'project', root: '/code/acme' } };
const pageReq = { ref, columns: [], derived: [], filters: [{ column: 'status', op: 'eq', values: ['paid'] }], sort: [{ column: 'id', dir: 'desc' }], page: 0, size: 100 };

/** Every channel, a valid argument for it, and the call the hub should get from window 1. */
const CALLS: [channel: string, arg: unknown, method: keyof DbIpcHub, args: unknown[]][] = [
  [IPC.dbSnapshot, undefined, 'snapshotFor', []],
  [IPC.dbSelect, ID, 'select', [ID]],
  [IPC.dbConnect, ID, 'connect', [ID]],
  [IPC.dbDisconnect, ID, 'disconnect', [ID]],
  [IPC.dbPassword, { connId: ID, password: 'pw', save: true }, 'password', [{ connId: ID, password: 'pw', save: true }]],
  [IPC.dbTest, { form, password: null, id: null }, 'test', [{ form, password: null, id: null }]],
  [IPC.dbSave, { form, password: 'pw', id: null }, 'save', [{ form, password: 'pw', id: null }]],
  [IPC.dbDuplicate, ID, 'duplicate', [ID]],
  [IPC.dbRemove, ID, 'remove', [ID]],
  [IPC.dbSetMask, { id: ID, on: true }, 'setMask', [ID, true]],
  [IPC.dbNoteWrite, ID, 'noteWrite', [ID]],
  [IPC.dbSetSchema, { id: ID, schema: 'billing' }, 'setSchema', [ID, 'billing']],
  [IPC.dbRefresh, undefined, 'refresh', []],
  [IPC.dbPage, pageReq, 'page', [pageReq]],
  [IPC.dbEstimate, { ref, filters: [] }, 'estimate', [{ ref, filters: [] }]],
  [IPC.dbCount, { ref, filters: [] }, 'count', [{ ref, filters: [] }]],
  [IPC.dbPeek, { ref, cols: ['id'], values: ['7'] }, 'peek', [{ ref, cols: ['id'], values: ['7'] }]],
  [IPC.dbRefs, { ref, key: { id: '7' } }, 'refs', [{ ref, key: { id: '7' } }]],
  [IPC.dbFull, { ref, key: { id: '7' }, column: 'doc', path: ['a', 0] }, 'full', [{ ref, key: { id: '7' }, column: 'doc', path: ['a', 0] }]],
  [IPC.dbStructure, ref, 'structure', [ref]],
  [IPC.dbRelations, ref, 'relations', [ref]],
  [IPC.dbDdl, ref, 'ddl', [ref]],
  [IPC.dbOverview, ID, 'overview', [ID]],
  [IPC.dbReadOnlySql, ID, 'readOnlySql', [ID]]
];

function fakeHub(): DbIpcHub & Record<string, ReturnType<typeof vi.fn>> {
  const methods = [...new Set(CALLS.map((c) => c[2]))];
  return Object.fromEntries(methods.map((m) => [m, vi.fn(() => ({ from: m }))])) as unknown as DbIpcHub & Record<string, ReturnType<typeof vi.fn>>;
}

// Window 1: a project window (trusted page); 2: the welcome window (no project).
const projects = new Map<number, string | null>([[1, '/code/acme'], [2, null]]);
const event = (wcId = 1, url = 'app://atelier/index.html') => ({ sender: { id: wcId }, senderFrame: { url } });
const call = (channel: string, arg: unknown, e: unknown = event()) => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return h(e, arg);
};

let hub: ReturnType<typeof fakeHub>;
beforeEach(() => {
  handlers.clear();
  hub = fakeHub();
  installDbIpc(hub, (id) => projects.get(id) ?? null, (e) => ((e as { senderFrame?: { url?: string } }).senderFrame?.url ?? '').startsWith('app://'));
});

describe('databases IPC', () => {
  test('one handler per db channel, and the snapshot event is the IPC one', () => {
    const channels = Object.entries(IPC).filter(([k]) => /^db[A-Z]/.test(k)).map(([, v]) => v);
    expect([...handlers.keys()].sort()).toEqual([...channels].sort());
    expect(CALLS.map((c) => c[0]).sort()).toEqual([...channels].sort());
    expect(IPC.evDatabases).toBe('ev:databases');
    expect(DB_CHANNELS.snapshot).toBe(IPC.evDatabases);
  });

  test("the API's arguments and replies are the hub's (checked by the typecheck)", () => {
    expectTypeOf<{ [K in keyof Api]: Reply<Api[K]> }>().toEqualTypeOf<{ [K in keyof Api]: Reply<HubOf<K>> }>();
    // setMask and setSchema's two values travel as one object ({ id, on }, { id, schema }) and reach the hub as two.
    expectTypeOf<{ [K in keyof Api]: Parameters<Api[K]> }>().toEqualTypeOf<{ [K in keyof Api]: HubArgs<HubOf<K>> }>();
  });

  test('a trusted project window reaches the hub with its own id first and the parsed input', async () => {
    for (const [channel, arg, method, args] of CALLS) {
      expect(await call(channel, arg), channel).toEqual({ from: method });
      expect(hub[method], channel).toHaveBeenLastCalledWith(1, ...args);
    }
    // Select none.
    await call(IPC.dbSelect, null);
    expect(hub.select).toHaveBeenLastCalledWith(1, null);
  });

  test('an untrusted sender (not an app page) is refused on every channel, before its input is read', () => {
    const bad = event(1, 'https://example.com/');
    for (const [channel, arg] of CALLS) expect(() => call(channel, arg, bad), channel).toThrow('unauthorized sender');
    // Not even parsed: malformed input from an untrusted sender gets the same refusal.
    expect(() => call(IPC.dbPage, 'garbage', bad)).toThrow('unauthorized sender');
    expect(() => call(IPC.dbPage, pageReq, { sender: { id: 1 } })).toThrow('unauthorized sender');
    for (const fn of Object.values(hub)) expect(fn).not.toHaveBeenCalled();
  });

  test('a window without a project (the welcome window) or an unknown one is refused', () => {
    for (const [channel, arg] of CALLS) {
      expect(() => call(channel, arg, event(2)), channel).toThrow('unauthorized sender');
      expect(() => call(channel, arg, event(99)), channel).toThrow('unauthorized sender');
    }
    for (const fn of Object.values(hub)) expect(fn).not.toHaveBeenCalled();
  });

  test('malformed input is refused before the hub sees it', () => {
    const bad: [string, unknown][] = [
      [IPC.dbSelect, 'c0123'], [IPC.dbSelect, undefined], [IPC.dbConnect, SUGGESTION], [IPC.dbDisconnect, { id: ID }],
      [IPC.dbPassword, { connId: ID, password: 'x'.repeat(1025), save: true }], [IPC.dbTest, { form: { ...form, password: 'pw' }, password: null, id: null }],
      // Nothing names a suggestion any more — a Test or a Save that tries is refused.
      [IPC.dbTest, { form, password: null, id: null, suggestion: SUGGESTION }], [IPC.dbSave, { form, password: null, id: null, suggestion: SUGGESTION }],
      [IPC.dbSave, { form, password: 'x'.repeat(1025), id: null }], [IPC.dbDuplicate, 'c0123456789AB'], [IPC.dbRemove, null],
      [IPC.dbSetMask, { id: ID, on: 1 }], [IPC.dbNoteWrite, ''], [IPC.dbSetSchema, { id: ID, schema: 'a\0b' }],
      [IPC.dbPage, { ...pageReq, size: 77 }], [IPC.dbPage, { ...pageReq, extra: 1 }], [IPC.dbEstimate, { ref, filters: [{ column: 'a', op: 'like', values: ['x'] }] }],
      [IPC.dbCount, { ref: { ...ref, name: 'x'.repeat(129) }, filters: [] }], [IPC.dbPeek, { ref, cols: ['id'], values: [] }],
      [IPC.dbRefs, { ref, key: { id: 7 } }], [IPC.dbFull, { ref, key: { id: '7' }, column: 'doc', path: Array.from({ length: 17 }, (_, i) => `k${i}`) }],
      [IPC.dbStructure, { ...ref, extra: 1 }], [IPC.dbRelations, { connId: ID }], [IPC.dbDdl, 'orders'], [IPC.dbOverview, 7], [IPC.dbReadOnlySql, undefined]
    ];
    for (const [channel, arg] of bad) expect(() => call(channel, arg), channel).toThrow();
    for (const fn of Object.values(hub)) expect(fn).not.toHaveBeenCalled();
  });

  test('page, estimate and count may name their slot (the tab key: 1–300 characters, no NUL); nothing else may', async () => {
    const slot = 'db:c0123456789ab:public:orders';
    for (const [channel, arg, method] of [[IPC.dbPage, { ...pageReq, slot }, 'page'], [IPC.dbEstimate, { ref, filters: [], slot }, 'estimate'], [IPC.dbCount, { ref, filters: [], slot }, 'count']] as const) {
      expect(await call(channel, arg)).toEqual({ from: method });
      expect(hub[method]).toHaveBeenLastCalledWith(1, arg);
      expect(await call(channel, { ...arg, slot: 'x'.repeat(300) })).toEqual({ from: method });
      for (const bad of ['', 'x'.repeat(301), 'a\0b', 7, null]) expect(() => call(channel, { ...arg, slot: bad }), `${channel} ${String(bad).slice(0, 9)}`).toThrow();
    }
    for (const [channel, arg] of [[IPC.dbPeek, { ref, cols: ['id'], values: ['7'], slot }], [IPC.dbRefs, { ref, key: { id: '7' }, slot }], [IPC.dbFull, { ref, key: { id: '7' }, column: 'doc', slot }]] as const) {
      expect(() => call(channel, arg), channel).toThrow();
    }
  });

  test('DDL takes a table or a function: a function by its identity arguments, strictly shaped', async () => {
    const fn = { connId: ID, schema: 'public', name: 'order_total', args: 'bigint' };
    expect(await call(IPC.dbDdl, fn)).toEqual({ from: 'ddl' });
    expect(hub.ddl).toHaveBeenLastCalledWith(1, fn);
    // No arguments: the empty list, as oidvectortypes writes it.
    expect(await call(IPC.dbDdl, { ...fn, args: '' })).toEqual({ from: 'ddl' });
    const bad: unknown[] = [
      { ...fn, extra: 1 }, { ...fn, args: 7 }, { ...fn, args: null }, { ...fn, args: 'a\0b' }, { ...fn, args: 'x'.repeat(16_385) },
      { ...fn, name: '' }, { ...fn, schema: 'x'.repeat(129) }, { ...fn, connId: SUGGESTION }, { connId: ID, schema: 'public', args: 'bigint' }
    ];
    for (const arg of bad) expect(() => call(IPC.dbDdl, arg), JSON.stringify(arg).slice(0, 80)).toThrow();
    expect(hub.ddl).toHaveBeenCalledTimes(2);
  });
});

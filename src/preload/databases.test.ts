import { beforeAll, expect, test, vi } from 'vitest';
import type { AtelierApi } from '@shared/api';

// window.atelier.databases: each call invokes its db channel with one argument, the two-value
// calls as one plain object; the snapshot event is listened to on ev:databases.

const calls: unknown[][] = [];
type Listener = (...a: unknown[]) => void;
const listening: [string, Listener][] = [];
const removed: [string, Listener][] = [];
let api: AtelierApi;
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, v: AtelierApi) => { api = v; } },
  ipcRenderer: {
    invoke: (...a: unknown[]) => { calls.push(a); return Promise.resolve(); }, send: () => {},
    on: (ch: string, h: Listener) => { listening.push([ch, h]); }, off: (ch: string, h: Listener) => { removed.push([ch, h]); },
    removeListener: (ch: string, h: Listener) => { removed.push([ch, h]); }
  },
  webUtils: { getPathForFile: () => '' }
}));
beforeAll(async () => { await import('./index'); });

const sent = (fn: () => unknown) => { calls.length = 0; void fn(); return calls[0]; };
const ID = 'c0123456789ab';
const ref = { connId: ID, schema: 'public', name: 'orders' };

test('each databases call invokes its channel with one argument', () => {
  const d = () => api.databases;
  const form = { name: 'x', engine: 'postgres', env: 'local', host: 'h', port: 5432, database: 'd', user: 'u', tls: 'prefer', ssh: null, scope: { kind: 'all' } } as const;
  const page = { ref, columns: [], derived: [], filters: [], sort: [], page: 0, size: 100 };
  expect(sent(() => d().snapshot())).toStrictEqual(['db:snapshot']);
  expect(sent(() => d().select(ID))).toStrictEqual(['db:select', ID]);
  expect(sent(() => d().select(null))).toStrictEqual(['db:select', null]);
  expect(sent(() => d().connect(ID))).toStrictEqual(['db:connect', ID]);
  expect(sent(() => d().disconnect(ID))).toStrictEqual(['db:disconnect', ID]);
  expect(sent(() => d().password({ connId: ID, password: 'pw', save: true }))).toStrictEqual(['db:password', { connId: ID, password: 'pw', save: true }]);
  expect(sent(() => d().test({ form, password: null, id: ID }))).toStrictEqual(['db:test', { form, password: null, id: ID }]);
  expect(sent(() => d().save({ form, password: 'pw', id: null }))).toStrictEqual(['db:save', { form, password: 'pw', id: null }]);
  expect(sent(() => d().duplicate(ID))).toStrictEqual(['db:duplicate', ID]);
  expect(sent(() => d().remove(ID))).toStrictEqual(['db:remove', ID]);
  expect(sent(() => d().setMask(ID, true))).toStrictEqual(['db:set-mask', { id: ID, on: true }]);
  expect(sent(() => d().noteWrite(ID))).toStrictEqual(['db:note-write', ID]);
  expect(sent(() => d().setSchema(ID, 'billing'))).toStrictEqual(['db:set-schema', { id: ID, schema: 'billing' }]);
  expect(sent(() => d().refresh())).toStrictEqual(['db:refresh']);
  expect(sent(() => d().page(page))).toStrictEqual(['db:page', page]);
  expect(sent(() => d().estimate({ ref, filters: [] }))).toStrictEqual(['db:estimate', { ref, filters: [] }]);
  expect(sent(() => d().count({ ref, filters: [] }))).toStrictEqual(['db:count', { ref, filters: [] }]);
  expect(sent(() => d().peek({ ref, cols: ['id'], values: ['7'] }))).toStrictEqual(['db:peek', { ref, cols: ['id'], values: ['7'] }]);
  expect(sent(() => d().refs({ ref, key: { id: '7' } }))).toStrictEqual(['db:refs', { ref, key: { id: '7' } }]);
  expect(sent(() => d().full({ ref, key: { id: '7' }, column: 'doc' }))).toStrictEqual(['db:full', { ref, key: { id: '7' }, column: 'doc' }]);
  expect(sent(() => d().structure(ref))).toStrictEqual(['db:structure', ref]);
  expect(sent(() => d().relations(ref))).toStrictEqual(['db:relations', ref]);
  expect(sent(() => d().ddl(ref))).toStrictEqual(['db:ddl', ref]);
  // A function's definition through the same channel.
  const fn = { connId: ID, schema: 'public', name: 'order_total', args: 'bigint' };
  expect(sent(() => d().ddl(fn))).toStrictEqual(['db:ddl', fn]);
  expect(sent(() => d().overview(ID))).toStrictEqual(['db:overview', ID]);
  expect(sent(() => d().readOnlySql(ID))).toStrictEqual(['db:read-only-sql', ID]);
});

test('the snapshot event: listened to on ev:databases, the snapshot handed over; the returned function removes that listener', () => {
  const got: unknown[] = [];
  const off = api.on.databases((s) => { got.push(s); });
  const on = listening.filter(([ch]) => ch === 'ev:databases');
  expect(on).toHaveLength(1);
  const [, handler] = on[0]!;
  const snap = { connections: [], selected: null, catalog: null };
  handler({}, snap);
  expect(got).toEqual([snap]);
  expect(removed).toEqual([]);
  off();
  expect(removed).toEqual([['ev:databases', handler]]);
});

import { expect, test } from 'vitest';
import { applyPayload, payloadOf, type PayloadState } from './popout-payload';

// What a tab needs besides its key to be shown in another window: read from one store, applied to another.
const base = (): PayloadState => ({
  project: { root: '/p', name: 'p', realRoot: '/p' },
  openFiles: [],
  review: null,
  historyTab: null,
  backgroundTab: null,
  dockerTabs: [],
  redisTabs: [],
  revFiles: [],
  scmRepo: null,
  terminals: [],
  askOpen: {}
});

test('a terminal carries whether Ask is open for its live session; an ended one\'s panel stays', () => {
  const term = (id: string, sessionId: string | null) => ({ id, session: sessionId ? { sessionId } : null }) as PayloadState['terminals'][number];
  const bind = (terminalId: string, sessionId: string) => ({ terminalId, sessionId, cwd: '/p', configDir: null, title: 'x' });
  const st: PayloadState = { ...base(), terminals: [term('a', 's1'), term('b', null), term('c', 's3')], askOpen: { a: bind('a', 's1'), b: bind('b', 's2'), c: bind('c', 'old') } };
  expect(payloadOf(st, 't:a')).toEqual({ kind: 'terminal', ask: true });
  // Claude exited (b) or /clear started another conversation (c): nothing live to bind Ask to over there.
  expect(payloadOf(st, 't:b')).toEqual({ kind: 'terminal', ask: false });
  expect(payloadOf(st, 't:c')).toEqual({ kind: 'terminal', ask: false });
  expect(payloadOf(st, 't:z')).toEqual({ kind: 'terminal', ask: false });
  // The store it lands in opens Ask itself once the terminal is listed (askWanted): nothing else to apply.
  expect(applyPayload(st, 't:a', { kind: 'terminal', ask: true })).toEqual({});
});

test('Services carry no payload; a tab that is not open has none', () => {
  const st = base();
  expect(payloadOf(st, 'services')).toBeUndefined();
  expect(payloadOf(st, 'f:/p/a.ts')).toBeUndefined();
  expect(payloadOf(st, 'review')).toBeUndefined();
  expect(payloadOf(st, 'history')).toBeUndefined();
  expect(payloadOf(st, 'rev:abc:a.ts')).toBeUndefined();
});

test('every special tab carries what shows it; nonces stay behind', () => {
  const st: PayloadState = {
    ...base(),
    openFiles: [{ path: '/p/a.ts', rel: 'a.ts', line: 3, nonce: 1, mode: 'diff' }],
    review: { scope: 'all', nonce: 1, againstMain: true },
    historyTab: { repo: '/p', scope: { kind: 'refs', refs: 'all', firstParent: false }, nonce: 1 },
    backgroundTab: { terminalId: 'a', itemId: 'x', nonce: 1 },
    dockerTabs: [{ key: 'dk:c:0123456789ab', target: { kind: 'container', id: '0123456789ab' }, view: 'inspect', nonce: 1 }],
    redisTabs: ['queues'],
    revFiles: [{ key: 'rev:abc:a.ts', root: '/p', oid: 'abc', rel: 'a.ts' }]
  };
  expect(payloadOf(st, 'f:/p/a.ts')).toEqual({ kind: 'file', rel: 'a.ts', mode: 'diff' });
  expect(payloadOf(st, 'review')).toEqual({ kind: 'review', scope: 'all', againstMain: true });
  expect(payloadOf(st, 'history')).toEqual({ kind: 'history', repo: '/p', scope: { kind: 'refs', refs: 'all', firstParent: false } });
  expect(payloadOf(st, 'background')).toEqual({ kind: 'background', terminalId: 'a', itemId: 'x' });
  expect(payloadOf(st, 'dk:c:0123456789ab')).toEqual({ kind: 'docker', target: { kind: 'container', id: '0123456789ab' }, view: 'inspect' });
  expect(payloadOf(st, 'dk:overview')).toBeUndefined();
  expect(payloadOf(st, 'rd:queues')).toEqual({ kind: 'redis', view: 'queues' });
  expect(payloadOf(st, 'rd:live')).toBeUndefined();
  expect(payloadOf(st, 'rev:abc:a.ts')).toEqual({ kind: 'rev', root: '/p', oid: 'abc', rel: 'a.ts' });
  // A review opened without a choice of its own says nothing about Against main.
  expect(payloadOf({ ...st, review: { scope: 't1', nonce: 2 } }, 'review')).toEqual({ kind: 'review', scope: 't1' });
});

test('round trip: what payloadOf reads, applyPayload puts back in another store', () => {
  const from: PayloadState = {
    ...base(),
    openFiles: [{ path: '/p/a.ts', rel: 'a.ts', line: null, nonce: 1, mode: 'diff' }],
    review: { scope: 'all', nonce: 1, againstMain: false },
    historyTab: { repo: '/p/sub', scope: { kind: 'refs', refs: 'all', firstParent: true }, nonce: 1 },
    backgroundTab: { terminalId: 'a', itemId: null, nonce: 1 },
    dockerTabs: [{ key: 'dk:s:web', target: { kind: 'stack', project: 'web' }, view: 'logs', nonce: 1 }],
    redisTabs: ['live'],
    revFiles: [{ key: 'rev:abc:a.ts', root: '/p', oid: 'abc', rel: 'a.ts' }]
  };
  const to = base();
  const file = applyPayload(to, 'f:/p/a.ts', payloadOf(from, 'f:/p/a.ts'));
  expect(file.openFiles?.map(({ path, rel, line, mode }) => ({ path, rel, line, mode }))).toEqual([{ path: '/p/a.ts', rel: 'a.ts', line: null, mode: 'diff' }]);
  expect(applyPayload(to, 'review', payloadOf(from, 'review')).review).toMatchObject({ scope: 'all', againstMain: false });
  const h = applyPayload(to, 'history', payloadOf(from, 'history'));
  expect(h.historyTab).toMatchObject({ repo: '/p/sub', scope: { kind: 'refs', refs: 'all', firstParent: true } });
  expect(h.scmRepo).toBe('/p/sub');
  expect(applyPayload(to, 'background', payloadOf(from, 'background')).backgroundTab).toMatchObject({ terminalId: 'a', itemId: null });
  expect(applyPayload(to, 'dk:s:web', payloadOf(from, 'dk:s:web')).dockerTabs).toMatchObject([{ key: 'dk:s:web', target: { kind: 'stack', project: 'web' }, view: 'logs' }]);
  // The key names the target: a Docker tab without payload shows its logs; one already open there keeps one tab.
  expect(applyPayload(to, 'dk:c:0123456789ab', undefined).dockerTabs).toMatchObject([{ key: 'dk:c:0123456789ab', target: { kind: 'container', id: '0123456789ab' }, view: 'logs' }]);
  expect(applyPayload(from, 'dk:s:web', { kind: 'docker', target: { kind: 'stack', project: 'web' }, view: 'inspect' }).dockerTabs).toMatchObject([{ key: 'dk:s:web', view: 'inspect' }]);
  // Asked without a payload while open: it keeps its own view.
  const inspecting: PayloadState = { ...from, dockerTabs: [{ key: 'dk:s:web', target: { kind: 'stack', project: 'web' }, view: 'inspect', nonce: 1 }] };
  expect(applyPayload(inspecting, 'dk:s:web', undefined).dockerTabs).toMatchObject([{ key: 'dk:s:web', view: 'inspect' }]);
  expect(applyPayload(to, 'dk:nope', undefined)).toEqual({});
  // A Redis tab's key names its view: one already open there stays one.
  expect(applyPayload(to, 'rd:live', payloadOf(from, 'rd:live')).redisTabs).toEqual(['live']);
  expect(applyPayload(from, 'rd:live', undefined).redisTabs).toEqual(['live']);
  expect(applyPayload(to, 'rd:nope', undefined)).toEqual({});
  expect(applyPayload(to, 'rev:abc:a.ts', payloadOf(from, 'rev:abc:a.ts')).revFiles).toEqual([{ key: 'rev:abc:a.ts', root: '/p', oid: 'abc', rel: 'a.ts' }]);
  expect(applyPayload(to, 'services', undefined)).toEqual({ servicesOpen: true });
  expect(applyPayload(to, 't:a', undefined)).toEqual({});
});

test('a file already open keeps its entry (new nonce, the mode carried); one without payload gets its project-relative name', () => {
  const st: PayloadState = { ...base(), openFiles: [{ path: '/p/a.ts', rel: 'a.ts', line: 4, nonce: 1, mode: 'margin' }] };
  const again = applyPayload(st, 'f:/p/a.ts', { kind: 'file', rel: 'a.ts', mode: 'diff' });
  expect(again.openFiles).toHaveLength(1);
  expect(again.openFiles![0]).toMatchObject({ path: '/p/a.ts', mode: 'diff' });
  expect(again.openFiles![0]!.nonce).not.toBe(1);
  expect(applyPayload(base(), 'f:/p/src/b.ts', undefined).openFiles).toMatchObject([{ path: '/p/src/b.ts', rel: 'src/b.ts', mode: 'margin' }]);
  expect(applyPayload(base(), 'f:/h/c.ts', undefined).openFiles).toMatchObject([{ path: '/h/c.ts', rel: '/h/c.ts' }]);
});

test('a payload of another kind than the key is ignored; a revision already open is not added twice', () => {
  expect(applyPayload(base(), 'review', { kind: 'docker', target: { kind: 'overview' }, view: 'logs' })).toEqual({ review: expect.objectContaining({ scope: 'all' }) });
  const st: PayloadState = { ...base(), revFiles: [{ key: 'rev:abc:a.ts', root: '/p', oid: 'abc', rel: 'a.ts' }] };
  expect({ ...st, ...applyPayload(st, 'rev:abc:a.ts', { kind: 'rev', root: '/p', oid: 'abc', rel: 'a.ts' }) }.revFiles).toHaveLength(1);
});

test('a table tab: its connection, names, view and kind go along; the key names the table', () => {
  const orders = { key: 'db:c0123456789ab/public/orders' as const, connId: 'c0123456789ab', schema: 'public', name: 'orders', kind: 'view' as const, view: 'structure' as const };
  const overview = { key: 'db:c0123456789ab' as const, connId: 'c0123456789ab', schema: '', name: '', kind: 'overview' as const, view: 'data' as const };
  const from: PayloadState = { ...base(), dbTabs: [orders, overview] };
  expect(payloadOf(from, orders.key)).toEqual({ kind: 'db', connId: 'c0123456789ab', schema: 'public', name: 'orders', view: 'structure', rel: 'view' });
  expect(payloadOf(from, overview.key)).toEqual({ kind: 'db', connId: 'c0123456789ab', schema: '', name: '', view: 'data' });
  // Not open, or a store with no table tabs at all: nothing.
  expect(payloadOf(from, 'db:c0123456789ab/public/gone')).toBeUndefined();
  expect(payloadOf(base(), orders.key)).toBeUndefined();
  // There and back.
  expect(applyPayload(base(), orders.key, payloadOf(from, orders.key)).dbTabs).toEqual([orders]);
  expect(applyPayload(base(), overview.key, payloadOf(from, overview.key)).dbTabs).toEqual([overview]);
  // Already open there: one tab, the view coming along.
  const there: PayloadState = { ...base(), dbTabs: [{ ...orders, view: 'data' }] };
  expect(applyPayload(there, orders.key, payloadOf(from, orders.key)).dbTabs).toEqual([orders]);
  // The key names the table: a payload naming another one changes nothing of that; no payload adds no tab; junk keys none.
  expect(applyPayload(base(), orders.key, { kind: 'db', connId: 'c00000000000d', schema: 'x', name: 'y', view: 'data' }).dbTabs).toEqual([{ ...orders, kind: 'table', view: 'data' }]);
  expect(applyPayload(base(), orders.key, undefined)).toEqual({});
  expect(applyPayload(base(), 'db:nope', payloadOf(from, orders.key))).toEqual({});
  // An open asked from another window: a view goes along only when one was asked; an open tab keeps its own.
  const asked = { kind: 'db' as const, connId: 'c0123456789ab', schema: 'public', name: 'orders', view: 'relations' as const };
  expect(applyPayload(there, orders.key, { ...asked, open: { preview: true, view: false } }).dbTabs).toEqual([{ ...orders, view: 'data' }]);
  expect(applyPayload(there, orders.key, { ...asked, open: { preview: true, view: true } }).dbTabs).toEqual([{ ...orders, view: 'relations' }]);
  // Not open there: it opens on the view it names.
  expect(applyPayload(base(), orders.key, { ...asked, open: { preview: true, view: false } }).dbTabs).toEqual([{ ...orders, kind: 'table', view: 'relations' }]);
});

test('an Automations tab carries nothing: it never lives in another window', () => {
  expect(payloadOf(base(), 'au:a1')).toBeUndefined();
  expect(applyPayload(base(), 'au:a1', undefined)).toEqual({});
});

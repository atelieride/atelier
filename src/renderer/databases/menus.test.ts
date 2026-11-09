import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbConnState, type DbConnView, type DbConnection, type DbRel } from '@shared/databases';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import {
  attempt, connMenu, databaseMenu, enumMenu, fnMenu, problemAction, REFRESH_MIN_MS, refreshSidebar, relMenu, schemaMenu, selectConn, switchDatabase, useSideWork
} from './menus';
import { useDb } from './store';
import type { DbTabRef } from './tabs';

// Claude's module: its own tests are actions.test.ts's.
const claude = vi.hoisted(() => ({ sendSchema: vi.fn(async () => {}), askTable: vi.fn(async () => {}) }));
vi.mock('./actions', () => claude);

// The sidebar's context menus: a connection's, a table's or view's, an enum's, a function's.

const C = 'c0123456789ab';
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme · production', engine: 'postgres', env: 'prod', host: 'sample-db1.proxy.rlwy.net', port: 54321, database: 'railway', user: 'postgres',
  tls: 'require', ssh: null, scope: { kind: 'project', root: '/p' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (state: DbConnState, o: Partial<DbConnection> = {}): DbConnView => ({ conn: conn(o), state, problem: null, server: null, hasPassword: true, provider: 'Railway', held: false });
const ORDERS: DbRel = { schema: 'public', name: 'orders', kind: 'table', estimate: 48210 };

const items = (m: MenuItem[]) => m.filter((x): x is Exclude<MenuItem, 'sep'> => x !== 'sep');
const labels = (m: MenuItem[]) => m.map((x) => (x === 'sep' ? '—' : x.label));
const run = (m: MenuItem[], id: string) => {
  const it = items(m).find((x) => x.id === id);
  if (!it) throw new Error(`no item ${id}`);
  it.run();
};
const settle = () => new Promise((r) => setTimeout(r, 0));

let api: Record<string, ReturnType<typeof vi.fn>>;
let clip: ReturnType<typeof vi.fn>;
beforeEach(() => {
  api = {
    select: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
    duplicate: vi.fn(async () => ({ ok: true, value: { id: 'cdup000000000' } }))
  };
  clip = vi.fn(async () => true);
  vi.stubGlobal('window', { atelier: { databases: api, clipboard: { write: clip } } });
  useApp.setState({ openDbTab: vi.fn(), showToast: vi.fn() });
  useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, selected: C } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useApp.setState(useApp.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
});

describe('a connection', () => {
  test('its items in the spec\'s order: Connect or Disconnect, Overview, Refresh, edits and copies, Remove last and in red', () => {
    expect(labels(connMenu(view('idle')))).toEqual([
      'Connect', 'Overview', 'Refresh', '—', 'Edit Connection…', 'Duplicate', 'Copy URL (No Password)', 'Copy psql Command', 'Copy SQL for a Read-only Role',
      '—', 'Remove Connection…'
    ]);
    expect(labels(connMenu(view('connected')))[0]).toBe('Disconnect');
    expect(labels(connMenu(view('connecting')))[0]).toBe('Disconnect');
    const remove = items(connMenu(view('idle'))).find((x) => x.id === 'remove');
    expect(remove?.danger).toBe(true);
    expect(items(connMenu(view('idle'))).filter((x) => x.danger).map((x) => x.id)).toEqual(['remove']);
  });

  test('Refresh reads a connected database again; with nothing to read it waits', () => {
    expect(items(connMenu(view('idle'))).find((x) => x.id === 'refresh')?.disabled).toBe(true);
    expect(items(connMenu(view('connected'))).find((x) => x.id === 'refresh')?.disabled).toBeFalsy();
  });

  test('Connect selects and connects it; Disconnect closes it', () => {
    run(connMenu(view('idle')), 'connect');
    expect(api.select).toHaveBeenCalledWith(C);
    run(connMenu(view('connected')), 'disconnect');
    expect(api.disconnect).toHaveBeenCalledWith(C);
  });

  test('Refresh on the picked connection reads its catalog again; on another one it picks it first', async () => {
    run(connMenu(view('connected')), 'refresh');
    await settle();
    expect(api.select).not.toHaveBeenCalled();
    expect(api.refresh).toHaveBeenCalledTimes(1);
    useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, selected: 'cother0000000' } });
    run(connMenu(view('connected')), 'refresh');
    await settle();
    expect(api.select).toHaveBeenCalledWith(C);
    expect(api.refresh).toHaveBeenCalledTimes(2);
  });

  test('Overview opens the connection\'s overview tab, kept', () => {
    run(connMenu(view('connected')), 'overview');
    expect(useApp.getState().openDbTab).toHaveBeenCalledWith({ connId: C, schema: '', name: '', kind: 'overview', view: 'data' }, { preview: false });
  });

  test('Edit and Remove open their sheets; Duplicate asks main', () => {
    run(connMenu(view('idle')), 'edit');
    expect(useDb.getState().sheet).toEqual({ kind: 'edit', id: C });
    run(connMenu(view('idle')), 'remove');
    expect(useDb.getState().sheet).toEqual({ kind: 'remove', id: C });
    run(connMenu(view('idle')), 'duplicate');
    expect(api.duplicate).toHaveBeenCalledWith(C);
  });

  test('a Duplicate main refuses says why', async () => {
    api.duplicate!.mockResolvedValueOnce({ ok: false, problem: { kind: 'other', message: 'Too many connections saved' } });
    run(connMenu(view('idle')), 'duplicate');
    await settle();
    expect(useApp.getState().showToast).toHaveBeenCalledWith('Too many connections saved');
  });

  test('the copies never hold a password: the URL and the psql command, then "Copied"', async () => {
    run(connMenu(view('idle')), 'copy-url');
    await settle();
    expect(clip).toHaveBeenLastCalledWith('postgresql://postgres@sample-db1.proxy.rlwy.net:54321/railway?sslmode=require');
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith('Copied', undefined, 'info');
    run(connMenu(view('idle')), 'copy-psql');
    await settle();
    expect(clip).toHaveBeenLastCalledWith("psql 'postgresql://postgres@sample-db1.proxy.rlwy.net:54321/railway?sslmode=require'");
  });
});

describe('a table or a view', () => {
  test('its items: the three ways to open it, its other views, the copies, then Claude\'s', () => {
    useApp.setState({ terminals: [{ id: 't1', title: 'db-migration', color: '#8B5CF6', session: { state: 'waiting', updatedAt: 0 } } as never], selectedId: 't1' });
    expect(labels(relMenu(C, ORDERS))).toEqual([
      'Open', 'Open in New Tab', 'Open to the Side', '—', 'Structure', 'Relations', '—', 'Copy Name', 'Copy SELECT', '—',
      'Send Schema to db-migration', 'Ask About This Table in a New Session'
    ]);
    expect(items(relMenu(C, ORDERS)).some((x) => x.danger)).toBe(false);
    // No session to send to: the item stays (its press says why, with a Copy), named as Redis's.
    useApp.setState({ terminals: [], selectedId: null });
    expect(labels(relMenu(C, ORDERS)).at(-2)).toBe('Send Schema to Session');
  });

  test('Send Schema and Ask About This Table: the table by its names', () => {
    run(relMenu(C, { ...ORDERS, kind: 'view' }), 'send-schema');
    expect(claude.sendSchema).toHaveBeenCalledWith({ connId: C, schema: 'public', name: 'orders' });
    run(relMenu(C, ORDERS), 'ask-table');
    expect(claude.askTable).toHaveBeenCalledWith({ connId: C, schema: 'public', name: 'orders' });
  });

  test('Open is a click (the preview), Open in New Tab keeps it, Open to the Side splits; Structure and Relations open that view, kept', () => {
    const ref = { connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'data' };
    const open = useApp.getState().openDbTab as ReturnType<typeof vi.fn>;
    run(relMenu(C, ORDERS), 'open');
    expect(open).toHaveBeenLastCalledWith(ref, { preview: true });
    run(relMenu(C, ORDERS), 'open-new');
    expect(open).toHaveBeenLastCalledWith(ref, { preview: false });
    run(relMenu(C, ORDERS), 'open-to-side');
    expect(open).toHaveBeenLastCalledWith(ref, { preview: false, side: true });
    // A view other than Data is an investment: its nodes and links then open beside it, never in its place.
    run(relMenu(C, ORDERS), 'structure');
    expect(open).toHaveBeenLastCalledWith(ref, { preview: false, view: 'structure' });
    run(relMenu(C, ORDERS), 'relations');
    expect(open).toHaveBeenLastCalledWith(ref, { preview: false, view: 'relations' });
  });

  test('Copy Name and Copy SELECT', async () => {
    run(relMenu(C, { ...ORDERS, name: 'Order Items', kind: 'view' }), 'copy-name');
    await settle();
    expect(clip).toHaveBeenLastCalledWith('Order Items');
    run(relMenu(C, { ...ORDERS, name: 'Order Items', kind: 'view' }), 'copy-select');
    await settle();
    expect(clip).toHaveBeenLastCalledWith('SELECT * FROM public."Order Items" LIMIT 100;');
  });
});

describe('a call to main that fails says so, and never leaves the UI waiting', () => {
  test('attempt: the answer; a rejected or throwing call → a toast and null', async () => {
    const toast = useApp.getState().showToast as ReturnType<typeof vi.fn>;
    expect(await attempt(async () => 7, "Couldn't connect")).toBe(7);
    expect(toast).not.toHaveBeenCalled();
    expect(await attempt(() => Promise.reject(new Error('ipc')), "Couldn't connect")).toBeNull();
    expect(toast).toHaveBeenLastCalledWith("Couldn't connect");
    expect(await attempt(() => { throw new Error('gone'); }, "Couldn't refresh")).toBeNull();
    expect(toast).toHaveBeenLastCalledWith("Couldn't refresh");
  });

  test('every action of the menus: a rejection becomes "Couldn\'t …"', async () => {
    const toast = useApp.getState().showToast as ReturnType<typeof vi.fn>;
    const fail = () => vi.fn(() => Promise.reject(new Error('ipc')));
    api.duplicate = fail();
    run(connMenu(view('idle')), 'duplicate');
    await settle();
    expect(toast).toHaveBeenLastCalledWith("Couldn't duplicate the connection");
    api.disconnect = fail();
    run(connMenu(view('connected')), 'disconnect');
    await settle();
    expect(toast).toHaveBeenLastCalledWith("Couldn't disconnect");
    api.select = fail();
    run(connMenu(view('idle')), 'connect');
    await settle();
    expect(toast).toHaveBeenLastCalledWith("Couldn't connect");
    api.refresh = fail();
    run(connMenu(view('connected')), 'refresh');
    await settle();
    expect(toast).toHaveBeenLastCalledWith("Couldn't refresh");
    api.setSchema = fail();
    run(schemaMenu({ connId: C, schemas: ['public', 'audit'], schema: 'public' }), 'schema:audit');
    await settle();
    expect(toast).toHaveBeenLastCalledWith("Couldn't change the schema");
    api.save = fail();
    useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, selected: C, connections: [view('connected')] } });
    run(databaseMenu({ connId: C, database: 'railway', databases: ['railway', 'analytics'] }), 'database:analytics');
    await settle();
    expect(toast).toHaveBeenLastCalledWith("Couldn't switch the database");
    api.readOnlySql = fail();
    run(connMenu(view('connected')), 'copy-role-sql');
    await settle();
    expect(toast).toHaveBeenLastCalledWith("Couldn't get the SQL for a read-only role");
  });
});

describe('Refresh says it is working', () => {
  afterEach(() => { vi.useRealTimers(); });

  test('busy while main reads the catalog again, one turn at least so it is seen; two at once count both', async () => {
    vi.useFakeTimers();
    useSideWork.setState({ refreshing: 0, switching: null });
    let release!: () => void;
    api.refresh = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const p = refreshSidebar();
    expect(useSideWork.getState().refreshing).toBe(1);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    // Main answered at once: the icon still finishes its turn.
    expect(useSideWork.getState().refreshing).toBe(1);
    const q = refreshSidebar();
    expect(useSideWork.getState().refreshing).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(REFRESH_MIN_MS);
    await Promise.all([p, q]);
    expect(useSideWork.getState().refreshing).toBe(0);
  });

  test('a refresh that never reached main still ends (said in a toast)', async () => {
    vi.useFakeTimers();
    useSideWork.setState({ refreshing: 0, switching: null });
    api.refresh = vi.fn(() => Promise.reject(new Error('ipc')));
    const p = refreshSidebar();
    await vi.advanceTimersByTimeAsync(REFRESH_MIN_MS);
    await p;
    expect(useSideWork.getState().refreshing).toBe(0);
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith("Couldn't refresh");
  });

  test('the connection menu\'s Refresh is that refresh', async () => {
    useSideWork.setState({ refreshing: 0, switching: null });
    run(connMenu(view('connected')), 'refresh');
    await settle();
    expect(useSideWork.getState().refreshing).toBe(1);
  });
});

describe('Disconnect holds a connection closed (the hold is main\'s)', () => {
  test('Disconnect, Connect, a row\'s click and Try Again are one call each to main, which holds and lets go for every window; the store keeps nothing of its own', async () => {
    const before = useDb.getState();
    run(connMenu(view('connected')), 'disconnect');
    await settle();
    expect(api.disconnect).toHaveBeenCalledWith(C);
    run(connMenu(view('idle', {})), 'connect');
    await settle();
    await selectConn(C);
    expect(api.select).toHaveBeenCalledTimes(2);
    expect(api.select).toHaveBeenLastCalledWith(C);
    api.connect = vi.fn(async () => ({ ok: true }));
    await problemAction(view('error'), 'retry');
    expect(api.connect).toHaveBeenCalledWith(C);
    expect(useDb.getState()).toBe(before);
  });
});

describe('what a problem\'s button does', () => {
  test('a double click sends one save and one connect', async () => {
    const waiting: ((v: unknown) => void)[] = [];
    api.save = vi.fn(() => new Promise((r) => { waiting.push(r); }));
    api.connect = vi.fn(async () => ({ ok: true }));
    const first = problemAction(view('error'), 'tlsOff');
    const second = problemAction(view('error'), 'tlsOff');
    await settle();
    for (const answer of waiting) answer({ ok: true, value: { id: C } });
    await Promise.all([first, second]);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.connect).toHaveBeenCalledTimes(1);
    // Once answered, the button works again.
    await problemAction(view('error'), 'retry');
    expect(api.connect).toHaveBeenCalledTimes(2);
  });

  test('a save or connect that fails to reach main says so', async () => {
    api.save = vi.fn(() => Promise.reject(new Error('ipc')));
    api.connect = vi.fn(async () => ({ ok: true }));
    expect(await problemAction(view('error'), 'tlsOff')).toBe(false);
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith("Couldn't save the connection");
    expect(api.connect).not.toHaveBeenCalled();
    api.connect = vi.fn(() => Promise.reject(new Error('ipc')));
    expect(await problemAction(view('error'), 'retry')).toBe(false);
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith("Couldn't connect");
  });

  test('a TLS fix saves the connection with that mode, as the exact form, keeping the password field empty; then connects', async () => {
    api.save = vi.fn(async () => ({ ok: true, value: { id: C } }));
    api.connect = vi.fn(async () => ({ ok: true }));
    await problemAction(view('error', { ssh: { host: 'bastion', port: null, user: '' } }), 'tlsOff');
    expect(api.save).toHaveBeenCalledWith({
      form: {
        name: 'acme · production', engine: 'postgres', env: 'prod', host: 'sample-db1.proxy.rlwy.net', port: 54321, database: 'railway', user: 'postgres',
        tls: 'off', ssh: { host: 'bastion', port: null, user: '' }, scope: { kind: 'project', root: '/p' }
      },
      password: null, id: C
    });
    expect(api.connect).toHaveBeenCalledWith(C);
    expect(api.save!.mock.invocationCallOrder[0]).toBeLessThan(api.connect!.mock.invocationCallOrder[0]!);
    await problemAction(view('error', { tls: 'off' }), 'useTls');
    expect(api.save!.mock.lastCall![0].form.tls).toBe('require');
    await problemAction(view('error', { tls: 'verify' }), 'useRequire');
    expect(api.save!.mock.lastCall![0].form.tls).toBe('require');
  });

  test('a save main refuses says why and connects nothing', async () => {
    api.save = vi.fn(async () => ({ ok: false, problem: { kind: 'other', message: 'Too many connections saved' } }));
    api.connect = vi.fn(async () => ({ ok: true }));
    await problemAction(view('error'), 'tlsOff');
    expect(useApp.getState().showToast).toHaveBeenCalledWith('Too many connections saved');
    expect(api.connect).not.toHaveBeenCalled();
  });

  test('Try Again connects; Edit Connection… opens the sheet; Refresh reads the catalog again', async () => {
    api.save = vi.fn();
    api.connect = vi.fn(async () => ({ ok: true }));
    await problemAction(view('error'), 'retry');
    expect(api.connect).toHaveBeenCalledWith(C);
    await problemAction(view('error'), 'edit');
    expect(useDb.getState().sheet).toEqual({ kind: 'edit', id: C });
    await problemAction(view('error'), 'refresh');
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.save).not.toHaveBeenCalled();
    expect(api.connect).toHaveBeenCalledTimes(1);
  });
});

describe('Copy SQL for a Read-only Role (the write note\'s button moved to the connection\'s menu)', () => {
  const SERVER = { version: '17.2', versionNum: 170002, tls: false, role: 'postgres', canWrite: true, latencyMs: 3 };

  test('next to Copy psql Command; it waits for a connection (the script depends on the server version)', () => {
    const idle = items(connMenu(view('idle'))).find((x) => x.id === 'copy-role-sql');
    expect(idle?.disabled).toBe(true);
    const live = items(connMenu({ ...view('connected'), server: SERVER })).find((x) => x.id === 'copy-role-sql');
    expect(live?.disabled).toBeFalsy();
    expect(labels(connMenu(view('connected'))).indexOf('Copy SQL for a Read-only Role')).toBe(labels(connMenu(view('connected'))).indexOf('Copy psql Command') + 1);
  });

  test('main\'s script, copied and said; main\'s refusal said', async () => {
    api.readOnlySql = vi.fn(async () => ({ ok: true, value: 'CREATE ROLE "atelier_readonly" LOGIN;\n' }));
    run(connMenu({ ...view('connected'), server: SERVER }), 'copy-role-sql');
    await settle();
    await settle();
    expect(api.readOnlySql).toHaveBeenCalledWith(C);
    expect(clip).toHaveBeenLastCalledWith('CREATE ROLE "atelier_readonly" LOGIN;\n');
    api.readOnlySql = vi.fn(async () => ({ ok: false, problem: { kind: 'other', message: 'Connect first: the script depends on the server version' } }));
    run(connMenu({ ...view('connected'), server: SERVER }), 'copy-role-sql');
    await settle();
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith('Connect first: the script depends on the server version');
  });
});

describe('the database chip: another database of the server, one pick away', () => {
  const OTHER = 'cother0000000';
  const tabs = [
    { key: `db:${C}/public/orders`, connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'data' },
    { key: `db:${C}`, connId: C, schema: '', name: '', kind: 'overview', view: 'data' },
    { key: `db:${OTHER}/public/orders`, connId: OTHER, schema: 'public', name: 'orders', kind: 'table', view: 'data' }
  ] as const;
  let closeDbTabs: Mock<(filter: (r: DbTabRef) => boolean) => void>;
  const picked = (o: Partial<DbConnection> = {}) => useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, selected: C, connections: [view('connected', { name: 'postgres', database: 'postgres', host: '127.0.0.1', port: 5432, env: 'local', tls: 'prefer', ...o })] } });
  beforeEach(() => {
    api.save = vi.fn(async () => ({ ok: true, value: { id: C } }));
    api.connect = vi.fn(async () => ({ ok: true, value: {} }));
    closeDbTabs = vi.fn();
    useApp.setState({ closeDbTabs });
    useSideWork.setState({ refreshing: 0, switching: null });
    picked();
  });

  test('its menu: the server\'s databases, the one shown checked (listed even when the server\'s list left it out)', () => {
    const menu = databaseMenu({ connId: C, database: 'postgres', databases: ['acme', 'postgres'] });
    expect(labels(menu)).toEqual(['acme', 'postgres']);
    expect(items(menu).map((x) => [x.checked, x.radio, x.icon])).toEqual([[false, true, undefined], [true, true, 'check']]);
    expect(labels(databaseMenu({ connId: C, database: 'shop', databases: [] }))).toEqual(['shop']);
  });

  test('a pick saves the connection on that database (the exact form, no password: the same server keeps it), closes its table tabs, says so, connects', async () => {
    await switchDatabase(C, 'acme');
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith({
      form: { name: 'acme', engine: 'postgres', env: 'local', host: '127.0.0.1', port: 5432, database: 'acme', user: 'postgres', tls: 'prefer', ssh: null, scope: { kind: 'project', root: '/p' } },
      password: null, id: C
    });
    // Its table tabs named the old database's tables; the overview is the connection's, and another connection's stay.
    expect(closeDbTabs).toHaveBeenCalledTimes(1);
    const which = closeDbTabs.mock.calls[0]![0];
    expect(tabs.filter((r) => which(r as unknown as DbTabRef)).map((r) => r.key)).toEqual([`db:${C}/public/orders`]);
    expect(useApp.getState().showToast).toHaveBeenCalledWith('Switched to acme', undefined, 'info');
    expect(api.connect).toHaveBeenCalledWith(C);
    expect(useSideWork.getState().switching).toBeNull();
  });

  test('the database it shows already, or a second pick while one runs: nothing', async () => {
    await switchDatabase(C, 'postgres');
    expect(api.save).not.toHaveBeenCalled();
    let release!: () => void;
    api.save = vi.fn(() => new Promise((r) => { release = () => r({ ok: true, value: { id: C } }); }));
    const first = switchDatabase(C, 'acme');
    expect(useSideWork.getState().switching).toBe(C);
    await switchDatabase(C, 'shop');
    release();
    await first;
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  test('a save main refuses says why: no tab closed, nothing connected', async () => {
    api.save = vi.fn(async () => ({ ok: false, problem: { kind: 'other', message: 'Invalid connection: database' } }));
    await switchDatabase(C, 'acme');
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith('Invalid connection: database');
    expect(closeDbTabs).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
    expect(useSideWork.getState().switching).toBeNull();
  });

  test('a pick from the menu is that switch', async () => {
    run(databaseMenu({ connId: C, database: 'postgres', databases: ['acme', 'postgres'] }), 'database:acme');
    await settle();
    expect(api.save).toHaveBeenCalledTimes(1);
  });
});

test('the schema chip\'s menu: the schemas holding anything, the picked one checked; a pick is remembered on the connection', () => {
  api.setSchema = vi.fn(async () => {});
  const menu = schemaMenu({ connId: C, schemas: ['public', 'audit'], schema: 'public' });
  expect(labels(menu)).toEqual(['public', 'audit']);
  expect(items(menu).map((x) => [x.checked, x.radio, x.icon])).toEqual([[true, true, 'check'], [false, true, undefined]]);
  run(menu, 'schema:audit');
  expect(api.setSchema).toHaveBeenCalledWith(C, 'audit');
});

test('an enum copies its name or its values; a function its name or its signature', async () => {
  expect(labels(enumMenu({ schema: 'public', name: 'order_status', values: ['pending', 'paid'] }))).toEqual(['Copy Name', 'Copy Values']);
  run(enumMenu({ schema: 'public', name: 'order_status', values: ['pending', 'paid'] }), 'copy-values');
  await settle();
  expect(clip).toHaveBeenLastCalledWith('pending, paid');
  const fn = { schema: 'public', name: 'order_total', args: 'bigint', returns: 'numeric', oid: 7 };
  expect(labels(fnMenu(C, fn))).toEqual(['Copy Name', 'Copy Signature', 'Copy Definition']);
  run(fnMenu(C, fn), 'copy-signature');
  await settle();
  expect(clip).toHaveBeenLastCalledWith('public.order_total(bigint) RETURNS numeric');
});

describe('a function\'s Copy Definition: read through main\'s DDL path, then copied', () => {
  const fn = { schema: 'public', name: 'order_total', args: 'bigint', returns: 'numeric', oid: 7 };
  const DEF = 'CREATE OR REPLACE FUNCTION public.order_total(order_id bigint)\n RETURNS numeric\n LANGUAGE sql\n';

  test('asked by the function\'s schema, name and identity arguments (overloads apart), never its oid; copied, said', async () => {
    api.ddl = vi.fn(async () => ({ ok: true, value: DEF }));
    run(fnMenu(C, fn), 'copy-definition');
    await settle();
    expect(api.ddl).toHaveBeenCalledWith({ connId: C, schema: 'public', name: 'order_total', args: 'bigint' });
    expect(clip).toHaveBeenLastCalledWith(DEF);
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith('Copied', undefined, 'info');
  });

  test('main\'s problem said in a toast, nothing copied; a call that never got there too', async () => {
    api.ddl = vi.fn(async () => ({ ok: false, problem: { kind: 'gone', message: 'This function no longer exists' } }));
    run(fnMenu(C, fn), 'copy-definition');
    await settle();
    expect(clip).not.toHaveBeenCalled();
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith('This function no longer exists');
    api.ddl = vi.fn(async () => { throw new Error('ipc'); });
    run(fnMenu(C, fn), 'copy-definition');
    await settle();
    expect(clip).not.toHaveBeenCalled();
    expect(useApp.getState().showToast).toHaveBeenLastCalledWith('Couldn\'t read the definition');
  });

  test('the clipboard refusing it (over 16 MB): no "Copied"', async () => {
    api.ddl = vi.fn(async () => ({ ok: true, value: DEF }));
    clip.mockResolvedValueOnce(false);
    run(fnMenu(C, fn), 'copy-definition');
    await settle();
    expect(useApp.getState().showToast).not.toHaveBeenCalledWith('Copied', undefined, 'info');
  });
});

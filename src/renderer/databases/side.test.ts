import { describe, expect, test, vi } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbCatalog, type DbConnState, type DbConnView, type DbConnection, type DbProblem, type DbProblemKind, type DbSnapshot } from '@shared/databases';
import {
  DEFAULT_FOLDED, ROW_CAP, capRows, catalogLists, connSub, connectOnShow, endpointOf, foldedOf, formOf, navNext, noteFor, pastedSheet, problemActions,
  problemParts, sameCatalog, sameEnum, sameFn, sameRel, selectSql, sqlName, stateDot, switchForm, tlsOf, toggleFold
} from './side';
import { Catalog, Fold } from './Catalog';

// The Databases sidebar's pure helpers.

const C = 'c0123456789ab';
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme_dev', user: 'app', tls: 'prefer',
  ssh: null, scope: { kind: 'project', root: '/p' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (state: DbConnState, o: Partial<DbConnection> = {}, problem: DbProblem | null = null): DbConnView =>
  ({ conn: conn(o), state, problem, server: null, hasPassword: false, provider: null, held: false });
const snap = (o: Partial<DbSnapshot>): DbSnapshot => ({ ...EMPTY_DB_SNAPSHOT, ...o });

describe('the connection row\'s sub line', () => {
  test('host:port, a socket directory, an IPv6 host in brackets, the SSH hop', () => {
    expect(endpointOf(conn())).toBe('localhost:5432');
    expect(endpointOf(conn({ socket: '/var/run/postgresql' }))).toBe('/var/run/postgresql');
    expect(endpointOf(conn({ host: '::1' }))).toBe('[::1]:5432');
    expect(endpointOf(conn({ host: '10.0.4.12', ssh: { host: 'bastion', port: null, user: '' } }))).toBe('10.0.4.12:5432 · via SSH bastion');
  });

  test('a socket on another port than 5432 says which', () => {
    expect(endpointOf(conn({ socket: '/tmp', port: 6543 }))).toBe('/tmp · :6543');
    expect(endpointOf(conn({ socket: '/tmp', port: 5432 }))).toBe('/tmp');
  });

  test('connected and idle rows show where they point; the state words while connecting, wanting a password, or picked but idle', () => {
    expect(connSub(view('connected'), true)).toBe('localhost:5432');
    expect(connSub(view('idle'), false)).toBe('localhost:5432');
    expect(connSub(view('error'), true)).toBe('localhost:5432');
    expect(connSub(view('idle'), true)).toBe('localhost:5432 · not connected');
    expect(connSub(view('connecting'), false)).toBe('connecting…');
    expect(connSub(view('password'), false)).toBe('needs a password');
  });
});

describe('state dots', () => {
  test('connected green, idle grey, needs a password amber, error rose, connecting busy', () => {
    expect(stateDot(view('connected'))).toBe('ok');
    expect(stateDot(view('idle'))).toBe('idle');
    expect(stateDot(view('password'))).toBe('warn');
    expect(stateDot(view('error'))).toBe('error');
    expect(stateDot(view('connecting'))).toBe('busy');
  });

  test('connected, but its catalog couldn\'t be read: amber (it works, something to look at), not rose (it can\'t connect)', () => {
    expect(stateDot(view('connected', {}, { kind: 'denied', message: "This role can't read pg_class" }))).toBe('warn');
  });
});

describe('the note under a row (static UI: a row never collapses while its own action runs)', () => {
  const p: DbProblem = { kind: 'refused', message: "Can't connect · connection refused localhost:5432" };
  const writer = (o: Partial<DbConnection> = {}): DbConnView => ({ ...view('connected', o), server: { version: '17', versionNum: 170000, tls: false, role: 'app', canWrite: true, latencyMs: 1 } });

  test('what the state asks for: the password field, the problem, the write note, else nothing', () => {
    expect(noteFor(view('password', {}, { kind: 'password', message: 'Needs a password' }), null)).toBe('password');
    expect(noteFor(view('error', {}, p), null)).toBe('problem');
    expect(noteFor(writer(), null)).toBe('write');
    expect(noteFor(writer({ writeNoted: true }), null)).toBeNull();
    for (const s of ['idle', 'connecting', 'connected'] as const) expect(noteFor(view(s), null), s).toBeNull();
  });

  test('its own action pending keeps the note while main says "connecting", whatever comes back', () => {
    expect(noteFor(view('connecting'), 'password')).toBe('password');
    expect(noteFor(view('connecting'), 'problem')).toBe('problem');
    expect(noteFor(view('connected'), 'password')).toBe('password');
    expect(noteFor(view('connected'), null)).toBeNull();
  });

  test('a connected connection whose catalog read failed: not under the row (the catalog says it, with Refresh)', () => {
    expect(noteFor(view('connected', {}, { kind: 'denied', message: 'x' }), null)).toBeNull();
  });
});

describe('the catalog', () => {
  const cat: DbCatalog = {
    connId: C, database: 'acme_dev', databases: ['acme_dev', 'postgres'], noRels: false, schemas: ['public', 'sales'], schema: 'public', readAt: 1, names: [], namesMore: false,
    rels: [
      { schema: 'public', name: 'customers', kind: 'table', estimate: 2118 },
      { schema: 'public', name: 'Orders', kind: 'table', estimate: 48210 },
      { schema: 'public', name: 'paid_orders', kind: 'view', estimate: null },
      { schema: 'public', name: 'daily_sales', kind: 'matview', estimate: 365 }
    ],
    enums: [{ schema: 'public', name: 'order_status', values: ['pending', 'paid'] }],
    functions: [{ schema: 'public', name: 'order_total', args: 'bigint', returns: 'numeric', oid: 1 }]
  };

  test('split by kind in main\'s order', () => {
    const l = catalogLists(cat, '');
    expect(l.tables.map((r) => r.name)).toEqual(['customers', 'Orders']);
    expect(l.views.map((r) => r.name)).toEqual(['paid_orders']);
    expect(l.matviews.map((r) => r.name)).toEqual(['daily_sales']);
    expect(l.enums.map((e) => e.name)).toEqual(['order_status']);
    expect(l.functions.map((f) => f.name)).toEqual(['order_total']);
  });

  test('the filter keeps names holding it, whatever the case, in every section', () => {
    const l = catalogLists(cat, '  ORDER ');
    expect(l.tables.map((r) => r.name)).toEqual(['Orders']);
    expect(l.views.map((r) => r.name)).toEqual(['paid_orders']);
    expect(l.matviews).toEqual([]);
    expect(l.enums.map((e) => e.name)).toEqual(['order_status']);
    expect(l.functions.map((f) => f.name)).toEqual(['order_total']);
  });

  test('folds: Tables open and the rest folded until opened, then remembered per connection', () => {
    expect(foldedOf({}, C)).toEqual(DEFAULT_FOLDED);
    expect(DEFAULT_FOLDED).toEqual(['views', 'matviews', 'enums', 'functions']);
    const opened = toggleFold({}, C, 'views');
    expect(opened[C]).toEqual(['matviews', 'enums', 'functions']);
    const folded = toggleFold(opened, C, 'tables');
    expect(folded[C]).toEqual(['matviews', 'enums', 'functions', 'tables']);
    expect(toggleFold(folded, 'cother0000000', 'enums')).toEqual({ ...folded, cother0000000: ['views', 'matviews', 'functions'] });
  });

  test('a section shows at most 500 rows until Show all (the filter is the fast way in)', () => {
    expect(ROW_CAP).toBe(500);
    const rows = Array.from({ length: 1204 }, (_, i) => i);
    expect(capRows(rows, false)).toEqual({ shown: rows.slice(0, 500), more: 704 });
    expect(capRows(rows, true)).toEqual({ shown: rows, more: 0 });
    expect(capRows(rows.slice(0, 500), false)).toEqual({ shown: rows.slice(0, 500), more: 0 });
    const few = [1, 2];
    expect(capRows(few, false).shown).toBe(few);
  });

  test('rows re-render only when what they show changed, not because main sent a new snapshot', () => {
    const r = cat.rels[0]!;
    expect(sameRel(r, { ...r })).toBe(true);
    expect(sameRel(r, { ...r, estimate: 2119 })).toBe(false);
    expect(sameRel({ ...r, partitions: 3 }, { ...r, partitions: 4 })).toBe(false);
    const e = cat.enums[0]!;
    expect(sameEnum(e, { ...e, values: [...e.values] })).toBe(true);
    expect(sameEnum(e, { ...e, values: [...e.values, 'shipped'] })).toBe(false);
    const f = cat.functions[0]!;
    expect(sameFn(f, { ...f })).toBe(true);
    expect(sameFn(f, { ...f, returns: 'bigint' })).toBe(false);
  });

  test('the catalog and its folds re-render only when what they show changed, not on another connection\'s broadcast', () => {
    // A copy, as main's next snapshot carries it.
    const copy = (c: DbCatalog): DbCatalog => JSON.parse(JSON.stringify(c)) as DbCatalog;
    expect(sameCatalog(cat, copy(cat))).toBe(true);
    // The palette's names aren't the sidebar's.
    expect(sameCatalog(cat, { ...copy(cat), names: [{ schema: 'sales', name: 'x', kind: 'table' }], namesMore: true })).toBe(true);
    for (const changed of [
      { ...copy(cat), connId: 'cother0000000' }, { ...copy(cat), schema: 'sales' }, { ...copy(cat), schemas: ['public'] },
      { ...copy(cat), rels: cat.rels.map((r, i) => (i === 1 ? { ...r, estimate: 48211 } : r)) }, { ...copy(cat), rels: cat.rels.slice(1) },
      { ...copy(cat), enums: [] }, { ...copy(cat), functions: [{ ...cat.functions[0]!, args: 'integer' }] },
      // The database chip and the empty database's hint.
      { ...copy(cat), database: 'postgres' }, { ...copy(cat), databases: ['acme_dev'] }, { ...copy(cat), noRels: true }
    ]) expect(sameCatalog(cat, changed), JSON.stringify(changed).slice(0, 80)).toBe(false);
    // The components themselves are memoized on that: Catalog by its catalog, a fold's head by its props.
    const memoOf = (c: unknown) => c as { $$typeof: symbol; compare: ((a: unknown, b: unknown) => boolean) | null };
    expect(memoOf(Catalog).$$typeof).toBe(Symbol.for('react.memo'));
    expect(memoOf(Catalog).compare?.({ cat }, { cat: copy(cat) })).toBe(true);
    expect(memoOf(Catalog).compare?.({ cat }, { cat: { ...copy(cat), schema: 'sales' } })).toBe(false);
    expect(memoOf(Fold).$$typeof).toBe(Symbol.for('react.memo'));
  });
});

describe('problems and what to do about them', () => {
  test('a message with a dot splits into its title and the mono detail; others are the title alone', () => {
    expect(problemParts({ kind: 'refused', message: "Can't connect · connection refused localhost:5432", code: 'ECONNREFUSED' }))
      .toEqual({ title: "Can't connect", detail: 'connection refused localhost:5432', code: null });
    expect(problemParts({ kind: 'host', message: 'Host not found: db.example.com' })).toEqual({ title: 'Host not found: db.example.com', detail: null, code: null });
  });

  test('Postgres\'s own message ("other") whole, its detail and SQLSTATE; a certificate\'s raw reason as the detail', () => {
    expect(problemParts({ kind: 'other', message: 'relation · broken', detail: 'Key (id)=(1) is still referenced.', code: '55000' }))
      .toEqual({ title: 'relation · broken', detail: 'Key (id)=(1) is still referenced.', code: '55000' });
    expect(problemParts({ kind: 'other', message: 'something odd' })).toEqual({ title: 'something odd', detail: null, code: null });
    expect(problemParts({ kind: 'cert', message: "The certificate isn't trusted (self-signed)", detail: 'self-signed certificate in certificate chain', code: 'SELF_SIGNED_CERT_IN_CHAIN' }))
      .toEqual({ title: "The certificate isn't trusted (self-signed)", detail: 'self-signed certificate in certificate chain', code: null });
  });

  test('each cause gets its action', () => {
    const want: Partial<Record<DbProblemKind, string[]>> = {
      refused: ['retry'], host: ['edit'], timeout: ['retry'], nodb: ['edit'], toomany: ['retry'], notls: ['tlsOff'], needtls: ['useTls'],
      cert: ['useRequire'], ssh: ['edit'], gone: ['refresh'], lost: [], other: ['retry'], auth: [], password: []
    };
    for (const [kind, actions] of Object.entries(want)) expect(problemActions(kind as DbProblemKind), kind).toEqual(actions);
  });

  test('the TLS fixes: Turn TLS Off, Use TLS and Use Require', () => {
    expect(tlsOf('tlsOff')).toBe('off');
    expect(tlsOf('useTls')).toBe('require');
    expect(tlsOf('useRequire')).toBe('require');
  });

  test('a fix saves the connection as the form the API takes, exactly: nothing more, nested values copied', () => {
    const c = conn({ ssh: { host: 'bastion', port: 2222, user: 'deploy' }, schema: 'sales', mask: true, writeNoted: true });
    const f = formOf(c, 'off');
    expect(f).toEqual({
      name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme_dev', user: 'app', tls: 'off',
      ssh: { host: 'bastion', port: 2222, user: 'deploy' }, scope: { kind: 'project', root: '/p' }
    });
    expect(Object.keys(f).sort()).toEqual(['database', 'engine', 'env', 'host', 'name', 'port', 'scope', 'ssh', 'tls', 'user']);
    expect(f.ssh).not.toBe(c.ssh);
    expect(f.scope).not.toBe(c.scope);
    expect(formOf(conn({ socket: '/tmp', scope: { kind: 'all' } }), 'require')).toMatchObject({ socket: '/tmp', scope: { kind: 'all' }, ssh: null, tls: 'require' });
  });

  test('another database is the exact form with that database; a name that was the database\'s follows it, any other stays', () => {
    const c = conn({ name: 'postgres', database: 'postgres', host: '127.0.0.1', user: 'postgres', ssh: { host: 'bastion', port: null, user: '' }, schema: 'sales', mask: true });
    const f = switchForm(c, 'acme');
    expect(f).toEqual({
      name: 'acme', engine: 'postgres', env: 'local', host: '127.0.0.1', port: 5432, database: 'acme', user: 'postgres', tls: 'prefer',
      ssh: { host: 'bastion', port: null, user: '' }, scope: { kind: 'project', root: '/p' }
    });
    expect(Object.keys(f).sort()).toEqual(['database', 'engine', 'env', 'host', 'name', 'port', 'scope', 'ssh', 'tls', 'user']);
    // A provider's default name ("Neon · main") follows too; a name of their own never changes.
    expect(switchForm(conn({ host: 'ep-1.eu.aws.neon.tech', name: 'Neon · main', database: 'main' }), 'analytics').name).toBe('Neon · analytics');
    expect(switchForm(conn({ name: 'Local Postgres :5432', database: 'postgres' }), 'acme').name).toBe('Local Postgres :5432');
    expect(switchForm(conn({ name: 'shop (mine)', database: 'shop' }), 'acme')).toMatchObject({ name: 'shop (mine)', database: 'acme', tls: 'prefer' });
    expect(switchForm(conn({ socket: '/tmp' }), 'acme')).toMatchObject({ socket: '/tmp', database: 'acme' });
  });
});

describe('⌘V with a connection URL', () => {
  test('a postgres:// text opens Add Connection at its form, with what the URL holds and its password', () => {
    expect(pastedSheet('  postgres://app:s3cret@db.example.com:6543/acme?sslmode=require \n')).toEqual({
      kind: 'add', step: 2, password: 's3cret', form: { host: 'db.example.com', port: 6543, database: 'acme', user: 'app', tls: 'require' }
    });
    // A socket form has no host: host= wins over the URL's host, as libpq reads it.
    expect(pastedSheet('postgresql://localhost/acme?host=/var/run/postgresql')).toEqual({
      kind: 'add', step: 2, form: { host: '', port: 5432, database: 'acme', user: '', socket: '/var/run/postgresql' }
    });
  });

  test('anything else is not a connection URL', () => {
    expect(pastedSheet('orders')).toBeNull();
    expect(pastedSheet('mysql://root@localhost/app')).toBeNull();
    expect(pastedSheet('')).toBeNull();
  });
});

describe('copies', () => {
  test('names as SQL: plain lowercase names as they are, anything else quoted, a reserved word too', () => {
    expect(sqlName('public', 'orders')).toBe('public.orders');
    expect(sqlName('public', 'Order "Items"')).toBe('public."Order ""Items"""');
    expect(sqlName('Sales', 'order_items')).toBe('"Sales".order_items');
    expect(sqlName('user', 'select')).toBe('"user"."select"');
    expect(sqlName('a b', 'Kunden')).toBe('"a b"."Kunden"');
  });

  test('Copy SELECT reads a first page, never the whole table', () => {
    expect(selectSql('public', 'orders')).toBe('SELECT * FROM public.orders LIMIT 100;');
  });
});

test('↑/↓ in the list: one row at a time, stopping at the ends', () => {
  expect(navNext(3, 0, 'ArrowDown')).toBe(1);
  expect(navNext(3, 2, 'ArrowDown')).toBeNull();
  expect(navNext(3, 1, 'ArrowUp')).toBe(0);
  expect(navNext(3, 0, 'ArrowUp')).toBeNull();
  expect(navNext(0, -1, 'ArrowDown', 0)).toBeNull();
  expect(navNext(3, 1, 'Home')).toBe(0);
  expect(navNext(3, 1, 'End')).toBe(2);
});

test('from outside the rows (the filter, a note\'s button, the sidebar itself) ↓/↑ go to the nearest row, not the top', () => {
  // `before`: how many rows come before the focused element.
  expect(navNext(6, -1, 'ArrowDown', 2)).toBe(2);
  expect(navNext(6, -1, 'ArrowUp', 2)).toBe(1);
  expect(navNext(6, -1, 'ArrowUp', 0)).toBeNull();
  expect(navNext(6, -1, 'ArrowDown', 6)).toBeNull();
  // The sidebar itself: ↓ the first row, ↑ the last.
  expect(navNext(6, -1, 'ArrowDown', 0)).toBe(0);
  expect(navNext(6, -1, 'ArrowUp', 6)).toBe(5);
});

describe('showing the view connects the remembered pick once', () => {
  const picked = (state: DbConnState, problem: DbProblem | null = null) => snap({ selected: C, connections: [view(state, {}, problem)] });

  test('an idle pick with no problem: connect, once, and only once main has answered', () => {
    const connect = vi.fn();
    const shown = connectOnShow(connect);
    shown(picked('idle'), false);
    expect(connect).not.toHaveBeenCalled();
    shown(picked('idle'), true);
    expect(connect).toHaveBeenCalledWith(C);
    shown(picked('idle'), true);
    shown(picked('idle'), true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test('nothing else connects: no pick, a pick already connected or connecting, one with a problem, a password wanted', () => {
    for (const s of [snap({}), picked('connected'), picked('connecting'), picked('password'), picked('error', { kind: 'refused', message: 'x' }),
      picked('idle', { kind: 'refused', message: 'x' }), snap({ selected: 'cgone00000000', connections: [view('idle')] })]) {
      const connect = vi.fn();
      connectOnShow(connect)(s, true);
      expect(connect, JSON.stringify(s.connections.map((c) => c.state))).not.toHaveBeenCalled();
    }
  });

  test('decided on the first snapshot: a pick going idle later is left alone (Disconnect stays disconnected)', () => {
    const connect = vi.fn();
    const shown = connectOnShow(connect);
    shown(picked('connected'), true);
    shown(picked('idle'), true);
    expect(connect).not.toHaveBeenCalled();
  });

  test('a pick the user disconnected stays closed when the user comes back to the view — main\'s hold, from any window', () => {
    const connect = vi.fn();
    const held = snap({ selected: C, connections: [{ ...view('idle'), held: true }] });
    connectOnShow(connect)(held, true);
    expect(connect).not.toHaveBeenCalled();
    connectOnShow(connect)(picked('idle'), true);
    expect(connect).toHaveBeenCalledWith(C);
  });
});

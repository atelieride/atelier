import { describe, expect, test } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbConnState, type DbConnView, type DbConnection, type DbScope, type DbSnapshot } from '@shared/databases';
import { databasesShown, dbFoot, envClass, groupConnections, liveConn } from './view';

const conn = (id: string, scope: DbScope = { kind: 'project', root: '/p' }): DbConnection => ({
  id, name: id, engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: id, user: 'app', tls: 'prefer', ssh: null,
  scope, mask: false, writeNoted: false, createdAt: 0
});
const view = (id: string, o: { state?: DbConnState; scope?: DbScope } = {}): DbConnView => ({
  conn: conn(id, o.scope), state: o.state ?? 'idle', problem: null, server: null, hasPassword: false, provider: null, held: false
});
const snap = (o: Partial<DbSnapshot>): DbSnapshot => ({ ...EMPTY_DB_SNAPSHOT, ...o });

describe('visibility (no automatic discovery)', () => {
  test('Auto: a saved connection this window can see — this project\'s or every project\'s —, nothing else', () => {
    expect(databasesShown('auto', snap({}))).toBe(false);
    expect(databasesShown('auto', null)).toBe(false);
    expect(databasesShown('auto', snap({ connections: [view('a')] }))).toBe(true);
    expect(databasesShown('auto', snap({ connections: [view('g', { scope: { kind: 'all' } })] }))).toBe(true);
    // The snapshot says nothing of the project's files any more: no suggestions, no "mentions Postgres".
    expect(Object.keys(EMPTY_DB_SNAPSHOT).sort()).toEqual(['catalog', 'connections', 'selected']);
  });

  test('Always shows it even before the first snapshot; Never hides it whatever is saved', () => {
    expect(databasesShown('always', null)).toBe(true);
    expect(databasesShown('always', snap({}))).toBe(true);
    expect(databasesShown('never', snap({ connections: [view('a')] }))).toBe(false);
    expect(databasesShown('never', null)).toBe(false);
  });
});

describe('environment tags', () => {
  test('one class per environment: Local green, Dev sky, Staging violet, Prod the danger color', () => {
    expect(envClass('local')).toBe('is-local');
    expect(envClass('dev')).toBe('is-dev');
    expect(envClass('staging')).toBe('is-staging');
    expect(envClass('prod')).toBe('is-prod');
  });
});

describe('connections by scope ("This project" / "Every project")', () => {
  test('this project\'s connections, then those shown in every project, each in the order main sent', () => {
    const a = view('a');
    const g = view('g', { scope: { kind: 'all' } });
    const b = view('b');
    const h = view('h', { scope: { kind: 'all' } });
    expect(groupConnections([a, g, b, h], '/p')).toEqual({ project: [a, b], all: [g, h] });
  });

  test('a connection of another project is in neither list; without a project only the shared ones show', () => {
    const other = view('o', { scope: { kind: 'project', root: '/elsewhere' } });
    const g = view('g', { scope: { kind: 'all' } });
    expect(groupConnections([other, g], '/p')).toEqual({ project: [], all: [g] });
    expect(groupConnections([view('a'), g], null)).toEqual({ project: [], all: [g] });
  });

  test('nothing in, nothing out', () => {
    expect(groupConnections([], '/p')).toEqual({ project: [], all: [] });
  });
});

describe('the connection in use (the footer, the palette\'s Overview and tables)', () => {
  const picked = (state: DbConnState, o: Partial<DbSnapshot> = {}) => snap({ connections: [view('a'), view('b', { state })], selected: 'b', ...o });

  test('the selected connection while it is connected', () => {
    const s = picked('connected');
    expect(liveConn('auto', s)).toBe(s.connections[1]);
    expect(liveConn('always', s)).toBe(s.connections[1]);
  });

  test('none while it connects, wants a password, failed or sits idle; none selected or the selection not listed here', () => {
    for (const st of ['idle', 'connecting', 'password', 'error'] as const) expect(liveConn('auto', picked(st)), st).toBeNull();
    expect(liveConn('auto', picked('connected', { selected: null }))).toBeNull();
    expect(liveConn('auto', picked('connected', { selected: 'gone' }))).toBeNull();
    // Another connection connected is not the one the footer names.
    expect(liveConn('auto', snap({ connections: [view('a', { state: 'connected' }), view('b')], selected: 'b' }))).toBeNull();
  });

  test('Never: none, whatever is connected', () => {
    expect(liveConn('never', picked('connected'))).toBeNull();
  });
});

describe('the footer item (`pg · <selected connection>`, danger color for production)', () => {
  const one = (o: Partial<DbConnection> = {}) => {
    const v = view('acme_dev', { state: 'connected' });
    return { ...v, conn: { ...v.conn, ...o } };
  };

  test('the name; the tooltip says which connection, where it points and that it is connected', () => {
    expect(dbFoot(one())).toEqual({ name: 'acme_dev', tip: 'acme_dev · localhost:5432 · connected', prod: false });
    expect(dbFoot(one({ name: 'acme · production', env: 'prod', host: 'db.acme.test', port: 6543 }))).toEqual({ name: 'acme · production', tip: 'acme · production · db.acme.test:6543 · connected', prod: true });
    for (const env of ['local', 'dev', 'staging'] as const) expect(dbFoot(one({ env }))?.prod, env).toBe(false);
  });

  test('an IPv6 host in brackets, a socket directory as it is (with its port when not 5432)', () => {
    expect(dbFoot(one({ host: '::1' }))?.tip).toBe('acme_dev · [::1]:5432 · connected');
    expect(dbFoot(one({ host: '', socket: '/tmp' }))?.tip).toBe('acme_dev · /tmp · connected');
    // As the sidebar's sub line writes it.
    expect(dbFoot(one({ host: '', socket: '/tmp', port: 5433 }))?.tip).toBe('acme_dev · /tmp · :5433 · connected');
  });

  test('none without a connection in use', () => {
    expect(dbFoot(null)).toBeNull();
  });
});

import { describe, expect, test, vi } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbConnView, type DbRel } from '@shared/databases';
import { useApp } from '../store';
import { dbConnsIf, dbRefOfKey, dbTabKey, dbTabLabel, dbTabTip, openDbOverview, parseDbTabKey, shownDbTabsIf, type DbTabRef } from './tabs';

// Table tabs: keys, labels and tooltips (pure), and the overview's opener.

const C = 'c0123456789ab';
const D = 'c00000000000d';

describe('keys', () => {
  test.each([['public', 'orders'], ['sales', 'Order "Items"'], ['public', 'a/b'], ['ü', 'tëst ü'], ['we ird', '%41'], ['x', "o'k (1)!*~"]])('%s.%s round-trips', (schema, name) => {
    const key = dbTabKey(C, schema, name);
    expect(key.startsWith(`db:${C}/`)).toBe(true);
    // One part per segment: a slash in a name never makes a fourth one.
    expect(key.split('/')).toHaveLength(3);
    expect(parseDbTabKey(key)).toEqual({ connId: C, schema, name });
  });
  test('each part URI-encoded, exactly', () => {
    expect(dbTabKey(C, 'public', 'Order "Items"')).toBe(`db:${C}/public/Order%20%22Items%22`);
    expect(dbTabKey(C, 'public', 'a/b')).toBe(`db:${C}/public/a%2Fb`);
    expect(dbTabKey(C, 'public', 'ü')).toBe(`db:${C}/public/%C3%BC`);
  });
  test('the overview is the connection\'s own key', () => {
    expect(dbTabKey(C)).toBe(`db:${C}`);
    expect(parseDbTabKey(`db:${C}`)).toEqual({ connId: C, schema: null, name: null });
  });
  test('junk is no key', () => {
    for (const k of [
      '', 'db:', `db:${C}/`, `db:${C}/public`, `db:${C}/public/`, `db:${C}//orders`, `db:${C}/public/a/b`, 'db:c123/public/orders', `t:${C}`, `f:/db:${C}/a/b`,
      `db:${C}/public/%FF`, `db:${C}/public/%E2%82`, `db:${C}/public/a%00b`, `db:${C}/public/${'x'.repeat(129)}`, `db:${C}/public/${'%C3%BC'.repeat(60)}`
    ]) expect(parseDbTabKey(k), k).toBeNull();
  });
});

const ref = (o: Partial<DbTabRef> & { connId?: string; schema?: string; name?: string }): DbTabRef => {
  const connId = o.connId ?? C;
  const schema = o.schema ?? 'public';
  const name = o.name ?? 'orders';
  const kind = o.kind ?? 'table';
  return { key: kind === 'overview' ? dbTabKey(connId) : dbTabKey(connId, schema, name), connId, schema: kind === 'overview' ? '' : schema, name: kind === 'overview' ? '' : name, kind, view: o.view ?? 'data' };
};
const names: Record<string, string> = { [C]: 'acme_dev', [D]: 'acme · production' };
const connName = (id: string) => names[id] ?? '';

describe('labels', () => {
  test('the table\'s name alone while no other open tab has it', () => {
    const a = ref({ name: 'orders' });
    expect(dbTabLabel(a, [a, ref({ name: 'customers' })], connName)).toBe('orders');
  });
  test('the same name from another connection adds the connection; from another schema, the schema', () => {
    const a = ref({ name: 'orders' });
    const b = ref({ connId: D, name: 'orders' });
    expect(dbTabLabel(a, [a, b], connName)).toBe('orders · acme_dev');
    expect(dbTabLabel(b, [a, b], connName)).toBe('orders · acme · production');
    const c = ref({ schema: 'sales', name: 'orders' });
    expect(dbTabLabel(a, [a, c], connName)).toBe('orders · public');
    expect(dbTabLabel(c, [a, c], connName)).toBe('orders · sales');
    // Both: each part that tells them apart.
    expect(dbTabLabel(a, [a, b, c], connName)).toBe('orders · acme_dev · public');
    expect(dbTabLabel(b, [a, b, c], connName)).toBe('orders · acme · production');
  });
  test('the overview is named by its connection, never compared with tables; unknown connection: Overview', () => {
    const o = ref({ kind: 'overview' });
    const t = ref({ name: 'acme_dev' });
    expect(dbTabLabel(o, [o, t], connName)).toBe('acme_dev');
    expect(dbTabLabel(t, [o, t], connName)).toBe('acme_dev');
    expect(dbTabLabel(ref({ kind: 'overview', connId: 'c99999999999f' }), [], connName)).toBe('Overview');
  });
  test('tooltip: connection · schema.name; the overview\'s says so', () => {
    expect(dbTabTip(ref({ schema: 'sales', name: 'orders' }), connName)).toBe('acme_dev · sales.orders');
    expect(dbTabTip(ref({ connId: 'c99999999999f' }), connName)).toBe('public.orders');
    expect(dbTabTip(ref({ kind: 'overview' }), connName)).toBe('acme_dev · Overview');
  });
});

describe('what a strip or a header reads (selectors)', () => {
  const orders = ref({ name: 'orders' });
  const hidden = ref({ connId: D, name: 'orders' });
  const snap = (connections: DbConnView[]) => ({ snap: { ...EMPTY_DB_SNAPSHOT, connections } });
  test('with no table tab of its own: the same empty list every time, whatever the table tabs or the snapshot', () => {
    const a = shownDbTabsIf(false)({ dbTabs: [orders], tabOrder: [orders.key] });
    expect(a).toEqual([]);
    expect(shownDbTabsIf(false)({ dbTabs: [orders, hidden], tabOrder: [] })).toBe(a);
    const c = dbConnsIf(false)(snap([{ conn: { id: C } } as DbConnView]));
    expect(c).toEqual([]);
    expect(dbConnsIf(false)(snap([]))).toBe(c);
  });
  test('with one: the table tabs this window shows now (its strip and panes, never another workspace\'s); the connections', () => {
    expect(shownDbTabsIf(true)({ dbTabs: [orders, hidden], tabOrder: ['t:a', orders.key] })).toEqual([orders]);
    const s = snap([{ conn: { id: C } } as DbConnView]);
    expect(dbConnsIf(true)(s)).toBe(s.snap.connections);
  });
});

describe('a key back into a tab (a restore, a pop-out)', () => {
  const rels: DbRel[] = [{ schema: 'public', name: 'paid', kind: 'view', estimate: null }, { schema: 'public', name: 'daily', kind: 'matview', estimate: 3 }];
  test('its names from the key; its kind from the catalog when it lists it, else a table; the overview\'s own', () => {
    expect(dbRefOfKey(dbTabKey(C, 'public', 'orders'))).toEqual(ref({}));
    expect(dbRefOfKey(dbTabKey(C, 'public', 'paid'), { rels, connId: C })).toEqual(ref({ name: 'paid', kind: 'view' }));
    expect(dbRefOfKey(dbTabKey(C, 'public', 'daily'), { rels, connId: C })).toEqual(ref({ name: 'daily', kind: 'matview' }));
    // Another connection's catalog says nothing about this one.
    expect(dbRefOfKey(dbTabKey(C, 'public', 'paid'), { rels, connId: D })).toEqual(ref({ name: 'paid' }));
    expect(dbRefOfKey(dbTabKey(C))).toEqual(ref({ kind: 'overview' }));
    expect(dbRefOfKey(dbTabKey(C, 'public', 'orders'), null, 'relations')).toEqual(ref({ view: 'relations' }));
    expect(dbRefOfKey('db:nope')).toBeNull();
  });
});

describe('the overview tab: one way to open it, for the sidebar\'s menu and the palette', () => {
  test('openDbOverview opens the connection\'s overview, kept', () => {
    const open = vi.fn();
    useApp.setState({ openDbTab: open });
    try {
      openDbOverview(C);
      expect(open).toHaveBeenCalledWith({ connId: C, schema: '', name: '', kind: 'overview', view: 'data' }, { preview: false });
    } finally {
      useApp.setState(useApp.getInitialState(), true);
    }
  });
});

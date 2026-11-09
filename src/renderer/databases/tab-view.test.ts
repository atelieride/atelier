import { afterEach, beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbConnView, type DbEnv } from '@shared/databases';
import { useDb } from './store';
import { DbTabView } from './DbTabView';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// A table tab's view: the table (its toolbar, rows and footer: table-markup.test.ts), the overview (its own markup:
// overview-markup.test.ts), and a connection this window doesn't show said calmly — never before main's first snapshot.

const C = 'c0123456789ab';
const ORDERS: DbTabRef = { key: `db:${C}/sales/orders`, connId: C, schema: 'sales', name: 'orders', kind: 'table', view: 'data' };
const conn = (env: DbEnv) => ({
  conn: { id: C, name: 'acme_dev', env, host: 'localhost', port: 5432, database: 'acme', ssh: null, mask: false, scope: { kind: 'all' } },
  state: 'idle', problem: null, server: null, hasPassword: false, provider: null
}) as unknown as DbConnView;

const render = (tab: DbTabRef = ORDERS) => live(createElement(DbTabView, { tab, visible: true }));

beforeEach(() => useDb.setState({ snap: EMPTY_DB_SNAPSHOT, loaded: false }));
afterEach(() => useDb.setState(useDb.getInitialState(), true));

test('a table: its table view (the toolbar\'s crumb), the tab named for screen readers', () => {
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [conn('local')] } });
  const html = render();
  expect(html).toContain('<span class="dbt-crumb-conn">acme_dev</span>');
  expect(html).toContain('<b class="dbt-crumb-name">orders</b>');
  expect(html).toContain('data-tip="acme_dev / sales / orders"');
  expect(html).toContain('aria-label="acme_dev · sales.orders"');
  expect(html).not.toContain('is-prod');
  expect(html).not.toContain(t('unavailable'));
});

test('before main\'s first snapshot a table waits in its view (the crumb from the key), never "isn\'t available"', () => {
  const html = render();
  expect(html).toContain('<b class="dbt-crumb-name">orders</b>');
  expect(html).not.toContain(t('unavailable'));
});

test('production: the view carries the danger hairline\'s class', () => {
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [conn('prod')] } });
  expect(render()).toMatch(/^<section class="dk-view db-tab is-prod"/);
});

test('a connection this window doesn\'t show: said calmly, with what the tab was; never before the first snapshot', () => {
  expect(render()).not.toContain(t('unavailable'));
  useDb.setState({ loaded: true });
  const html = render();
  expect(html).toContain(t('unavailable'));
  expect(html).toContain('It belongs to another project, or it was removed.');
  expect(html).toContain('sales.orders');
  expect(html).toMatch(/^<section class="dk-view db-tab is-missing"/);
});

test('the overview: named by its connection', () => {
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [conn('dev')] } });
  const html = render({ key: `db:${C}`, connId: C, schema: '', name: '', kind: 'overview', view: 'data' });
  expect(html).toContain('<h2 class="dbo-name" data-tip="acme_dev">acme_dev</h2>');
  expect(html).toContain('aria-label="acme_dev · Overview"');
  expect(html).not.toContain('dbt-crumb');
});

test('hidden while another tab is in front', () => {
  expect(live(createElement(DbTabView, { tab: ORDERS, visible: false }))).toContain('display:none');
});

function t(which: 'unavailable'): string {
  return which === 'unavailable' ? 'This connection isn’t available here' : '';
}

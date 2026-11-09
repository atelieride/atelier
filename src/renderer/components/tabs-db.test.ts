import { afterEach, beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbConnView, type DbEnv } from '@shared/databases';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from '../store';
import { single } from '../split';
import { useDb } from '../databases/store';
import type { DbTabRef } from '../databases/tabs';
import { renderLive as live } from '../databases/test-render';
import { tabMenu } from '../menus';
import type { MenuItem } from '../menu-model';
import { PaneStrip, keepTabOpen } from './Tabs';
import { PaneHeader } from './PaneHeader';

// Table tabs in the strip: kind icon, mono name, environment dot, production frame, italic
// while the table preview; labels told apart among the tabs this window shows; double click and Keep Open keep it.

const PROD = 'c0000000000a1';
const LOCAL = 'c0000000000b2';
const ORDERS: DbTabRef = { key: `db:${PROD}/public/orders`, connId: PROD, schema: 'public', name: 'orders', kind: 'table', view: 'data' };
const DAILY: DbTabRef = { key: `db:${LOCAL}/public/daily`, connId: LOCAL, schema: 'public', name: 'daily', kind: 'matview', view: 'data' };
// Another workspace's tab with the same name: not in this strip, so never a reason to add " · <connection>".
const HIDDEN: DbTabRef = { key: `db:${LOCAL}/public/orders`, connId: LOCAL, schema: 'public', name: 'orders', kind: 'table', view: 'data' };
const conn = (id: string, name: string, env: DbEnv) => ({ conn: { id, name, env, scope: { kind: 'all' } }, state: 'idle', problem: null, server: null, hasPassword: false, provider: null }) as unknown as DbConnView;
const term: TerminalInfo = { id: 'a', projectRoot: '/p', cwd: '/p', title: 'a', name: null, color: '#fff', foreground: 'zsh', createdAt: 0, session: null };

/** The markup of one tab of the strip: from its opening tag to the next tab's. */
function tabOf(html: string, key: string): string {
  const at = html.indexOf(`data-key="${key}"`);
  expect(at, key).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div role="tab"', at);
  const next = html.indexOf('<div role="tab"', at);
  return html.slice(start, next === -1 ? undefined : next);
}
const strip = () => live(createElement(PaneStrip, { pane: 0, split: false, last: false, onNew: () => {} }));

beforeEach(() => {
  useApp.setState({
    project: null, popout: null, poppedOut: [], terminals: [term], selectedId: 'a', starting: {}, openFiles: [], preview: null, split: single(), ws: null,
    tabOrder: ['t:a', ORDERS.key, DAILY.key], dbTabs: [ORDERS, DAILY, HIDDEN], dbPreview: ORDERS.key, activeTab: ORDERS.key, tabDrag: null, dockHover: null
  });
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [conn(PROD, 'acme · production', 'prod'), conn(LOCAL, 'acme_dev', 'local')] } });
});
afterEach(() => {
  useApp.setState({ tabOrder: [], dbTabs: [], dbPreview: null, activeTab: 'term', terminals: [], selectedId: null });
  useDb.setState(useDb.getInitialState(), true);
});

test('a production table in front, as the preview: framed, its dot in the danger color, italic, its kind and tooltip', () => {
  const tab = tabOf(strip(), ORDERS.key);
  expect(tab).toMatch(/class="tab is-active [^"]*is-preview[^"]* is-db is-prod"/);
  expect(tab).toContain('<span class="tab-db" role="img" aria-label="Table">');
  expect(tab).toContain('<span class="tab-name">orders</span>');
  expect(tab).toContain('<i class="tab-env is-prod" aria-hidden="true"></i>');
  expect(tab).toContain('data-tip="acme · production · public.orders"');
});

test('a local materialized view, kept: its own dot, no frame, not italic', () => {
  const tab = tabOf(strip(), DAILY.key);
  expect(tab).toMatch(/class="tab [^"]* is-db"/);
  expect(tab).not.toContain('is-prod');
  expect(tab).not.toContain('is-preview');
  expect(tab).toContain('aria-label="Materialized view"');
  expect(tab).toContain('<i class="tab-env is-local" aria-hidden="true"></i>');
});

test('labels are told apart among the tabs this window shows: another workspace\'s same name adds nothing; one here does', () => {
  expect(tabOf(strip(), ORDERS.key)).toContain('<span class="tab-name">orders</span>');
  useApp.setState({ tabOrder: ['t:a', ORDERS.key, DAILY.key, HIDDEN.key] });
  const html = strip();
  expect(tabOf(html, ORDERS.key)).toContain('<span class="tab-name">orders · acme · production</span>');
  expect(tabOf(html, HIDDEN.key)).toContain('<span class="tab-name">orders · acme_dev</span>');
});

test('a connection this window doesn\'t show: no dot, no frame — the tab stays, named by the table', () => {
  useDb.setState({ snap: EMPTY_DB_SNAPSHOT });
  const tab = tabOf(strip(), ORDERS.key);
  expect(tab).not.toContain('tab-env');
  expect(tab).not.toContain('is-prod');
  expect(tab).toContain('data-tip="public.orders"');
});

test('double click keeps the preview: the table\'s, or the file\'s', () => {
  keepTabOpen(DAILY.key);
  expect(useApp.getState().dbPreview).toBe(ORDERS.key);
  keepTabOpen(ORDERS.key);
  expect(useApp.getState().dbPreview).toBeNull();
  useApp.setState({ preview: '/p/x.ts' });
  keepTabOpen('f:/p/x.ts');
  expect(useApp.getState().preview).toBeNull();
});

test('the tab menu: Keep Open on the table preview only', () => {
  const keep = (items: MenuItem[]) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === 'keep-open');
  const item = keep(tabMenu(ORDERS.key));
  expect(item?.label).toBe('Keep Open');
  expect(keep(tabMenu(DAILY.key))).toBeUndefined();
  item!.run();
  expect(useApp.getState().dbPreview).toBeNull();
  expect(keep(tabMenu(ORDERS.key))).toBeUndefined();
});

// Databases' strip has no "+" to carry the caret for the end of the strip.
test('a tab dragged to the end of a strip with no "+": the drop caret still shows after the last tab', () => {
  useApp.setState({ space: 'databases', tabOrder: [ORDERS.key, DAILY.key], tabDrag: ORDERS.key, tabDragTarget: { kind: 'strip', pane: 0, before: null } });
  try {
    const html = strip();
    expect(html).not.toContain('class="tab-new');
    expect(html).toContain('<span class="tab-end is-drop" aria-hidden="true"></span>');
    // Nothing dragged: no caret.
    useApp.setState({ tabDrag: null, tabDragTarget: null });
    expect(strip()).not.toContain('tab-end');
  } finally { useApp.setState({ space: 'sessions', tabDrag: null, tabDragTarget: null }); }
});

test('a popped-out table\'s bar: its kind, its label, and the tab\'s tooltip', () => {
  useApp.setState({ popout: { key: ORDERS.key }, tabOrder: [ORDERS.key], dbTabs: [ORDERS] });
  const html = live(createElement(PaneHeader, { k: ORDERS.key, popout: true }));
  expect(html).toContain('<span class="ph-title" data-tip="acme · production · public.orders">orders</span>');
  useApp.setState({ popout: null });
});

import { afterEach, expect, test } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbConnState, type DbConnView, type DbConnection } from '@shared/databases';
import type { ShowDatabases } from '@shared/settings';
import { DbFootItem } from '../components/Footer';
import { useApp } from '../store';
import { useDb } from './store';
import { renderLive } from './test-render';

// The footer's Databases item: with a connected database in this window, `pg · <selected
// connection>`, in the danger color for production. Markup only (its click and stylesheet: databases-css.test.ts; e2e).

const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: 'c0123456789ab', name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme_dev', user: 'app',
  tls: 'prefer', ssh: null, scope: { kind: 'project', root: '/p' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (state: DbConnState, o: Partial<DbConnection> = {}): DbConnView => ({ conn: conn(o), state, problem: null, server: null, hasPassword: true, provider: null, held: false });
const shown = (v: DbConnView, show: ShowDatabases = 'auto') => {
  useApp.setState({ settings: { ...useApp.getState().settings, showDatabases: show } });
  useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: [v], selected: v.conn.id }, loaded: true });
  return renderLive(DbFootItem);
};

afterEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
});

test('a connected database: a footer button `pg · <name>`, the tooltip naming it, where it points and its state', () => {
  const html = shown(view('connected'));
  expect(html).toMatch(/^<button type="button" class="foot-item db-foot-item is-ok"/);
  expect(html).toContain('data-tip="acme_dev · localhost:5432 · connected"');
  expect(html).toContain('<i></i><span>pg · acme_dev</span>');
});

test('production: the danger color, never the "ok" green', () => {
  const html = shown(view('connected', { env: 'prod', name: 'acme · production' }));
  expect(html).toContain('class="foot-item db-foot-item is-prod"');
  expect(html).toContain('<span>pg · acme · production</span>');
});

test('nothing connected (idle, connecting, a password to type, an error), or Never: no item', () => {
  for (const s of ['idle', 'connecting', 'password', 'error'] as const) expect(shown(view(s)), s).toBe('');
  expect(shown(view('connected'), 'never')).toBe('');
  expect(shown(view('connected'), 'always')).not.toBe('');
});

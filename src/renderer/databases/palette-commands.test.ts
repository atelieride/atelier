import { createElement } from 'react';
import { afterEach, expect, test } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbConnState, type DbConnView, type DbConnection } from '@shared/databases';
import type { ShowDatabases } from '@shared/settings';
import { Palette } from '../components/Palette';
import { useApp } from '../store';
import { useDb } from './store';
import { renderLive } from './test-render';

// The palette's Databases commands: "Databases" (⌃⇧B) and "Databases: Add Connection…" unless
// Never, "Databases: Overview" with a connection connected. Markup of the palette as it opens on `>databases`; the
// table results load with their module (palette.test.ts; lazy: databases-table.test.ts; their rows in the app: e2e).

const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: 'c0123456789ab', name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme_dev', user: 'app',
  tls: 'prefer', ssh: null, scope: { kind: 'project', root: '/p' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (state: DbConnState): DbConnView => ({ conn: conn(), state, problem: null, server: null, hasPassword: true, provider: null, held: false });

function open(show: ShowDatabases, state: DbConnState | null): string[] {
  useApp.setState({ settings: { ...useApp.getState().settings, showDatabases: show }, paletteQuery: '>databases' });
  useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: state ? [view(state)] : [], selected: state ? 'c0123456789ab' : null }, loaded: true });
  const html = renderLive(createElement(Palette, { onNewSession: () => {}, onNewTerminal: () => {} }));
  return [...html.matchAll(/<span class="palette-label[^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]!).filter((l) => l.startsWith('Databases'));
}

afterEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
});

test('Auto or Always: the view and Add Connection…, Overview once a connection is connected (in the search\'s order)', () => {
  expect(open('auto', null)).toEqual(['Databases', 'Databases: Add Connection…']);
  expect(open('always', 'idle')).toEqual(['Databases', 'Databases: Add Connection…']);
  expect(open('auto', 'connected')).toEqual(['Databases', 'Databases: Overview', 'Databases: Add Connection…']);
});

test('Never: none of them', () => {
  expect(open('never', 'connected')).toEqual([]);
});

test('"Databases" shows its key; Overview names the connection it opens', () => {
  useApp.setState({ settings: { ...useApp.getState().settings, showDatabases: 'auto' }, paletteQuery: '>databases' });
  useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: [view('connected')], selected: 'c0123456789ab' }, loaded: true });
  const html = renderLive(createElement(Palette, { onNewSession: () => {}, onNewTerminal: () => {} }));
  expect(html).toMatch(/>Databases<\/span><span class="palette-hint mono">⌃⇧B<\/span>/);
  expect(html).toMatch(/>Databases: Overview<\/span><span class="palette-hint mono">acme_dev<\/span>/);
});

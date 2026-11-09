import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbConnection, type DbPage, type DbStructure } from '@shared/databases';
import type { DbColumn, DbFilter } from '@shared/databases-filters';
import { useApp } from '../store';
import { useFilterUi } from './filter-actions';
import { FilterBar } from './FilterBar';
import { useDb, type DbTabState } from './store';
import { useStruct } from './structure-data';
import { TableView } from './TableView';
import { useTableUi } from './table-view';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// The filter bar under a table tab's toolbar: chips, "+ Filter",
// the Columns chip, the filter popover's steps; markup only (the helpers: filters.test.ts).

const C = 'c0123456789ab';
const KEY = `db:${C}/public/orders` as DbTabRef['key'];
const ORDERS: DbTabRef = { key: KEY, connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'data' };
const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const COLS = [
  col('id', 'int8', 'N', { type: 'bigint', isPk: true, isKey: true, nullable: false }),
  col('email', 'text', 'S'),
  col('status', 'order_status', 'E', { typeSchema: 'public', enumValues: ['pending', 'paid', 'shipped'] }),
  col('payload', 'jsonb', 'U'),
  col('created_at', 'timestamptz', 'D', { type: 'timestamp with time zone' }),
  // Masked with Mask values on (their names match the mask's pattern).
  col('password_set', 'bool', 'B', { type: 'boolean' }),
  col('token_state', 'token_state', 'E', { typeSchema: 'public', enumValues: ['live', 'revoked'] })
];
const page = (o: Partial<DbPage> = {}): DbPage => ({
  columns: COLS, hidden: [], derived: [], ms: 9, sql: 'SELECT 1', pk: ['id'], kind: 'table',
  rows: [[{ v: '1' }, { v: 'a@acme.test' }, { v: 'paid' }, { v: '{}' }, { v: '2026-11-04 18:00:00+01' }, { v: 't' }, { v: 'live' }]], ...o,
  rowKey: o.rowKey ?? o.pk ?? ['id']
});
const st = (o: Partial<DbTabState> = {}): DbTabState => {
  const p = page();
  useDb.getState().patchTab(KEY, { data: p, rows: p.rows, more: 'end', tableCols: COLS, ...o });
  return useDb.getState().tab(KEY);
};
const bar = (o: Partial<DbTabState> = {}, masked = false) => live(createElement(FilterBar, { tab: ORDERS, st: st(o), masked, visible: true }));
const filters = (...f: DbFilter[]) => ({ filters: f });

afterEach(() => {
  useDb.setState(useDb.getInitialState(), true);
  useStruct.setState(useStruct.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
  useFilterUi.setState(useFilterUi.getInitialState(), true);
  useTableUi.setState(useTableUi.getInitialState(), true);
});

describe('the bar', () => {
  test('a chip per filter — column · operator · value, the whole filter in its tooltip —, then "+ Filter"', () => {
    const html = bar(filters({ column: 'created_at', op: 'lastDays', values: ['7'] }, { column: 'status', op: 'notin', values: ['pending'] }));
    expect(html).toContain('role="toolbar" aria-label="Filters"');
    expect(html).toMatch(/<span class="dbt-fchip-col">created_at<\/span><span class="dbt-fchip-op">in the last<\/span><span class="dbt-fchip-val">7 days<\/span>/);
    expect(html).toContain('data-tip="created_at in the last 7 days"');
    expect(html).toMatch(/<span class="dbt-fchip-col">status<\/span><span class="dbt-fchip-op">is none of<\/span><span class="dbt-fchip-val">pending<\/span>/);
    expect(html).toContain('aria-label="Remove filter: status is none of pending"');
    // Its word in a span the narrowest pane folds away (filters.css), its name kept by aria-label.
    expect(html).toMatch(/data-fanchor="add"[^>]*aria-label="Filter"[^>]*>.*<span class="dbt-fadd-label">Filter<\/span><\/button>/);
  });

  test('a filter without a value (is null) has no value part', () => {
    const html = bar(filters({ column: 'email', op: 'null', values: [] }));
    expect(html).toMatch(/<span class="dbt-fchip-col">email<\/span><span class="dbt-fchip-op">is null<\/span><\/button>/);
  });

  test('Mask values: a masked column\'s value is dots in its chip, its tooltip, its label — and in the measuring copies', () => {
    const html = bar(filters({ column: 'email', op: 'eq', values: ['a@acme.test'] }), true);
    expect(html).toContain('<span class="dbt-fchip-val">••••••••</span>');
    expect(html).not.toContain('a@acme.test');
  });

  test('"+ Filter" waits for the columns (nothing read yet), and stops at main\'s 30', () => {
    useDb.getState().patchTab(KEY, {});
    const none = live(createElement(FilterBar, { tab: ORDERS, st: useDb.getState().tab(KEY), masked: false, visible: true }));
    expect(none).toMatch(/<button[^>]*data-fanchor="add"[^>]*disabled=""/);
    const full = bar(filters(...Array.from({ length: 30 }, (_, i): DbFilter => ({ column: 'id', op: 'ne', values: [String(i)] }))));
    expect(full).toMatch(/<button[^>]*data-fanchor="add"[^>]*data-tip="30 filters at most"[^>]*disabled=""/);
  });

  test('the Columns chip: "N of M" with a choice, "M columns" without; it opens a dialog', () => {
    expect(bar()).toMatch(/data-fanchor="columns"[^>]*aria-haspopup="dialog"[^>]*>.*<span class="dbt-cchip-label">7 columns<\/span>/);
    expect(bar({ columns: ['id', 'status'] })).toContain('<span class="dbt-cchip-label">2 of 7</span>');
  });

  test('the first read of every column failed: the Columns chip and "+ Filter" work from the catalog\'s columns', () => {
    const failed = { data: null, rows: [], tableCols: undefined, problem: { kind: 'canceled' as const, message: 'Stopped after 15 s' } };
    const render = () => live(createElement(FilterBar, { tab: ORDERS, st: useDb.getState().tab(KEY), masked: false, visible: true }));
    useDb.getState().patchTab(KEY, failed);
    // Nothing known yet (the catalog's read on its way): the bar waits, as before.
    expect(render()).not.toContain('data-fanchor="columns"');
    useStruct.setState({ tabs: { [KEY]: { structure: { id: 1, loading: false, at: 1, v: { columns: COLS.slice(0, 3).map((c) => ({ ...c, comment: null, identity: false, generated: null, check: null })) } as DbStructure } } } });
    const html = render();
    expect(html).toContain('<span class="dbt-cchip-label">3 columns</span>');
    expect(html).not.toMatch(/<button[^>]*data-fanchor="add"[^>]*disabled=""/);
  });
});

describe('the filter popover', () => {
  test('"+ Filter": the column list first — searchable, each with its type —, nothing to apply yet', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'add', edit: null, target: null } });
    const html = bar();
    expect(html).toMatch(/role="dialog" aria-label="Add a filter"/);
    expect(html).toMatch(/<input[^>]*placeholder="Find a column"/);
    expect(html).toMatch(/role="listbox"/);
    expect(html).toMatch(/role="option"[^>]*>.*<span class="dbt-fcol-name">created_at<\/span><span class="dbt-fcol-type">timestamptz<\/span>/);
    expect(html).not.toContain('>Apply<');
  });

  test('editing a chip: its column, its operator, its values checked (an enum\'s list from the catalog), Remove', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'status', op: 'in', values: ['paid'] }));
    expect(html).toMatch(/role="dialog" aria-label="Edit filter"/);
    expect(html).toMatch(/<option value="in" selected="">is any of<\/option>/);
    expect(html).toMatch(/role="checkbox" aria-checked="true"[^>]*>.*paid/);
    expect(html).toMatch(/role="checkbox" aria-checked="false"[^>]*>.*shipped/);
    expect(html).toContain('>Remove<');
    expect(html).toContain('>Apply<');
  });

  test('a JSON path filter: the path as written, the SQL it reads', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'payload', path: ['data', 'object', 0], op: 'pathEq', values: ['x'] }));
    expect(html).toMatch(/<input[^>]*value="data\.object\[0\]"/);
    expect(html).toContain('&quot;payload&quot; #&gt;&gt; &#x27;{data,object,0}&#x27;');
  });

  test('a masked column\'s value is typed hidden (dots), never shown', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'email', op: 'eq', values: ['a@acme.test'] }), true);
    expect(html).toMatch(/<input[^>]*class="[^"]*is-masked/);
  });

  test('at path exists: the SQL main runs, #> … IS NOT NULL', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'payload', path: ['refund'], op: 'pathExists', values: [] }));
    expect(html).toContain('&quot;payload&quot; #&gt; &#x27;{refund}&#x27; IS NOT NULL');
    expect(html).not.toContain('#&gt;&gt;');
  });

  test('is JSON null: the SQL main runs, the JSON there as jsonb equals the JSON null; the chip says so', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'payload', path: ['refund'], op: 'pathNull', values: [] }));
    expect(html).toContain('(&quot;payload&quot; #&gt; &#x27;{refund}&#x27;)::jsonb = &#x27;null&#x27;::jsonb');
    expect(html).toMatch(/<span class="dbt-fchip-op">at path is JSON null<\/span>/);
    // The operator list says it as its siblings do.
    expect(html).toMatch(/>at path equals<[\s\S]*>at path contains<[\s\S]*>at path exists<[\s\S]*>at path is JSON null</);
  });

  test('Mask values on a boolean: the chip says "is ••••"; its editor has nothing chosen, and says why', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'password_set', op: 'false', values: [] }), true);
    expect(html).toMatch(/<span class="dbt-fchip-col">password_set<\/span><span class="dbt-fchip-op">is<\/span><span class="dbt-fchip-val">••••••••<\/span>/);
    expect(html).not.toContain('is false');
    expect(html).toMatch(/role="radiogroup"/);
    expect(html).not.toMatch(/role="radio" aria-checked="true"/);
    expect(html).toContain('Values are masked: turn Mask values off to see them');
    // Without the mask: its value chosen, no note.
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const open = bar(filters({ column: 'password_set', op: 'false', values: [] }));
    expect(open).toMatch(/role="radio" aria-checked="true"[^>]*>false</);
    expect(open).not.toContain('Values are masked');
  });

  test('Mask values on an enum: its checklist has nothing checked, and says why', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'token_state', op: 'in', values: ['revoked'] }), true);
    expect(html).not.toMatch(/role="checkbox" aria-checked="true"/);
    expect(html).toMatch(/role="checkbox" aria-checked="false"[^>]*>.*revoked/);
    expect(html).toContain('Values are masked: turn Mask values off to see them');
  });

  test('an enum value the type no longer has: listed last, checked, marked', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'status', op: 'in', values: ['paid', 'lost'] }));
    expect(html).toMatch(/role="checkbox" aria-checked="true"[^>]*>(?:(?!<\/button>).)*lost \(not in the type anymore\)/);
  });

  test('a filter on a column the table no longer has: its editor says so, with Remove — no Apply', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'gone_col', op: 'eq', values: ['x'] }));
    expect(html).toMatch(/role="dialog" aria-label="Edit filter"/);
    expect(html).toContain('This column isn’t in the table anymore');
    expect(html).toContain('>gone_col<');
    expect(html).toContain('>Remove<');
    expect(html).not.toContain('>Apply<');
    expect(html).not.toContain('placeholder="Find a column"');
  });

  test('the last N days: the number, its unit, quick picks', () => {
    useFilterUi.setState({ pop: { key: KEY, anchor: 'chip-0', edit: 0, target: null } });
    const html = bar(filters({ column: 'created_at', op: 'lastDays', values: ['7'] }));
    expect(html).toMatch(/<input[^>]*inputMode="numeric"[^>]*value="7"/);
    expect(html).toContain('>days<');
    expect(html).toMatch(/>30<\/button>/);
  });
});

describe('the Columns popover', () => {
  test('a checklist of the table\'s columns, the key\'s note, Show All, Apply', () => {
    useFilterUi.setState({ cols: KEY });
    const html = bar({ columns: ['email', 'status'] });
    expect(html).toMatch(/role="dialog" aria-label="Columns"/);
    expect(html).toMatch(/role="checkbox" aria-checked="false"[^>]*data-tip="The row’s key: always read, hidden from view only"/);
    expect(html).toMatch(/role="checkbox" aria-checked="true"[^>]*>.*email/);
    expect(html).toContain('>Show All<');
    expect(html).toContain('>Apply<');
  });
});

describe('in the table tab', () => {
  const conn: DbConnection = {
    id: C, name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme', user: 'me', tls: 'prefer', ssh: null,
    scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1
  };
  beforeEach(() => {
    useApp.setState({ dbTabs: [ORDERS] });
    useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ conn, state: 'connected', problem: null, server: null, hasPassword: false, provider: null, held: false }] } });
  });

  test('the bar is the Data view\'s, under the toolbar, above the rows', () => {
    st();
    const html = live(createElement(TableView, { tab: ORDERS, conn, visible: true, focused: true }));
    const at = (s: string) => html.indexOf(s);
    expect(at('class="dbt-fbar"')).toBeGreaterThan(at('class="dbt-data"'));
    expect(at('class="dbt-fbar"')).toBeLessThan(at('class="dbt-body'));
  });
});

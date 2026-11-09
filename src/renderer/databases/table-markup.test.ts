import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { EMPTY_DB_SNAPSHOT, type DbCatalog, type DbConnView, type DbConnection, type DbEnv, type DbPage } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { useApp } from '../store';
import { useDb, type DbTabState } from './store';
import { TableView } from './TableView';
import { MoreRow } from './MoreRow';
import { useStruct } from './structure-data';
import { useTableUi } from './table-view';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// A table tab's Data view: the toolbar, the rows loaded so far, the footer,
// the states; markup only (the loading itself: data.test.ts).

const C = 'c0123456789ab';
const KEY = `db:${C}/public/orders` as DbTabRef['key'];
const ORDERS: DbTabRef = { key: KEY, connId: C, schema: 'public', name: 'orders', kind: 'table', view: 'data' };
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme_dev', engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme', user: 'me', tls: 'prefer', ssh: null,
  scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const view = (c: DbConnection): DbConnView => ({ conn: c, state: 'connected', problem: null, server: null, hasPassword: false, provider: null, held: false });
const CATALOG: DbCatalog = { connId: C, database: 'acme', databases: ['acme'], noRels: false, schemas: ['public'], schema: 'public', rels: [{ schema: 'public', name: 'orders', kind: 'table', estimate: 48210 }], enums: [], functions: [], names: [], namesMore: false, readAt: 1 };

const col = (name: string, typeName: string, typeCat: string, o: Partial<DbColumn> = {}): DbColumn => ({
  name, type: typeName, typeSchema: 'pg_catalog', typeName, typeCat, isArray: false, nullable: true, isPk: false, isKey: false, ...o
});
const COLS = [col('id', 'int8', 'N', { isPk: true, isKey: true }), col('email', 'text', 'S'), col('note', 'text', 'S')];
function page(n: number, o: Partial<DbPage> = {}): DbPage {
  return {
    columns: COLS, hidden: [], derived: [], rows: Array.from({ length: n }, (_, i) => [{ v: String(i + 1) }, { v: `u${i + 1}@acme.test` }, { v: i === 0 ? null : 'hello' }]),
    ms: 14, sql: 'SELECT "id", "email", "note" FROM "public"."orders" ORDER BY "id" LIMIT 100 OFFSET 0', pk: ['id'], kind: 'table', ...o,
    rowKey: o.rowKey ?? o.pk ?? ['id']
  };
}
const loaded = (n: number, o: Partial<DbTabState> = {}): Partial<DbTabState> => {
  const p = page(n);
  return { data: p, rows: p.rows, more: n < 100 ? 'end' : 'idle', at: Date.now() - 12_000, ...o };
};

function render(o: { c?: DbConnection | null; tab?: DbTabRef; st?: Partial<DbTabState>; env?: DbEnv; held?: boolean } = {}): string {
  const c = o.c === undefined ? conn(o.env ? { env: o.env } : {}) : o.c;
  useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: c ? [{ ...view(c), held: o.held ?? false }] : [], catalog: CATALOG, selected: C } });
  if (o.st) useDb.getState().patchTab(KEY, o.st);
  return live(createElement(TableView, { tab: o.tab ?? ORDERS, conn: c, visible: true, focused: true }));
}
const count = (html: string, s: string) => html.split(s).length - 1;

beforeEach(() => useApp.setState({ dbTabs: [ORDERS] }));
afterEach(() => {
  useDb.setState(useDb.getInitialState(), true);
  useApp.setState(useApp.getInitialState(), true);
  useTableUi.setState(useTableUi.getInitialState(), true);
  useStruct.setState(useStruct.getInitialState(), true);
});

describe('the toolbar', () => {
  test('crumb connection / schema / table, the full path in its tooltip; the Read-only chip; the catalog\'s estimate', () => {
    const html = render();
    expect(html).toContain('data-tip="acme_dev / public / orders"');
    expect(html).toMatch(/<span class="dbt-crumb-conn">acme_dev<\/span><span class="dbt-crumb-sep"[^>]*>\/<\/span><span class="dbt-crumb-schema">public<\/span><span class="dbt-crumb-sep"[^>]*>\/<\/span><b class="dbt-crumb-name">orders<\/b>/);
    expect(html).toContain('data-tip="Read-only. Every query runs in a read-only transaction."');
    expect(html).toContain('<span class="dbt-ro-label">Read-only</span>');
    expect(html).toContain('>~48,210 rows<');
  });

  test('Data · Structure · Relations: a radio group, the tab\'s view checked, each label also its tooltip (icons only when narrow)', () => {
    const html = render({ tab: { ...ORDERS, view: 'structure' } });
    expect(html).toContain('role="radiogroup" aria-label="Table views"');
    for (const [v, label] of [['data', 'Data'], ['structure', 'Structure'], ['relations', 'Relations']] as const) {
      const on = v === 'structure';
      expect(html).toContain(`role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-value="${v}" aria-label="${label}" data-tip="${label}"`);
      expect(html).toContain(`<span class="dbt-views-label">${label}</span>`);
    }
  });

  test('Mask values: an eye toggle reading the connection\'s setting', () => {
    expect(render()).toMatch(/aria-label="Mask Values" aria-pressed="false"/);
    expect(render({ c: conn({ mask: true }) })).toMatch(/aria-label="Mask Values" aria-pressed="true"/);
  });

  test('Refresh with its key and when the rows came back; SQL waits for a statement', () => {
    const before = render();
    expect(before).toMatch(/aria-label="Refresh" data-tip="Refresh" data-kbd="⌘R"/);
    expect(before).toMatch(/<button type="button" class="dbt-sql"[^>]*disabled=""/);
    const after = render({ st: loaded(100) });
    expect(after).toMatch(/aria-label="Refresh" data-tip="Refresh · Updated 1[0-9] s ago" data-kbd="⌘R"/);
    expect(after).not.toMatch(/<button type="button" class="dbt-sql"[^>]*disabled=""/);
    expect(after).toContain('aria-haspopup="dialog" aria-expanded="false"');
  });

  test('before main\'s first snapshot: the crumb from the key, nothing asked yet', () => {
    const html = render({ c: null });
    expect(html).toContain('<b class="dbt-crumb-name">orders</b>');
    expect(html).not.toContain('dbt-crumb-conn');
  });
});

describe('the footer', () => {
  test('rows loaded of the estimate, Count exactly, the last fetch\'s time, the scroll hint', () => {
    const html = render({ st: loaded(300, { estimate: 2300, more: 'idle' }) });
    // Its full text in a tooltip too: a narrow pane ellipsizes it.
    expect(html).toContain('<span class="dbt-foot-label" data-tip="300 loaded of ~2,300">300 loaded of ~2,300</span>');
    expect(html).toMatch(/<button type="button" class="dbt-link dbt-count"[^>]*>Count exactly<\/button>/);
    expect(html).toContain('<span class="dbt-ms mono">14 ms</span>');
    expect(html).toContain('More rows load as you scroll');
  });

  test('the end: all loaded, exact by itself — no Count exactly, no scroll hint', () => {
    const html = render({ st: loaded(42) });
    expect(html).toContain('>all 42 loaded</span>');
    expect(html).not.toContain('Count exactly');
    expect(html).not.toContain('More rows load as you scroll');
  });

  test('nothing to count before the rows, nor after a problem', () => {
    expect(render()).not.toContain('Count exactly');
    expect(render({ st: { problem: { kind: 'other', message: 'boom' } } })).not.toContain('Count exactly');
  });
});

describe('the states', () => {
  test('timed out: the message, the hint, Try Again', () => {
    const html = render({ st: { problem: { kind: 'canceled', message: 'Stopped after 15 s', code: '57014' } } });
    expect(html).toContain('>Stopped after 15 s</h2>');
    expect(html).toContain('Add a filter or sort by an indexed column.');
    expect(html).toContain('>Try Again</button>');
    expect(html).toContain('role="alert"');
  });

  test('Postgres\'s message with its SQLSTATE, detail and hint; Try Again', () => {
    const html = render({ st: { problem: { kind: 'other', message: 'column "x" does not exist', code: '42703', detail: 'Perhaps you meant "y".', hint: 'Check the name.' } } });
    expect(html).toContain('>column &quot;x&quot; does not exist</h2>');
    expect(html).toContain('SQLSTATE 42703');
    expect(html).toContain('Perhaps you meant &quot;y&quot;.');
    expect(html).toContain('Check the name.');
    expect(html).toContain('>Try Again</button>');
  });

  test('with filters, Clear Filters beside Try Again: a filter that fails every time never loops', () => {
    const problem = { kind: 'other' as const, message: 'invalid input syntax for type timestamp with time zone: "soon"', code: '22007' };
    const html = render({ st: { problem, filters: [{ column: 'created_at', op: 'before', values: ['soon'] }] } });
    expect(html).toMatch(/>Try Again<\/button><button type="button" class="btn-ghost sm"[^>]*>Clear Filters<\/button>/);
    expect(render({ st: { problem, filters: [] } })).not.toContain('Clear Filters');
  });

  test('with JSON columns, Remove JSON Columns too: a key path main refuses never leaves the tab stuck', () => {
    const problem = { kind: 'other' as const, message: 'A path key holds at most 256 characters' };
    const html = render({ st: { problem, derived: [{ column: 'metadata', path: ['x'.repeat(300)] }], filters: [{ column: 'status', op: 'in', values: ['paid'] }] } });
    expect(html).toMatch(/>Try Again<\/button><button type="button" class="btn-ghost sm"[^>]*>Clear Filters<\/button><button type="button" class="btn-ghost sm"[^>]*>Remove JSON Columns<\/button>/);
    expect(render({ st: { problem, derived: [] } })).not.toContain('Remove JSON Columns');
  });

  test('the connection lost after main\'s own retry: Try Again; a role that can\'t read: nothing to try', () => {
    expect(render({ st: { problem: { kind: 'lost', message: 'The connection was lost' } } })).toContain('>Try Again</button>');
    const denied = render({ st: { problem: { kind: 'denied', message: 'This role can\'t read orders', code: '42501' } } });
    expect(denied).toContain('This role can&#x27;t read orders');
    expect(denied).not.toContain('Try Again');
  });

  test('empty: "No rows", or "No rows match these filters" with Clear Filters', () => {
    const none = render({ st: loaded(0) });
    expect(none).toContain('>No rows</h2>');
    expect(none).not.toContain('Clear Filters');
    const filtered = render({ st: loaded(0, { filters: [{ column: 'note', op: 'eq', values: ['x'] }] }) });
    expect(filtered).toContain('>No rows match these filters</h2>');
    expect(filtered).toContain('>Clear Filters</button>');
  });

  test('loading: nothing in the first 150 ms (the skeleton comes after)', () => {
    const html = render({ st: { loading: true } });
    expect(html).not.toContain('dbt-skel');
    expect(html).not.toContain('dbt-grid');
  });

  test('Structure and Relations: their own views, the toolbar stays to come back', () => {
    const html = render({ tab: { ...ORDERS, view: 'relations' }, st: loaded(3) });
    expect(html).toContain('dbt-bar');
    expect(html).toContain('class="dbr-view');
    expect(render({ tab: { ...ORDERS, view: 'structure' }, st: loaded(3) })).toContain('class="dbs');
    // The rows stay mounted, hidden, so Data comes back where it was.
    expect(html).toMatch(/<div class="dbt-data" style="display:none">[\s\S]*dbt-grid[\s\S]*dbt-foot/);
    expect(render({ st: loaded(3) })).toMatch(/<div class="dbt-data" style="display:flex">/);
  });

  test('a connection the user disconnected (main\'s hold): a calm card with Connect, nothing read', () => {
    expect(render()).not.toContain('>Disconnected</h2>');
    const html = render({ held: true });
    expect(html).toContain('>Disconnected</h2>');
    expect(html).toContain('You disconnected acme_dev in this session.');
    expect(html).toMatch(/<button type="button" class="btn-primary sm"[^>]*>Connect<\/button>/);
    expect(html).not.toContain('dbt-skel');
  });

  test('a Refresh with rows on screen: the bar moves for as long as the query timeout allows', () => {
    const html = render({ st: loaded(3, { loading: true }) });
    expect(html).toMatch(/<span class="dbt-progress" aria-hidden="true" style="--dbt-cycles:\d+"><i><\/i><\/span>/);
  });
});

describe('narrow panes and the keyboard', () => {
  test('a ⋯ button holds the toolbar\'s actions (shown by CSS when the pane is narrow), a menu', () => {
    const html = render({ st: loaded(3) });
    expect(html).toMatch(/<button type="button" class="icon-btn dbt-fold" aria-label="More Actions" aria-haspopup="menu" aria-expanded="false" data-tip="More Actions">/);
  });

  test('⋯ reads expanded while the menu it opened is the one on screen', () => {
    const menu = { x: 1, y: 2, items: [] };
    useApp.setState({ menu });
    useTableUi.setState({ fold: { key: KEY, menu } });
    expect(render({ st: loaded(3) })).toMatch(/class="icon-btn dbt-fold is-open" aria-label="More Actions" aria-haspopup="menu" aria-expanded="true"/);
    useApp.setState({ menu: { ...menu } });
    expect(render({ st: loaded(3) })).toContain('aria-expanded="false" data-tip="More Actions"');
  });
});

describe('the SQL popover (12)', () => {
  /** Whether the first element with class `inner` sits inside the element with class `outer` (div nesting). */
  function inside(html: string, outer: string, inner: string): boolean {
    const start = html.indexOf(`class="${outer}"`);
    const at = html.indexOf(`class="${inner}"`);
    if (start < 0 || at < 0 || at < start) return false;
    let depth = 0;
    for (const m of html.slice(html.lastIndexOf('<', start), html.lastIndexOf('<', at)).matchAll(/<(\/?)div\b/g)) depth += m[1] ? -1 : 1;
    return depth > 0;
  }

  test('beside the bar, not in it (the bar clips); Copy takes the keyboard; it names the statement', () => {
    useTableUi.setState({ sql: KEY });
    const html = render({ st: loaded(3) });
    expect(html).toContain('class="dbt-pop"');
    expect(inside(html, 'dbt-bar', 'dbt-pop')).toBe(false);
    expect(inside(html, 'dbt', 'dbt-pop')).toBe(true);
    expect(html).toMatch(/class="dbt-pop" role="dialog" aria-label="The statement"/);
    expect(html).toMatch(/<button type="button" class="btn-ghost sm dbt-pop-copy" data-autofocus="true">/);
    expect(html).toContain('SELECT &quot;id&quot;, &quot;email&quot;');
    expect(html).toContain('aria-expanded="true"');
  });

  test('Mask values on: the statement\'s filter values are dots — what the popover shows and copies', () => {
    useTableUi.setState({ sql: KEY });
    const sql = `SELECT "id", "email", "note" FROM "public"."orders" WHERE "email" = 'a@acme.test'::text ORDER BY "id" LIMIT 100 OFFSET 0`;
    const html = render({ c: conn({ mask: true }), st: { ...loaded(3), data: page(3, { sql }) } });
    expect(html).toContain('WHERE &quot;email&quot; = &#x27;••••&#x27;::text');
    expect(html).not.toContain('a@acme.test&#x27;');
    expect(render({ st: { ...loaded(3), data: page(3, { sql }) } })).toContain('&#x27;a@acme.test&#x27;');
  });

  test('another tab\'s popover, or this tab hidden: none here', () => {
    useTableUi.setState({ sql: `db:${C}/public/other` });
    expect(render({ st: loaded(3) })).not.toContain('class="dbt-pop"');
    useTableUi.setState({ sql: KEY });
    useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(conn())], catalog: CATALOG, selected: C } });
    useDb.getState().patchTab(KEY, loaded(3));
    expect(live(createElement(TableView, { tab: ORDERS, conn: conn(), visible: false, focused: false }))).not.toContain('class="dbt-pop"');
  });
});

describe('the grid', () => {
  test('the header: names and short type lines, the key\'s icon, the full name and type on hover', () => {
    const html = render({ st: loaded(3) });
    expect(html).toMatch(/class="dbt-grid" role="grid"[^>]*aria-multiselectable="true"/);
    expect(html).toContain('<span class="dbt-th-name">email</span>');
    expect(html).toContain('<span class="dbt-th-type">text</span>');
    expect(html).toMatch(/data-tip="email · text"/);
    // The primary key's icon before its name, a sort button over name and type, an edge to resize.
    expect(html).toMatch(/<span class="dbt-th-line"><span class="dbt-th-pk"><svg[^>]*>[\s\S]*?<\/svg><\/span><span class="dbt-th-name">id<\/span><\/span>/);
    expect(html).toMatch(/<button type="button" class="dbt-th-btn" tabindex="-1">/);
    expect(count(html, 'class="dbt-th-rs"')).toBe(3);
    expect(html).toMatch(/aria-sort="none"/);
  });

  test('the rows numbered, NULL as a pill, numbers right-aligned, values typed', () => {
    const html = render({ st: loaded(3) });
    expect(html).toContain('<td class="dbt-rn">1</td>');
    expect(html).toContain('<span class="dbt-nul">NULL</span>');
    expect(html).toMatch(/<td role="gridcell" data-col="0" class="is-num"><span class="dbt-num">1<\/span><\/td>/);
    expect(html).toContain('<span class="dbt-text">u1@acme.test</span>');
  });

  test('Mask values on: matching columns as dots (email), the others as they are', () => {
    const html = render({ c: conn({ mask: true }), st: loaded(3) });
    expect(html).not.toContain('u1@acme.test');
    expect(html).toContain('<span class="dbt-mask">••••••••</span>');
    expect(html).toContain('hello');
  });

  test('columns kept only to name the row (hidden) aren\'t shown; JSON columns follow the selected ones, marked', () => {
    const p = page(2, { columns: [COLS[1]!, COLS[0]!], hidden: ['id'], derived: [{ column: 'meta', path: ['user', 'plan'] }], rows: [[{ v: 'a@x' }, { v: '1' }, { v: 'pro' }], [{ v: 'b@x' }, { v: '2' }, { v: 'free' }]] });
    const html = render({ st: { data: p, rows: p.rows, more: 'end' } });
    expect(html).not.toContain('<span class="dbt-th-name">id</span>');
    expect(html).toContain('<span class="dbt-th-name">plan</span>');
    expect(html).toContain('<span class="dbt-th-type">meta → user.plan</span>');
    expect(html).toMatch(/<th [^>]*class="dbt-th is-drv"/);
    expect(html).toMatch(/<td role="gridcell" data-col="2" class="is-drv"><span class="dbt-text">pro<\/span><\/td>/);
    expect(html).not.toMatch(/data-col="1"/);
  });

  test('a cut value says so', () => {
    const p = page(1, { rows: [[{ v: '1' }, { v: 'x'.repeat(10), cut: 120_000 }, { v: null }]] });
    expect(render({ st: { data: p, rows: p.rows, more: 'end' } }))
      .toContain('<span class="dbt-cutbox"><span class="dbt-cutv"><span class="dbt-text">xxxxxxxxxx</span></span><span class="dbt-cut" data-tip="Showing 64 KB of 117 KB">…</span></span>');
  });

  test('virtualized: 10,000 loaded rows put only a screenful (plus overscan) in the page, spacers for the rest', () => {
    const p = page(100);
    const rows = Array.from({ length: 10_000 }, (_, i) => [{ v: String(i + 1) }, { v: 'e' }, { v: 'n' }]);
    const html = render({ st: { data: p, rows, more: 'cap' } });
    expect(count(html, '<td class="dbt-rn">')).toBeLessThanOrEqual(60);
    expect(count(html, '<td class="dbt-rn">')).toBeGreaterThan(10);
    expect(html).toContain('aria-rowcount="10001"');
    expect(html).toMatch(/<tr class="dbt-spacer" aria-hidden="true"><td colSpan="4" style="height:\d+px"><\/td><\/tr>/i);
  });

  test('selection and focus: the rows selected, the focused cell outlined', () => {
    const html = render({ st: loaded(3, { selection: [1, 2], focus: { row: 2, col: 1 } }) });
    expect(count(html, 'aria-selected="true"')).toBe(2);
    expect(html).toMatch(/<tr aria-rowindex="3" data-row="1" class="is-sel" aria-selected="true">/);
    expect(html).toMatch(/<td role="gridcell" data-col="1" class="is-focus"><span class="dbt-text">u3@acme.test<\/span><\/td>/);
    expect(html).toMatch(/<tr aria-rowindex="2" data-row="0" aria-selected="false">/);
  });

  test('the sort on the header: its arrow, its rank with more than one', () => {
    const one = render({ st: loaded(3, { sort: [{ column: 'email', dir: 'desc' }] }) });
    expect(one).toMatch(/<th [^>]*class="dbt-th is-sorted" aria-sort="descending"/);
    expect(one).toMatch(/<span class="dbt-th-sort"><svg[^>]*>[\s\S]*?<\/svg><\/span>/);
    const two = render({ st: loaded(3, { sort: [{ column: 'email', dir: 'asc' }, { column: 'id', dir: 'desc' }] }) });
    expect(two).toMatch(/<span class="dbt-th-sort"><svg[^>]*>[\s\S]*?<\/svg><sup>2<\/sup><\/span>/);
  });

  test('Wrap Cells (⌥Z): the table wraps, rows of a fixed six-line height', () => {
    const html = render({ st: loaded(3, { wrap: true }) });
    expect(html).toMatch(/<table class="dbt-table is-wrap"/);
    expect(html).toContain('<div class="dbt-wrapc"><span class="dbt-text">hello</span></div>');
    expect(render({ st: loaded(3, { wrap: false }) })).not.toContain('is-wrap');
  });

  test('column widths: one colgroup for the whole table (never a width per cell); a dragged width kept', () => {
    const html = render({ st: loaded(3, { widths: { email: 333 } }) });
    expect(html).toMatch(/<colgroup><col style="width:52px"\/><col style="width:\d+px"\/><col style="width:333px"\/><col style="width:\d+px"\/><\/colgroup>/);
    expect(html).not.toMatch(/<td[^>]*style="width/);
  });

  test('first widths are the tab\'s: a new run (sort, filter, Refresh) with longer values keeps them', () => {
    const long = page(3, { rows: [[{ v: '1' }, { v: `${'x'.repeat(60)}@acme.test` }, { v: 'n' }]] });
    const html = render({ st: { data: long, rows: long.rows, more: 'end', autoWidths: { id: 64, email: 77, note: 90 } } });
    expect(html).toMatch(/<colgroup><col style="width:52px"\/><col style="width:64px"\/><col style="width:77px"\/><col style="width:90px"\/><\/colgroup>/);
    // A dragged width still wins over a first one.
    const dragged = render({ st: { data: long, rows: long.rows, more: 'end', autoWidths: { id: 64, email: 77, note: 90 }, widths: { email: 300 } } });
    expect(dragged).toMatch(/<col style="width:300px"\/>/);
  });

  test('the bottom row: the cap message once 10,000 rows are here', () => {
    const p = page(100);
    const rows = Array.from({ length: 10_000 }, (_, i) => [{ v: String(i + 1) }, { v: 'e' }, { v: 'n' }]);
    expect(render({ st: { data: p, rows, more: 'cap' } })).toContain('10,000 rows loaded. Add a filter or a sort to see others.');
  });
});

describe('Claude', () => {
  const session = (title: string | null) => useApp.setState({
    terminals: title ? [{ id: 't1', title, color: '#8B5CF6', session: { state: 'waiting', updatedAt: 0 } } as never] : [], selectedId: title ? 't1' : null
  });
  const bar = (html: string) => /<div class="db-selwrap"[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? '';

  test('rows selected: the action bar over the grid, naming the rows and the session Send pastes into; none: no bar', () => {
    session('db-migration');
    const html = render({ st: loaded(5, { selection: [1, 3], focus: { row: 3, col: 0 } }) });
    expect(bar(html)).toContain('<span class="db-selbar-n">2 rows</span>');
    expect(bar(html)).toContain('Send to db-migration');
    // Inside the grid's box (it centers on the rows, never on the inspector beside them), after the scroller.
    expect(html).toMatch(/<div class="dbt-gridbox"><div class="dbt-grid"[\s\S]*<div class="db-selwrap"/);
    expect(bar(render({ st: loaded(5, { selection: [], focus: null }) }))).toBe('');
    // A focused row alone (⌘-click took the last one off): no bar — ⌥↩ still sends the focused row.
    expect(bar(render({ st: loaded(5, { selection: [], focus: { row: 2, col: 0 } }) }))).toBe('');
  });

  test('the bar never hides the last row: the rows always end with room for it (clearing never shifts them)', () => {
    session('db-migration');
    const room = '<div class="dbt-barroom" aria-hidden="true" style="height:56px"></div></div>';
    expect(render({ st: loaded(5, { selection: [0] }) })).toContain(`${room}<div class="db-selwrap"`);
    // No bar: the same room, so the rows stay where they were when it goes.
    const none = render({ st: loaded(5, { selection: [], focus: null }) });
    expect(none).toContain(room);
    expect(none).not.toContain('db-selwrap');
  });

  test('no session: Send disabled with the reason as its tooltip', () => {
    session(null);
    const html = bar(render({ st: loaded(5, { selection: [0] }) }));
    expect(html).toContain('<span class="db-selbar-n">1 row</span>');
    expect(html).toMatch(/class="btn-primary sm sel-send" aria-label="Send to a session" data-tip="No Claude session to send to: start one first." disabled=""/);
  });

  test('an inspector lying over the rows (a narrow tab): the bar centers on the rows left of it', () => {
    session('db-migration');
    useTableUi.getState().setWidth(KEY, 500);
    // The app's inspector width (one for every tab), 340 by default.
    const over = render({ st: loaded(5, { selection: [0], focus: { row: 0, col: 0 }, inspector: true }) });
    expect(over).toMatch(/<div class="db-selwrap" style="right:340px;bottom:0">/);
    // Beside the rows (a wide tab): the grid's box is already left of it.
    useTableUi.getState().setWidth(KEY, 1200);
    const beside = render({ st: loaded(5, { selection: [0], focus: { row: 0, col: 0 }, inspector: true }) });
    expect(beside).toMatch(/<div class="db-selwrap" style="right:0;bottom:0">/);
  });

  test('Structure\'s DDL card: Send Schema to <session> beside Copy; with none, "Send Schema to Session" (its press says why)', () => {
    useStruct.setState({ tabs: { [KEY]: { ddl: { id: 1, loading: false, v: 'CREATE TABLE public.orders ();\n' } } } });
    session('db-migration');
    const html = render({ tab: { ...ORDERS, view: 'structure' } });
    expect(html).toMatch(/<button type="button" class="btn-ghost sm dbs-send" data-tip="Send Schema to db-migration: the DDL and the relations, typed into its prompt">/);
    expect(html).toContain('<span class="dk-ellipsis">Send Schema to db-migration</span>');
    session(null);
    expect(render({ tab: { ...ORDERS, view: 'structure' } })).toContain('<span class="dk-ellipsis">Send Schema to Session</span>');
  });
});

describe('MoreRow (the grid\'s last row)', () => {
  const row = (more: DbTabState['more'], problem: DbTabState['moreProblem'] = null, loaded = 10_000) => live(createElement(MoreRow, { more, problem, loaded, onRetry: () => {} }));

  test('the values budget\'s cap names its rows and what to do', () => {
    expect(row('cap', null, 2_400)).toContain('2,400 rows loaded (64 MB of values). Add a filter or choose fewer columns to see others.');
  });

  test('a spinner while the next fetch loads', () => {
    const html = row('loading');
    expect(html).toContain('<span class="dk-spin" aria-hidden="true"></span>');
    expect(html).toContain('Loading more rows…');
    expect(html).toContain('role="status"');
  });

  test('an error row with Retry; a timeout with its hint', () => {
    const lost = row('error', { kind: 'lost', message: 'The connection was lost' });
    expect(lost).toContain('role="alert"');
    expect(lost).toContain('The connection was lost');
    expect(lost).toContain('>Retry</button>');
    expect(row('error', { kind: 'canceled', message: 'Stopped after 15 s' })).toContain('Stopped after 15 s. Add a filter or sort by an indexed column.');
  });

  test('the cap message; nothing while idle or at the end', () => {
    expect(row('cap')).toContain('10,000 rows loaded. Add a filter or a sort to see others.');
    expect(row('idle')).toBe('');
    expect(row('end')).toBe('');
  });
});

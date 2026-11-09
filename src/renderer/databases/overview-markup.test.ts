import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EMPTY_DB_SNAPSHOT, type DbActivity, type DbConnView, type DbConnection, type DbOverview, type DbServerInfo } from '@shared/databases';
import { useDb } from './store';
import { DbTabView } from './DbTabView';
import { addSample, NO_SAMPLES, type OvSamples } from './overview';
import { OverviewBody, OverviewView, type OverviewActions, type OvState } from './OverviewView';
import type { DbTabRef } from './tabs';
import { renderLive as live } from './test-render';

// The overview tab: the header with its chips, five tiles, the biggest tables, schemas
// and extensions, Now running, the slowest statements or the hint; Mask values on the queries; the
// Disconnected card; production's frame; the layout's classes at every width. Markup only: when it
// reads is overview.test.ts.

const C = 'c0123456789ab';
const TAB: DbTabRef = { key: `db:${C}` as DbTabRef['key'], connId: C, schema: '', name: '', kind: 'overview', view: 'data' };
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const conn = (o: Partial<DbConnection> = {}): DbConnection => ({
  id: C, name: 'acme · production', engine: 'postgres', env: 'prod', host: 'sample-db1.proxy.rlwy.net', port: 54321, database: 'railway', user: 'readonly_analyst',
  tls: 'verify', ssh: null, scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const SERVER: DbServerInfo = { version: '17.2', versionNum: 170002, tls: true, role: 'readonly_analyst', canWrite: false, latencyMs: 3 };
const view = (c: DbConnection, o: Partial<DbConnView> = {}): DbConnView => ({ conn: c, state: 'connected', problem: null, server: SERVER, hasPassword: true, provider: 'Railway', held: false, ...o });
const act = (o: Partial<DbActivity>): DbActivity => ({ pid: 1, role: 'app', app: 'api', state: 'active', seconds: 0, query: 'SELECT 1', ours: false, ...o });
const ACTIVITY: DbActivity[] = [
  act({ pid: 48213, app: 'api-worker', seconds: 72, query: "SELECT id FROM audit_log WHERE payload->>'actor' = 'jane@acme.test'" }),
  act({ pid: 48177, app: 'billing-cron', state: 'idle in transaction', seconds: 243, query: 'UPDATE invoices SET status = $1 WHERE id = $2' }),
  act({ pid: 48290, seconds: 0, query: 'SELECT * FROM orders WHERE customer_id = $1 LIMIT 20' }),
  act({ pid: 48301, role: 'readonly_analyst', app: 'atelier', seconds: 0, query: 'WITH RECURSIVE act AS (SELECT a.pid FROM pg_catalog.pg_stat_activity a)', ours: true }),
  act({ pid: 48400, app: 'reporting', state: 'idle', seconds: 900, query: null })
];
const OVERVIEW: DbOverview = {
  server: SERVER, uptimeSec: 21 * 86400 + 3 * 3600, sizeBytes: 4.2 * GB,
  connections: { total: 23, max: 100, active: 3, idleInTx: 1 }, cacheHit: 0.994,
  longest: { pid: 48213, seconds: 72, query: "SELECT id FROM audit_log WHERE payload->>'actor' = 'jane@acme.test'" }, xacts: 1710,
  biggest: [
    { schema: 'public', name: 'webhook_events', bytes: 1.9 * GB }, { schema: 'public', name: 'audit_log', bytes: 820 * MB },
    { schema: 'public', name: 'order_items', bytes: 410 * MB }, { schema: 'public', name: 'orders', bytes: 260 * MB },
    { schema: 'public', name: 'payments', bytes: 210 * MB }, { schema: 'public', name: 'shipments', bytes: 150 * MB }
  ],
  schemas: [{ name: 'analytics', bytes: 300 * MB, tables: 4, views: 2 }, { name: 'public', bytes: 3.9 * GB, tables: 18, views: 0 }],
  extensions: [{ name: 'citext', version: '1.6' }, { name: 'pg_stat_statements', version: '1.11' }, { name: 'pgcrypto', version: '1.3' }],
  activity: ACTIVITY, slowest: null, at: 15_000
};
/** Two reads 5 s apart: 142 transactions a second. */
const TWO: OvSamples = addSample(addSample(NO_SAMPLES, { xacts: 1000, at: 10_000 }), { xacts: 1710, at: 15_000 });
const state = (o: Partial<OvState> = {}): OvState => ({ data: OVERVIEW, problem: null, samples: TWO, ...o });

type BodyOpts = { c?: DbConnection; v?: DbConnView | null; st?: OvState; held?: boolean; width?: number; actions?: OverviewActions };
function element(o: BodyOpts = {}): ReactElement {
  const c = o.c ?? conn();
  return createElement(OverviewBody, {
    conn: c, view: o.v === undefined ? view(c) : o.v, st: o.st ?? state(), held: o.held ?? false, width: o.width ?? 1180, actions: o.actions,
    onRetry: () => {}, onConnect: () => {}, onMask: () => {}
  });
}
const body = (o: BodyOpts = {}): string => renderToStaticMarkup(element(o));
type Host = ReactElement<Record<string, unknown>>;
/**
 * The host elements of a tree, its function components called (OverviewBody's parts use no hooks): their props are
 * the handlers a click or a key would reach, so a test can press a button without a DOM.
 */
function hosts(node: ReactNode, out: Host[] = []): Host[] {
  if (Array.isArray(node)) {
    for (const n of node) hosts(n as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const el = node as Host;
  if (typeof el.type === 'function') return hosts((el.type as (p: unknown) => ReactNode)(el.props), out);
  if (typeof el.type === 'string') out.push(el);
  return hosts(el.props.children as ReactNode, out);
}
/** The text of the element whose opening tag matches `open`, tags stripped. */
function textOf(html: string, open: RegExp): string {
  const m = open.exec(html);
  if (!m) return '';
  let depth = 0;
  const tagName = /^<(\w+)/.exec(m[0])![1]!;
  const re = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'g');
  re.lastIndex = m.index;
  for (let t = re.exec(html); t; t = re.exec(html)) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(m.index, t.index + t[0].length).replace(/<[^>]+>/g, '');
  }
  return '';
}
/** One Now running row by its pid. */
const row = (html: string, pid: number): string => {
  const m = new RegExp(`<tr[^>]*>(?:(?!</tr>).)*?<td[^>]*>${pid}</td>.*?</tr>`).exec(html);
  return m ? m[0] : '';
};

describe('the header', () => {
  test('glyph, name, environment, provider, the version line, the role chip, Mask values', () => {
    const html = body();
    expect(html).toMatch(/<h2 class="dbo-name"[^>]*>acme · production<\/h2>/);
    expect(html).toContain('<span class="db-env is-prod">Prod</span>');
    expect(html).toContain('<span class="dbo-provider">Railway</span>');
    expect(textOf(html, /<p class="dbo-sub mono"/)).toBe('PostgreSQL 17.2 · sample-db1.proxy.rlwy.net:54321/railway · up 21d 3h · TLS verified');
    expect(textOf(html, /<span class="dbo-role is-read"/)).toBe('role readonly_analyst can only read');
    expect(html).toMatch(/<button type="button" class="dbo-mask" aria-pressed="false"[^>]*>/);
    expect(textOf(html, /<button type="button" class="dbo-mask/)).toBe('Mask values');
  });
  test('a role that can write: the amber chip', () => {
    const html = body({ st: state({ data: { ...OVERVIEW, server: { ...SERVER, role: 'app', canWrite: true } } }) });
    expect(html).not.toContain('dbo-role is-read');
    expect(textOf(html, /<span class="dbo-role is-write"/)).toBe('role app can write');
  });
  test('TLS as it is: on, verified, or off; a socket instead of host:port; no provider, no chip', () => {
    expect(textOf(body({ c: conn({ tls: 'require' }) }), /<p class="dbo-sub mono"/)).toContain('· TLS');
    expect(textOf(body({ c: conn({ tls: 'require' }) }), /<p class="dbo-sub mono"/)).not.toContain('verified');
    const off = body({ st: state({ data: { ...OVERVIEW, server: { ...SERVER, tls: false } } }) });
    expect(textOf(off, /<p class="dbo-sub mono"/)).toContain('· no TLS');
    const sock = conn({ host: '', socket: '/tmp', port: 5432, database: 'acme', env: 'local' });
    const html = body({ c: sock, v: view(sock, { provider: null }) });
    expect(textOf(html, /<p class="dbo-sub mono"/)).toContain('/tmp/acme');
    expect(html).not.toContain('dbo-provider');
  });
  test('before the first read: what the connection says (the server info of its connect), no uptime yet', () => {
    const html = body({ st: { data: null, problem: null, samples: NO_SAMPLES } });
    expect(textOf(html, /<p class="dbo-sub mono"/)).toBe('PostgreSQL 17.2 · sample-db1.proxy.rlwy.net:54321/railway · TLS verified');
    expect(textOf(html, /<span class="dbo-role is-read"/)).toBe('role readonly_analyst can only read');
  });
  test('Mask values on: pressed, the switch on', () => {
    const html = body({ c: conn({ mask: true }) });
    expect(html).toMatch(/<button type="button" class="dbo-mask is-on" aria-pressed="true"/);
  });
  test('the header stacks its chips under the name in a narrow pane', () => {
    expect(body({ width: 1180 })).toMatch(/<header class="dbo-head">/);
    expect(body({ width: 430 })).toMatch(/<header class="dbo-head is-stacked">/);
  });
});

describe('the tiles', () => {
  test('size, connections, cache hit, the longest query, transactions per second with its sparkline', () => {
    const html = body();
    const tiles = [...html.matchAll(/<div class="dbo-tile[^"]*"[^>]*>.*?<\/div>/g)].map((m) => m[0].replace(/<svg.*?<\/svg>/, '[spark]').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|'));
    expect(tiles).toEqual([
      '|Size|4.2 GB|22 tables · 2 views|',
      '|Connections|23|/ 100|3 active · 1 idle in transaction|',
      '|Cache hit|99.4%|reads served from memory|',
      '|Longest query|1m 12s|pid 48213 · still running|',
      '|Transactions|142|/s|[spark]|'
    ]);
    expect(html).toMatch(/<svg class="dbo-spark"[^>]*role="img" aria-label="Transactions per second, the last 1 sample"/);
  });
  test('the longest query goes amber over 30 s only', () => {
    expect(body()).toMatch(/<div class="dbo-tile is-long"/);
    const short = body({ st: state({ data: { ...OVERVIEW, longest: { pid: 7, seconds: 30, query: 'SELECT 1' } } }) });
    expect(short).not.toContain('dbo-tile is-long');
    expect(short).toMatch(/<span class="section-label">Longest query<\/span><span class="dbo-v"[^>]*>30s<\/span>/);
    const none = body({ st: state({ data: { ...OVERVIEW, longest: null } }) });
    expect(textOf(none, /<div class="dbo-tile"[^>]*><span class="section-label">Longest query/)).toBe('Longest query—nothing running');
  });
  test('the longest query\'s text in its tooltip, masked with Mask values on', () => {
    expect(body()).toContain('data-tip="SELECT id FROM audit_log WHERE payload-&gt;&gt;&#x27;actor&#x27; = &#x27;jane@acme.test&#x27;"');
    const masked = body({ c: conn({ mask: true }) });
    expect(masked).not.toContain('jane@acme.test');
    expect(masked).toContain('data-tip="SELECT id FROM audit_log WHERE payload-&gt;&gt;&#x27;••••&#x27; = &#x27;••••&#x27;"');
  });
  test('one read so far: no rate yet, "measuring…", no line', () => {
    const html = body({ st: state({ samples: addSample(NO_SAMPLES, { xacts: 1, at: 1 }) }) });
    expect(html).toContain('measuring…');
    expect(html).not.toContain('dbo-spark');
  });
  test('the tiles wrap 5 → 3 → 2 → 1; the last fills its row', () => {
    expect(body({ width: 1180 })).toContain('<div class="dbo-tiles" style="--dbo-cols:5">');
    expect(body({ width: 640 })).toContain('<div class="dbo-tiles" style="--dbo-cols:3">');
    const two = body({ width: 430 });
    expect(two).toContain('<div class="dbo-tiles" style="--dbo-cols:2">');
    expect(two).toMatch(/<div class="dbo-tile" style="grid-column:span 2"><span class="section-label">Transactions/);
    expect(body({ width: 280 })).toContain('<div class="dbo-tiles" style="--dbo-cols:1">');
  });
  test('values and sub lines carry their full text in a tooltip (they ellipsize when narrow)', () => {
    const html = body();
    expect(html).toMatch(/<span class="dbo-v" data-tip="4.2 GB">4.2 GB<\/span>/);
    expect(html).toMatch(/<span class="dbo-s" data-tip="3 active · 1 idle in transaction">/);
  });
  test('transactions per second: the tooltip says the overview\'s own reads are in it', () => {
    expect(body()).toMatch(/<span class="dbo-v" data-tip="142 transactions a second, this overview’s own reads included">142<span class="dbo-of">\/s<\/span><\/span>/);
  });
});

describe('biggest tables, schemas and extensions', () => {
  test('six bars, the biggest full, each opens its table; the names ellipsize, the sizes stay right', () => {
    const html = body();
    const bars = [...html.matchAll(/<button type="button" class="dbo-bar"[^>]*>(.*?)<\/button>/g)];
    expect(bars).toHaveLength(6);
    expect(bars[0]![0]).toContain('<span class="dbo-bar-name">webhook_events</span>');
    expect(bars[0]![0]).toContain('<i style="width:100%"></i>');
    expect(bars[0]![0]).toContain('<span class="dbo-bar-size">1.9 GB</span>');
    // 820 MB of 1.9 GB.
    expect(bars[1]![0]).toContain('<i style="width:42.1%"></i>');
    expect(bars[0]![0]).toContain('data-tip="Open public.webhook_events · 1.9 GB"');
    expect(textOf(html, /<section class="dbo-card dbo-biggest"/)).toMatch(/^Biggest tables22 tables/);
  });
  test('tables of more than one schema: the schema in front of each name', () => {
    const html = body({ st: state({ data: { ...OVERVIEW, biggest: [{ schema: 'analytics', name: 'events', bytes: 10 }, { schema: 'public', name: 'orders', bytes: 5 }] } }) });
    expect(html).toContain('<span class="dbo-bar-name">analytics.events</span>');
    expect(html).toContain('<span class="dbo-bar-name">public.orders</span>');
  });
  test('no tables: said so', () => {
    expect(body({ st: state({ data: { ...OVERVIEW, biggest: [] } }) })).toContain('No tables yet');
  });
  test('schemas with their size and counts, extensions with their version', () => {
    const t = textOf(body(), /<section class="dbo-card dbo-schemas"/);
    expect(t).toContain('analytics300 MB · 4 tables · 2 views');
    expect(t).toContain('public3.9 GB · 18 tables');
    expect(t).toContain('pg_stat_statements1.11');
    expect(t).toContain('pgcrypto1.3');
  });
  test('the slowest statements\' hint: installed but unreadable, or not installed', () => {
    expect(body()).toContain('pg_stat_statements is installed, but this role can’t read it (needs pg_read_all_stats).');
    const none = body({ st: state({ data: { ...OVERVIEW, extensions: [] } }) });
    expect(none).toContain('Slow queries come from <code>pg_stat_statements</code> when it’s installed.');
    expect(none).not.toContain('dbo-slowest');
  });
});

describe('Now running', () => {
  test('pid, role, application, state chip, for how long, the query on one line', () => {
    const html = body();
    expect(html).toContain('<table class="dbo-act mono">');
    const r = row(html, 48177);
    expect(r).toMatch(/<td class="dbo-app" data-tip="billing-cron">billing-cron<\/td>/);
    expect(r).toContain('<span class="dbo-st is-amber">idle in transaction</span>');
    expect(r).toContain('<td class="dbo-for">4m 03s</td>');
    expect(r).toMatch(/^<tr class="is-long" tabindex="-1">/);
    expect(row(html, 48290)).toContain('<td class="dbo-for">&lt;1s</td>');
    expect(row(html, 48290)).toContain('<span class="dbo-st is-sky">active</span>');
    expect(row(html, 48290)).toMatch(/^<tr tabindex="-1">/);
  });
  test('by keyboard: one row in the Tab order (the first until another is focused), the others reached with the arrows', () => {
    const html = body();
    expect(row(html, 48213)).toMatch(/^<tr class="is-long" tabindex="0">/);
    const running = /<table class="dbo-act mono">.*?<\/table>/.exec(html)![0];
    expect(running.match(/tabindex="0"/g)).toHaveLength(1);
    expect(running.match(/<tr[^>]*tabindex="-1"/g)).toHaveLength(4);
    // Shift+F10 or the menu key on a focused row opens its menu: App dispatches a contextmenu event at it.
    const tr = hosts(element()).find((e) => e.type === 'tr' && e.props.tabIndex === 0)!;
    expect(typeof tr.props.onContextMenu).toBe('function');
    expect(typeof tr.props.onFocus).toBe('function');
  });
  test('ours labelled "this view"', () => {
    const r = row(body(), 48301);
    expect(r).toMatch(/^<tr class="is-ours" tabindex="-1">/);
    expect(r).toContain('<span class="dbo-st is-ours">this view</span>');
    expect(r).toMatch(/<td class="dbo-app" data-tip="atelier">atelier<\/td>/);
  });
  test('no role and no application name (a background worker): a dash in each, never a blank cell', () => {
    const r = row(body({ st: state({ data: { ...OVERVIEW, activity: [act({ pid: 7, role: '', app: '' })] } }) }), 7);
    expect(r).toContain('<td>7</td><td>—</td><td class="dbo-app">—</td>');
  });
  test('a query Postgres hides from this role says why', () => {
    expect(row(body(), 48400)).toContain('hidden by Postgres (needs pg_read_all_stats)');
  });
  test('the query on one line with its full text in a tooltip, keywords tinted', () => {
    const r = row(body(), 48290);
    expect(r).toMatch(/<td class="dbo-q" data-tip="SELECT \* FROM orders WHERE customer_id = \$1 LIMIT 20">/);
    expect(r).toContain('<span class="dbo-kw">SELECT</span>');
    expect(r).toContain('<span class="dbo-num">20</span>');
  });
  test('Mask values on: every literal as dots in the row and its tooltip — numbers too — names kept', () => {
    const html = body({ c: conn({ mask: true }) });
    expect(html).not.toContain('jane@acme.test');
    const r = row(html, 48213);
    expect(r).toContain('audit_log');
    expect(r).toContain('&#x27;••••&#x27;');
    const n = row(html, 48290);
    expect(n).toMatch(/<td class="dbo-q" data-tip="SELECT \* FROM orders WHERE customer_id = \$1 LIMIT ••••">/);
    expect(n).toContain('<span class="dbo-num">••••</span>');
    expect(n).not.toContain('20');
  });
  test('✦ Ask Claude: only when the action is given, on active queries over 5 s, never ours', () => {
    expect(body()).not.toContain('Ask Claude');
    const html = body({ actions: { ask: () => {} } });
    expect(row(html, 48213)).toContain('Ask Claude');
    expect(row(html, 48177)).not.toContain('Ask Claude');
    expect(row(html, 48290)).not.toContain('Ask Claude');
    expect(row(html, 48301)).not.toContain('Ask Claude');
    expect(row(html, 48213)).toMatch(/<button type="button" class="dbo-ask"/);
  });
  test('✦ Ask Claude hands T29 the query as shown: masked with Mask values on', () => {
    const asked: [number, string][] = [];
    const press = (c: DbConnection) => {
      const btn = hosts(element({ c, actions: { ask: (a, q) => asked.push([a.pid, q]) } })).find((e) => e.props.className === 'dbo-ask')!;
      (btn.props.onClick as () => void)();
    };
    press(conn({ mask: true }));
    press(conn());
    expect(asked).toEqual([
      [48213, "SELECT id FROM audit_log WHERE payload->>'••••' = '••••'"],
      [48213, "SELECT id FROM audit_log WHERE payload->>'actor' = 'jane@acme.test'"]
    ]);
  });
  test('the count and when it reads', () => {
    const t = textOf(body(), /<section class="dbo-card dbo-running"/);
    expect(t).toMatch(/^Now running5 sessionspg_stat_activity · every 5 s while shown/);
  });
});

describe('the slowest statements (pg_stat_statements readable)', () => {
  test('top statements by mean time: the query masked when masked, calls, the mean', () => {
    const data = { ...OVERVIEW, slowest: [{ query: "SELECT * FROM users WHERE email = 'x@y.z'", calls: 1234, meanMs: 42 }, { query: 'SELECT 1', calls: 1, meanMs: 72_000 }] };
    const html = body({ st: state({ data }) });
    const t = textOf(html, /<section class="dbo-card dbo-slowest"/);
    expect(t).toContain('Slowest statements');
    expect(t).toContain('1,234');
    expect(t).toContain('42 ms');
    expect(t).toContain('1m 12s');
    expect(html).not.toContain('can’t read it');
    expect(body({ c: conn({ mask: true }), st: state({ data }) })).not.toContain('x@y.z');
  });
  test('readable but empty: said so', () => {
    expect(body({ st: state({ data: { ...OVERVIEW, slowest: [] } }) })).toContain('No statements recorded yet');
  });
});

describe('the states', () => {
  test('waiting for the first read: the header and quiet tiles, busy', () => {
    const html = body({ st: { data: null, problem: null, samples: NO_SAMPLES } });
    expect(html).toMatch(/<div class="dbo-tiles"[^>]*aria-busy="true"/);
    expect(html).not.toContain('Now running');
  });
  test('a failed first read: the problem and Retry', () => {
    const html = body({ st: { data: null, problem: { kind: 'refused', message: 'Can’t connect · connection refused', code: '08001', hint: 'Is Postgres running?' }, samples: NO_SAMPLES } });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Can’t connect · connection refused');
    expect(html).toContain('Is Postgres running?');
    expect(html).toContain('SQLSTATE 08001');
    expect(html).toMatch(/<button type="button" class="btn-ghost sm"[^>]*>.*?Retry<\/button>/);
  });
  test('a failed read with data on screen: the data stays, a paused note with Retry above it', () => {
    const html = body({ st: state({ problem: { kind: 'canceled', message: 'Stopped after 15 s' } }) });
    expect(textOf(html, /<div class="dbo-paused"/)).toBe('Paused · Stopped after 15 sRetry');
    expect(html).toContain('Now running');
  });
  test('a connection the user disconnected: the Disconnected card with Connect, nothing else', () => {
    const html = body({ held: true });
    expect(html).toContain('Disconnected');
    expect(html).toContain('You disconnected acme · production in this session.');
    expect(html).toMatch(/<button type="button" class="btn-primary sm">Connect<\/button>/);
    expect(html).not.toContain('dbo-tiles');
  });
  test('production: the glyph in the danger color (the view\'s 2 px hairline is the tab\'s)', () => {
    expect(body()).toMatch(/^<div class="dbo is-prod"/);
    expect(body({ c: conn({ env: 'dev' }) })).toMatch(/^<div class="dbo"/);
  });
});

describe('in its tab', () => {
  beforeEach(() => useDb.setState({ snap: EMPTY_DB_SNAPSHOT, loaded: false }));
  afterEach(() => useDb.setState(useDb.getInitialState(), true));

  test('DbTabView shows the overview for `db:<connId>`, in production\'s frame', () => {
    useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(conn())] } });
    const html = live(createElement(DbTabView, { tab: TAB, visible: true }));
    expect(html).toMatch(/^<section class="dk-view db-tab is-prod"/);
    expect(html).toContain('<div class="dbo is-prod"');
    expect(html).toMatch(/<h2 class="dbo-name"[^>]*>acme · production<\/h2>/);
  });
  test('OverviewView before its first read: the header and quiet tiles', () => {
    useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(conn())] } });
    const html = live(createElement(OverviewView, { tab: TAB, conn: conn(), visible: true }));
    expect(html).toMatch(/aria-busy="true"/);
    expect(html).toContain('acme · production');
  });
  test('OverviewView on a connection the user disconnected (main\'s hold): the Disconnected card', () => {
    useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(conn(), { state: 'idle', held: true })] } });
    const html = live(createElement(OverviewView, { tab: TAB, conn: conn(), visible: true }));
    expect(html).toContain('You disconnected acme · production in this session.');
    useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(conn(), { state: 'idle' })] } });
    expect(live(createElement(OverviewView, { tab: TAB, conn: conn(), visible: true }))).not.toContain('You disconnected');
  });
  test('a read main answered "held" (another window disconnected it meanwhile): the Disconnected card, never an error card', () => {
    const html = body({ st: state({ data: null, problem: { kind: 'held', message: 'Disconnected' } }) });
    expect(html).toContain('You disconnected acme · production in this session.');
    expect(html).not.toContain('role="alert"');
  });
});

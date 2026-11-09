import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  EMPTY_DB_SNAPSHOT, type DbCatalog, type DbConnState, type DbConnView, type DbConnection, type DbProblem, type DbServerInfo, type DbSnapshot
} from '@shared/databases';
import { useApp } from '../store';
import { Sidebar } from '../components/Sidebar';
import { DatabasesList } from './DatabasesList';
import { useSideWork } from './menus';
import { useDb } from './store';
import { renderLive } from './test-render';

// The Databases sidebar.

const DEV = 'c00000000000a';
const STG = 'c00000000000b';
const PROD = 'c00000000000c';
const conn = (id: string, o: Partial<DbConnection>): DbConnection => ({
  id, name: id, engine: 'postgres', env: 'local', host: 'localhost', port: 5432, database: 'acme_dev', user: 'app', tls: 'prefer', ssh: null,
  scope: { kind: 'project', root: '/p' }, mask: false, writeNoted: false, createdAt: 1, ...o
});
const SERVER: DbServerInfo = { version: '17.2', versionNum: 170002, tls: false, role: 'app', canWrite: false, latencyMs: 3 };
const view = (c: DbConnection, state: DbConnState = 'idle', o: Partial<DbConnView> = {}): DbConnView =>
  ({ conn: c, state, problem: null, server: state === 'connected' ? SERVER : null, hasPassword: false, provider: null, held: false, ...o });
const dev = conn(DEV, { name: 'acme_dev' });
const stg = conn(STG, { name: 'acme · staging', env: 'staging', host: 'ep-misty-fog-41.eu-central-1.aws.neon.tech', tls: 'require' });
const prod = conn(PROD, { name: 'acme · production', env: 'prod', host: 'sample-db1.proxy.rlwy.net', port: 54321, tls: 'require', scope: { kind: 'all' } });
const CATALOG: DbCatalog = {
  connId: DEV, database: 'acme_dev', databases: ['acme_dev', 'acme_test', 'postgres'], noRels: false, schemas: ['public', 'audit'], schema: 'public', readAt: 1,
  names: [], namesMore: false,
  rels: [
    { schema: 'public', name: 'customers', kind: 'table', estimate: 2118 },
    { schema: 'public', name: 'orders', kind: 'table', estimate: 48210 },
    { schema: 'public', name: 'webhook_events', kind: 'table', estimate: 1_204_331 },
    { schema: 'public', name: 'schema_migrations', kind: 'table', estimate: null },
    { schema: 'public', name: 'paid_orders', kind: 'view', estimate: null },
    { schema: 'public', name: 'daily_sales', kind: 'matview', estimate: 365 }
  ],
  enums: [{ schema: 'public', name: 'order_status', values: ['pending', 'paid', 'shipped'] }],
  functions: [{ schema: 'public', name: 'order_total', args: 'bigint', returns: 'numeric', oid: 1 }]
};
const show = (o: Partial<DbSnapshot>) => useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, ...o } });
const html = () => renderLive(DatabasesList);
/** The markup of the connection row named `name`, and the note under it (up to the next row or section). */
const rowOf = (out: string, name: string) => {
  const at = out.indexOf(`<span class="db-name">${name}</span>`);
  const start = out.lastIndexOf('<button', at);
  const next = out.slice(at).search(/<button type="button" class="db-conn|<div class="db-sec|<div class="db-divider/);
  return next < 0 ? out.slice(start) : out.slice(start, at + next);
};

beforeEach(() => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, ws: null, activity: 'databases' });
  useDb.setState({ snap: EMPTY_DB_SNAPSHOT, loaded: false });
});
afterEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
});

describe('the sidebar slot (the live demo\'s first paint)', () => {
  // The list loads lazily (Sidebar's import is checked by tests/integration/databases-css.test.ts): a server render
  // shows what the slot shows while its chunk loads.
  test('the Databases activity puts the list in its own sidebar slot, its head shown while the list\'s chunk loads', () => {
    const out = renderLive(Sidebar);
    expect(out).toMatch(/^<aside class="sidebar is-db"><div class="sidebar-head"><span class="section-label">Databases<\/span>/);
  });

  test('the head while the chunk loads lays out as the list\'s own (title, count, the room of the two buttons): nothing moves when it arrives', () => {
    useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [view(dev), view(stg)] } });
    // Same elements in the same classes (the buttons' icons come with the chunk).
    const shape = (head: string) => head.replace(/<svg.*?<\/svg>/g, '').replace(/ (aria-label|data-tip|aria-hidden|disabled|aria-busy)="[^"]*"/g, '')
      .replace(/<(button|span) type="button" class="icon-btn"/g, '<$1 class="icon-btn"').replace(/<\/?(button|span)( class="icon-btn")?>/g, (m) => m.replace('button', 'span'));
    const fallback = /<div class="sidebar-head">.*?<\/div>/.exec(renderLive(Sidebar))![0];
    const real = /<div class="sidebar-head">.*?<\/div>/.exec(html())![0];
    expect(shape(fallback)).toBe(shape(real));
    expect(fallback).toContain('>2</span>');
  });
});

describe('head and footer', () => {
  test('the title, the number of connections once there are some, Refresh and Add Connection', () => {
    show({});
    expect(html()).not.toContain('db-head-count');
    show({ connections: [view(dev), view(stg), view(prod)] });
    const out = html();
    expect(out).toContain('<span class="section-label">Databases</span>');
    expect(out).toMatch(/<span class="section-label mono db-head-count"[^>]*>3<\/span>/);
    expect(out).toMatch(/<button type="button" class="icon-btn"[^>]*aria-label="Refresh"/);
    expect(out).toMatch(/<button type="button" class="icon-btn"[^>]*aria-label="Add Connection…"/);
  });

  test('footer: the lock and the read-only line, under the list', () => {
    show({ connections: [view(dev)] });
    const out = html();
    expect(out).toMatch(/<div class="db-foot">.*<rect x="4" y="9" width="12" height="8".*Read-only\. Every query runs in a read-only transaction\.<\/span><\/div>/);
    expect(out.indexOf('class="db-list"')).toBeLessThan(out.indexOf('class="db-foot"'));
  });
});

describe('no connection saved (nothing is looked for)', () => {
  test('never said before main\'s first snapshot has arrived: only the head', () => {
    const out = html();
    expect(out).not.toContain('No databases yet');
    expect(out).not.toContain('Add Connection<');
    expect(out).toContain('<span class="section-label">Databases</span>');
  });

  test('how to add one: Add Connection, Paste a Connection URL, and where to hide the view — never what the project holds', () => {
    show({});
    const out = html();
    expect(out).toContain('No databases yet');
    expect(out).toContain('Add one by hand, or paste a <code>postgres://</code> URL anywhere in this panel.');
    expect(out).not.toMatch(/\.env|docker compose|5432|Found in this project/);
    expect(out).toMatch(/<button type="button" class="btn-primary"[^>]*>.*Add Connection<\/button>/);
    expect(out).toContain('>Paste a Connection URL</button>');
    expect(out).toContain('Hide this view in <button type="button" class="db-link">Settings › Databases</button>');
    expect(out).not.toContain('Read-only. Every query');
  });
});

describe('connections', () => {
  test('a row each: glyph with its state dot, name, environment tag, sub line; production in the danger color', () => {
    show({ selected: DEV, connections: [view(dev, 'connected'), view(stg), view(prod)] });
    const out = html();
    expect(rowOf(out, 'acme_dev')).toMatch(/class="db-conn is-selected is-connected"/);
    expect(rowOf(out, 'acme_dev')).toContain('<i class="db-st is-ok" aria-hidden="true"></i>');
    expect(rowOf(out, 'acme_dev')).toContain('<span class="db-env is-local">Local</span>');
    expect(rowOf(out, 'acme_dev')).toContain('<span class="db-conn-sub">localhost:5432</span>');
    expect(rowOf(out, 'acme · staging')).toMatch(/class="db-conn is-idle"/);
    expect(rowOf(out, 'acme · staging')).toContain('<span class="db-env is-staging">Staging</span>');
    expect(rowOf(out, 'acme · staging')).toContain('<i class="db-st is-idle" aria-hidden="true"></i>');
    expect(rowOf(out, 'acme · production')).toMatch(/class="db-conn is-idle is-prod"/);
    expect(rowOf(out, 'acme · production')).toContain('<span class="db-env is-prod">Prod</span>');
    expect(rowOf(out, 'acme · production')).toContain('sample-db1.proxy.rlwy.net:54321');
    expect(out.match(/is-prod/g)).toHaveLength(2); // the row and its tag, nothing else
  });

  test('the full name and sub line in the row\'s tooltip (they truncate at narrow widths)', () => {
    show({ connections: [view(stg)] });
    expect(rowOf(html(), 'acme · staging')).toContain('data-tip="acme · staging\nep-misty-fog-41.eu-central-1.aws.neon.tech:5432"');
  });

  test('"This project" and "Every project" only when both have connections', () => {
    show({ connections: [view(dev), view(stg)] });
    expect(html()).not.toContain('This project');
    show({ connections: [view(prod)] });
    expect(html()).not.toContain('Every project');
    show({ connections: [view(dev), view(stg), view(prod)] });
    const out = html();
    const at = (s: string) => out.indexOf(s);
    expect(at('>This project<')).toBeGreaterThan(-1);
    expect(at('>This project<')).toBeLessThan(at('>acme_dev<'));
    expect(at('>acme · staging<')).toBeLessThan(at('>Every project<'));
    expect(at('>Every project<')).toBeLessThan(at('>acme · production<'));
  });

  test('the state on the sub line: connecting, needs a password, a picked one not connected', () => {
    show({ selected: PROD, connections: [view(dev, 'connecting'), view(stg, 'password'), view(prod)] });
    const out = html();
    expect(rowOf(out, 'acme_dev')).toContain('<span class="db-conn-sub">connecting…</span>');
    expect(rowOf(out, 'acme_dev')).toContain('db-st is-busy');
    expect(rowOf(out, 'acme · staging')).toContain('<span class="db-conn-sub">needs a password</span>');
    expect(rowOf(out, 'acme · staging')).toContain('db-st is-warn');
    expect(rowOf(out, 'acme · production')).toContain('<span class="db-conn-sub">sample-db1.proxy.rlwy.net:54321 · not connected</span>');
  });
});


describe('the selected connection\'s catalog', () => {
  const withCatalog = (o: Partial<DbSnapshot> = {}) => show({ selected: DEV, connections: [view(dev, 'connected')], catalog: CATALOG, ...o });

  test('the schema chip, the filter, sections with their counts; estimated rows compact', () => {
    withCatalog();
    const out = html();
    expect(out).toMatch(/<button type="button" class="db-schema mono"[^>]*aria-haspopup="menu"[^>]*><span class="db-schema-name">public<\/span>/);
    expect(out).toContain('placeholder="Filter tables"');
    expect(out).toMatch(/<span class="section-label">Tables<\/span><span class="db-sec-count">4<\/span>/);
    expect(out).toMatch(/<span class="section-label">Views<\/span><span class="db-sec-count">1<\/span>/);
    expect(out).toMatch(/<span class="section-label">Materialized views<\/span><span class="db-sec-count">1<\/span>/);
    expect(out).toMatch(/<span class="section-label">Enums<\/span><span class="db-sec-count">1<\/span>/);
    expect(out).toMatch(/<span class="section-label">Functions<\/span><span class="db-sec-count">1<\/span>/);
    expect(out).toContain('<span class="db-rel-name">customers</span><span class="db-rel-count">2.1k</span>');
    expect(out).toContain('<span class="db-rel-name">orders</span><span class="db-rel-count">48.2k</span>');
    expect(out).toContain('<span class="db-rel-name">webhook_events</span><span class="db-rel-count">1.2M</span>');
    expect(out).toContain('<span class="db-rel-name">schema_migrations</span><span class="db-rel-count">—</span>');
  });

  test('Tables open, the other sections folded at first; the folds a connection remembers', () => {
    withCatalog();
    let out = html();
    expect(out).toContain('>customers<');
    expect(out).not.toContain('>paid_orders<');
    expect(out).not.toContain('>order_status<');
    expect(out).toMatch(/<button type="button" class="db-fold" aria-expanded="true"[^>]*>.*Tables/);
    useDb.setState({ folds: { [DEV]: ['tables'] } });
    out = html();
    expect(out).not.toContain('>customers<');
    expect(out).toContain('>paid_orders<');
    expect(out).toContain('>daily_sales<');
    expect(out).toContain('>order_status<');
    expect(out).toContain('order_total');
  });

  test('the filter keeps the matching names, counts included', () => {
    withCatalog();
    useDb.setState({ filter: 'ORDER', folds: { [DEV]: [] } });
    const out = html();
    expect(out).toMatch(/<span class="section-label">Tables<\/span><span class="db-sec-count">1<\/span>/);
    expect(out).toContain('>orders<');
    expect(out).not.toContain('>customers<');
    expect(out).not.toContain('>Materialized views<');
    useDb.setState({ filter: 'zzz' });
    expect(html()).toContain('Nothing matches');
  });

  test('a row opened in the focused tab is marked', () => {
    withCatalog();
    useApp.setState({ activeTab: `db:${DEV}/public/orders` });
    expect(html()).toMatch(/<button type="button" class="db-rel is-selected"[^>]*>(?:(?!<button).)*>orders</);
  });

  test('another connection\'s catalog is never shown under this one; a connected pick still reading it says so', () => {
    show({ selected: STG, connections: [view(dev, 'connected'), view(stg, 'connected')], catalog: CATALOG });
    expect(html()).not.toContain('>customers<');
    show({ selected: DEV, connections: [view(dev, 'connected')], catalog: null });
    expect(html()).toContain('Reading the catalog…');
  });

  test('a catalog main couldn\'t read: the problem with Refresh instead of "Reading…" forever; the dot amber', () => {
    const denied: DbProblem = { kind: 'denied', message: "This role can't read pg_class" };
    show({ selected: DEV, connections: [view(dev, 'connected', { problem: denied })], catalog: null });
    const out = html();
    expect(out).not.toContain('Reading the catalog…');
    expect(out).toMatch(/<div class="db-divider"><\/div><div class="db-note is-err" role="status"><p class="db-note-title">This role can&#x27;t read pg_class<\/p>/);
    expect(out).toMatch(/<button type="button" class="btn-ghost sm"[^>]*><span>Refresh<\/span><\/button>/);
    expect(rowOf(out, 'acme_dev')).toContain('db-st is-warn');
    // Not said twice: nothing under the row.
    expect(rowOf(out, 'acme_dev')).not.toContain('db-note');
  });

  test('…and above the catalog it still has (stale), which stays', () => {
    show({ selected: DEV, connections: [view(dev, 'connected', { problem: { kind: 'canceled', message: 'Stopped after 15 s' } })], catalog: CATALOG });
    const out = html();
    expect(out.indexOf('Stopped after 15 s')).toBeGreaterThan(-1);
    expect(out.indexOf('Stopped after 15 s')).toBeLessThan(out.indexOf('class="db-cat-bar"'));
    expect(out).toContain('>customers<');
  });

  test('the database chip before the schema chip — the database it reads, a menu of the server\'s others', () => {
    withCatalog();
    const out = html();
    const bar = /<div class="db-cat-bar">.*?<label class="db-filter">/.exec(out)![0];
    expect(bar).toMatch(/^<div class="db-cat-bar"><button type="button" class="db-schema db-database mono" aria-haspopup="menu" aria-label="Database acme_dev" data-tip="Database acme_dev"><svg[^]*?<\/svg><span class="db-schema-name">acme_dev<\/span><svg/);
    expect(bar.indexOf('db-database')).toBeLessThan(bar.indexOf('aria-label="Schema public"'));
  });

  test('a database without a table says so and lists the server\'s others, one click each; never "Nothing in this schema yet."', () => {
    withCatalog({ catalog: { ...CATALOG, rels: [], enums: [], functions: [], schemas: [], noRels: true, database: 'postgres' } });
    const out = html();
    expect(out).toContain('<p class="db-cat-note">No tables in postgres.</p>');
    expect(out).not.toContain('Nothing in this schema yet.');
    expect(out).toContain('<span class="section-label">Other databases on this server</span>');
    expect(out).toMatch(/<button type="button" class="db-rel db-other-db" data-nav="" data-tip="Switch to acme_dev"><svg[^]*?<\/svg><span class="db-rel-name">acme_dev<\/span><\/button>/);
    expect(out).toContain('<span class="db-rel-name">acme_test</span>');
    expect(out).not.toMatch(/db-other-db[^>]*data-tip="Switch to postgres"/);
    // Alone on its server: the sentence alone.
    withCatalog({ catalog: { ...CATALOG, rels: [], enums: [], functions: [], noRels: true, database: 'postgres', databases: ['postgres'] } });
    expect(html()).toContain('No tables in postgres.');
    expect(html()).not.toContain('Other databases on this server');
    // A schema without anything while another holds tables: the schema's words.
    withCatalog({ catalog: { ...CATALOG, rels: [], enums: [], functions: [], schema: 'audit' } });
    expect(html()).toContain('Nothing in this schema yet.');
    expect(html()).not.toContain('No tables in');
  });

  test('while the database switches, the catalog\'s place stays, reading', () => {
    useSideWork.setState({ refreshing: 0, switching: DEV });
    show({ selected: DEV, connections: [view(dev, 'connecting')], catalog: null });
    const out = html();
    expect(out).toContain('<div class="db-divider"></div>');
    expect(out).toContain('Reading the catalog…');
    useSideWork.setState({ refreshing: 0, switching: null });
    expect(html()).not.toContain('Reading the catalog…');
  });

  test('Refresh while it runs — its icon turns, it says it is busy, a second click can\'t start another; the catalog dims', () => {
    withCatalog();
    // At rest, the head the first paint draws while the chunk loads (above): nothing moves when it arrives.
    expect(html()).toMatch(/<button type="button" class="icon-btn" aria-label="Refresh" data-tip="[^"]*">/);
    expect(html()).toContain('<div class="db-list">');
    useSideWork.setState({ refreshing: 1, switching: null });
    const out = html();
    expect(out).toMatch(/<button type="button" class="icon-btn is-busy" aria-label="Refresh" data-tip="[^"]*" disabled="" aria-busy="true">/);
    expect(out).toContain('<div class="db-list is-refreshing">');
    useSideWork.setState({ refreshing: 0, switching: null });
  });

  test('a section shows 500 rows at most, then a quiet "Show all N"', () => {
    const rels = Array.from({ length: 501 }, (_, i) => ({ schema: 'public', name: `t${String(i).padStart(3, '0')}`, kind: 'table' as const, estimate: i }));
    withCatalog({ catalog: { ...CATALOG, rels } });
    const out = html();
    expect(out).toContain('>t499<');
    expect(out).not.toContain('>t500<');
    expect(out).toMatch(/<button type="button" class="db-more" data-nav="">Show all 501<\/button>/);
  });
});

describe('states under a row', () => {
  const problem = (p: DbProblem) => show({ selected: DEV, connections: [view(dev, 'error', { problem: p })] });

  test('needs a password: the field, Save in Keychain on, Connect', () => {
    show({ selected: PROD, connections: [view(prod, 'password', { problem: { kind: 'password', message: 'Needs a password' } })] });
    const row = rowOf(html(), 'acme · production');
    expect(row).toMatch(/<input[^>]*type="password"[^>]*placeholder="Password"/);
    expect(row).toMatch(/<button type="button" role="switch" aria-checked="true" class="switch is-on"/);
    expect(row).toContain('<span data-tip="Save in Keychain">Save in Keychain</span>');
    expect(row).toMatch(/<button type="submit" class="btn-primary sm"[^>]*>Connect<\/button>/);
    expect(row).not.toContain('Needs a password');
  });

  test('a wrong password says so above the field; the row\'s "needs a password" isn\'t said twice, whatever main\'s words', () => {
    show({ selected: PROD, connections: [view(prod, 'password', { problem: { kind: 'auth', message: 'Wrong user or password', code: '28P01' } })] });
    expect(rowOf(html(), 'acme · production')).toContain('Wrong user or password');
    show({ selected: PROD, connections: [view(prod, 'password', { problem: { kind: 'password', message: 'Type the password for the new server' } })] });
    expect(rowOf(html(), 'acme · production')).not.toContain('db-note-err');
  });

  test('rows in their state: an error\'s glyph in the danger color, idle ones quieter', () => {
    show({ selected: DEV, connections: [view(dev, 'error', { problem: { kind: 'refused', message: "Can't connect · connection refused localhost:5432" } }), view(stg)] });
    const out = html();
    expect(rowOf(out, 'acme_dev')).toMatch(/class="db-conn is-selected is-error"/);
    expect(rowOf(out, 'acme · staging')).toMatch(/class="db-conn is-idle"/);
  });

  test('Postgres\'s own error: its message whole, its detail and SQLSTATE, Try Again', () => {
    problem({ kind: 'other', message: 'unsupported frontend protocol · 3.2', detail: 'The server speaks protocol 3.0 only.', code: '08P01' });
    const row = rowOf(html(), 'acme_dev');
    expect(row).toContain('<p class="db-note-title">unsupported frontend protocol · 3.2</p>');
    expect(row).toContain('<p class="db-note-detail mono">The server speaks protocol 3.0 only.</p>');
    expect(row).toContain('<p class="db-note-code mono">SQLSTATE 08P01</p>');
    expect(row).toContain('<span>Try Again</span>');
  });

  test('can\'t connect: the cause, the detail, the hint, Try Again', () => {
    problem({ kind: 'refused', message: "Can't connect · connection refused localhost:5432", hint: 'Is Postgres running?', code: 'ECONNREFUSED' });
    const row = rowOf(html(), 'acme_dev');
    expect(row).toContain('db-st is-error');
    expect(row).toContain('<p class="db-note-title">Can&#x27;t connect</p>');
    expect(row).toContain('<p class="db-note-detail mono">connection refused localhost:5432</p>');
    expect(row).toContain('<p class="db-note-hint">Is Postgres running?</p>');
    expect(row).toMatch(/<button type="button" class="btn-ghost sm"[^>]*><span>Try Again<\/span><\/button>/);
  });

  test('each cause offers its fix: TLS off, TLS on, Require, Edit Connection…', () => {
    const button = (label: string) => new RegExp(`<button type="button" class="btn-(primary|ghost) sm"[^>]*><span>${label}</span></button>`);
    problem({ kind: 'notls', message: "This server doesn't offer TLS" });
    expect(rowOf(html(), 'acme_dev')).toMatch(button('Turn TLS Off'));
    problem({ kind: 'needtls', message: 'The server requires TLS', code: '28000' });
    expect(rowOf(html(), 'acme_dev')).toMatch(button('Use TLS'));
    problem({ kind: 'cert', message: "The certificate isn't trusted (self-signed)" });
    expect(rowOf(html(), 'acme_dev')).toMatch(button('Use Require'));
    problem({ kind: 'host', message: 'Host not found: db.internal' });
    const row = rowOf(html(), 'acme_dev');
    expect(row).toMatch(button('Edit Connection…'));
    expect(row).not.toContain('Try Again');
  });

  test('a role that can write — one quiet line under the row (amber dot, the sentence, its longer reason in a tooltip) and a × that dismisses it; nothing else', () => {
    const writer = { ...SERVER, canWrite: true };
    show({ selected: DEV, connections: [view(dev, 'connected', { server: writer })], catalog: CATALOG });
    const row = rowOf(html(), 'acme_dev');
    // Short enough for one line at the sidebar's default width; the reason in the tooltip.
    expect(row).toMatch(/<div class="db-write" role="note"><i class="db-write-dot" aria-hidden="true"><\/i><span class="db-write-text" data-tip="Atelier stays read-only: every statement runs in a read-only transaction\. A read-only role is safer still\.">This role can write<\/span><button type="button" class="db-write-x" aria-label="Dismiss" data-tip="Dismiss"><svg/);
    expect(row).not.toContain('db-note');
    expect(row).not.toContain('Copy SQL for a Read-only Role');
    expect(row.match(/<button/g)).toHaveLength(2); // the row and the ×
    show({ selected: DEV, connections: [view({ ...dev, writeNoted: true }, 'connected', { server: writer })], catalog: CATALOG });
    expect(html()).not.toContain('This role can write');
    show({ selected: DEV, connections: [view(dev, 'connected')], catalog: CATALOG });
    expect(html()).not.toContain('This role can write');
  });
});

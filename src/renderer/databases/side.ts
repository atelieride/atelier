// The Databases sidebar's pure helpers: a connection's sub line, the catalog split by kind
// and filtered, the folds each connection remembers, what each problem offers, the exact form a TLS fix saves, a pasted
// connection URL, SQL names for the copies, ↑/↓ in the list, and the one connect that showing the view makes.
// Loaded with the sidebar's chunk, never with the first paint.
import {
  defaultName, type DbCatalog, type DbConnection, type DbConnectionForm, type DbConnState, type DbConnView, type DbEnum, type DbFunction, type DbProblem,
  type DbProblemKind, type DbRel, type DbSnapshot, type DbTls
} from '@shared/databases';
import { parseDbUrl } from '@shared/databases-url';
import { quoteIdent } from '@shared/pg-json';
import { tdb } from '../i18n/db';
import type { DbSheet } from './store';
import { whereOf } from './view';

// —— connections ——

/**
 * Where a connection points (view.ts's whereOf, the footer's too: host:port, an IPv6 host in brackets, or its socket
 * directory with its port when not 5432 — the socket file is named after it), and its SSH hop.
 */
export function endpointOf(c: Pick<DbConnection, 'host' | 'port' | 'socket' | 'ssh'>): string {
  const where = whereOf(c);
  return c.ssh ? `${where} · ${tdb.side.viaSsh(c.ssh.host)}` : where;
}

export type StateDot = 'ok' | 'idle' | 'warn' | 'error' | 'busy';

const DOTS: Record<DbConnState, StateDot> = { connected: 'ok', idle: 'idle', password: 'warn', error: 'error', connecting: 'busy' };

/**
 * The row's dot (databases.css `.db-st`): green connected, grey idle, amber needs a password, rose can't connect, sky
 * while connecting. Connected with a problem (its catalog couldn't be read): amber — it works, something to look at;
 * rose stays for a connection that can't connect.
 */
export function stateDot(v: Pick<DbConnView, 'state' | 'problem'>): StateDot {
  return v.state === 'connected' && v.problem ? 'warn' : DOTS[v.state];
}

export type NoteKind = 'password' | 'problem' | 'write';

/**
 * The note under a row: the password field, the problem with its fix, the write note. While its
 * own action is pending (Connect, Try Again, a TLS fix), the note it came from stays whatever main says meanwhile
 * ("connecting"): the row never collapses and comes back under the pointer. A connected connection's problem (its
 * catalog couldn't be read) is the catalog's to say, with Refresh.
 */
export function noteFor(v: DbConnView, pending: NoteKind | null): NoteKind | null {
  if (pending) return pending;
  if (v.state === 'password') return 'password';
  if (v.state === 'error' && v.problem) return 'problem';
  if (v.state === 'connected' && v.server?.canWrite && !v.conn.writeNoted) return 'write';
  return null;
}

/**
 * The row's sub line: where it points, or the state while connecting or wanting a password; the picked
 * connection left idle (Disconnect, or main closed it) says it isn't connected.
 */
export function connSub(v: DbConnView, selected: boolean): string {
  if (v.state === 'connecting') return tdb.side.connecting;
  if (v.state === 'password') return tdb.side.needsPassword;
  const where = endpointOf(v.conn);
  return v.state === 'idle' && selected ? `${where} · ${tdb.side.notConnected}` : where;
}

/**
 * Showing the view connects the remembered pick when it is idle with no problem — opening the view is the user's
 * action — and nothing else: decided once, on the first snapshot main has answered with. A pick the user
 * disconnected (main holds it, in this window or another) stays closed until the user connects it themselves.
 */
export function connectOnShow(connect: (id: string) => void): (snap: DbSnapshot, loaded: boolean) => void {
  let done = false;
  return (snap, loaded) => {
    if (done || !loaded) return;
    done = true;
    const v = snap.selected ? snap.connections.find((c) => c.conn.id === snap.selected) : undefined;
    if (v && v.state === 'idle' && v.problem === null && !v.held) connect(v.conn.id);
  };
}

// —— the catalog ——

export type FoldId = 'tables' | 'views' | 'matviews' | 'enums' | 'functions';
/** Board 1: Tables open, the other sections folded until opened. */
export const DEFAULT_FOLDED: readonly FoldId[] = Object.freeze(['views', 'matviews', 'enums', 'functions']);

export function foldedOf(folds: Readonly<Record<string, readonly string[]>>, connId: string): readonly string[] {
  return folds[connId] ?? DEFAULT_FOLDED;
}

/** The folds with one section of one connection opened or folded (remembered per connection). */
export function toggleFold(folds: Readonly<Record<string, readonly string[]>>, connId: string, id: FoldId): Record<string, string[]> {
  const cur = foldedOf(folds, connId);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  return { ...(folds as Record<string, string[]>), [connId]: next };
}

/** A section's rows shown at first: enough to scroll, few enough to draw at once; the filter finds the rest. */
export const ROW_CAP = 500;

/** The rows a section shows, and how many more Show all would add. */
export function capRows<T>(rows: T[], all: boolean, cap = ROW_CAP): { shown: T[]; more: number } {
  return all || rows.length <= cap ? { shown: rows, more: 0 } : { shown: rows.slice(0, cap), more: rows.length - cap };
}

// Each snapshot main sends is a new object: rows compare what they show, so an unchanged one isn't drawn again.
export const sameRel = (a: DbRel, b: DbRel) =>
  a.schema === b.schema && a.name === b.name && a.kind === b.kind && a.estimate === b.estimate && a.partitions === b.partitions;
export const sameEnum = (a: DbEnum, b: DbEnum) =>
  a.schema === b.schema && a.name === b.name && a.values.length === b.values.length && a.values.every((v, i) => v === b.values[i]);
export const sameFn = (a: DbFunction, b: DbFunction) =>
  a.oid === b.oid && a.schema === b.schema && a.name === b.name && a.args === b.args && a.returns === b.returns;
const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean) => a.length === b.length && a.every((x, i) => same(x, b[i]!));

/**
 * Whether two catalogs show the same in the sidebar: the Catalog and its folds aren't drawn again when main's next
 * snapshot carries the same one (another connection's state, a mask, a tab). The palette's names aren't the sidebar's.
 */
export const sameCatalog = (a: DbCatalog, b: DbCatalog) =>
  a === b || (a.connId === b.connId && a.database === b.database && a.schema === b.schema && a.noRels === b.noRels
    && sameList(a.databases, b.databases, (x, y) => x === y) && sameList(a.schemas, b.schemas, (x, y) => x === y)
    && sameList(a.rels, b.rels, sameRel) && sameList(a.enums, b.enums, sameEnum) && sameList(a.functions, b.functions, sameFn));

export interface CatalogLists { tables: DbRel[]; views: DbRel[]; matviews: DbRel[]; enums: DbEnum[]; functions: DbFunction[] }

/** The schema's tables, views, materialized views, enums and functions holding the filter (any case), in main's order. */
export function catalogLists(cat: Pick<DbCatalog, 'rels' | 'enums' | 'functions'>, filter: string): CatalogLists {
  const q = filter.trim().toLowerCase();
  const hit = (name: string) => !q || name.toLowerCase().includes(q);
  const rels = cat.rels.filter((r) => hit(r.name));
  return {
    tables: rels.filter((r) => r.kind === 'table'), views: rels.filter((r) => r.kind === 'view'), matviews: rels.filter((r) => r.kind === 'matview'),
    enums: cat.enums.filter((e) => hit(e.name)), functions: cat.functions.filter((f) => hit(f.name))
  };
}

// —— problems ——

export type ProblemAction = 'retry' | 'edit' | 'tlsOff' | 'useTls' | 'useRequire' | 'refresh';

const ACTIONS: Record<DbProblemKind, readonly ProblemAction[]> = {
  refused: ['retry'], host: ['edit'], timeout: ['retry'], auth: [], password: [], nodb: ['edit'], toomany: ['retry'], notls: ['tlsOff'],
  needtls: ['useTls'], cert: ['useRequire'], ssh: ['edit'], canceled: ['retry'], denied: [], gone: ['refresh'], lost: [],
  'unknown-table': ['refresh'], norow: [], toolarge: [], held: [], other: ['retry']
};

/** What a problem offers: Try Again, Edit Connection…, the TLS fixes, Refresh; a password wanted has its own field. */
export function problemActions(kind: DbProblemKind): readonly ProblemAction[] {
  return ACTIONS[kind];
}

/**
 * What a problem note says: "Can't connect · connection refused localhost:5432" → its title and the mono detail;
 * Postgres's own error ("other") whole, with its detail and SQLSTATE; a certificate's raw reason as the detail.
 */
export function problemParts(p: DbProblem): { title: string; detail: string | null; code: string | null } {
  if (p.kind === 'other') return { title: p.message, detail: p.detail ?? null, code: p.code ?? null };
  if (p.kind === 'cert') return { title: p.message, detail: p.detail ?? null, code: null };
  const i = p.message.indexOf(' · ');
  return i < 0 ? { title: p.message, detail: null, code: null } : { title: p.message.slice(0, i), detail: p.message.slice(i + 3), code: null };
}

/** The TLS mode a fix saves: Turn TLS Off, Use TLS (Require), Use Require (encrypted, not verified). */
export function tlsOf(fix: 'tlsOff' | 'useTls' | 'useRequire'): DbTls {
  return fix === 'tlsOff' ? 'off' : 'require';
}

/**
 * The connection as the form `save` takes, exactly (main's schema is strict, so nothing of the store's
 * object is spread in), with another TLS mode.
 */
export function formOf(c: DbConnection, tls: DbTls): DbConnectionForm {
  return {
    name: c.name, engine: c.engine, env: c.env, host: c.host, port: c.port, database: c.database, user: c.user,
    ...(c.socket !== undefined ? { socket: c.socket } : {}),
    tls,
    ssh: c.ssh ? { host: c.ssh.host, port: c.ssh.port, user: c.ssh.user } : null,
    scope: c.scope.kind === 'all' ? { kind: 'all' } : { kind: 'project', root: c.scope.root }
  };
}

/**
 * The database chip's pick: the connection as the exact form `save` takes, on another database of its
 * server. A name that was the database's own (defaultName: `<database>`, `<provider> · <database>`) follows it; a name
 * the user gave it stays.
 */
export function switchForm(c: DbConnection, database: string): DbConnectionForm {
  const name = c.name === defaultName(c) ? defaultName({ host: c.host, database }) : c.name;
  return { ...formOf(c, c.tls), name, database };
}

// —— paste ——

/**
 * ⌘V with a connection URL: Add Connection at its form, holding what the URL says (its password too: it
 * stays in the sheet until saved); the sheet fills the rest. Null for anything else.
 */
export function pastedSheet(text: string): DbSheet | null {
  const p = parseDbUrl(text.trim());
  if (!p) return null;
  return {
    kind: 'add', step: 2,
    form: { host: p.host, port: p.port, database: p.database, user: p.user, ...(p.socket ? { socket: p.socket } : {}), ...(p.tls ? { tls: p.tls } : {}) },
    ...(p.password !== null ? { password: p.password } : {})
  };
}

// —— copies ——

// Postgres's reserved key words: as a schema name they need quotes.
const RESERVED = new Set(('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column '
  + 'concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user '
  + 'default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner '
  + 'intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order '
  + 'outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then '
  + 'to trailing true union unique user using variadic verbose when where window with').split(' '));

const ident = (s: string) => (/^[a-z_][a-z0-9_$]*$/.test(s) && !RESERVED.has(s) ? s : quoteIdent(s));

/** `schema.name` as SQL: plain lowercase names as they are, anything else (or a reserved word) quoted. */
export function sqlName(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}

/** Copy SELECT: a first page, never the whole table (a production table can be huge). */
export function selectSql(schema: string, name: string): string {
  return `SELECT * FROM ${sqlName(schema, name)} LIMIT 100;`;
}

// —— keyboard ——

/**
 * ↑/↓, Home/End among the list's rows: the next index, or null to stay. From outside the rows (`current` -1: the
 * filter, a note's button, the sidebar itself), the nearest: ↓ the first row after it, ↑ the last before it (`before`:
 * how many rows come before it).
 */
export function navNext(count: number, current: number, key: string, before = 0): number | null {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (current < 0) {
    if (key === 'ArrowDown') return before < count ? before : null;
    if (key === 'ArrowUp') return before > 0 ? Math.min(before, count) - 1 : null;
    return null;
  }
  if (key === 'ArrowDown') return current + 1 < count ? current + 1 : null;
  if (key === 'ArrowUp') return current > 0 ? current - 1 : null;
  return null;
}

// Table tabs: a table, view or materialized view of a connection — or the connection's overview
// — open as a tab, keyed `db:<connId>/<schema>/<name>` (each part URI-encoded) or `db:<connId>`. Their labels,
// tooltips and icons (pure), and the overview's one opener (the app store's openDbTab, read when it runs).
import type { DbCatalog, DbConnView, DbRelKind, DbSnapshot } from '@shared/databases';
import { isDbTabKey } from '@shared/tabs-state';
import type { IconName } from '../components/Icon';
import { t } from '../i18n/en';
import type { TabKey } from '../tabs-model';
import { useApp } from '../store';

export type DbTabKind = DbRelKind | 'overview';
export type DbTabView = 'data' | 'structure' | 'relations';

/** An open table tab: what it shows (the overview's schema and name are empty) and which of its views. */
export interface DbTabRef { key: TabKey; connId: string; schema: string; name: string; kind: DbTabKind; view: DbTabView }

/** Identifiers as the catalog spells them (main's schemas: up to 128 characters, never a NUL). */
const MAX_NAME = 128;

/** The tab's key: a relation's, or the connection's overview when no schema and name are given. */
export function dbTabKey(connId: string, schema?: string, name?: string): TabKey {
  if (schema === undefined || name === undefined) return `db:${connId}`;
  return `db:${connId}/${encodeURIComponent(schema)}/${encodeURIComponent(name)}`;
}

/** The connection's overview tab, opened kept: the sidebar's Overview and "Databases: Overview". */
export function openDbOverview(connId: string): void {
  useApp.getState().openDbTab({ connId, schema: '', name: '', kind: 'overview', view: 'data' }, { preview: false });
}

function decode(part: string): string | null {
  try {
    const v = decodeURIComponent(part);
    return v.length > 0 && v.length <= MAX_NAME && !v.includes('\0') ? v : null;
  } catch {
    return null;
  }
}

/** What a key names (schema and name null for the overview); null for anything that isn't a well-formed table tab key. */
export function parseDbTabKey(key: string): { connId: string; schema: string | null; name: string | null } | null {
  if (!isDbTabKey(key)) return null;
  const [connId, schemaPart, namePart] = key.slice(3).split('/') as [string, string?, string?];
  if (schemaPart === undefined || namePart === undefined) return { connId, schema: null, name: null };
  const schema = decode(schemaPart);
  const name = decode(namePart);
  return schema !== null && name !== null ? { connId, schema, name } : null;
}

/**
 * The tab a key names (a restore, a tab arriving in a pop-out): its kind from the catalog when it lists it (the one of
 * this connection), else a table; the overview's own. Null for a malformed key.
 */
export function dbRefOfKey(key: string, catalog?: Pick<DbCatalog, 'connId' | 'rels'> | null, view: DbTabView = 'data'): DbTabRef | null {
  const p = parseDbTabKey(key);
  if (!p) return null;
  if (p.schema === null || p.name === null) return { key: key as TabKey, connId: p.connId, schema: '', name: '', kind: 'overview', view };
  const listed = catalog?.connId === p.connId ? catalog.rels.find((r) => r.schema === p.schema && r.name === p.name) : undefined;
  return { key: key as TabKey, connId: p.connId, schema: p.schema, name: p.name, kind: listed?.kind ?? 'table', view };
}

/**
 * What the tab is called: the relation's name, then — when another tab of `all` (the ones this window shows:
 * shownDbTabsIf) has the same name — its connection (the other is another connection's) and its schema (the other is
 * another schema of the same connection). The overview is its connection's name ("Overview" when this window doesn't
 * know that connection), never compared with tables.
 */
export function dbTabLabel(ref: DbTabRef, all: readonly DbTabRef[], connName: (id: string) => string): string {
  if (ref.kind === 'overview') return connName(ref.connId) || t.db.tab.overview;
  const same = all.filter((r) => r.key !== ref.key && r.kind !== 'overview' && r.name === ref.name);
  const parts = [ref.name];
  const conn = connName(ref.connId);
  if (conn && same.some((r) => r.connId !== ref.connId)) parts.push(conn);
  if (same.some((r) => r.connId === ref.connId && r.schema !== ref.schema)) parts.push(ref.schema);
  return parts.join(' · ');
}

/** The tooltip: `<connection> · <schema>.<name>`; the overview's `<connection> · Overview`. */
export function dbTabTip(ref: DbTabRef, connName: (id: string) => string): string {
  const conn = connName(ref.connId);
  const what = ref.kind === 'overview' ? t.db.tab.overview : `${ref.schema}.${ref.name}`;
  return conn ? `${conn} · ${what}` : what;
}

const NO_DB_TABS: readonly DbTabRef[] = Object.freeze([]);
const NO_CONNS: readonly DbConnView[] = Object.freeze([]);

/**
 * What a strip or a pop-out's bar reads of the table tabs (with useShallow): those this window shows now — its strip and
 * panes, never another workspace's — which labels are told apart among; with no table tab of its own, the same empty
 * list every time, so a table tab opened or closed elsewhere never re-renders it.
 */
export const shownDbTabsIf = (on: boolean) => (s: { dbTabs: readonly DbTabRef[]; tabOrder: readonly TabKey[] }): readonly DbTabRef[] =>
  (on ? s.dbTabs.filter((r) => s.tabOrder.includes(r.key)) : NO_DB_TABS);

/** The connections, for a strip or a bar that shows a table tab; otherwise the same empty list, whatever main sends. */
export const dbConnsIf = (on: boolean) => (s: { snap: Pick<DbSnapshot, 'connections'> }): readonly DbConnView[] => (on ? s.snap.connections : NO_CONNS);

/** Each kind's icon: a table, a view, a materialized view; the overview is the connection's cylinder. */
export const DB_TAB_ICON: Record<DbTabKind, IconName> = { table: 'dbTable', view: 'view', matview: 'matview', overview: 'databases' };

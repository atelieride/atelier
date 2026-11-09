// Databases view helpers: pure — visibility, the connection in use and the footer's item,
// the environment tag's class, the connections split into this project's and those shown in every project. (A
// connection's state dot is the sidebar's: side.ts.)
import type { DbConnection, DbConnView, DbEnv, DbSnapshot } from '@shared/databases';
import type { ShowDatabases } from '@shared/settings';
import { t } from '../i18n/en';

/**
 * Auto: a saved connection this window can see — this project's or every project's (nothing is looked
 * for). Otherwise View › Databases, ⌃⇧B and the palette still open it, and it stays while it is the active view.
 */
export function databasesShown(show: ShowDatabases, snap: DbSnapshot | null): boolean {
  if (show === 'never') return false;
  if (show === 'always') return true;
  return !!snap && snap.connections.length > 0;
}

/**
 * The connection in use (the footer, the palette's Overview and tables): the selected one while it is
 * connected. Never: none.
 */
export function liveConn(show: ShowDatabases, snap: DbSnapshot): DbConnView | null {
  const v = show === 'never' ? undefined : snap.connections.find((x) => x.conn.id === snap.selected);
  return v?.state === 'connected' ? v : null;
}

/** Where a connection points: host:port (an IPv6 host in brackets) or its socket directory (its port when not 5432). */
export function whereOf(c: Pick<DbConnection, 'host' | 'port' | 'socket'>): string {
  return c.socket ? (c.port === 5432 ? c.socket : `${c.socket} · :${c.port}`) : `${c.host.includes(':') ? `[${c.host}]` : c.host}:${c.port}`;
}

/**
 * The footer's item: `pg · <name>`, a tooltip naming it, where it points and its state (the SSH hop is the
 * sidebar's to say); production in the danger color.
 */
export function dbFoot(v: DbConnView | null): { name: string; tip: string; prod: boolean } | null {
  return v && { name: v.conn.name, tip: t.db.footTip(v.conn.name, whereOf(v.conn)), prod: v.conn.env === 'prod' };
}

export type EnvClass = 'is-local' | 'is-dev' | 'is-staging' | 'is-prod';

/** Local green, Dev sky, Staging violet, Prod the theme's danger color (databases.css `.db-env`). */
export function envClass(env: DbEnv): EnvClass {
  return `is-${env}`;
}

/**
 * "This project" and "Every project", each in the order main sent. Main only sends what the window's project
 * can see; a connection of another project (or any project connection with no project open) is left out.
 */
export function groupConnections(views: DbConnView[], root: string | null): { project: DbConnView[]; all: DbConnView[] } {
  const project: DbConnView[] = [];
  const all: DbConnView[] = [];
  for (const v of views) {
    const s = v.conn.scope;
    if (s.kind === 'all') all.push(v);
    else if (root !== null && s.root === root) project.push(v);
  }
  return { project, all };
}

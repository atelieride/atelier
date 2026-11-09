// The Databases sidebar's actions: the context menus — a connection's, a table's or view's,
// the schema chip's, an enum's and a function's (right-click or Shift+F10 on the row) — what a problem's buttons do, and
// the copies, which never hold a password. A table's Send Schema and Ask About This Table are actions.ts's.
import { create } from 'zustand';
import type { DbCatalog, DbConnView, DbEnum, DbFunction, DbRel } from '@shared/databases';
import { formatDbUrl, psqlCommand } from '@shared/databases-url';
import { copyText } from '../clipboard';
import { sendTarget } from '../docker/actions';
import { tdb } from '../i18n/db';
import { kbd } from '../kbd';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { askTable, sendSchema } from './actions';
import { formOf, selectSql, switchForm, tlsOf, type ProblemAction } from './side';
import { useDb } from './store';
import { openDbOverview, type DbTabView } from './tabs';

const m = tdb.menu;
const f = tdb.fail;
const api = () => window.atelier.databases;
const toast = (text: string) => useApp.getState().showToast(text);

/**
 * A user's action through main: its answer, or null when the call itself failed (rejected, or threw before it went) —
 * said in a toast, so nothing waits on an answer that won't come.
 */
export async function attempt<T>(call: () => Promise<T>, failed: string): Promise<T | null> {
  try {
    return await call();
  } catch {
    toast(failed);
    return null;
  }
}

/** Copies through main, then says so. */
export function copyWithToast(text: string): void {
  void copyText(text).then((ok) => { if (ok) useApp.getState().showToast(tdb.side.copied, undefined, 'info'); });
}

/**
 * A row's click or Connect: picks the connection (remembered for the project) and connects it — main lets an explicit
 * Disconnect's hold go, for every window.
 */
export async function selectConn(id: string): Promise<void> {
  await attempt(() => api().select(id), f.connect);
}

/** Disconnect: main closes it and holds it closed for every window until one connects it. */
async function disconnectConn(id: string): Promise<void> {
  await attempt(() => api().disconnect(id), f.disconnect);
}

/**
 * What the sidebar is doing in this window: the Refreshes running (the head's button turns, the
 * catalog dims) and the connection whose database is switching (the catalog's place stays). Its own small store,
 * in the sidebar's chunk: the first paint carries none of it.
 */
export const useSideWork = create<{ refreshing: number; switching: string | null }>(() => ({ refreshing: 0, switching: null }));

/** Refresh stays busy at least this long (one turn of its icon): a read that answers at once is still seen to happen. */
export const REFRESH_MIN_MS = 600;

/**
 * The sidebar's Refresh (its head's button, a connection's menu): the picked connection's catalog read again, busy
 * meanwhile — a failure said in a toast, as every call.
 */
export async function refreshSidebar(): Promise<void> {
  const started = Date.now();
  useSideWork.setState((s) => ({ refreshing: s.refreshing + 1 }));
  try {
    await attempt(() => api().refresh(), f.refresh);
    const left = REFRESH_MIN_MS - (Date.now() - started);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  } finally {
    useSideWork.setState((s) => ({ refreshing: Math.max(0, s.refreshing - 1) }));
  }
}

/** Refresh on a connection: its catalog read again; another one than the picked is picked first (only the pick's shows). */
async function refreshConn(id: string): Promise<void> {
  if (useDb.getState().snap.selected !== id && (await attempt(() => api().select(id), f.refresh)) === null) return;
  await refreshSidebar();
}

/** Copy SQL for a Read-only Role: main's script for the connected server's version, copied. */
async function copyRoleSql(id: string): Promise<void> {
  const r = await attempt(() => api().readOnlySql(id), f.roleSql);
  if (r?.ok) copyWithToast(r.value);
  else if (r) toast(r.problem.message);
}

async function duplicateConn(id: string): Promise<void> {
  const r = await attempt(() => api().duplicate(id), f.duplicate);
  if (r && !r.ok) toast(r.problem.message);
}

export function connMenu(v: DbConnView): MenuItem[] {
  const c = v.conn;
  const live = v.state === 'connected' || v.state === 'connecting';
  return [
    live
      ? { id: 'disconnect', label: m.disconnect, icon: 'plug', run: () => void disconnectConn(c.id) }
      // Connecting picks it too: its catalog is what one connects for.
      : { id: 'connect', label: m.connect, icon: 'plug', run: () => void selectConn(c.id) },
    { id: 'overview', label: m.overview, icon: 'pulse', run: () => openDbOverview(c.id) },
    { id: 'refresh', label: m.refresh, icon: 'refresh', disabled: v.state !== 'connected', run: () => void refreshConn(c.id) },
    'sep',
    { id: 'edit', label: m.edit, icon: 'edit', run: () => useDb.getState().setSheet({ kind: 'edit', id: c.id }) },
    { id: 'duplicate', label: m.duplicate, run: () => void duplicateConn(c.id) },
    { id: 'copy-url', label: m.copyUrl, icon: 'copy', run: () => copyWithToast(formatDbUrl(c)) },
    { id: 'copy-psql', label: m.copyPsql, icon: 'terminal', run: () => copyWithToast(psqlCommand(c)) },
    // The script depends on the server's version: once connected.
    { id: 'copy-role-sql', label: m.copyRoleSql, icon: 'lock', disabled: !v.server, run: () => void copyRoleSql(c.id) },
    'sep',
    { id: 'remove', label: m.remove, icon: 'trash', danger: true, run: () => useDb.getState().setSheet({ kind: 'remove', id: c.id }) }
  ];
}

/** The connections a problem's button is working on: a second click while it runs does nothing. */
const running = new Set<string>();

/**
 * A problem's button: Try Again, Edit Connection…, Refresh, or a TLS fix — the connection saved with that mode
 * as the exact form `save` takes, the password field left empty, then connected. Another TLS mode is another server for
 * a password: a saved one is asked for again, never sent in the clear without being typed for it.
 * True when it did what it set out to (the connection connected, the catalog read again, the sheet open).
 */
export async function problemAction(v: DbConnView, a: ProblemAction): Promise<boolean> {
  const id = v.conn.id;
  if (a === 'edit') { useDb.getState().setSheet({ kind: 'edit', id }); return true; }
  if (running.has(id)) return false;
  running.add(id);
  try {
    if (a === 'refresh') return (await attempt(() => api().refresh(), f.refresh)) !== null;
    // Main's connect lets a hold go too.
    if (a !== 'retry') {
      const r = await attempt(() => api().save({ form: formOf(v.conn, tlsOf(a)), password: null, id }), f.save);
      if (!r) return false;
      if (!r.ok) { toast(r.problem.message); return false; }
      if (r.warning) toast(r.warning);
    }
    return (await attempt(() => api().connect(id), f.connect))?.ok ?? false;
  } finally {
    running.delete(id);
  }
}

/** Opens a table or view: a click's preview, a kept tab, to the side, or in another of its views. */
export function openRel(connId: string, r: DbRel, o: { preview: boolean; side?: boolean; view?: DbTabView }): void {
  useApp.getState().openDbTab({ connId, schema: r.schema, name: r.name, kind: r.kind, view: 'data' }, o);
}

export function relMenu(connId: string, r: DbRel): MenuItem[] {
  const ref = { connId, schema: r.schema, name: r.name };
  // The session Send Schema pastes into (the Docker and Redis bars' target); none: Redis's words, the press says why.
  const target = sendTarget();
  return [
    { id: 'open', label: m.open, run: () => openRel(connId, r, { preview: true }) },
    { id: 'open-new', label: m.openNew, run: () => openRel(connId, r, { preview: false }) },
    { id: 'open-to-side', label: m.openSide, icon: 'split', hint: kbd('⌥-click'), run: () => openRel(connId, r, { preview: false, side: true }) },
    'sep',
    // Another view than Data is an investment: kept, so its nodes and links open beside it, never in its place.
    { id: 'structure', label: m.structure, run: () => openRel(connId, r, { preview: false, view: 'structure' }) },
    { id: 'relations', label: m.relations, run: () => openRel(connId, r, { preview: false, view: 'relations' }) },
    'sep',
    { id: 'copy-name', label: m.copyName, icon: 'copy', run: () => copyWithToast(r.name) },
    { id: 'copy-select', label: m.copySelect, icon: 'code', run: () => copyWithToast(selectSql(r.schema, r.name)) },
    'sep',
    { id: 'send-schema', label: target ? m.sendSchema(target.title) : m.sendSchemaNone, icon: 'send', run: () => void sendSchema(ref) },
    { id: 'ask-table', label: m.askTable, icon: 'sparkle', run: () => void askTable(ref) }
  ];
}

/**
 * Another database of the connection's server (the database chip, the empty database's hint): saved on it
 * through `save` — the exact form (switchForm), the password field empty —, its
 * table tabs closed (they name the old database's tables; its overview is the connection's and follows), said in a
 * quiet toast, then connected. One switch at a time; the database it shows already does nothing.
 */
export async function switchDatabase(connId: string, database: string): Promise<void> {
  const v = useDb.getState().snap.connections.find((x) => x.conn.id === connId);
  if (!v || v.conn.database === database || useSideWork.getState().switching !== null) return;
  useSideWork.setState({ switching: connId });
  try {
    const r = await attempt(() => api().save({ form: switchForm(v.conn, database), password: null, id: connId }), f.database);
    if (!r) return;
    if (!r.ok) { toast(r.problem.message); return; }
    useApp.getState().closeDbTabs((t) => t.connId === connId && t.kind !== 'overview');
    useApp.getState().showToast(tdb.side.switched(database), undefined, 'info');
    await attempt(() => api().connect(connId), f.connect);
  } finally {
    useSideWork.setState({ switching: null });
  }
}

/**
 * The database chip's drop-down: the server's databases the role may connect to, the one shown checked —
 * listed even when the server's list left it out (or couldn't be read).
 */
export function databaseMenu(cat: Pick<DbCatalog, 'connId' | 'database' | 'databases'>): MenuItem[] {
  const all = cat.databases.includes(cat.database) ? cat.databases : [cat.database, ...cat.databases];
  return all.map((d) => ({
    id: `database:${d}`, label: d, checked: d === cat.database, radio: true as const, ...(d === cat.database ? { icon: 'check' as const } : {}),
    run: () => void switchDatabase(cat.connId, d)
  }));
}

/** The schema chip's drop-down: the schemas holding anything (public first, main's order), the picked one checked. */
export function schemaMenu(cat: Pick<DbCatalog, 'connId' | 'schemas' | 'schema'>): MenuItem[] {
  return cat.schemas.map((s) => ({
    id: `schema:${s}`, label: s, checked: s === cat.schema, radio: true as const, ...(s === cat.schema ? { icon: 'check' as const } : {}),
    run: () => void attempt(() => api().setSchema(cat.connId, s), f.schema)
  }));
}

export function enumMenu(e: DbEnum): MenuItem[] {
  return [
    { id: 'copy-name', label: m.copyName, icon: 'copy', run: () => copyWithToast(e.name) },
    { id: 'copy-values', label: m.copyValues, run: () => copyWithToast(e.values.join(', ')) }
  ];
}

/** A function's signature as Postgres states it: `schema.name(args) RETURNS type`. */
export const signatureOf = (f: DbFunction) => `${f.schema}.${f.name}(${f.args}) RETURNS ${f.returns}`;

/**
 * Copy Definition: pg_get_functiondef through main's DDL path, the function named by its schema,
 * name and identity arguments as the list shows them (overloads apart; never its oid, which a restore changes), then
 * copied. Main's problem, or a call that never got there, said in a toast; nothing copied then.
 */
async function copyDefinition(connId: string, fn: DbFunction): Promise<void> {
  const r = await attempt(() => api().ddl({ connId, schema: fn.schema, name: fn.name, args: fn.args }), f.definition);
  if (!r) return;
  if (!r.ok) { toast(r.problem.message); return; }
  copyWithToast(r.value);
}

export function fnMenu(connId: string, f: DbFunction): MenuItem[] {
  return [
    { id: 'copy-name', label: m.copyName, icon: 'copy', run: () => copyWithToast(f.name) },
    { id: 'copy-signature', label: m.copySignature, run: () => copyWithToast(signatureOf(f)) },
    { id: 'copy-definition', label: m.copyDefinition, icon: 'code', run: () => void copyDefinition(connId, f) }
  ];
}

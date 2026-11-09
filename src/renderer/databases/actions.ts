// What the Databases view hands to Claude: rows, a table's schema, a
// running query — into the session the Docker and Redis bars target (their sendToSession: one bracketed paste, no
// Enter, only while Claude waits for input; no session: a toast with Copy), or into a new session "db: <table>" as
// Redis's Ask starts one. The texts are prompts.ts's: what is sent is what is shown (Mask values sends the masks,
// nothing filtered, no confirm for production — the environment in the first line is the cue). A read that fails is
// said in a toast, never silent. Lazy: in the chunk the sidebar and the table tab share (menus.ts imports it statically:
// a dynamic import there would grow the first paint — Vite's preload helper exported, a chunk in the entry's map).
import type { DbConnection, DbRelations, DbResult, DbTableRef } from '@shared/databases';
import type { FormatOpts } from '@shared/pg-format';
import { copyText } from '../clipboard';
import { askInSession, sendTarget, sendToSession } from '../docker/actions';
import { tdt } from '../i18n/db-table';
import { useApp } from '../store';
import { ask } from './data';
import { inGridOrder, rowsAs, type GridSource } from './grid-copy';
import { bytesLabel } from './grid-model';
import type { OverviewActions } from './OverviewView';
import { askQueryPrompt, askTablePrompt, rowsPrompt, schemaPrompt } from './prompts';
import { useDb } from './store';
import { useStruct } from './structure-data';

const c = tdt.claude;
const toast = (text: string) => useApp.getState().showToast(text);
const api = () => window.atelier.databases;

/**
 * The title of the session a Send pastes into (Docker's and Redis's target: the selected session, else the first), or
 * null; read again whenever the app's store changes (sendTarget reads the same state the selector is handed).
 */
export const useTarget = (): string | null => useApp(() => sendTarget()?.title ?? null);

/** The connection as main's snapshot has it; one removed meanwhile is said so (null). */
function connOf(id: string) {
  const conn = useDb.getState().snap.connections.find((v) => v.conn.id === id)?.conn ?? null;
  if (!conn) toast(tdt.unavailable);
  return conn;
}

/** A new session named "db: <name>", the prompt typed in once Claude is ready — not sent —, as Redis's Ask. */
const askNew = (name: string, what: string, prompt: string): Promise<void> => askInSession(c.sessionName(name), prompt, c.typed(what));

const names = (ref: DbTableRef): DbTableRef => ({ connId: ref.connId, schema: ref.schema, name: ref.name });
const label = (ref: DbTableRef) => `${ref.schema}.${ref.name}`;

/**
 * A table's DDL or relations: what its tab's Structure view shows when it read them (`key`: the tab), else read now by
 * the table's names — a read is theirs, so a held connection connects first (data.ts ask).
 */
function part<T>(ref: DbTableRef, key: string | undefined, which: 'ddl' | 'relations'): DbResult<T> | Promise<DbResult<T>> {
  const shown = key === undefined ? undefined : useStruct.getState().tabs[key]?.[which]?.v;
  if (shown !== undefined) return { ok: true, value: shown as T };
  return ask(ref.connId, () => (which === 'ddl' ? api().ddl(names(ref)) : api().relations(names(ref))) as Promise<DbResult<T>>);
}

/**
 * The rows' text for a send, or null — said: the connection gone, none of the rows loaded, or a first row
 * too large to send, with a Copy of it as Copy Row as JSON writes it.
 */
function rowsText(table: DbTableRef, src: GridSource, sel: readonly number[], o: FormatOpts): { conn: DbConnection; text: string } | null {
  const conn = connOf(table.connId);
  if (!conn) return null;
  const r = rowsPrompt({ conn, table, src, sel, o });
  if (r.kind === 'text') return { conn, text: r.text };
  if (r.kind === 'none') { toast(c.nothing); return null; }
  const row = rowsAs(src, inGridOrder(src, sel).slice(0, 1), 'json', table, o);
  useApp.getState().showToast(c.tooLarge(bytesLabel(r.bytes)), { label: tdt.copy, run: () => void copyText(row) });
  return null;
}

/** Send to <session> (⌥↩, the action bar, the cell menu): the rows as shown, in the grid's order. */
export function sendRows(table: DbTableRef, src: GridSource, sel: readonly number[], o: FormatOpts): void {
  const r = rowsText(table, src, sel, o);
  if (r) void sendToSession(r.text);
}

/**
 * Ask in a New Session (the action bar, the cell menu): the rows as Send gives them — taken at the press —, then the
 * table's DDL; one that can't be read is said, and the rows go without it.
 */
export async function askRows(table: DbTableRef, src: GridSource, sel: readonly number[], o: FormatOpts, key?: string): Promise<void> {
  const r = rowsText(table, src, sel, o);
  if (!r) return;
  const ddl = await part<string>(table, key, 'ddl');
  if (!ddl.ok) toast(c.ddlSkipped(label(table), ddl.problem.message));
  await askNew(table.name, label(table), askTablePrompt({ conn: r.conn, table, ddl: ddl.ok ? ddl.value : null, rows: r.text }));
}

/** The DDL and the relations: no DDL, said and nothing to send (null); no relations, said and left out. */
async function schemaOf(ref: DbTableRef, key: string | undefined): Promise<{ ddl: string; rel: DbRelations | null } | null> {
  const [ddl, rel] = await Promise.all([part<string>(ref, key, 'ddl'), part<DbRelations>(ref, key, 'relations')]);
  if (!ddl.ok) { toast(c.ddlFailed(label(ref), ddl.problem.message)); return null; }
  if (!rel.ok) toast(c.relSkipped(label(ref), rel.problem.message));
  return { ddl: ddl.value, rel: rel.ok ? rel.value : null };
}

/** Send Schema to <session> (Structure's DDL card, the sidebar's table menu): the DDL and its relations. */
export async function sendSchema(ref: DbTableRef, key?: string): Promise<void> {
  const conn = connOf(ref.connId);
  const s = conn ? await schemaOf(ref, key) : null;
  if (conn && s) void sendToSession(schemaPrompt({ conn, table: ref, ...s }));
}

/** Ask About This Table in a New Session (the sidebar's table menu): a session with the DDL and the relations. */
export async function askTable(ref: DbTableRef, key?: string): Promise<void> {
  const conn = connOf(ref.connId);
  const s = conn ? await schemaOf(ref, key) : null;
  if (conn && s) await askNew(ref.name, label(ref), askTablePrompt({ conn, table: ref, ...s }));
}

/** The overview's ✦ Ask Claude: a session "db: <connection> pid <pid>" with the query as shown. */
export function overviewActions(connId: string): OverviewActions {
  return {
    ask: (a, query) => {
      const conn = connOf(connId);
      if (conn) void askNew(`${conn.name} pid ${a.pid}`, `pid ${a.pid}`, askQueryPrompt({ conn, activity: a, query }));
    }
  };
}

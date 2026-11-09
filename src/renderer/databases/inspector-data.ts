// The row inspector's reads: Referenced by's counts, the FK peeks, the hidden fields,
//Load full value, and the table's foreign keys (once per tab). Cached per (tab, row key) — a row shown again
// asks nothing — and dropped when a new first page lands (data.ts announces it: a reload, a filter, a sort), which
// starts a new generation of the tab's reads (the inspector's reads wait on it). One read in flight per
// section, which a second asker waits on; a reply for an older read, or for rows that were replaced since, is dropped
// (monotonic ids, as data.ts). Each section keeps its own failure (shown in its place, never a global error). Load full
// value keeps the last 3 values of a tab. Plus Open Referenced Row. Lazy, with the table's chunk.
import { create } from 'zustand';
import type { DbCell, DbFullRequest, DbPage, DbPeek, DbPeekRequest, DbProblem, DbRefCount, DbRefsRequest, DbRelations, DbResult, DbTableRef } from '@shared/databases';
import type { DbFilter } from '@shared/databases-filters';
import { useApp } from '../store';
import { ask, onFirstPage } from './data';
import { fkOf, referencedFilters, rowFields } from './inspector-model';

/** A read: waiting, its value, or its problem; `id` says which read it is (the latest wins). */
export type Req<T> = { s: 'wait'; id: number } | { s: 'ok'; id: number; v: T } | { s: 'err'; id: number; p: DbProblem };

/** What the inspector read for one row. */
export interface RowReads {
  refs?: Req<DbRefCount[]>;
  /** The FK peeks, by foreign key name. */
  peeks: Readonly<Record<string, Req<DbPeek>>>;
  /** The hidden fields: this table's row by its row key, every column. */
  more?: Req<DbPeek>;
  /** Load full value, by column. */
  full: Readonly<Record<string, Req<string>>>;
}

/**
 * A tab's reads: its foreign keys, and per row (by its key). `gen`: the page they belong to; `fulls`: the full values
 * kept, oldest first (row and column).
 */
export interface TabReads { gen: number; rels?: Req<DbRelations>; rows: Readonly<Record<string, RowReads>>; fulls?: readonly string[] }

interface InspState { tabs: Readonly<Record<string, TabReads>> }
export const useInsp = create<InspState>(() => ({ tabs: {} }));

/** Full values a tab keeps: up to 16 MB each, so only the last few. */
const FULL_KEEP = 3;
const NO_ROW: RowReads = Object.freeze({ peeks: Object.freeze({}), full: Object.freeze({}) });
let gen = 0;
let seq = 0;
/** The reads in flight, by id: who asks while one waits waits on it (Open Referenced Row while the keys are read). */
const inflight = new Map<number, Promise<unknown>>();

const entry = (key: string): TabReads => useInsp.getState().tabs[key] ?? { gen: 0, rows: {} };
const put = (key: string, t: TabReads) => useInsp.setState((s) => ({ tabs: { ...s.tabs, [key]: t } }));

/** A row's reads, or undefined before any. */
export function rowReads(key: string, row: string): RowReads | undefined {
  return useInsp.getState().tabs[key]?.rows[row];
}

/** The generation of a tab's reads (a selector): it changes with every new first page, read or not since. */
export const readsGen = (key: string) => (s: InspState): number => s.tabs[key]?.gen ?? 0;

/** A new first page landed: the rows the reads were for are gone — a new generation, nothing in it. */
export function newPage(key: string): void {
  const g = ++gen;
  useInsp.setState((s) => ({ tabs: { ...s.tabs, [key]: { gen: g, rows: {} } } }));
}
onFirstPage(newPage);

/** The tab closed: its reads go. */
export function forgetReads(key: string): void {
  if (!(key in useInsp.getState().tabs)) return;
  gen++;
  useInsp.setState((s) => {
    const tabs = { ...s.tabs };
    delete tabs[key];
    return { tabs };
  });
}

/**
 * One section's read: nothing new when it waits already (the read in flight is waited on) or has its value (or its
 * failure — until Retry, `force`, which always reads again: the newer read wins); else asked through main (data.ts ask:
 * a user-caused read connects a held connection first, a call that never got there answers as a problem), its reply
 * kept only when the tab's reads are still the ones it was asked for and no newer read replaced it.
 */
function read<T>(
  key: string, connId: string, get: (t: TabReads) => Req<T> | undefined, set: (t: TabReads, r: Req<T>) => TabReads,
  call: () => Promise<DbResult<T>>, force: boolean
): Promise<Req<T> | undefined> {
  const t0 = entry(key);
  const cur = get(t0);
  if (cur && !force) return (cur.s === 'wait' ? inflight.get(cur.id) as Promise<Req<T> | undefined> | undefined : undefined) ?? Promise.resolve(cur);
  const id = ++seq;
  const g = useInsp.getState().tabs[key] ? t0.gen : gen;
  put(key, set({ ...t0, gen: g }, { s: 'wait', id }));
  const p = (async (): Promise<Req<T> | undefined> => {
    const r = await ask(connId, call);
    const now = useInsp.getState().tabs[key];
    if (!now || now.gen !== g || get(now)?.id !== id) return undefined;
    const done: Req<T> = r.ok ? { s: 'ok', id, v: r.value } : { s: 'err', id, p: r.problem };
    put(key, set(now, done));
    return done;
  })();
  inflight.set(id, p);
  void p.finally(() => inflight.delete(id));
  return p;
}

const api = () => window.atelier.databases;
const rowOf = (t: TabReads, row: string): RowReads => t.rows[row] ?? NO_ROW;
const withRow = (t: TabReads, row: string, r: Partial<RowReads>): TabReads => ({ ...t, rows: { ...t.rows, [row]: { ...rowOf(t, row), ...r } } });

/** The table's foreign keys (out: the FK peeks, Open Referenced Row): once per tab and page. */
export function readRels(key: string, ref: DbTableRef, force = false): Promise<Req<DbRelations> | undefined> {
  const names = { connId: ref.connId, schema: ref.schema, name: ref.name };
  return read(key, ref.connId, (t) => t.rels, (t, rels) => ({ ...t, rels }), () => api().relations(names), force);
}

/** Referenced by's counts for a row. */
export function readRefs(key: string, row: string, req: DbRefsRequest, force = false): Promise<Req<DbRefCount[]> | undefined> {
  return read(key, req.ref.connId, (t) => t.rows[row]?.refs, (t, refs) => withRow(t, row, { refs }), () => api().refs(req), force);
}

/** A foreign key's referenced row (the FK peek card). */
export function readPeek(key: string, row: string, fk: string, req: DbPeekRequest, force = false): Promise<Req<DbPeek> | undefined> {
  return read(key, req.ref.connId, (t) => t.rows[row]?.peeks[fk], (t, p) => withRow(t, row, { peeks: { ...rowOf(t, row).peeks, [fk]: p } }), () => api().peek(req), force);
}

/** The hidden fields: this table's row by its row key, every column. */
export function readMore(key: string, row: string, req: DbPeekRequest, force = false): Promise<Req<DbPeek> | undefined> {
  return read(key, req.ref.connId, (t) => t.rows[row]?.more, (t, more) => withRow(t, row, { more }), () => api().peek(req), force);
}

/** A full value in, the oldest beyond FULL_KEEP out (its "Load full value" comes back). */
function keepFull(t: TabReads, row: string, column: string, f: Req<string>): TabReads {
  let next = withRow(t, row, { full: { ...rowOf(t, row).full, [column]: f } });
  if (f.s !== 'ok') return next;
  const id = `${row}\0${column}`;
  const order = [...(t.fulls ?? []).filter((x) => x !== id), id];
  while (order.length > FULL_KEEP) {
    const [r, c] = order.shift()!.split('\0') as [string, string];
    const rr = next.rows[r];
    if (!rr) continue;
    const full = { ...rr.full };
    delete full[c];
    next = { ...next, rows: { ...next.rows, [r]: { ...rr, full } } };
  }
  return { ...next, fulls: order };
}

/** Load full value (≤ 16 MB; larger refused with main's message). */
export function readFull(key: string, row: string, column: string, req: DbFullRequest, force = false): Promise<Req<string> | undefined> {
  return read(key, req.ref.connId, (t) => t.rows[row]?.full[column], (t, f) => keepFull(t, row, column, f), () => api().full(req), force);
}

/**
 * Opens a table filtered on a key as a preview (Open ›, "N rows ›", Open Referenced Row): its first row
 * selected when the rows come; `inspector`: shown there too (the inspector's own links: the walk goes on).
 */
export function openFiltered(connId: string, target: { schema: string; name: string }, filters: DbFilter[], inspector = false): void {
  useApp.getState().openDbTab({ connId, schema: target.schema, name: target.name, kind: 'table', view: 'data' }, { preview: true, filters, ...(inspector ? { inspector: true } : {}) });
}

/**
 * Whether the cell menu offers Open Referenced Row for a column of this row: only when a filter can
 * name the key — exactly when the table's foreign keys are known, else by this column alone (its value sendable, its
 * type one a filter takes).
 */
export function canOpenReferenced(key: string, page: Pick<DbPage, 'columns'>, cells: readonly DbCell[], column: string): boolean {
  const fields = rowFields(page, cells, null);
  const ref = fields.get(column)?.col.fk;
  if (!ref) return false;
  const rels = useInsp.getState().tabs[key]?.rels;
  const fk = rels?.s === 'ok' ? fkOf(column, rels.v.out)
    : { name: '', from: { schema: '', table: '', columns: [column] }, to: { schema: ref.schema, table: ref.table, columns: [ref.column] }, indexed: false };
  return !!fk && referencedFilters(fk, fields) !== null;
}

/**
 * Open Referenced Row (the cell menu): the table a foreign key column points at, filtered on this row's key
 * (a composite key whole), as a preview. The foreign keys still being read: it waits for them.
 * Nothing for a key no filter can name; the foreign keys' read failing says why.
 */
export async function openReferenced(key: string, ref: DbTableRef, page: Pick<DbPage, 'columns'>, cells: readonly DbCell[], column: string): Promise<void> {
  const rels = await readRels(key, ref);
  if (rels?.s !== 'ok') {
    if (rels?.s === 'err') useApp.getState().showToast(rels.p.message);
    return;
  }
  const fk = fkOf(column, rels.v.out);
  const filters = fk ? referencedFilters(fk, rowFields(page, cells, null)) : null;
  if (fk && filters) openFiltered(ref.connId, { schema: fk.to.schema, name: fk.to.table }, filters);
}

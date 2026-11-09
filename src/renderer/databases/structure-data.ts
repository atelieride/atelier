// A table tab's Structure and Relations reads: the structure, the relations and
// the DDL, each a part of its own — read when the view showing it first shows (Structure: all three, its Relations card
// and DDL card included; Relations: the relations), kept while the tab is open, read again by Refresh (⌘R) for the
// visible view only, the old value shown (dimmed) meanwhile. Each part's failure stays in its place: shown again it
// isn't read again (Retry is the user's), unless the connection came back since. A reply for an older read, or for a
// tab closed since, is dropped (monotonic ids, as data.ts and inspector-data.ts). Lazy, with the table's chunk.
import { create } from 'zustand';
import type { DbConnState, DbProblem, DbRelations, DbResult, DbStructure, DbTableRef } from '@shared/databases';
import { ask, setDbKind } from './data';
import type { DbTabView } from './tabs';

export type StructPart = 'structure' | 'relations' | 'ddl';
/** A part: its read in flight (`loading`, the last value kept meanwhile), its value and when it came, or its problem. */
export interface Part<T> { readonly id: number; readonly loading: boolean; readonly v?: T; readonly p?: DbProblem; readonly at?: number }
export interface TabStruct { readonly structure?: Part<DbStructure>; readonly relations?: Part<DbRelations>; readonly ddl?: Part<string> }

interface StructState { tabs: Readonly<Record<string, TabStruct>> }
export const useStruct = create<StructState>(() => ({ tabs: {} }));

/** What a view shows, so what it reads — and what its Refresh reads again. Data's rows are data.ts's. */
export function partsOf(view: DbTabView): StructPart[] {
  return view === 'structure' ? ['structure', 'relations', 'ddl'] : view === 'relations' ? ['relations'] : [];
}

let seq = 0;
const api = () => window.atelier.databases;

function call(part: StructPart, names: DbTableRef): Promise<DbResult<unknown>> {
  return part === 'structure' ? api().structure(names) : part === 'relations' ? api().relations(names) : api().ddl(names);
}

const put = (key: string, part: StructPart, p: Part<unknown>) =>
  useStruct.setState((s) => ({ tabs: { ...s.tabs, [key]: { ...s.tabs[key], [part]: p } } }));

/** A part back as it was before a read that came to nothing: its value (no longer loading), else not there. */
function drop(key: string, part: StructPart, was: Part<unknown> | undefined): void {
  if (was?.v !== undefined) { put(key, part, { ...was, loading: false }); return; }
  useStruct.setState((s) => {
    const t: Record<string, unknown> = { ...s.tabs[key] };
    delete t[part];
    return { tabs: { ...s.tabs, [key]: t as TabStruct } };
  });
}

/**
 * A part's read: nothing new when it waits already or has its value or its failure — unless `force` (Refresh, Retry,
 * the connection back), which always reads again, the value kept on screen until the reply. Asked through main by the
 * table's names only (main's schema is strict), as data.ts asks: a read is theirs, so a held connection connects first.
 */
export async function readPart(key: string, ref: DbTableRef, part: StructPart, force = false): Promise<void> {
  const cur = useStruct.getState().tabs[key]?.[part];
  if (cur && !force) return;
  const id = ++seq;
  put(key, part, { id, loading: true, ...(cur?.v !== undefined ? { v: cur.v, at: cur.at } : {}) });
  const names: DbTableRef = { connId: ref.connId, schema: ref.schema, name: ref.name };
  const r = await ask(ref.connId, () => call(part, names));
  // The tab closed since, or a newer read replaced this one: its reply goes nowhere.
  if (useStruct.getState().tabs[key]?.[part]?.id !== id) return;
  // Main held it (another window disconnected it meanwhile): not a failure to keep — the part stays as it
  // was (a value kept, else missing: the Disconnected card, and the read once their Connect lets the hold go).
  if (!r.ok && r.problem.kind === 'held') { drop(key, part, cur); return; }
  if (!r.ok) { put(key, part, { id, loading: false, p: r.problem }); return; }
  put(key, part, { id, loading: false, v: r.value, at: Date.now() });
  // A restored tab is a table until its kind is known: the structure says.
  if (part === 'structure') setDbKind(key, (r.value as DbStructure).kind);
}

/**
 * A view shown (TableView, when it is in front with its connection known): the parts it shows that were never read;
 * `back` (the connection just came back): the failed ones too.
 */
export function showView(key: string, ref: DbTableRef, view: DbTabView, o: { back: boolean }): void {
  const t = useStruct.getState().tabs[key];
  for (const part of partsOf(view)) {
    const cur = t?.[part];
    if (!cur) void readPart(key, ref, part);
    else if (o.back && cur.p) void readPart(key, ref, part, true);
  }
}

/**
 * Refresh (⌘R, the toolbar's button, its menu) on Structure or Relations: the parts that view shows, read again — but
 * not one still being read (a second press, a double click: its read in flight answers both).
 */
export function refreshView(key: string, ref: DbTableRef, view: DbTabView): void {
  const t = useStruct.getState().tabs[key];
  for (const part of partsOf(view)) if (!t?.[part]?.loading) void readPart(key, ref, part, true);
}

/** TableView's Refresh: Structure or Relations read what they show again (true); on Data, false — the rows are its own. */
export function refreshFor(key: string, ref: DbTableRef, view: DbTabView): boolean {
  if (view === 'data') return false;
  refreshView(key, ref, view);
  return true;
}

/** What TableView's effect hands the reads: in front, the view, its connection known, held, its state. */
export interface StructInputs { visible: boolean; view: DbTabView; ready: boolean; held: boolean; connState: DbConnState }
/** What a step remembers for the next: the connection came back since the view last read (`back`), its last state. */
export interface StructWire { back: boolean; conn: DbConnState }

/**
 * TableView's effect as one step (it calls it whenever an input changes; `prev` from the last call): shown — in front,
 * on Structure or Relations, its connection known, not held — the view reads what it lacks (showView), and the parts
 * that failed again once the connection came back, even if it came back while the tab was hidden (remembered until
 * then). Held, nothing is read by itself: their Connect lets the hold go, and the next step reads.
 */
export function wireStructure(key: string, ref: DbTableRef, prev: StructWire, next: StructInputs): StructWire {
  const back = prev.back || (prev.conn !== 'connected' && next.connState === 'connected');
  if (!next.visible || next.view === 'data' || !next.ready || next.held) return { back, conn: next.connState };
  showView(key, ref, next.view, { back });
  return { back: false, conn: next.connState };
}

/** Whether a part the view shows was never asked for. */
export function viewMissing(t: TabStruct | undefined, view: DbTabView): boolean {
  return partsOf(view).some((part) => t?.[part] === undefined);
}

/** "Updated 12 s ago" for the view: its oldest part's time, once every part it shows came back with a value. */
export function viewAt(t: TabStruct | undefined, view: DbTabView): number | null {
  const ats = partsOf(view).map((part) => t?.[part]?.at);
  if (ats.length === 0 || ats.some((a) => a === undefined)) return null;
  return Math.min(...(ats as number[]));
}

/** The tab closed: its parts go (a reply still on its way finds nothing to fill). */
export function forgetStruct(key: string): void {
  if (!(key in useStruct.getState().tabs)) return;
  useStruct.setState((s) => {
    const tabs = { ...s.tabs };
    delete tabs[key];
    return { tabs };
  });
}

// The filter bar's actions: the two that change a tab's request — each
// keeps the preview, and the table view reads from the top when the request changes — and which popover is
// open: one at a time in a tab (the statement's, a filter's, the Columns checklist), none before the columns are known.
// Lazy, with the table's chunk.
import { create } from 'zustand';
import { DERIVED_MAX, type DbDerived, type DbFilter, type DbPath, type DbSort } from '@shared/databases-filters';
import { tdt } from '../i18n/db-table';
import { useApp } from '../store';
import type { TabKey } from '../tabs-model';
import { addFilter } from './filters';
import { keyOf, shownRow } from './inspector-model';
import { useDb, type DbTabState } from './store';
import { useTableUi } from './table-view';

/** The tab's filters: a change reads from the top (the table view watches the request) and keeps the preview. */
export function setFilters(key: string, next: readonly DbFilter[]): void {
  const db = useDb.getState();
  if (db.tab(key).filters === next) return;
  db.patchTab(key, { filters: next });
  useApp.getState().keepDbTab(key as TabKey);
}

/** The columns chosen (null: all of them; never none — main would read every column). Same rules as setFilters. */
export function setColumns(key: string, next: readonly string[] | null): void {
  if (next !== null && next.length === 0) return;
  const db = useDb.getState();
  const now = db.tab(key).columns;
  if (now === next || (now !== null && next !== null && now.length === next.length && now.every((c, i) => c === next[i]))) return;
  db.patchTab(key, { columns: next === null ? null : [...next] });
  useApp.getState().keepDbTab(key as TabKey);
}

const samePath = (a: DbPath, b: DbPath) => a.length === b.length && a.every((p, i) => p === b[i]);
const sameDerived = (a: DbDerived, b: DbDerived) => a.column === b.column && samePath(a.path, b.path);

type RowPick = NonNullable<DbTabState['pick']>;

/** The JSON view's pick: its row by its key, or the first row when it has none. */
export const pickOf = (rowKey: Readonly<Record<string, string>> | null): RowPick => (rowKey ? { key: { ...rowKey } } : true);

/**
 * The row the inspector shows, as a pick: the key profile's + Column reloads the rows and picks it again,
 * as the JSON view's does. None without the inspector or a row in it.
 */
export function inspectedPick(st: Pick<DbTabState, 'inspector' | 'data' | 'rows' | 'focus' | 'selection'>): RowPick | undefined {
  if (!st.inspector || !st.data) return undefined;
  const i = shownRow(st);
  return i === null ? undefined : pickOf(keyOf(st.data, st.rows[i]!));
}

/**
 * A JSON column added: appended, a copy, keeping the
 * preview; the same one again or past main's DERIVED_MAX: nothing (false). `pick`: the reloaded rows select that row
 * again — set only when it is added, so no later reload picks by surprise.
 */
export function addDerived(key: string, d: DbDerived, o: { pick?: RowPick } = {}): boolean {
  const db = useDb.getState();
  const now = db.tab(key).derived;
  if (now.length >= DERIVED_MAX || now.some((x) => sameDerived(x, d))) return false;
  db.patchTab(key, { derived: [...now, { column: d.column, path: [...d.path] }], ...(o.pick ? { pick: o.pick } : {}) });
  useApp.getState().keepDbTab(key as TabKey);
  return true;
}

/** The JSON view's Filter: the filter added — not there already, room left —, its row picked again by key. */
export function addFilterKeepingRow(key: string, f: DbFilter, rowKey: Readonly<Record<string, string>> | null): boolean {
  const now = useDb.getState().tab(key).filters;
  const next = addFilter(now, f);
  if (next === now) return false;
  setFilters(key, next);
  useDb.getState().patchTab(key, { pick: pickOf(rowKey) });
  return true;
}

/** The error card's Remove JSON Columns: a JSON column main refuses never leaves the tab stuck. */
export function clearDerived(key: string): void {
  const db = useDb.getState();
  if (db.tab(key).derived.length === 0) return;
  db.patchTab(key, { derived: [] });
  useApp.getState().keepDbTab(key as TabKey);
}

/** A JSON column's Remove Column: that one goes, the preview kept. */
export function removeDerived(key: string, d: DbDerived): void {
  const db = useDb.getState();
  const now = db.tab(key).derived;
  if (!now.some((x) => sameDerived(x, d))) return;
  db.patchTab(key, { derived: now.filter((x) => !sameDerived(x, d)) });
  useApp.getState().keepDbTab(key as TabKey);
}

/** The column menu's Sort Ascending / Descending, Sort by Key…: that column (a key by its path) alone. */
export function sortBy(key: string, column: string, dir: DbSort['dir'], path?: DbPath): void {
  useDb.getState().patchTab(key, { sort: [{ column, ...(path && path.length > 0 ? { path: [...path] } : {}), dir }] });
  useApp.getState().keepDbTab(key as TabKey);
}

/**
 * Opened on a key (Open ›, "N rows ›", Open Referenced Row — self-references too): the key's filters handed
 * over by openDbTab become the tab's — no investment, a preview stays one —, its first row is picked when the rows come
 * (data.ts), the inspector shows when asked. A tab that had filters of its own: "Filters replaced" with
 * Undo, which brings back its filters, sort and columns — only while the tab is open and still as the handoff left it
 * (else "Nothing to undo"); filters that were themselves a handoff (a walk through Open ›) are replaced quietly
 *. The table's view runs it before it reads.
 */
export function applyHandoff(key: string): void {
  const db = useDb.getState();
  const st = db.tab(key);
  const h = st.handoff;
  if (!h?.filters) return;
  const before = { filters: st.filters, sort: st.sort, columns: st.columns };
  const walked = st.handed !== undefined && st.filters === st.handed;
  db.patchTab(key, { filters: h.filters, pick: true, handoff: undefined, handed: h.filters, ...(h.inspector ? { inspector: true } : {}) });
  if (before.filters.length === 0 || walked) return;
  const after = useDb.getState().tab(key);
  const undo = () => {
    const now = useDb.getState().tab(key);
    const open = useApp.getState().dbTabs.some((r) => r.key === key);
    if (!open || now.filters !== after.filters || now.sort !== after.sort || now.columns !== after.columns) {
      useApp.getState().showToast(tdt.filters.nothingToUndo, undefined, 'info');
      return;
    }
    useDb.getState().patchTab(key, { ...before, handed: undefined });
  };
  useApp.getState().showToast(tdt.filters.replaced, { label: tdt.filters.undo, run: undo }, 'info');
}

// ---------- which popover is open ----------

/**
 * The filter popover (one in a window): its tab, the bar's element it hangs from (`data-fanchor`: "add", "chip-2",
 * "more"), the chip it edits (else a new filter), the column (a target's key) to start from (else the column list).
 */
export interface FilterPop { key: string; anchor: string; edit: number | null; target: string | null }

interface FilterUi {
  pop: FilterPop | null;
  /** The tab whose Columns popover is open. */
  cols: string | null;
  openFilter(p: FilterPop): void;
  closeFilter(key: string): void;
  openCols(key: string): void;
  closeCols(key: string): void;
}

export const useFilterUi = create<FilterUi>((set, get) => ({
  pop: null,
  cols: null,
  openFilter: (pop) => set({ pop, cols: null }),
  closeFilter: (key) => { if (get().pop?.key === key) set({ pop: null }); },
  openCols: (key) => set({ cols: key, pop: null }),
  closeCols: (key) => { if (get().cols === key) set({ cols: null }); }
}));

/**
 * A chip, "+ Filter", a "+N more" entry, the header's Filter… (`target`, the column to start from): opens the
 * filter popover — the tab's other popovers close. `toggle` (a chip, "+ Filter"): the same one open closes instead; a
 * menu entry never toggles. Before the columns are known (`ready` false) nothing opens, nor reads open: a
 * quiet toast says why.
 */
export function openFilterAt(key: string, at: { anchor: string; edit: number | null; target?: string | null }, o: { ready: boolean; toggle: boolean }): void {
  const ui = useFilterUi.getState();
  const cur = ui.pop;
  if (o.toggle && cur && cur.key === key && cur.anchor === at.anchor && cur.edit === at.edit) {
    ui.closeFilter(key);
    return;
  }
  if (!o.ready) {
    useApp.getState().showToast(tdt.filters.notYet, undefined, 'info');
    return;
  }
  useTableUi.getState().closeSql(key);
  ui.openFilter({ key, anchor: at.anchor, edit: at.edit, target: at.target ?? null });
}

/** The Columns chip: its checklist opens — the tab's other popovers close —, or closes when open. */
export function toggleColumns(key: string): void {
  const ui = useFilterUi.getState();
  if (ui.cols === key) {
    ui.closeCols(key);
    return;
  }
  useTableUi.getState().closeSql(key);
  ui.openCols(key);
}

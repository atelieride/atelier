// Databases view state: main's snapshot, each table tab's own state (filters,
// sort, columns, the rows loaded so far, selection, inspector) keyed by tab key, the open sheet, the sidebar's folds
// and table filter. A store of its own: a page of rows arriving doesn't re-render the app.
import { create } from 'zustand';
import type { DbCell, DbConnectionForm, DbPage, DbProblem, DbSnapshot } from '@shared/databases';
// Its own module: the first paint reaches nothing else of the shared databases model.
import { EMPTY_DB_SNAPSHOT } from '@shared/databases-empty';
// Types only: the module itself stays out of the live demo's bundle until the renderer runs filters (demo guard).
import type { DbColumn, DbDerived, DbFilter, DbPath, DbSort } from '@shared/databases-filters';

/**
 * One table tab's state. Read-only all the way down: tabs with no state share DEFAULT_TAB, so a change is always a new
 * value through patchTab (a request built from it copies its arrays: main's schemas take exact, mutable shapes).
 */
export interface DbTabState {
  readonly filters: readonly DbFilter[];
  readonly sort: readonly DbSort[];
  /** The columns chosen, in order; null: all of them. */
  readonly columns: readonly string[] | null;
  /** JSON keys added as columns. */
  readonly derived: readonly DbDerived[];
  /** Rows load as you scroll: every fetch so far, appended. */
  readonly rows: readonly (readonly DbCell[])[];
  /** The next fetch: none asked, one in flight, the end reached, the 10,000-row cap reached, or the last one failed. */
  readonly more: 'idle' | 'loading' | 'end' | 'cap' | 'error';
  readonly moreProblem: DbProblem | null;
  /** The first page's reply: columns, keys, the statement. */
  readonly data: DbPage | null;
  readonly loading: boolean;
  readonly problem: DbProblem | null;
  readonly estimate: number | null;
  /** Count exactly's answer (replaces the estimate). */
  readonly exact: number | null;
  /** Selected rows, by index in `rows`. */
  readonly selection: readonly number[];
  readonly focus: { readonly row: number; readonly col: number } | null;
  /** Open or not; its width is the app's (inspector-width.ts), the same in every tab. */
  readonly inspector: boolean;
  /**
   * The JSON view: its column (a JSON column's: its column and `base`, the column's path), the node
   * selected (`path`, from the value's root), where it was opened from (the keyboard goes back there) and whether it
   * opened the inspector too (Esc closes both then).
   */
  readonly json: {
    readonly column: string;
    readonly path: Readonly<DbPath>;
    readonly base?: Readonly<DbPath>;
    readonly from?: 'grid' | 'fields';
    readonly opened?: boolean;
  } | null;
  readonly wrap: boolean;
  /** Column widths the user dragged, by column name. */
  readonly widths: Readonly<Record<string, number>>;
  /**
   * First widths, measured once per tab and column from the first rows that showed it: a new run (a
   * sort, a filter, Refresh) keeps them, so columns never shift under the pointer. Not an investment (no keep). Set by
   * the grid (lazy); absent from the defaults so the first paint carries nothing of it.
   */
  readonly autoWidths?: Readonly<Record<string, number>>;
  /**
   * The table's columns, from the last read of every column: what the filter popover and the Columns chip
   * list — chosen columns read only some, a failed read none. Set by the lazy loader; absent from the defaults.
   */
  readonly tableCols?: readonly DbColumn[];
  /**
   * Opened on a key (Open ›, "N rows ›", Open Referenced Row): the next first page selects its first row, once.
   * By a row's key (the JSON view's Filter and + Column): that row when the page has it, else the first.
   * Absent from the defaults.
   */
  readonly pick?: boolean | { readonly key: Readonly<Record<string, string>> };
  /**
   * Opened on a key, not applied yet: the first paint's openDbTab hands the key's filters over, the table's view applies
   * them before it reads (filter-actions applyHandoff: the toast and its Undo). Absent from the defaults.
   */
  readonly handoff?: { readonly filters?: readonly DbFilter[]; readonly inspector?: boolean };
  /** The filters the last handoff set: replaced again unchanged, no "Filters replaced" (a walk). */
  readonly handed?: readonly DbFilter[];
  /**
   * The row inspector's own: Fields or JSON, "N more fields" open — kept while rows change and when it is
   * closed and shown again. Absent from the defaults.
   */
  readonly insp?: { readonly view: 'fields' | 'json'; readonly more: boolean };
  /**
   * How the Data view shows the rows: the grid, or the record view — one row, every column (Tab on a row). Absent: the
   * grid. Absent from the defaults.
   */
  readonly view?: 'grid' | 'record';
  /** The record view's row, by index in `rows` (shown within the rows loaded: record.ts recordRow). */
  readonly record?: number;
  /** The request in flight: a reply for an older one is dropped. */
  readonly reqId: number;
  /** When the last fetch came back (ms). */
  readonly at: number | null;
}

/** Frozen with every array and object in it: a slip that writes into the shared defaults throws. */
export const DEFAULT_TAB: DbTabState = Object.freeze({
  filters: Object.freeze([]), sort: Object.freeze([]), columns: null, derived: Object.freeze([]), rows: Object.freeze([]), more: 'idle',
  moreProblem: null, data: null, loading: false, problem: null, estimate: null, exact: null, selection: Object.freeze([]), focus: null,
  inspector: false, json: null, wrap: false, widths: Object.freeze({}), reqId: 0, at: null
});

export type DbSheet =
  | { kind: 'add'; step: 1 | 2; form?: Partial<DbConnectionForm>; password?: string }
  | { kind: 'edit'; id: string }
  | { kind: 'remove'; id: string };

interface DbState {
  /** This window's snapshot from main; the empty one until it answers. */
  snap: DbSnapshot;
  /**
   * Main answered at least once: until then the empty snapshot says nothing — no "no databases yet", no
   * "this connection isn't available here", no restored table tab dropped for a connection not seen yet.
   */
  loaded: boolean;
  /** Per table tab, by tab key: only tabs that changed something from the defaults have an entry. */
  tabs: Record<string, DbTabState>;
  sheet: DbSheet | null;
  /** The sidebar's folded sections, per connection id. */
  folds: Record<string, string[]>;
  /** The sidebar's "Filter tables". */
  filter: string;
  setSnap(s: DbSnapshot): void;
  /**
   * A tab's state as it is now (it reads get()): for actions and event handlers. Not a selector: a component that shows
   * a tab reads it with useDbTab(key), which re-renders when that tab changes.
   */
  tab(key: string): DbTabState;
  patchTab(key: string, p: Partial<DbTabState>): void;
  dropTab(key: string): void;
  setSheet(s: DbSheet | null): void;
}

/** A tab's state in the store: the shared defaults (the same object every time) for a tab with none yet. */
export const selectTab = (key: string) => (s: Pick<DbState, 'tabs'>): DbTabState => s.tabs[key] ?? DEFAULT_TAB;

export const useDb = create<DbState>((set, get) => ({
  snap: EMPTY_DB_SNAPSHOT,
  loaded: false,
  tabs: {},
  sheet: null,
  folds: {},
  filter: '',
  setSnap: (snap) => set({ snap, loaded: true }),
  tab: (key) => selectTab(key)(get()),
  patchTab: (key, p) => set((s) => ({ tabs: { ...s.tabs, [key]: { ...(s.tabs[key] ?? DEFAULT_TAB), ...p } } })),
  dropTab: (key) => {
    if (!(key in get().tabs)) return;
    const tabs = { ...get().tabs };
    delete tabs[key];
    set({ tabs });
  },
  setSheet: (sheet) => set({ sheet })
}));

/** The tab's state for a component: it re-renders when this tab changes, not when another one does. */
export const useDbTab = (key: string): DbTabState => useDb(selectTab(key));

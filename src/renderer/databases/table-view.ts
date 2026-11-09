// A table tab's view decisions: when it loads, what its body
// shows, Refresh's key and tooltip, the toolbar's menu (the ⋯ button of a narrow pane, right-click or Shift+F10 on the
// bar), which tab's SQL popover is open, how long the refresh bar moves. Lazy, with the table's chunk.
import { create } from 'zustand';
import type { DbConnState } from '@shared/databases';
import { isMod } from '@shared/keys';
import { tdt } from '../i18n/db-table';
import { kbd } from '../kbd';
import type { MenuItem } from '../menu-model';
import type { DbTabState } from './store';
import type { DbTabView } from './tabs';

/** Refresh's "Updated 12 s ago". */
export function agoText(at: number | null, now: number): string {
  if (at === null) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return tdt.ago.now;
  if (s < 60) return tdt.ago.sec(s);
  if (s < 3600) return tdt.ago.min(Math.floor(s / 60));
  return tdt.ago.hour(Math.floor(s / 3600));
}

export type TableBody = 'wait' | 'skeleton' | 'error' | 'empty' | 'rows' | 'disconnected';

/**
 * What the Data view's body shows: nothing for the first 150 ms of a load (`waited` false), then skeleton
 * rows; the error; "No rows"; the rows — kept on screen through a Refresh. A connection the user disconnected (`held`,
 * main's hold) shows its calm card instead of anything that would read — rows already here stay —, and so does a
 * read main answered 'held' (another window disconnected it meanwhile): never an error.
 */
export function tableBody(st: DbTabState, waited: boolean, held = false): TableBody {
  if (st.rows.length > 0 && !st.problem) return 'rows';
  if ((held || st.problem?.kind === 'held') && !st.data && !st.loading) return 'disconnected';
  if (st.problem) return 'error';
  if (st.loading || !st.data) return waited ? 'skeleton' : 'wait';
  return 'empty';
}

/** What a fetch's rows depend on, compared by identity (the tab's state is replaced, never changed in place). */
export type DbRequestDeps = readonly [DbTabState['filters'], DbTabState['sort'], DbTabState['columns'], DbTabState['derived']];
export const requestDeps = (st: DbTabState): DbRequestDeps => [st.filters, st.sort, st.columns, st.derived];

/**
 * Whether the view loads from the top now: in front, on Data, its connection known, and either never loaded or the
 * request changed since (`last`: the deps of the last load). A hidden tab waits until it is shown. A connection the
 * user
 * disconnected this session (`held`) doesn't connect by itself when its tab is shown; a request the user changes
 * (a filter, a sort) is theirs to read.
 */
export function shouldLoad(o: { visible: boolean; view: DbTabView; ready: boolean; held: boolean; last: readonly unknown[] | null; req: readonly unknown[] }): boolean {
  if (!o.visible || o.view !== 'data' || !o.ready) return false;
  if (o.last === null) return !o.held;
  return o.last.length !== o.req.length || o.last.some((v, i) => v !== o.req[i]);
}

/**
 * A tab whose load failed reads again once its connection is back (a password typed, the server up again): at once
 * when it is in front on Data, else when it is shown next (`pending` carries it). A tab that no longer has a failure
 * has nothing to read again.
 */
export function reconnectStep(pending: boolean, e: { prev: DbConnState; cur: DbConnState; failed: boolean; visible: boolean; view: DbTabView }): { pending: boolean; load: boolean } {
  if (!e.failed) return { pending: false, load: false };
  const due = pending || (e.prev !== 'connected' && e.cur === 'connected');
  if (due && e.visible && e.view === 'data') return { pending: false, load: true };
  return { pending: due, load: false };
}

/**
 * The one load decision of a render: a first show or a changed request (shouldLoad) and a reconnect that is
 * due (reconnectStep) make one read between them, for the request as it is now — a hidden tab whose request changed
 * while its connection came back reads once when shown. `last`: the request read last, after this decision.
 */
export function planLoad(o: {
  visible: boolean; view: DbTabView; ready: boolean; held: boolean; last: readonly unknown[] | null; req: readonly unknown[];
  pending: boolean; prev: DbConnState; cur: DbConnState; failed: boolean;
}): { load: boolean; pending: boolean; last: readonly unknown[] | null } {
  const step = reconnectStep(o.pending, { prev: o.prev, cur: o.cur, failed: o.failed, visible: o.visible, view: o.view });
  if (shouldLoad(o) || step.load) return { load: true, pending: false, last: o.req };
  return { load: false, pending: step.pending, last: o.last };
}

/**
 * Connect on the Disconnected card: one call to main. A tab that never tried connects — main lets the hold go
 * and its first show reads by itself —; one that already tried has nothing new to read for, so it reads now,
 * which connects first (data.ts ask). One click, one read.
 */
export function onConnect(tried: boolean, act: { connect(): void; refresh(): void }): void {
  if (tried) act.refresh();
  else act.connect();
}

/** Refresh's key in a table tab: ⌘R (Ctrl+R on Windows), no other modifier. */
export function isRefreshKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  if (!isMod(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'r') return false;
  // The other platform's modifier held too is another chord.
  return !(e.metaKey && e.ctrlKey);
}

/**
 * What ⌘R does in a table tab: 'run' reads again; 'hold' a held key's repeat — taken (nothing else hears it), nothing
 * read (holding ⌘R never queues reads); null: not Refresh's key.
 */
export function refreshKeyAction(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean }): 'run' | 'hold' | null {
  if (!isRefreshKey(e)) return null;
  return e.repeat ? 'hold' : 'run';
}

/** One cycle of the refresh bar (table.css `.dbt-progress > i`). */
export const PROGRESS_MS = 1100;

/**
 * How many times the refresh bar crosses: enough for a load as long as the query timeout (and main's one retry's
 * reconnect), so it never looks frozen while a query runs — a finite count all the same (the idle motion budget).
 */
export function progressCycles(timeoutSec: number): number {
  return Math.ceil((timeoutSec * 1000 + 2000) / PROGRESS_MS);
}

export interface ToolbarActions {
  view(v: DbTabView): void; mask(): void; refresh(): void; showSql(): void; copySql(): void;
  /** Data's rows as a record or as the grid; the side inspector shown or hidden. */
  record?: () => void; inspector?: () => void;
}
const VIEWS: readonly DbTabView[] = ['data', 'structure', 'relations'];

/**
 * The toolbar's actions as a menu: what the ⋯ button holds when the pane is too narrow for the buttons, and what a
 * right-click or Shift+F10 on the bar opens — every action reachable at every width, from the keyboard too. On Data:
 * Record View (the Grid / Record toggle, folded here first) and Row Inspector — off while the record view
 * shows, which hides it.
 */
export function toolbarMenu(o: { view: DbTabView; masked: boolean; canMask: boolean; hasSql: boolean; record?: boolean; inspector?: boolean }, act: ToolbarActions): MenuItem[] {
  const m = tdt.menu;
  const rows: MenuItem[] = o.view === 'data' && act.record && act.inspector ? [
    'sep',
    { id: 'record', label: m.record, checked: !!o.record, hint: kbd('⇥'), run: act.record },
    { id: 'inspector', label: m.inspector, checked: !!o.inspector, hint: kbd('⏎'), disabled: !!o.record, run: act.inspector }
  ] : [];
  return [
    ...VIEWS.map((v): MenuItem => ({ id: `view-${v}`, label: tdt.views[v], radio: true, checked: o.view === v, run: () => act.view(v) })),
    ...rows,
    'sep',
    { id: 'mask', label: m.mask, checked: o.masked, disabled: !o.canMask, run: act.mask },
    { id: 'refresh', label: m.refresh, hint: kbd('⌘R'), run: act.refresh },
    'sep',
    { id: 'sql', label: m.showSql, disabled: !o.hasSql, run: act.showSql },
    { id: 'copy-sql', label: m.copySql, disabled: !o.hasSql, run: act.copySql }
  ];
}

/** A ⋯ menu opened: by which tab, and the store menu it put on screen (compared by identity, as Header's New does). */
export interface FoldMenu { key: string; menu: unknown }

interface TableUi {
  /** Which tab's SQL popover is open (one at a time in a window: a press anywhere else closes it). */
  sql: string | null;
  /** The ⋯ menu last opened. */
  fold: FoldMenu | null;
  /** Each table tab's width as drawn (the row inspector goes beside the grid or over its rows by it). */
  widths: Readonly<Record<string, number>>;
  /** A tab measured (0: hidden or closed, dropped). */
  setWidth(key: string, w: number): void;
  openSql(key: string): void;
  closeSql(key: string): void;
  /** The popover never outlives its tab in front, nor its statement (a failed load clears it): closed then. */
  sync(key: string, visible: boolean, sql: string | null): void;
}

export const useTableUi = create<TableUi>((set, get) => ({
  sql: null,
  fold: null,
  widths: {},
  setWidth: (key, w) => {
    const cur = get().widths;
    if ((cur[key] ?? 0) === w) return;
    const widths = { ...cur };
    if (w > 0) widths[key] = w;
    else delete widths[key];
    set({ widths });
  },
  openSql: (key) => set({ sql: key }),
  closeSql: (key) => { if (get().sql === key) set({ sql: null }); },
  sync: (key, visible, sql) => { if (get().sql === key && (!visible || !sql)) set({ sql: null }); }
}));

/** Whether the ⋯ button reads open: the store's menu on screen is the one this tab's ⋯ opened. */
export function foldOpen(menu: unknown, fold: FoldMenu | null, key: string): boolean {
  return menu !== null && fold !== null && fold.key === key && fold.menu === menu;
}

/** The popover shows for its own tab, only while that tab is in front and has a statement. */
export function sqlShown(open: string | null, key: string, visible: boolean, sql: string | null): boolean {
  return open === key && visible && !!sql;
}

/** What Mask values leaves of an inlined value. */
const DOTS = "'••••'";

/** The end of a quoted run starting at `i` (`q` doubled inside stays in it): the index of its closing quote. */
function closing(s: string, i: number, q: string): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === q) {
      if (s[j + 1] !== q) return j;
      j += 2;
    } else j++;
  }
  return s.length - 1;
}

/**
 * The statement as the SQL popover shows it and Copy SQL copies it: Mask values on, each value main's
 * displaySql inlined — every single-quoted literal, an escape string (E'…': a value with a backslash) too, an array's
 * one by one — reads '••••'. Quoted names, the JSON paths after #> and #>> (keys, not values), a LIKE's `ESCAPE E'\\'`
 * and the paging (bare numbers) stay as they are.
 */
export function sqlFor(sql: string, masked: boolean): string {
  if (!masked) return sql;
  let out = '';
  let path = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === '"' || ch === "'") {
      const j = closing(sql, i, ch);
      const run = sql.slice(i, j + 1);
      const escapeString = ch === "'" && sql[i - 1] === 'E' && !/[\w$]/.test(sql[i - 2] ?? '');
      if (ch === '"' || path || (escapeString && /\bESCAPE\s+E$/.test(out))) out += run;
      else out = (escapeString ? out.slice(0, -1) : out) + DOTS;
      i = j + 1;
      continue;
    }
    if (sql.startsWith('ARRAY[', i) && /#>>?\s*$/.test(out)) {
      path = true;
      out += 'ARRAY[';
      i += 6;
      continue;
    }
    if (ch === ']') path = false;
    out += ch;
    i++;
  }
  return out;
}

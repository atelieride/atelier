// The Data view's grid: a sticky header (name, key
// icons, Postgres's short type, the sort; click sorts, Shift-click adds, an edge to drag or double-click), the row
// numbers sticky on the left, typed cells (Cell.tsx), a right fade while more columns wait. Virtualized: only the rows
// on screen and an overscan are in the DOM — memoized, so a scroll draws only the rows it brings, and a selection only
// the rows it changes —; a scroll frame reads the scroll and the viewport's height, the rest is measured on resize;
// widths live in one colgroup, the first ones measured once per tab and column (a new run never shifts them). Rows
// load as you scroll (data.ts needsMore → loadMore, never after an error: Retry is theirs), the bottom row says how
// (MoreRow). The place in the rows survives Structure and Relations (display: none), and the record view (`away`: a
// row it moved to is brought into view when the grid comes back). Keyboard (keys that reach the grid itself): ↑/↓
// (Shift extends), ⌘A, Esc, Enter (the inspector), Tab, ⌘C, ⌥Z (Wrap
// Cells), ⌥↩ (the selected rows, or the focused one); right-click or Shift+F10 a cell for its
// menu (a foreign key's: Open Referenced Row; a JSON value's: Open in JSON View, as a double click; Send to <session>,
// Ask in a New Session; Column Menu…). A header's chevron or right-click: its column menu (ColumnMenu.tsx).
// Rows selected: the action bar over the grid's foot (SelBar.tsx); the rows always end with its room and a row
// brought into view stops above it (revealTop). Copies: grid-copy.ts (a cut value read whole first); Claude:
// actions.ts. Lazy, with the table's chunk.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { DbCell, DbPage, DbTableRef } from '@shared/databases';
import { typeClass, type DbFilter } from '@shared/databases-filters';
import { isMod } from '@shared/keys';
import type { CellView, DbTimes, FormatOpts } from '@shared/pg-format';
import { copyText as toClipboard } from '../clipboard';
import { Icon } from '../components/Icon';
import { isWordWrapKey } from '../editor/word-wrap';
import { tdt } from '../i18n/db-table';
import { useApp } from '../store';
import { askRows, sendRows, useTarget } from './actions';
import { Cell } from './Cell';
import { ask, loadMore, needsMore } from './data';
import { setFilters } from './filter-actions';
import { addFilter, cellFilter, MAX_FILTERS } from './filters';
import { blankAt, copyText, cutCount, rowsAs, valueCopy, type CopyFormat, type GridSource } from './grid-copy';
import { openColumnMenu, useColMenu } from './ColumnMenu';
import { canOpenReferenced, openReferenced } from './inspector-data';
import {
  BAR_ROOM, cellMenu, cellView, firstWidths, fitWidth, focusMovedOutside, gridColumns, gridKey, HEAD_H, hiddenColumns, jsonCell, menuCell, menuPoint, nextSort,
  ownKey, revealTop, RN_W, ROW_H, selectRow, sortOf, visibleRange, WRAP_ROW_H, type GridColumn
} from './grid-model';
import { openJsonView } from './JsonInspector';
import { MoreRow } from './MoreRow';
import { openRecord } from './record';
import { formatsMenu, SelBar } from './SelBar';
import { useDb, type DbTabState } from './store';
import type { DbTabRef } from './tabs';

/** What the grid gets from the table view. */
export interface GridProps {
  tabKey: DbTabRef['key'];
  /** The table: SQL INSERT names it, a foreign key into another schema says which, a cut value is read whole from it. */
  table: DbTableRef;
  st: DbTabState;
  /** The page whose columns the rows follow (st.data, non-null while rows are shown). */
  page: DbPage;
  masked: boolean;
  times: DbTimes;
  /** An inspector lying over the rows' right side (a narrow tab): its width, which the action bar keeps clear of. */
  inset?: number;
  /** The record view shows instead: the grid stays mounted, hidden, its place in the rows kept. */
  away?: boolean;
}

/** A dragged width, between these. */
const DRAG_MIN = 48;
const DRAG_MAX = 1200;
const NULL_VIEW: CellView = { k: 'null' };
const NO_WIDTHS: Readonly<Record<string, number>> = Object.freeze({});

// A cell's view, once per value and options (a scroll back, a selection, draws the same cells again).
const views = new WeakMap<DbCell, { o: FormatOpts; g: GridColumn; v: CellView }>();
function viewOf(cell: DbCell | undefined, g: GridColumn, o: FormatOpts): CellView {
  if (!cell) return NULL_VIEW;
  const hit = views.get(cell);
  if (hit && hit.o === o && hit.g === g) return hit.v;
  const v = cellView(cell.v, g, o, cell.cut);
  views.set(cell, { o, g, v });
  return v;
}

interface RowProps {
  row: readonly DbCell[];
  i: number;
  cols: readonly GridColumn[];
  /** The committed widths (a drag in progress moves the colgroup only). */
  widths: readonly number[];
  o: FormatOpts;
  sel: boolean;
  /** The focused cell's index in the row when it is in this one, else -1. */
  focusCol: number;
  wrap: boolean;
}

/** One row: no state of its own, drawn again only when one of these changes. Events are the body's (delegated). */
const Row = memo(function Row({ row, i, cols, widths, o, sel, focusCol, wrap }: RowProps) {
  return (
    <tr aria-rowindex={i + 2} data-row={i} className={sel ? 'is-sel' : undefined} aria-selected={sel}>
      <td className="dbt-rn">{i + 1}</td>
      {cols.map((g, k) => {
        const cell = row[g.index];
        const cls = [g.num ? 'is-num' : '', g.derived ? 'is-drv' : '', focusCol === g.index ? 'is-focus' : ''].filter(Boolean).join(' ');
        const content = <Cell view={viewOf(cell, g, o)} width={widths[k]!} wrap={wrap} fk={!!g.col.fk} cut={cell?.cut} />;
        return <td key={g.key} role="gridcell" data-col={g.index} className={cls || undefined}>{wrap ? <div className="dbt-wrapc">{content}</div> : content}</td>;
      })}
    </tr>
  );
});

const toast = (text: string, info = false) => useApp.getState().showToast(text, undefined, info ? 'info' : undefined);
/** Copies, then says so; `warn`: something to know about the copy (values cut at 64 KB in it), said instead. */
function copyOut(text: string, done: string, warn: string | null = null): void {
  void toClipboard(text).then((ok) => { if (ok) toast(warn ?? done, warn === null); }, () => toast(tdt.copyFailed));
}

/** The row and the value's index of a cell under a pointer event (none on the spacers and outside rows). */
function cellAt(target: EventTarget): { row: number; col: number | null; td: HTMLElement } | null {
  const td = target instanceof Element ? target.closest('td') : null;
  const row = Number(td?.parentElement?.getAttribute('data-row') ?? NaN);
  if (!td || Number.isNaN(row)) return null;
  const col = td.getAttribute('data-col');
  return { row, col: col === null ? null : Number(col), td };
}

export function Grid({ tabKey, table, st, page, masked, times, inset = 0, away = false }: GridProps) {
  const wrapEl = useRef<HTMLDivElement>(null);
  // The session Send pastes into (the Docker and Redis bars' target), for the bar's and the cell menu's labels.
  const target = useTarget();
  const [box, setBox] = useState({ top: 0, height: 600 });
  const [fade, setFade] = useState(false);
  const [gutter, setGutter] = useState({ r: 0, b: 0 });
  const [drag, setDrag] = useState<{ key: string; width: number } | null>(null);
  const cols = useMemo(() => gridColumns(page, table.schema), [page.columns, page.hidden, page.derived, table.schema]);
  const hidden = useMemo(() => hiddenColumns(page, table.schema), [page.columns, page.hidden, table.schema]);
  // The relative ages ("2h") read the clock of the run: rows appended later aren't drawn again for it.
  const o = useMemo<FormatOpts>(() => ({ times, now: Date.now(), masked, width: 'grid' }), [times, masked, st.reqId]);
  // First widths: once per tab and column, from the first rows that showed it — kept by the tab (not an investment:
  // no keep), so a sort, a filter or a Refresh never moves a column under the pointer. Dragged ones win.
  const first = useMemo(() => firstWidths(cols, page.rows, st.autoWidths ?? NO_WIDTHS, o), [cols, page.rows, st.autoWidths, o]);
  useLayoutEffect(() => {
    if (first.added) useDb.getState().patchTab(tabKey, { autoWidths: { ...useDb.getState().tab(tabKey).autoWidths, ...first.added } });
  }, [first, tabKey]);
  const widths = useMemo(() => cols.map((g, k) => st.widths[g.key] ?? first.widths[k]!), [cols, first, st.widths]);
  const shown = drag ? cols.map((g, k) => (g.key === drag.key ? drag.width : widths[k]!)) : widths;
  const total = shown.reduce((s, w) => s + w, RN_W);
  const n = st.rows.length;
  const rowH = st.wrap ? WRAP_ROW_H : ROW_H;

  // What handlers read: the tab now (not as rendered), the options, the columns, the page, the row height.
  const tab = () => useDb.getState().tab(tabKey);
  const patch = (p: Partial<DbTabState>) => useDb.getState().patchTab(tabKey, p);
  const live = useRef({ o, cols, hidden, page, rowH, shown, range: { first: -1, last: -1 } });
  Object.assign(live.current, { o, cols, hidden, page, rowH, shown });
  const src = (): GridSource => ({ columns: live.current.cols, hidden: live.current.hidden, rows: tab().rows });
  /** The row Shift extends from: the last one clicked or moved to without Shift. */
  const anchor = useRef<number | null>(null);

  // The place in the rows, kept while the grid is hidden — another tab in front, or Structure / Relations: display:none
  // drops a scroller's offsets, so they are put back when it has a height again.
  const place = useRef({ top: 0, left: 0 });
  // Measured on resize and when the widths change, never in a scroll frame: how wide the rows are, the viewport's width.
  const dims = useRef({ scrollW: 0, viewW: 0 });

  /** On resize and width changes: the rows' width, the viewport's, the scrollbars (the fade keeps clear of them). */
  const measure = useCallback(() => {
    const el = wrapEl.current;
    if (!el) return;
    dims.current = { scrollW: el.scrollWidth, viewW: el.clientWidth };
    const r2 = el.offsetWidth - el.clientWidth;
    const b2 = el.offsetHeight - el.clientHeight;
    setGutter((g) => (g.r === r2 && g.b === b2 ? g : { r: r2, b: b2 }));
  }, []);

  /** A scroll frame (once a frame at most): the rows on screen, the right fade, rows to load when the end nears. */
  const raf = useRef(0);
  const frame = useCallback(() => {
    raf.current = 0;
    const el = wrapEl.current;
    if (!el) return;
    const top = el.scrollTop;
    const height = el.clientHeight;
    const left = el.scrollLeft;
    if (height > 0) place.current = { top, left };
    const t = useDb.getState().tab(tabKey);
    const { rowH: h, range } = live.current;
    // A render only when the rows on screen change (a row's height of scroll), not for every pixel.
    const r = visibleRange(top, height - HEAD_H, h, t.rows.length);
    const moved = r.first !== range.first || r.last !== range.last;
    live.current.range = r;
    setBox((b) => (b.height === height && !moved ? b : { top, height }));
    // The right fade: more columns past the right edge; never at the end, where the last column's edge must be free.
    setFade(height > 0 && left + dims.current.viewW < dims.current.scrollW - 1);
    if (t.more === 'idle' && needsMore(top, height, h, t.rows.length)) void loadMore(tabKey);
  }, [tabKey]);
  const onScroll = () => { if (!raf.current) raf.current = requestAnimationFrame(frame); };

  useLayoutEffect(() => {
    const el = wrapEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0) {
        if (Math.abs(el.scrollTop - place.current.top) > 1) el.scrollTop = place.current.top;
        if (Math.abs(el.scrollLeft - place.current.left) > 1) el.scrollLeft = place.current.left;
      }
      measure();
      frame();
    });
    ro.observe(el);
    measure();
    frame();
    // The tab had the keyboard before its rows came: the grid takes it, so ↑/↓ work at once.
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.classList.contains('dbt') && a.contains(el)) el.focus({ preventScroll: true });
    return () => { ro.disconnect(); if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0; };
  }, [measure, frame]);

  // A new first page (filters, sort, Refresh): from the top, nothing anchored. Appended rows keep the place, the
  // selection and the focus (static UI); the columns keep their sideways place (a sort was clicked there).
  const firstRow = st.rows[0];
  useLayoutEffect(() => {
    const el = wrapEl.current;
    anchor.current = null;
    place.current = { ...place.current, top: 0 };
    if (el && el.scrollTop > 0) { el.scrollTop = 0; setBox((b) => ({ ...b, top: 0 })); }
  }, [firstRow]);

  // After each fetch and when the pane grows: more if the end is already near (a short fetch in a tall pane). Never
  // after an error (Retry is theirs), never while one is out.
  useEffect(() => {
    const el = wrapEl.current;
    if (el && st.more === 'idle' && needsMore(el.scrollTop, el.clientHeight, rowH, n)) void loadMore(tabKey);
  }, [n, box.height, st.more, tabKey, rowH]);

  // Widths changed (a drag, a fit, new columns): measured again, the fade reads them.
  useLayoutEffect(() => { measure(); frame(); }, [total, measure, frame]);

  // Wrap Cells keeps the row at the top where it was.
  const keepRow = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = wrapEl.current;
    const r = keepRow.current;
    keepRow.current = null;
    if (!el || r === null) return;
    el.scrollTop = r * rowH;
    frame();
  }, [st.wrap]);
  const toggleWrap = () => {
    const el = wrapEl.current;
    const now = tab();
    if (el) keepRow.current = Math.floor(el.scrollTop / (now.wrap ? WRAP_ROW_H : ROW_H));
    patch({ wrap: !now.wrap });
  };

  /**
   * Scrolls a row into view under the sticky header, and above the action bar's room. The place is
   * kept at once: a resize right after (the grid shown again) never puts the old one back.
   */
  const reveal = (row: number) => {
    const el = wrapEl.current;
    if (!el) return;
    const top = revealTop(row, live.current.rowH, el.scrollTop, el.clientHeight, BAR_ROOM);
    if (top === null) return;
    el.scrollTop = top;
    place.current = { top: el.scrollTop, left: el.scrollLeft };
  };
  // The row the grid focused itself last (a click, a right-click, its keys): those never scroll it (static UI). One moved
  // from outside it (the inspector's ↑/↓, a row picked on opening; the record view's row) is
  // brought into view and becomes the Shift anchor, as the grid's own keys do — moved
  // while the record view hid the grid, once the grid shows again (`later`).
  const own = useRef<number | null>(null);
  const later = useRef<number | null>(null);
  /** Away until this render (the record view showed): the effect after the focus's keeps it. */
  const wasAway = useRef(away);
  const focusRow = st.focus?.row ?? null;
  useLayoutEffect(() => {
    if (focusMovedOutside(focusRow, own.current)) {
      anchor.current = focusRow;
      // Away, or back in this very render: brought into view once its place is back (below).
      if (away || wasAway.current) later.current = focusRow;
      else if ((wrapEl.current?.clientHeight ?? 0) > 0) reveal(focusRow!);
    }
    own.current = focusRow;
  }, [focusRow]);
  // Back from the record view: its place first (display: none dropped the scroll), then the row it moved to meanwhile,
  // drawn at once (no blank frame before the scroll's).
  useLayoutEffect(() => {
    const was = wasAway.current;
    wasAway.current = away;
    const el = wrapEl.current;
    if (away || !was || !el || el.clientHeight === 0) return;
    el.scrollTop = place.current.top;
    el.scrollLeft = place.current.left;
    if (later.current !== null) reveal(later.current);
    later.current = null;
    measure();
    frame();
  }, [away]);

  // ---------- copies ----------

  /** Copy Value: a cut value is read whole first; a refusal says why. */
  const copyValue = (at: { row: number; col: number }) => {
    const { o: opts, page: p } = live.current;
    void valueCopy(src(), p, table, at, opts, (r) => ask(table.connId, () => window.atelier.databases.full(r)))
      .then((res) => { if (res.ok) copyOut(res.text, tdt.grid.copied); else toast(res.message); });
  };
  /** Rows: what is loaded; values cut at 64 KB in it are counted and said. */
  const copyRows = (text: string, sel: readonly number[], fmt: CopyFormat | 'tsv', label: string) => {
    const cut = cutCount(src(), sel, fmt, live.current.o);
    copyOut(text, tdt.grid.copiedRows(sel.length, label), cut > 0 ? tdt.grid.cutInCopy(cut) : null);
  };

  // ---------- header: sort, resize, fit ----------

  /** A header press leaves the keyboard with the grid (↑/↓, ⌘C keep working), not on the header's button. */
  const keepKeys = (e: MouseEvent) => {
    e.preventDefault();
    wrapEl.current?.focus({ preventScroll: true });
  };
  const sortBy = (g: GridColumn, shift: boolean) => {
    const column = g.derived ? g.derived.column : g.name;
    patch({ sort: nextSort(tab().sort, column, shift, g.derived?.path) });
    // A sort is an investment: the preview tab is kept.
    useApp.getState().keepDbTab(tabKey);
  };
  const setWidth = (g: GridColumn, w: number) => {
    patch({ widths: { ...tab().widths, [g.key]: w } });
    useApp.getState().keepDbTab(tabKey);
  };
  const startResize = (e: PointerEvent<HTMLSpanElement>, g: GridColumn, from: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const x0 = e.clientX;
    let w = from;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      w = Math.round(Math.max(DRAG_MIN, Math.min(DRAG_MAX, from + ev.clientX - x0)));
      setDrag({ key: g.key, width: w });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDrag(null);
      if (w !== from) setWidth(g, w);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  // ---------- rows: selection, the menu, the inspector ----------

  const select = (row: number, col: number | null, mod: { meta: boolean; shift: boolean }) => {
    const now = tab();
    const sel = selectRow(now.selection, row, mod, anchor.current ?? now.focus?.row ?? null);
    if (!mod.shift) anchor.current = row;
    own.current = row;
    patch({ selection: sel, focus: { row, col: col ?? now.focus?.col ?? live.current.cols[0]?.index ?? 0 } });
  };
  const onRowsDown = (e: MouseEvent<HTMLTableSectionElement>) => {
    if (e.button !== 0) return;
    const at = cellAt(e.target);
    if (!at) return;
    e.preventDefault();
    wrapEl.current?.focus({ preventScroll: true });
    select(at.row, at.col, { meta: isMod(e), shift: e.shiftKey });
  };
  /** A cell's JSON view: a JSON column by its column and path. */
  const openJson = (g: GridColumn) => openJsonView(tabKey, g.derived ? { column: g.derived.column, base: g.derived.path } : { column: g.name }, 'grid');
  // A double click: a JSON value in the JSON view, any other cell's row in the inspector.
  const onRowsDouble = (e: MouseEvent<HTMLTableSectionElement>) => {
    const at = cellAt(e.target);
    if (!at) return;
    const g = at.col === null ? undefined : live.current.cols.find((c) => c.index === at.col);
    if (g && jsonCell(g, tab().rows[at.row]?.[g.index])) { openJson(g); return; }
    patch({ inspector: true });
  };

  const openCellMenu = (at: { x: number; y: number }, row: number, col: number) => {
    const now = tab();
    const g = live.current.cols.find((c) => c.index === col);
    if (!g) return;
    let sel = now.selection;
    if (!sel.includes(row)) {
      sel = [row];
      anchor.current = row;
    }
    own.current = row;
    patch({ selection: sel, focus: { row, col } });
    const f = tdt.grid.menu.formats;
    // Filter by / Exclude This Value: the value as Postgres printed it (a masked one too: its chip shows
    // dots); none for a value no operator takes, nor past main's 30 filters.
    const room = now.filters.length < MAX_FILTERS;
    const by = room ? cellFilter(g, now.rows[row]?.[col], 'by') : null;
    const ex = room ? cellFilter(g, now.rows[row]?.[col], 'exclude') : null;
    const add = (fl: DbFilter) => () => setFilters(tabKey, addFilter(tab().filters, fl));
    // Open Referenced Row: a foreign key's value opens the row it points at (a preview).
    const cells = now.rows[row];
    // Offered only when a filter can name the key; a click while the keys are read waits for them.
    const ref = g.derived === null && cells && canOpenReferenced(tabKey, live.current.page, cells, g.col.name)
      ? () => void openReferenced(tabKey, table, live.current.page, cells, g.col.name) : null;
    const items = cellMenu({ rows: sel.length, wrap: now.wrap, json: jsonCell(g, cells?.[col]) }, {
      copyValue: () => copyValue({ row, col }),
      copyRow: () => copyRows(rowsAs(src(), [row], 'json', table, live.current.o), [row], 'json', f.json),
      copyAs: (fmt: CopyFormat) => copyRows(rowsAs(src(), sel, fmt, table, live.current.o), sel, fmt, f[fmt]),
      wrap: toggleWrap,
      ...(by ? { filterBy: add(by) } : {}),
      ...(ex ? { exclude: add(ex) } : {}),
      ...(ref ? { openRef: ref } : {}),
      openJson: () => openJson(g),
      // Claude: the rows as shown, Mask values' dots included.
      sendTo: { label: target, run: () => sendRows(table, src(), sel, live.current.o) },
      askNew: () => void askRows(table, src(), sel, live.current.o, tabKey),
      columnMenu: () => openColumnMenu(tabKey, col)
    });
    useApp.getState().openMenu(at, items);
  };

  // ---------- the action bar ----------

  /** Copy as …: the selected rows in that format, as the cell menu's Copy Rows As. */
  const copySelected = (fmt: CopyFormat) => {
    const sel = tab().selection;
    copyRows(rowsAs(src(), sel, fmt, table, live.current.o), sel, fmt, tdt.grid.menu.formats[fmt]);
  };
  // Copy as ▾ reads expanded while the menu it opened is the one on screen (as the toolbar's ⋯: the store's menu object).
  const [formats, setFormats] = useState<unknown>(null);
  const formatsOpen = useApp((s) => s.menu !== null && s.menu === formats);
  const openFormats = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    // At the button's top: the menu opens above it when the room below is short (it always is, by the footer).
    useApp.getState().openMenu({ x: r.left, y: r.top }, formatsMenu(copySelected));
    setFormats(useApp.getState().menu);
  };
  const clearSelection = () => {
    anchor.current = null;
    patch({ selection: [], focus: null });
  };
  const onRowsMenu = (e: MouseEvent<HTMLTableSectionElement>) => {
    const at = cellAt(e.target);
    if (!at) return;
    e.preventDefault();
    e.stopPropagation();
    openCellMenu({ x: e.clientX, y: e.clientY }, at.row, at.col ?? tab().focus?.col ?? live.current.cols[0]?.index ?? 0);
  };
  // Shift+F10 with the grid focused (App sends it as a contextmenu on the grid): the focused cell's menu — none focused,
  // the first row on screen's — its row brought into view, the menu beside the cell (placed from the widths and the
  // scroll: the row needn't be drawn yet), inside the grid.
  const onGridMenu = (e: MouseEvent<HTMLDivElement>) => {
    const el = wrapEl.current;
    if (e.target !== e.currentTarget || !el) return;
    const now = tab();
    const at = menuCell(now.focus, el.scrollTop, live.current.rowH, now.rows.length, live.current.cols[0]?.index ?? 0);
    if (!at) return;
    e.preventDefault();
    e.stopPropagation();
    reveal(at.row);
    const k = live.current.cols.findIndex((c) => c.index === at.col);
    const p = menuPoint({
      row: at.row, k: Math.max(0, k), widths: live.current.shown, rowH: live.current.rowH,
      scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, viewW: el.clientWidth, viewH: el.clientHeight
    });
    const g = el.getBoundingClientRect();
    openCellMenu({ x: g.left + p.x, y: g.top + p.y }, at.row, at.col);
  };

  // ---------- keyboard ----------

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !ownKey(e.target, e.currentTarget)) return;
    const now = tab();
    const act = gridKey(
      { key: e.key, code: e.code, mod: isMod(e), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, wrapKey: isWordWrapKey(e.nativeEvent) },
      { count: now.rows.length, selection: now.selection, focus: now.focus, anchor: anchor.current, firstCol: live.current.cols[0]?.index ?? 0 }
    );
    if (!act) return;
    if (act.kind === 'record') {
      // The row as a record in the rows' place, which takes the keyboard; Tab or Esc
      // there comes back to this row. Nothing else in the window hears this Tab.
      e.preventDefault();
      e.stopPropagation();
      openRecord(tabKey, act.row, true);
      return;
    }
    if (act.kind === 'copy') {
      const one = now.focus !== null && (now.selection.length === 0 || (now.selection.length === 1 && now.selection[0] === now.focus.row));
      if (one) {
        // NULL or empty: nothing to copy, nothing said.
        if (blankAt(src(), now.focus!)) return;
        e.preventDefault();
        copyValue(now.focus!);
        return;
      }
      const text = copyText(src(), now.selection, now.focus, live.current.o);
      if (!text) return;
      e.preventDefault();
      copyRows(text, now.selection, 'tsv', tdt.grid.menu.formats.tsv);
      return;
    }
    e.preventDefault();
    // ⌥↩: the rows to the session, once a press (held down, nothing more is pasted); nothing else hears it.
    if (act.kind === 'send') { e.stopPropagation(); if (!e.repeat) sendRows(table, src(), act.rows, live.current.o); return; }
    // Esc and ⌥Z are the grid's here: nothing else in the window hears them.
    if (act.kind === 'clear' || act.kind === 'wrap') e.stopPropagation();
    if (act.kind === 'wrap') { if (!e.repeat) toggleWrap(); return; }
    // Hidden, its JSON view goes with it (shown again: its fields).
    if (act.kind === 'inspector') { patch(now.inspector ? { inspector: false, json: null } : { inspector: true }); return; }
    if (act.kind === 'clear') { anchor.current = null; patch({ selection: [], focus: null }); return; }
    anchor.current = act.anchor;
    own.current = act.focus.row;
    patch({ selection: act.selection, focus: act.focus });
    if (act.reveal !== null) reveal(act.reveal);
  };

  // ---------- render ----------

  const menuCol = useColMenu((s) => (s.open?.key === tabKey ? s.open.col : -1));
  const { first: from, last } = visibleRange(box.top, box.height - HEAD_H, rowH, n);
  const selSet = useMemo(() => new Set(st.selection), [st.selection]);
  const focus = st.focus;
  // The action bar: with rows selected.
  const bar = st.selection.length > 0;
  return (
    <div className="dbt-gridbox" style={away ? { display: 'none' } : undefined}>
      <div ref={wrapEl} className="dbt-grid" role="grid" aria-label={tdt.grid.label(table.name)} aria-rowcount={n + 1} aria-colcount={cols.length + 1}
        aria-multiselectable="true" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown} onContextMenu={onGridMenu}>
        <table className={`dbt-table${st.wrap ? ' is-wrap' : ''}`} style={{ width: total }}>
          <colgroup><col style={{ width: RN_W }} />{shown.map((w, k) => <col key={cols[k]!.key} style={{ width: w }} />)}</colgroup>
          <thead>
            <tr>
              <th className="dbt-rn" scope="col" aria-label="#" />
              {cols.map((g, k) => {
                const s = sortOf(st.sort, g.derived ? g.derived.column : g.name, g.derived?.path);
                const json = g.derived === null && typeClass(g.col) === 'json';
                const menuOn = menuCol === g.index;
                const cls = ['dbt-th', g.num ? 'is-num' : '', s ? 'is-sorted' : '', g.derived ? 'is-drv' : '', json ? 'is-json' : '', menuOn ? 'is-menu' : ''].filter(Boolean).join(' ');
                return (
                  <th key={g.key} scope="col" className={cls} aria-sort={s ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'} data-tip={g.tip} data-col={g.index}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openColumnMenu(tabKey, g.index); }}>
                    <button type="button" className="dbt-th-btn" tabIndex={-1} onMouseDown={keepKeys} onClick={(e) => sortBy(g, e.shiftKey)}>
                      <span className="dbt-th-line">
                        {g.col.isPk && <span className="dbt-th-pk"><Icon name="key" size={12} /></span>}
                        {g.derived && <span className="dbt-th-drv"><Icon name="jsonBranch" size={12} /></span>}
                        <span className="dbt-th-name">{g.name}</span>
                        {g.col.fk && <span className="dbt-th-fk"><Icon name="fkArrow" size={12} /></span>}
                        {s && <span className="dbt-th-sort"><Icon name={s.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} stroke={2} />{st.sort.length > 1 ? <sup>{s.at + 1}</sup> : null}</span>}
                      </span>
                      <span className="dbt-th-type">{g.type}</span>
                    </button>
                    {/* The column menu: a JSON column's key profile lives there, so its chevron always shows. */}
                    <button type="button" className="dbt-th-menu" tabIndex={-1} aria-label={tdt.colMenu.open} aria-haspopup="menu" aria-expanded={menuOn}
                      data-tip={tdt.colMenu.open} onMouseDown={keepKeys} onClick={() => openColumnMenu(tabKey, g.index)}>
                      <Icon name="chevronDown" size={12} />
                    </button>
                    <span className="dbt-th-rs" aria-hidden="true" data-tip={tdt.grid.resizeTip}
                      onPointerDown={(e) => startResize(e, g, shown[k]!)}
                      onDoubleClick={() => setWidth(g, fitWidth(g, tab().rows, live.current.o))} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody onMouseDown={onRowsDown} onDoubleClick={onRowsDouble} onContextMenu={onRowsMenu}>
            {from > 0 && <tr className="dbt-spacer" aria-hidden="true"><td colSpan={cols.length + 1} style={{ height: from * rowH }} /></tr>}
            {st.rows.slice(from, last).map((row, j) => {
              const i = from + j;
              return <Row key={`${st.reqId}:${i}`} row={row} i={i} cols={cols} widths={widths} o={o} sel={selSet.has(i)} focusCol={focus?.row === i ? focus.col : -1} wrap={st.wrap} />;
            })}
            {last < n && <tr className="dbt-spacer" aria-hidden="true"><td colSpan={cols.length + 1} style={{ height: (n - last) * rowH }} /></tr>}
          </tbody>
        </table>
        <MoreRow more={st.more} problem={st.moreProblem} loaded={n} onRetry={() => void loadMore(tabKey)} />
        {/* The action bar's room, always: scrolled to the end, the last rows sit above the bar, and they
            stay where they are when it goes. */}
        <div className="dbt-barroom" aria-hidden="true" style={{ height: BAR_ROOM }} />
      </div>
      {bar && (
        <SelBar count={st.selection.length} target={target} right={inset + gutter.r} bottom={gutter.b} formatsOpen={formatsOpen}
          onSend={() => sendRows(table, src(), tab().selection, live.current.o)}
          onAsk={() => void askRows(table, src(), tab().selection, live.current.o, tabKey)}
          onCopy={copySelected} onFormats={openFormats} onClear={clearSelection} />
      )}
      {fade && <div className="dbt-fade" style={{ right: gutter.r, bottom: gutter.b }} aria-hidden="true" />}
    </div>
  );
}

// The filter bar: under the toolbar on Data, the
// filters as chips — column · operator · value, AND-ed; the value ellipsizes first, the whole filter in the tooltip; a
// click edits one, ⌫ or Delete removes the focused one, a right-click or Shift+F10 opens its menu —, "+ Filter", and
// the Columns chip at the right. The chips wrap to two lines at most; past them "+N more" opens a menu of the others
// (one picked opens its editor; Clear All Filters). Every change keeps the preview and reads from the top
// (filter-actions.ts). Nothing opens before the table's columns are known (a toast says so). The popovers close when
// the tab is hidden. Lazy, with the table's chunk; its stylesheet comes with it.
import './filters.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { DbFilter } from '@shared/databases-filters';
import { Icon } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { ColumnsChip, ColumnsPopover } from './ColumnsChip';
import { openFilterAt, setFilters, useFilterUi } from './filter-actions';
import { fitChips } from './filter-layout';
import { FilterPopover } from './FilterPopover';
import { barColumns, chipParts, MAX_FILTERS, removeFilter, wantsCatalogColumns } from './filters';
import { useHeld } from './hold';
import { useDb, type DbTabState } from './store';
import { readPart, useStruct } from './structure-data';
import type { DbTabRef } from './tabs';

const tf = tdt.filters;
/** The chips' gap (filters.css `.dbt-fchips`). */
const GAP = 6;

/** The bar's element `[data-fanchor="<k>"]` that takes the keyboard: it, else "+ Filter", else the last chip. */
function focusIn(bar: HTMLElement | null, k: string): void {
  const pick = (sel: string) => {
    const el = bar?.querySelector<HTMLElement>(sel);
    return el && !(el as HTMLButtonElement).disabled ? el : null;
  };
  (pick(`[data-fanchor="${k}"]`) ?? pick('[data-fanchor="add"]') ?? pick('.dbt-fchip:last-of-type .dbt-fchip-main'))?.focus({ preventScroll: true });
}

export function FilterBar({ tab, st, masked, visible }: { tab: DbTabRef; st: DbTabState; masked: boolean; visible: boolean }) {
  const key = tab.key;
  const filters = st.filters;
  // The table's columns: from the last read of all of them (a failed read or a choice keeps that list) — none known
  // and the read failed, the catalog's (Structure's read, asked once): a table whose every column can't be read stays
  // rescuable. Never on a connection main holds.
  const held = useHeld(tab.connId);
  const catalog = useStruct((s) => s.tabs[key]?.structure?.v?.columns ?? null);
  const cols = useMemo(() => barColumns(st, catalog), [st.tableCols, st.columns, st.data, catalog]);
  const wantCatalog = visible && wantsCatalogColumns(st, held);
  useEffect(() => {
    if (wantCatalog) void readPart(key, { connId: tab.connId, schema: tab.schema, name: tab.name }, 'structure');
  }, [wantCatalog, key, tab.connId, tab.schema, tab.name]);
  const pop = useFilterUi((s) => (s.pop?.key === key ? s.pop : null));
  const colsOpen = useFilterUi((s) => s.cols === key);
  const bar = useRef<HTMLDivElement>(null);
  const chipsEl = useRef<HTMLDivElement>(null);
  const measureEl = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(filters.length);
  const shown = Math.min(fit, filters.length);
  const hidden = filters.length - shown;
  const full = filters.length >= MAX_FILTERS;

  // How many chips two lines hold: each chip's natural width from the measuring copies, the row's width; again when
  // the filters, the mask or the row's width change.
  const measure = useRef(() => {});
  measure.current = () => {
    const box = chipsEl.current;
    const m = measureEl.current;
    if (!box || !m) return;
    const kids = [...m.children] as HTMLElement[];
    const n = filters.length;
    const widths = kids.slice(0, n).map((k) => k.getBoundingClientRect().width);
    const more = kids[n]?.getBoundingClientRect().width ?? 0;
    const add = kids[n + 1]?.getBoundingClientRect().width ?? 0;
    setFit(fitChips(widths, box.clientWidth, { gap: GAP, more: () => more, add }));
  };
  useLayoutEffect(() => measure.current(), [filters, masked]);
  useEffect(() => {
    const el = chipsEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The popovers go with the tab: hidden (another tab in front, Structure, Relations) or closed, they close.
  useEffect(() => {
    if (visible) return;
    const ui = useFilterUi.getState();
    ui.closeFilter(key);
    ui.closeCols(key);
  }, [visible, key]);
  useEffect(() => () => {
    const ui = useFilterUi.getState();
    ui.closeFilter(key);
    ui.closeCols(key);
  }, [key]);

  // Where the keyboard goes once the bar has drawn the change (a chip removed, a popover closed).
  const focusNext = useRef<string | null>(null);
  useLayoutEffect(() => {
    const k = focusNext.current;
    if (k === null) return;
    focusNext.current = null;
    focusIn(bar.current, k);
  }, [filters, fit, pop, colsOpen]);

  // A popover asked for before the columns are known (another way in than the bar's) never opens late.
  useEffect(() => { if (pop && !cols) useFilterUi.getState().closeFilter(key); }, [pop, cols, key]);

  // A chip or "+ Filter" toggles its popover; a menu entry opens it (never a toggle closing the one being edited).
  const openFilter = (anchor: string, edit: number | null, toggle = true) => openFilterAt(key, { anchor, edit }, { ready: cols !== null, toggle });
  const remove = (i: number, refocus: boolean) => {
    useFilterUi.getState().closeFilter(key);
    const next = removeFilter(useDb.getState().tab(key).filters, i);
    if (refocus) focusNext.current = next.length > i ? `chip-${i}` : next.length > 0 ? `chip-${next.length - 1}` : 'add';
    setFilters(key, next);
  };
  const clearAll = () => {
    useFilterUi.getState().closeFilter(key);
    focusNext.current = 'add';
    setFilters(key, []);
  };
  const chipMenu = (e: MouseEvent, i: number) => {
    e.stopPropagation();
    const items: MenuItem[] = [
      { id: 'edit', label: tf.menu.edit, icon: 'edit', run: () => openFilter(`chip-${i}`, i, false) },
      { id: 'remove', label: tf.menu.remove, icon: 'x', run: () => remove(i, true) },
      'sep',
      { id: 'clear', label: tf.menu.clearAll, run: clearAll }
    ];
    useApp.getState().openMenu(e, items);
  };
  const openMore = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const items: MenuItem[] = filters.slice(shown).map((f, j) => ({ id: `filter-${shown + j}`, label: chipParts(f, masked).tip, icon: 'filter', run: () => openFilter('more', shown + j, false) }));
    items.push('sep', { id: 'clear', label: tf.menu.clearAll, run: clearAll });
    useApp.getState().openMenu({ x: r.left, y: r.bottom + 4, anchor: { left: r.left, right: r.right, bottom: r.bottom } }, items);
  };
  const closeFilter = (focus: string | null) => {
    if (focus !== null) focusNext.current = focus;
    useFilterUi.getState().closeFilter(key);
  };
  const closeCols = (refocus: boolean) => {
    if (refocus) focusNext.current = 'columns';
    useFilterUi.getState().closeCols(key);
  };

  const addOpen = !!pop && !!cols && pop.anchor === 'add';
  return (
    <>
      <div ref={bar} className="dbt-fbar" role="toolbar" aria-label={tf.label}>
        <span className="dbt-fbar-icon" aria-hidden="true"><Icon name="filter" size={14} /></span>
        <div ref={chipsEl} className="dbt-fchips">
          {/* Keyed by the filter itself (the list never holds one twice): removing one leaves the others where they are. */}
          {filters.slice(0, shown).map((f, i) => (
            <Chip key={JSON.stringify([f.column, f.path ?? null, f.op, f.values])} f={f} i={i} masked={masked} open={!!pop && !!cols && pop.edit === i && pop.anchor === `chip-${i}`}
              onEdit={() => openFilter(`chip-${i}`, i)} onRemove={(refocus) => remove(i, refocus)} onMenu={(e) => chipMenu(e, i)} />
          ))}
          {hidden > 0 && (
            <button type="button" className={`dbt-fmore${pop?.anchor === 'more' ? ' is-open' : ''}`} data-fanchor="more" aria-haspopup="menu" data-tip={tf.moreTip}
              onClick={(e) => openMore(e.currentTarget)}>
              {tf.more(hidden)}
            </button>
          )}
          {/* Named by aria-label: its word folds away in the narrowest pane (filters.css). */}
          <button type="button" className={`dbt-fadd${addOpen ? ' is-open' : ''}`} data-fanchor="add" aria-haspopup="dialog" aria-expanded={addOpen} aria-label={tf.add}
            data-tip={full ? tf.full(MAX_FILTERS) : cols ? tf.addTip : tf.waiting} disabled={!cols || full} onClick={() => openFilter('add', null)}>
            <Icon name="plus" size={12} stroke={2} /><span className="dbt-fadd-label">{tf.add}</span>
          </button>
          {/* What each chip, "+N more" and "+ Filter" would take on one line: read by the bar, never seen. */}
          <div ref={measureEl} className="dbt-fmeasure" aria-hidden="true">
            {filters.map((f, i) => <ChipFace key={i} f={f} masked={masked} />)}
            <span className="dbt-fmore">{tf.more(filters.length)}</span>
            <span className="dbt-fadd"><Icon name="plus" size={12} stroke={2} /><span className="dbt-fadd-label">{tf.add}</span></span>
          </div>
        </div>
        {cols && <ColumnsChip tabKey={key} cols={cols} chosen={st.columns} open={colsOpen} />}
      </div>
      {visible && pop && cols && (
        <FilterPopover key={`${pop.anchor}:${pop.edit}:${pop.target}`} tabKey={key} pop={pop} filters={filters} cols={cols} derived={st.derived} masked={masked} onClose={closeFilter} />
      )}
      {visible && colsOpen && cols && <ColumnsPopover tabKey={key} cols={cols} chosen={st.columns} onClose={closeCols} />}
    </>
  );
}

/** A chip's words as the measuring copy draws them (no handlers, no tooltip). */
function ChipFace({ f, masked }: { f: DbFilter; masked: boolean }) {
  const p = chipParts(f, masked);
  return (
    <span className="dbt-fchip">
      <span className="dbt-fchip-main"><span className="dbt-fchip-col">{p.col}</span><span className="dbt-fchip-op">{p.op}</span>{p.val && <span className="dbt-fchip-val">{p.val}</span>}</span>
      <span className="dbt-fchip-x" />
    </span>
  );
}

/** A chip: its words (a button: click edits, ⌫ / Delete removes, its menu), then × (by pointer; the keys do it too). */
function Chip({ f, i, masked, open, onEdit, onRemove, onMenu }: {
  f: DbFilter; i: number; masked: boolean; open: boolean; onEdit: () => void; onRemove: (refocus: boolean) => void; onMenu: (e: MouseEvent) => void;
}) {
  const p = chipParts(f, masked);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    onRemove(true);
  };
  return (
    <span className={`dbt-fchip${open ? ' is-open' : ''}`}>
      <button type="button" className="dbt-fchip-main" data-fanchor={`chip-${i}`} data-tip={p.tip} aria-label={tf.editChip(p.tip)} aria-haspopup="dialog" aria-expanded={open}
        onClick={onEdit} onKeyDown={onKey} onContextMenu={onMenu}>
        <span className="dbt-fchip-col">{p.col}</span><span className="dbt-fchip-op">{p.op}</span>{p.val && <span className="dbt-fchip-val">{p.val}</span>}
      </button>
      <button type="button" className="dbt-fchip-x" tabIndex={-1} aria-label={tf.removeChip(p.tip)} onClick={() => onRemove(false)} onContextMenu={onMenu}>
        <Icon name="x" size={12} stroke={1.8} />
      </button>
    </span>
  );
}

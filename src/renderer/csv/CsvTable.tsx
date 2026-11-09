// CSV viewer: the table — sticky typed headers that sort (⌥-click adds a key) with an
// optional summary, the row numbers and frozen columns sticky on the left, typed cells, the selection drawn as a
// rectangle, rows that don't match the header marked. Rows are virtualized; the keyboard is the pane's.
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { formatNumber, jsonCell, toNumber, groupInt } from './format';
import { binHeights, summaryText, tintOf, typeLabel, TINTS } from './labels';
import { rowWindow, type Cell } from './selection';
import type { CellRange, ColumnProfile, CsvData, Decimal, Sort } from './types';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';

export const ROW = 28;
const HEAD = 46;
const HEAD_SUMMARY = 88;
const OVERSCAN = 10;
const BAR = 44;
const BIN_H = 22;

export interface CsvTableHandle {
  /** Scrolls a display position into view (a column position too, when given). */
  reveal(row: number, col?: number): void;
  /** How many rows a page holds. */
  page(): number;
  focus(): void;
}

export interface CsvTableProps {
  id: string;
  data: CsvData;
  profiles: ColumnProfile[];
  decimal: Decimal;
  /** Data rows in display order and visible columns in order. */
  rows: number[];
  cols: number[];
  /** How many of the visible columns are frozen. */
  frozen: number;
  sort: Sort[];
  summaries: boolean;
  range: CellRange | null;
  focusCell: Cell | null;
  bad: Set<number>;
  scroll: { top: number; left: number };
  onScroll: (top: number, left: number) => void;
  /** A click (shift: extend), or a drag reaching a cell. */
  onCell: (cell: Cell, extend: boolean) => void;
  onRow: (row: number, extend: boolean) => void;
  onSort: (col: number, add: boolean) => void;
  onHeaderMenu: (col: number, anchor: DOMRect) => void;
  onCellMenu: (e: MouseEvent, cell: Cell) => void;
  onOpen: (cell: Cell) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

// JSON cells: parsed once per value while it is on screen (a scroll redraws the same cells).
const jsonCache = new Map<string, ReturnType<typeof jsonCell>>();
function jsonOf(value: string) {
  let j = jsonCache.get(value);
  if (j === undefined && !jsonCache.has(value)) {
    j = jsonCell(value);
    if (jsonCache.size > 2000) jsonCache.clear();
    jsonCache.set(value, j);
  }
  return j ?? null;
}

/** A cell's content, by its column's type. */
function CellContent({ value, p, decimal, missing }: { value: string | undefined; p: ColumnProfile; decimal: Decimal; missing: boolean }): ReactNode {
  if (value === undefined) return missing ? <span className="csv-missing">{t.csv.missing}</span> : <span className="csv-none">·</span>;
  if (value === '') return <span className="csv-empty">—</span>;
  switch (p.type) {
    case 'integer':
    case 'decimal': {
      const n = toNumber(value, decimal);
      if (n === null) return <span className="csv-odd">{value}</span>;
      const bar = p.bars && p.max ? Math.max(3, Math.round((Math.max(0, n) / p.max) * BAR)) : 0;
      return <>{bar > 0 && <span className="csv-bar" style={{ width: bar }} />}<span className="csv-num">{formatNumber(value, decimal)}</span></>;
    }
    case 'boolean': return <span className="csv-bool">{value}</span>;
    case 'date':
    case 'datetime': return <span className="csv-date">{value}</span>;
    case 'category':
      return p.codes ? <span className="csv-code">{value}</span> : <span className={`csv-pill t${tintOf(p, value)}`}>{value}</span>;
    case 'json': {
      const j = jsonOf(value);
      return j ? <><span className="csv-chip">{j.chip}</span><span className="csv-pv">{j.preview}</span></> : <span>{value}</span>;
    }
    default: return <span>{value}</span>;
  }
}

/** The header's summary: a histogram, a proportion bar or a count. */
function Summary({ p, decimal }: { p: ColumnProfile; decimal: Decimal }) {
  const text = summaryText(p, decimal);
  if (p.bins && p.bins.some((b) => b > 0)) {
    const h = binHeights(p.bins, BIN_H);
    return <><span className="csv-bins">{h.map((x, i) => <i key={i} style={{ height: x }} />)}</span><span className="csv-sum-text">{text}</span></>;
  }
  if ((p.type === 'category' || p.type === 'boolean') && p.top.length) {
    const total = p.count || 1;
    const shown = p.top.slice(0, 5);
    const rest = total - shown.reduce((s, x) => s + x.count, 0);
    return (
      <>
        <span className="csv-stack">
          {shown.map((x, i) => <i key={x.value} className={p.type === 'boolean' && x.value.toLowerCase() !== 'true' && x.value.toLowerCase() !== 'yes' ? 'is-off' : `t${i % TINTS}`} style={{ width: `${(x.count / total) * 100}%` }} />)}
          {rest > 0 && <i className="is-rest" style={{ width: `${(rest / total) * 100}%` }} />}
        </span>
        <span className="csv-sum-text">{text}</span>
      </>
    );
  }
  return <span className="csv-sum-text is-only">{text}</span>;
}

export const CsvTable = forwardRef<CsvTableHandle, CsvTableProps>(function CsvTable(p, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ top: p.scroll.top, height: 600 });
  const head = p.summaries ? HEAD_SUMMARY : HEAD;
  const dragging = useRef(false);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    el.scrollTop = p.scroll.top;
    el.scrollLeft = p.scroll.left;
    const ro = new ResizeObserver(() => setBox({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    setBox({ top: el.scrollTop, height: el.clientHeight });
    const up = () => { dragging.current = false; };
    window.addEventListener('mouseup', up);
    return () => { ro.disconnect(); window.removeEventListener('mouseup', up); };
  }, []);

  const digits = String(p.data.rows.length).length;
  const rnWidth = Math.max(44, Math.round(digits * 7.4 + 30));
  const widths = p.cols.map((c) => p.profiles[c]?.width ?? 100);
  const lefts: number[] = [];
  widths.reduce((x, w, i) => { lefts[i] = x; return x + w; }, rnWidth);
  const frozenEnd = p.frozen > 0 ? lefts[p.frozen - 1]! + widths[p.frozen - 1]! : rnWidth;
  const total = widths.reduce((s, w) => s + w, rnWidth);

  useImperativeHandle(ref, () => ({
    reveal: (row, col) => {
      const el = wrap.current;
      if (!el) return;
      const top = head + row * ROW;
      if (top < el.scrollTop + head) el.scrollTop = Math.max(0, top - head);
      else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight + 4;
      if (col !== undefined && col >= p.frozen) {
        const x = lefts[col]!;
        const w = widths[col]!;
        if (x - frozenEnd < el.scrollLeft) el.scrollLeft = x - frozenEnd;
        else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w - el.clientWidth;
      }
    },
    page: () => Math.max(1, Math.floor(((wrap.current?.clientHeight ?? 600) - head) / ROW) - 1),
    focus: () => wrap.current?.focus()
  }));

  // Fewer rows than the scroll position reaches (a filter): back to the last ones.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop > max) el.scrollTop = max;
    setBox({ top: el.scrollTop, height: el.clientHeight });
  }, [p.rows]);
  const { first, last } = rowWindow({ top: box.top, height: box.height, head, row: ROW, count: p.rows.length, overscan: OVERSCAN });
  const r = p.range;
  const single = !!r && r.r0 === r.r1 && r.c0 === r.c1;
  const sortAt = (col: number) => p.sort.findIndex((s) => s.col === col);

  // Frozen columns: sticky at their offset (their layer comes from csv.css, above the cells that scroll under them).
  const sticky = (k: number): CSSProperties | undefined => (k < p.frozen ? { position: 'sticky', left: lefts[k] } : undefined);
  /** The range's outline on its edge cells. */
  const edge = (pr: number, pc: number): CSSProperties | undefined => {
    if (!r || single || pr < r.r0 || pr > r.r1 || pc < r.c0 || pc > r.c1) return undefined;
    const s: string[] = [];
    if (pr === r.r0) s.push('inset 0 1.5px 0 var(--csv-edge)');
    if (pr === r.r1) s.push('inset 0 -1.5px 0 var(--csv-edge)');
    if (pc === r.c0) s.push('inset 1.5px 0 0 var(--csv-edge)');
    if (pc === r.c1) s.push('inset -1.5px 0 0 var(--csv-edge)');
    return s.length ? { boxShadow: s.join(', ') } : undefined;
  };

  return (
    <div ref={wrap} id={p.id} className={`csv-table-wrap ${p.summaries ? 'has-summaries' : ''}`} tabIndex={0} onKeyDown={p.onKeyDown}
      role="grid" aria-rowcount={p.rows.length + 1} aria-colcount={p.cols.length + 1} aria-multiselectable="true"
      onScroll={(e) => { const el = e.currentTarget; setBox((b) => ({ ...b, top: el.scrollTop })); p.onScroll(el.scrollTop, el.scrollLeft); }}>
      <table className="csv-table" style={{ width: total }}>
        <colgroup><col style={{ width: rnWidth }} />{widths.map((w, k) => <col key={p.cols[k]} style={{ width: w }} />)}</colgroup>
        <thead>
          <tr style={{ height: head }}>
            <th className="csv-rn" scope="col">#</th>
            {p.cols.map((c, k) => {
              const prof = p.profiles[c]!;
              const at = sortAt(c);
              const dir = at >= 0 ? p.sort[at]!.dir : null;
              const inSel = !!r && k >= r.c0 && k <= r.c1;
              const num = prof.type === 'integer' || prof.type === 'decimal';
              const name = prof.extra ? t.csv.noHeader : prof.name;
              return (
                <th key={c} scope="col" style={sticky(k)} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                  className={`${num ? 'is-num' : ''} ${dir ? 'is-sorted' : ''} ${inSel ? 'is-in' : ''} ${prof.extra ? 'is-extra' : ''} ${k === p.frozen - 1 ? 'is-frozen-end' : ''}`}
                  onContextMenu={(e) => { e.preventDefault(); p.onHeaderMenu(c, e.currentTarget.getBoundingClientRect()); }}>
                  <span className="csv-th">
                    <button type="button" className="csv-sort" tabIndex={-1} onClick={(e) => p.onSort(c, e.altKey)}
                      data-tip={`${t.csv.hints.sort} · ${t.csv.hints.addSort}`}>
                      <span className="csv-letter">{prof.letter}</span>
                      {name && <span className="csv-name">{name}</span>}
                      {dir && <span className="csv-arrow">{dir === 'asc' ? '↑' : '↓'}{p.sort.length > 1 && <sup>{at + 1}</sup>}</span>}
                    </button>
                    <button type="button" className="csv-col-menu" tabIndex={-1} aria-label={t.csv.columnMenu(name || prof.letter)}
                      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => p.onHeaderMenu(c, (e.currentTarget.closest('th') as HTMLElement).getBoundingClientRect())}>
                      <Icon name="chevronDown" size={11} stroke={2} />
                    </button>
                  </span>
                  <span className="csv-type">{typeLabel(prof)}</span>
                  {p.summaries && <span className="csv-summary"><Summary p={prof} decimal={p.decimal} /></span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {first > 0 && <tr className="csv-spacer" aria-hidden="true"><td colSpan={p.cols.length + 1} style={{ height: first * ROW }} /></tr>}
          {p.rows.slice(first, last).map((row, i) => {
            const pr = first + i;
            const values = p.data.rows[row]!;
            const isBad = p.bad.has(row);
            const inRows = !!r && pr >= r.r0 && pr <= r.r1;
            return (
              <tr key={row} className={`${inRows ? 'is-in' : ''} ${isBad ? 'is-bad' : ''}`} aria-rowindex={pr + 2}>
                <td className="csv-rn" onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); p.onRow(row, e.shiftKey); wrap.current?.focus(); } }}>
                  {isBad && <span className="csv-warn" aria-label={t.csv.problems(1)}><Icon name="warning" size={11} stroke={2} /></span>}
                  {groupInt(row + 1)}
                </td>
                {p.cols.map((c, k) => {
                  const prof = p.profiles[c]!;
                  const inSel = inRows && k >= r!.c0 && k <= r!.c1;
                  const isFocus = !!p.focusCell && p.focusCell.row === row && p.focusCell.col === c;
                  const num = prof.type === 'integer' || prof.type === 'decimal';
                  const cell = { row, col: c };
                  return (
                    <td key={c} role="gridcell" aria-selected={inSel}
                      className={`${num ? 'is-num' : ''} ${inSel ? 'is-in' : ''} ${isFocus ? (single ? 'is-focus' : 'is-anchor') : ''} ${k === p.frozen - 1 ? 'is-frozen-end' : ''}`}
                      style={{ ...sticky(k), ...edge(pr, k) }}
                      onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); dragging.current = true; p.onCell(cell, e.shiftKey); wrap.current?.focus(); }}
                      onMouseEnter={() => { if (dragging.current) p.onCell(cell, true); }}
                      onDoubleClick={() => p.onOpen(cell)}
                      onContextMenu={(e) => { e.preventDefault(); p.onCellMenu(e, cell); }}>
                      <CellContent value={values[c]} p={prof} decimal={p.decimal} missing={c < p.data.expected} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {last < p.rows.length && <tr className="csv-spacer" aria-hidden="true"><td colSpan={p.cols.length + 1} style={{ height: (p.rows.length - last) * ROW }} /></tr>}
        </tbody>
      </table>
    </div>
  );
});

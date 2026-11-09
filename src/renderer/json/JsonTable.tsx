// JSON navigation: an array of objects as a table — sticky typed headers that sort, cells in
// the editor's colors, bars in numeric columns, chips that open nested values in the tree. Rows are virtualized.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { nextSort, type Cell, type Column, type Sort, type TableRow } from './table';
import type { JsonNode } from './parse';
import type { Segment } from './scan';

const ROW = 28;
const HEAD = 30;
const OVERSCAN = 12;
const BAR = 60;

function CellView({ cell, col, onOpen }: { cell: Cell; col: Column; onOpen: () => void }) {
  if (cell.kind === 'missing') return <span className="jtab-miss">—</span>;
  if (cell.kind === 'box') {
    return (
      <>
        <button type="button" className="jtab-chip" tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} onClick={onOpen}>{cell.chip}</button>
        <span className="jtab-pv">{cell.text}</span>
      </>
    );
  }
  return (
    <>
      {col.numeric && cell.bar !== undefined && <span className="jtab-bar" style={{ width: Math.max(4, Math.round(cell.bar * BAR)) }} />}
      <span className={`jt-v-${cell.kind}`}>{cell.text}</span>
    </>
  );
}

export function JsonTable(p: {
  id: string;
  model: { columns: Column[]; rows: TableRow[]; total: number };
  sort: Sort | null;
  /** The selected element's index in the array. */
  sel: number | null;
  onSort: (s: Sort | null) => void;
  onSelect: (index: number) => void;
  /** Open a value of the array in the tree (its path inside the array). */
  onOpen: (path: Segment[]) => void;
  onShowSource: (node: JsonNode) => void;
  onMenu: (e: MouseEvent, index: number) => void;
}) {
  const { columns, rows } = p.model;
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor((box.top - HEAD) / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((box.top + box.height) / ROW) + OVERSCAN);
  const at = p.sel === null ? -1 : rows.findIndex((r) => r.index === p.sel);

  const reveal = (k: number) => {
    const el = wrap.current;
    if (!el) return;
    const top = HEAD + 12 + k * ROW;
    if (top - HEAD < el.scrollTop + HEAD) el.scrollTop = Math.max(0, top - 2 * HEAD);
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + 2 * ROW - el.clientHeight;
  };
  const onKey = (e: KeyboardEvent) => {
    if (!rows.length) return;
    const go = (k: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]!; p.onSelect(r.index); reveal(rows.indexOf(r)); };
    const row = at >= 0 ? rows[at]! : null;
    let handled = true;
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(Math.max(0, at - 1));
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'Enter' && row && e.altKey) p.onShowSource(row.node);
    else if (e.key === 'Enter' && row) p.onOpen([row.index]);
    else handled = false;
    if (handled) e.preventDefault();
  };

  return (
    <div ref={wrap} id={p.id} className="json-table-wrap" tabIndex={0} onKeyDown={onKey}
      onScroll={(e) => { const top = e.currentTarget.scrollTop; setBox((b) => ({ ...b, top })); }}>
      <table className="json-table" role="grid" aria-rowcount={rows.length + 1}>
        <thead>
          <tr>
            <th scope="col">#</th>
            {columns.map((c) => {
              const sorted = p.sort?.key === c.key ? p.sort.dir : null;
              return (
                <th key={c.key} scope="col" className={`${sorted ? 'is-sorted' : ''} ${c.numeric ? 'is-num' : ''}`} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}>
                  <button type="button" className="jtab-sort" onClick={() => p.onSort(nextSort(p.sort, c.key))}>
                    {c.key}{sorted && <span className="jtab-arrow">{sorted === 'asc' ? '↑' : '↓'}</span>}
                  </button>
                  <span className="jtab-type">{c.label}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {first > 0 && <tr className="jtab-spacer" aria-hidden="true"><td colSpan={columns.length + 1} style={{ height: first * ROW }} /></tr>}
          {rows.slice(first, last).map((r) => (
            <tr key={r.index} className={r.index === p.sel ? 'is-sel' : ''} aria-selected={r.index === p.sel}
              onMouseDown={(e) => { if (e.button === 0) p.onSelect(r.index); }}
              onDoubleClick={() => p.onOpen([r.index])}
              onContextMenu={(e) => { p.onSelect(r.index); p.onMenu(e, r.index); }}>
              <td className="jtab-idx">{r.index}</td>
              {r.cells.map((cell, k) => (
                <td key={columns[k]!.key} className={columns[k]!.numeric ? 'is-num' : ''}>
                  <CellView cell={cell} col={columns[k]!} onOpen={() => p.onOpen([r.index, columns[k]!.key])} />
                </td>
              ))}
            </tr>
          ))}
          {last < rows.length && <tr className="jtab-spacer" aria-hidden="true"><td colSpan={columns.length + 1} style={{ height: (rows.length - last) * ROW }} /></tr>}
        </tbody>
      </table>
    </div>
  );
}

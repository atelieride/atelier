// The JSON view's Table: an array of objects' items as rows, the union of their keys
// as columns (200 at most), only the rows on screen drawn, sticky header and index; it scrolls both ways, and keeps its
// scroll keys. Mask values on: a cell on a secret key's path is dots. A click selects
// the cell's node (the bottom bar's Path and SQL). Its own module; lazy, with the table's chunk.
import { useMemo, useRef } from 'react';
import type { DbPath } from '@shared/databases-filters';
import { tdt } from '../i18n/db-table';
import { nodeAt, scrollKey, tableCell, tableColumns, type JsonNode } from './json';
import { useRange } from './json-ui';

/** A row's height (fixed: the rows on screen are known without measuring). */
const TROW_H = 26;
const IDX_W = 52;
const COL_W = 150;

const samePath = (a: readonly (string | number)[], b: readonly (string | number)[]) => a.length === b.length && a.every((p, i) => p === b[i]);

export function JsonTable({ tree, target, parsed, secret, sel, onPick }: {
  tree: JsonNode; target: DbPath; parsed: ReadonlySet<string>; secret: ((k: string) => boolean) | null; sel: DbPath; onPick: (p: DbPath) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const items = useMemo(() => nodeAt(tree, target, parsed) as JsonNode[], [tree, target, parsed]);
  const cols = useMemo(() => tableColumns(items) ?? [], [items]);
  const { first, last } = useRange(box, items.length, TROW_H);
  const n = items.length;
  const selRow = sel.length === target.length + 2 && samePath(sel.slice(0, target.length), target) ? sel[target.length] : -1;
  const selCol = selRow === -1 ? null : sel[target.length + 1];
  return (
    <div ref={box} className="dbj-table" tabIndex={0} role="region" aria-label={tdt.json.views.table}
      onKeyDown={(e) => { if (scrollKey(e.key)) e.stopPropagation(); }}>
      <table className="dbj-tt" style={{ width: IDX_W + cols.length * COL_W }}>
        <colgroup><col style={{ width: IDX_W }} />{cols.map((c) => <col key={c} style={{ width: COL_W }} />)}</colgroup>
        <thead><tr><th className="dbj-tt-i" scope="col">#</th>{cols.map((c) => <th key={c} scope="col" data-tip={c}>{c}</th>)}</tr></thead>
        <tbody>
          {first > 0 && <tr className="dbj-tt-sp" aria-hidden="true"><td colSpan={cols.length + 1} style={{ height: first * TROW_H }} /></tr>}
          {items.slice(first, last).map((item, j) => {
            const i = first + j;
            const obj = item as Record<string, unknown>;
            return (
              <tr key={i} className={selRow === i ? 'is-sel' : undefined}>
                <td className="dbj-tt-i mono">{i}</td>
                {cols.map((c) => {
                  const has = Object.prototype.hasOwnProperty.call(obj, c);
                  const cell = tableCell(has ? obj[c] : undefined, [...target, i, c], secret);
                  return (
                    <td key={c} className={`${cell.cls}${selRow === i && selCol === c ? ' is-cur' : ''}`} data-tip={cell.text.length > 18 ? cell.text : undefined}
                      onClick={() => { if (has) onPick([...target, i, c]); }}>{cell.text}</td>
                  );
                })}
              </tr>
            );
          })}
          {last < n && <tr className="dbj-tt-sp" aria-hidden="true"><td colSpan={cols.length + 1} style={{ height: (n - last) * TROW_H }} /></tr>}
        </tbody>
      </table>
    </div>
  );
}

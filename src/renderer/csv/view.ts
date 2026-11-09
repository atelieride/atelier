// CSV viewer: the rows the table shows — problems only, the row filter, the column
// filters, a stable multi-key sort — and selection ranges with their totals. Pure.
import { toNumber } from './format';
import { dateMs } from './profile';
import type { CellRange, ColumnProfile, CsvData, Decimal, Sort, ValueFilter, ViewQuery } from './types';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const TRUE = new Set(['true', 'yes']);

/** Data rows that don't match the header, or start an unclosed quote. */
export const problemRows = (data: CsvData): Set<number> => new Set(data.problems.map((p) => p.row));

/** A column's sort keys: numbers (NaN = empty) for numbers, dates and booleans; strings ('' = empty) otherwise. */
function sortKeys(data: CsvData, p: ColumnProfile | undefined, col: number, decimal: Decimal): Float64Array | string[] {
  const rows = data.rows;
  const type = p?.type;
  if (type === 'integer' || type === 'decimal' || type === 'date' || type === 'datetime' || type === 'boolean') {
    const keys = new Float64Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      const v = (rows[r]![col] ?? '').trim();
      keys[r] = !v ? NaN
        : type === 'boolean' ? (TRUE.has(v.toLowerCase()) ? 1 : 0)
          : type === 'date' || type === 'datetime' ? dateMs(v) ?? NaN
            : toNumber(v, decimal) ?? NaN;
    }
    return keys;
  }
  return rows.map((r) => (r[col] ?? '').trim());
}

/** The data rows (indexes) the table shows, in display order. */
export function visibleRows(data: CsvData, profiles: readonly ColumnProfile[], q: ViewQuery, decimal: Decimal): number[] {
  const rows = data.rows;
  const bad = q.problemsOnly ? problemRows(data) : null;
  const needle = q.query.trim().toLowerCase();
  const filters = q.filters.map((f) => ({ col: f.col, keep: f.mode === 'in', values: new Set(f.values) }));
  const shown = q.columns ?? null;
  const out: number[] = [];
  for (let r = 0; r < rows.length; r++) {
    if (bad && !bad.has(r)) continue;
    const row = rows[r]!;
    if (filters.some((f) => f.values.has(row[f.col] ?? '') !== f.keep)) continue;
    if (needle && !(shown ? shown.some((c) => (row[c] ?? '').toLowerCase().includes(needle)) : row.some((v) => v.toLowerCase().includes(needle)))) continue;
    out.push(r);
  }
  if (!q.sort.length) return out;
  const keys = q.sort.map((s) => ({ dir: s.dir === 'asc' ? 1 : -1, k: sortKeys(data, profiles[s.col], s.col, decimal) }));
  return out.sort((a, b) => {
    for (const { dir, k } of keys) {
      const x = k[a]!, y = k[b]!;
      if (typeof x === 'number') {
        const nx = Number.isNaN(x), ny = Number.isNaN(y as number);
        if (nx || ny) { if (nx !== ny) return nx ? 1 : -1; continue; }
        if (x !== y) return (x - (y as number)) * dir;
      } else {
        if (!x || !y) { if (!x !== !y) return !x ? 1 : -1; continue; }
        const c = collator.compare(x, y as string);
        if (c) return c * dir;
      }
    }
    return a - b;
  });
}

/** A header click: asc → desc → off on that column, alone. ⌥-click (add): the column as a further key, stepped in place. */
export function nextSort(sort: readonly Sort[], col: number, add: boolean): Sort[] {
  const at = sort.findIndex((s) => s.col === col);
  const cur = at >= 0 ? sort[at]! : null;
  if (!add) return !cur ? [{ col, dir: 'asc' }] : cur.dir === 'asc' ? [{ col, dir: 'desc' }] : [];
  if (!cur) return [...sort, { col, dir: 'asc' }];
  return cur.dir === 'asc' ? sort.map((s, i) => (i === at ? { col, dir: 'desc' as const } : s)) : sort.filter((_, i) => i !== at);
}

/** The rectangle between two cells (display row, visible column position). */
export const normRange = (a: { row: number; col: number }, b: { row: number; col: number }): CellRange =>
  ({ r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) });

export interface Aggregate { col: number; count: number; sum: number; avg: number; min: number; max: number }

/**
 * Totals of a range for each number column in it. `rows`: data row indexes in display order; `cols`: the visible
 * columns' indexes in order; the range is over those positions.
 */
export function aggregates(data: CsvData, profiles: readonly ColumnProfile[], rows: readonly number[], cols: readonly number[], range: CellRange, decimal: Decimal): Aggregate[] {
  const out: Aggregate[] = [];
  for (let c = range.c0; c <= range.c1; c++) {
    const col = cols[c];
    const type = col === undefined ? undefined : profiles[col]?.type;
    if (col === undefined || (type !== 'integer' && type !== 'decimal')) continue;
    let count = 0, sum = 0, min = Infinity, max = -Infinity;
    for (let r = range.r0; r <= range.r1; r++) {
      const at = rows[r];
      if (at === undefined) continue;
      const n = toNumber(data.rows[at]?.[col] ?? '', decimal);
      if (n === null) continue;
      count++; sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (count) out.push({ col, count, sum, avg: sum / count, min, max });
  }
  return out;
}

/** A column filter's chip: `status delivered, shipped`, `status ≠ shipped`, `status a, b, c +2`. */
export function filterLabel(f: ValueFilter, p: ColumnProfile): string {
  const shown = f.values.slice(0, 3).map((v) => (v === '' ? '(empty)' : v)).join(', ');
  const more = f.values.length > 3 ? ` +${f.values.length - 3}` : '';
  return `${p.name || p.letter} ${f.mode === 'out' ? '≠ ' : ''}${shown}${more}`;
}

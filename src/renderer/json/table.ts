// JSON navigation: an array of objects as a table — which array, its columns and their types,
// the cells as the tree shows values, sorting and the row filter. Pure.
import { nodeAtPath, stringOf, type JsonNode } from './parse';
import type { Segment } from './scan';
import { chipOf, preview } from './rows';
import { groupNumber } from './paths';

export type ColumnType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'mixed';

export interface Column {
  key: string;
  type: ColumnType;
  /** Rows that have this key. */
  present: number;
  /** "object · 9/10" when some rows lack it. */
  label: string;
  /** Non-negative numbers only: the cells get a bar. */
  numeric: boolean;
}

export interface Cell {
  kind: 'string' | 'number' | 'boolean' | 'null' | 'box' | 'missing';
  node: JsonNode | null;
  text: string;
  chip?: string;
  /** 0…1 of the column's largest value. */
  bar?: number;
}

export interface TableRow { index: number; node: JsonNode; line: number; cells: Cell[] }

export interface Sort { key: string; dir: 'asc' | 'desc' }

const MAX_TEXT = 120;

const isTable = (n: JsonNode) => n.type === 'array' && !!n.children?.length && n.children.every((c) => c.type === 'object');

/** The array the Table shows for a selection: the selected value or its nearest ancestor that is an array of objects. */
export function tableTarget(root: JsonNode, sel: readonly Segment[]): Segment[] | null {
  const chain = nodeAtPath(root, sel);
  for (let k = chain.length - 1; k >= 0; k--) if (isTable(chain[k]!)) return sel.slice(0, k) as Segment[];
  return null;
}

function cellOf(n: JsonNode | undefined): Cell {
  if (!n) return { kind: 'missing', node: null, text: '—' };
  if (n.children) return { kind: 'box', node: n, chip: chipOf(n), text: preview(n) };
  const raw = n.raw ?? '';
  return { kind: n.type as Cell['kind'], node: n, text: raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}…` : raw };
}

const rank: Record<string, number> = { number: 0, string: 1, boolean: 2, null: 3, object: 4, array: 4 };

function compare(a: JsonNode, b: JsonNode): number {
  if (a.type !== b.type) return (rank[a.type] ?? 5) - (rank[b.type] ?? 5);
  if (a.type === 'number') return (a.value as number) - (b.value as number);
  if (a.type === 'string') return stringOf(a).localeCompare(stringOf(b), undefined, { numeric: true, sensitivity: 'base' });
  if (a.type === 'boolean') return Number(a.value) - Number(b.value);
  if (a.children && b.children) return a.children.length - b.children.length;
  return 0;
}

export function buildTable(arr: JsonNode, opts: { query: string; sort: Sort | null }): { columns: Column[]; rows: TableRow[]; total: number } {
  const items = arr.children ?? [];
  const order: string[] = [];
  const stats = new Map<string, { types: Set<string>; present: number; nonNeg: boolean; max: number }>();
  const maps = items.map((it) => {
    const m = new Map<string, JsonNode>();
    for (const c of it.children ?? []) {
      const k = c.key as string;
      m.set(k, c);
      let s = stats.get(k);
      if (!s) { s = { types: new Set(), present: 0, nonNeg: true, max: 0 }; stats.set(k, s); order.push(k); }
      s.types.add(c.type);
      s.present++;
      if (c.type === 'number') { const v = c.value as number; if (v < 0) s.nonNeg = false; s.max = Math.max(s.max, v); }
    }
    return m;
  });
  const columns: Column[] = order.map((key) => {
    const s = stats.get(key)!;
    const types = [...s.types];
    const type = (types.length === 1 ? types[0] : 'mixed') as ColumnType;
    return {
      key, type, present: s.present,
      label: s.present < items.length ? `${type} · ${groupNumber(s.present)}/${groupNumber(items.length)}` : type,
      numeric: type === 'number' && s.nonNeg && s.max > 0
    };
  });
  let rows: TableRow[] = items.map((it, index) => ({
    index, node: it, line: it.line,
    cells: columns.map((col) => {
      const cell = cellOf(maps[index]!.get(col.key));
      if (col.numeric && cell.node?.type === 'number') cell.bar = (cell.node.value as number) / stats.get(col.key)!.max;
      return cell;
    })
  }));
  const q = opts.query.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.cells.some((c) => c.kind !== 'missing' && `${c.chip ?? ''} ${c.text}`.toLowerCase().includes(q)));
  const sort = opts.sort;
  const col = sort ? columns.findIndex((c) => c.key === sort.key) : -1;
  if (sort && col >= 0) {
    const sign = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const x = a.cells[col]!.node;
      const y = b.cells[col]!.node;
      if (!x || !y) return x === y ? a.index - b.index : x ? -1 : 1;
      return sign * compare(x, y) || a.index - b.index;
    });
  }
  return { columns, rows, total: items.length };
}

/** A header click: ascending, descending, off; another column starts ascending. */
export function nextSort(cur: Sort | null, key: string): Sort | null {
  if (!cur || cur.key !== key) return { key, dir: 'asc' };
  return cur.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/** "10 rows · 6 columns · sorted by latencyMs", "3 of 10 rows · 1 column". */
export function tableMeta(m: { shown: number; total: number; columns: number; sort: Sort | null }): string {
  const rows = m.shown === m.total ? `${groupNumber(m.total)} ${m.total === 1 ? 'row' : 'rows'}` : `${groupNumber(m.shown)} of ${groupNumber(m.total)} rows`;
  return [rows, `${m.columns} ${m.columns === 1 ? 'column' : 'columns'}`, ...(m.sort ? [`sorted by ${m.sort.key}`] : [])].join(' · ');
}

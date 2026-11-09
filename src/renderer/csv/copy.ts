// CSV viewer: a block of cells as TSV (pastes as cells in a sheet), CSV with the file's delimiter,
// a Markdown table, JSON objects or SQL VALUES — and the one-line samples Copy As shows. Pure.
import { toNumber } from './format';
import type { ColType, Decimal, Delimiter } from './types';

export type CopyFormat = 'tsv' | 'csv' | 'markdown' | 'json' | 'sql';
export const COPY_FORMATS: readonly CopyFormat[] = ['tsv', 'csv', 'markdown', 'json', 'sql'];

/** The cells to copy: column names (the header's, or the letters), the rows' values, the columns' types. */
export interface CopyBlock { names: string[]; rows: string[][]; types: ColType[] }
export interface CopyOptions { header: boolean; delimiter: Delimiter; decimal: Decimal }

const SAMPLE_MAX = 80;
const TRUE = new Set(['true', 'yes']);
const isNum = (t: ColType | undefined) => t === 'integer' || t === 'decimal';

/**
 * A field quoted (RFC 4180) when it holds the separator, a quote or a line break. TSV quotes a quote only at the start
 * (as sheets read a pasted quote): a quote inside a TSV field stays as it is.
 */
const quoted = (v: string, sep: string): string => {
  const quote = sep === '\t' ? v.startsWith('"') || /[\t\n\r]/.test(v) : v.includes(sep) || /["\n\r]/.test(v);
  return quote ? `"${v.replace(/"/g, '""')}"` : v;
};

function delimited(b: CopyBlock, o: CopyOptions, sep: string): string[] {
  const rows = o.header ? [b.names, ...b.rows] : b.rows;
  return rows.map((r) => b.names.map((_, c) => quoted(r[c] ?? '', sep)).join(sep));
}

function markdown(b: CopyBlock): string[] {
  const esc = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const head = b.names.map(esc);
  const body = b.rows.map((r) => b.names.map((_, c) => esc(r[c] ?? '')));
  // A loop, never a spread of one argument per row: past ~110 000 rows that overflows the stack.
  const widths = head.map((h, c) => body.reduce((w, r) => Math.max(w, r[c]!.length), Math.max(3, h.length)));
  const cell = (v: string, c: number) => (isNum(b.types[c]) ? v.padStart(widths[c]!) : v.padEnd(widths[c]!));
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [
    line(head.map((h, c) => h.padEnd(widths[c]!))),
    line(widths.map((w, c) => (isNum(b.types[c]) ? `${'-'.repeat(w - 1)}:` : '-'.repeat(w)))),
    ...body.map((r) => line(r.map(cell)))
  ];
}

/** A value as JSON: numbers, booleans and JSON cells typed; an empty cell "" in text columns, null in the others. */
function jsonValue(v: string, type: ColType | undefined, decimal: Decimal): unknown {
  const s = v.trim();
  const textual = type === 'text' || type === 'category' || type === 'date' || type === 'datetime';
  if (!s) return textual ? '' : null;
  if (isNum(type)) return toNumber(s, decimal) ?? v;
  if (type === 'boolean') return TRUE.has(s.toLowerCase());
  if (type === 'json') { try { return JSON.parse(s) as unknown; } catch { return v; } }
  return v;
}

/** Unique keys: a repeated name gets `_2`, `_3`. */
function keysOf(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => { const k = (seen.get(n) ?? 0) + 1; seen.set(n, k); return k === 1 ? n : `${n}_${k}`; });
}

const objects = (b: CopyBlock, decimal: Decimal): Record<string, unknown>[] => {
  const keys = keysOf(b.names);
  return b.rows.map((r) => Object.fromEntries(keys.map((k, c) => [k, jsonValue(r[c] ?? '', b.types[c], decimal)])));
};

/** A value as SQL: numbers with a dot, TRUE/FALSE, NULL for empty, strings in single quotes. */
function sqlValue(v: string, type: ColType | undefined, decimal: Decimal): string {
  const s = v.trim();
  if (!s) return 'NULL';
  if (isNum(type) && toNumber(s, decimal) !== null) return decimal === '.' ? s.replace(/,/g, '').replace(/^\+/, '') : s.replace(/\./g, '').replace(',', '.').replace(/^\+/, '');
  if (type === 'boolean') return TRUE.has(s.toLowerCase()) ? 'TRUE' : 'FALSE';
  return `'${v.replace(/'/g, "''")}'`;
}

const tuples = (b: CopyBlock, decimal: Decimal): string[] => b.rows.map((r) => `(${b.names.map((_, c) => sqlValue(r[c] ?? '', b.types[c], decimal)).join(', ')})`);

/** The block in a format. Markdown always has its header row; JSON always uses the names as keys. */
export function copyCells(format: CopyFormat, b: CopyBlock, o: CopyOptions): string {
  switch (format) {
    case 'tsv': return delimited(b, o, '\t').join('\n');
    case 'csv': return delimited(b, o, o.delimiter).join('\n');
    case 'markdown': return markdown(b).join('\n');
    case 'json': return JSON.stringify(objects(b, o.decimal), null, 2);
    case 'sql': return [...(o.header ? [`-- ${b.names.join(', ')}`] : []), tuples(b, o.decimal).join(',\n')].join('\n');
  }
}

const cut = (s: string) => (s.length > SAMPLE_MAX ? `${s.slice(0, SAMPLE_MAX - 1)}…` : s);

/** Copy As's second line: the start of what the format gives. */
export function sample(format: CopyFormat, b: CopyBlock, o: CopyOptions): string {
  const head: CopyBlock = { ...b, rows: b.rows.slice(0, 2) };
  const more = b.rows.length > (format === 'json' ? 1 : 2) ? ', …' : '';
  switch (format) {
    case 'tsv': return cut(delimited(head, o, '\t')[0]?.replace(/\t/g, '⇥') ?? '');
    case 'csv': return cut(delimited(head, o, o.delimiter).slice(0, 2).join('  ·  '));
    case 'markdown': return markdown(head).slice(0, 2).map(cut).join('\n');
    case 'json': {
      const first = objects({ ...b, rows: b.rows.slice(0, 1) }, o.decimal)[0];
      const inner = first ? `{${Object.entries(first).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}` : '';
      return cut(`[${inner}${b.rows.length > 1 ? ', …' : ''}]`);
    }
    case 'sql': return cut(tuples(head, o.decimal).join(', ') + more);
  }
}

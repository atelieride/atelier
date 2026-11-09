// What the grid's copies carry: ⌘C (a cell's value, or rows as TSV) and Copy
// Rows As › JSON · CSV · Markdown · SQL INSERT — masked when Mask values is on. No number ever changes on
// its way, so JSON is written as text (numbers and json/jsonb values as Postgres printed them, never parsed and
// stringified again). R65: Copy Value on a value main cut at 64 KB reads it whole first; row copies carry what is
// loaded and say how many values were cut. R66: SQL INSERT carries the row's key columns even when they aren't shown.
// Lazy, with the table's chunk; the action bar and the sends (prompts.ts) reuse it.
import type { DbCell, DbFullRequest, DbPage, DbResult, DbTableRef } from '@shared/databases';
import { typeClass } from '@shared/databases-filters';
import { cellText, isMasked, MASK, type FormatOpts } from '@shared/pg-format';
import { quoteIdent } from '@shared/pg-json';
import { tdt } from '../i18n/db-table';
import type { GridColumn } from './grid-model';
import { isJsonText, looksJsonContainer, maskJson } from './json-text';

/** What copies read: the columns shown, those kept only to name the row (`hidden`, for SQL INSERT), the rows loaded. */
export interface GridSource { columns: readonly GridColumn[]; hidden?: readonly GridColumn[]; rows: readonly (readonly DbCell[])[] }
export type CopyFormat = 'json' | 'csv' | 'markdown' | 'insert';
export const COPY_FORMATS: readonly CopyFormat[] = ['json', 'csv', 'markdown', 'insert'];

/**
 * Whether a value is JSON text: a json/jsonb column's, or a JSON column's object or array — one cut at
 * 64 KB (`cut`) included, though no longer whole JSON.
 */
const isJson = (g: GridColumn, v: string, cut = false) => typeClass(g.col) === 'json' || (g.derived !== null && looksJsonContainer(v) && (cut || isJsonText(v)));
/** The value as stored; JSON with Mask values on: a secret key's value as dots, a cut one dots whole. */
const raw = (row: readonly DbCell[] | undefined, g: GridColumn, o?: FormatOpts) => {
  const cell = row?.[g.index];
  const v = cell?.v ?? null;
  return v !== null && o?.masked && isJson(g, v, cell?.cut !== undefined) ? maskJson(v, true) : v;
};
/** The value as one reads it: masked, booleans as words, times per Settings › Times with their whole precision. */
const read = (row: readonly DbCell[] | undefined, g: GridColumn, o: FormatOpts) => cellText(raw(row, g, o), g.col, o);
/** The selected rows' indices in the grid's order: each once, only rows loaded. */
export const inGridOrder = (src: GridSource, sel: readonly number[]): number[] =>
  [...new Set(sel)].sort((x, y) => x - y).filter((i) => i >= 0 && i < src.rows.length);
const selected = (src: GridSource, sel: readonly number[]) => inGridOrder(src, sel).map((i) => src.rows[i]!);
/** SQL INSERT's columns: the table's own (no JSON columns), the hidden keys among them, in the page's order. */
const tableColumns = (src: GridSource) => [...src.columns.filter((g) => g.derived === null), ...(src.hidden ?? [])].sort((a, b) => a.index - b.index);
const tsv = (s: string) => s.replace(/\t/g, '\\t').replace(/\r\n|\n|\r/g, (m) => (m === '\r' ? '\\r' : '\\n'));

/**
 * ⌘C: the focused cell's value as it is when it is the only row selected (or nothing is, and a cell is
 * focused); else the selected rows as TSV with a header — tabs and newlines in values written as \t and \n, so each
 * row stays one line, NULL empty. `focus.col` is the value's index in the row. (A cut value's whole: valueCopy.)
 */
export function copyText(src: GridSource, sel: readonly number[], focus: { row: number; col: number } | null, o: FormatOpts): string {
  if (focus && (sel.length === 0 || (sel.length === 1 && sel[0] === focus.row))) {
    const g = src.columns.find((c) => c.index === focus.col);
    return g ? read(src.rows[focus.row], g, o) : '';
  }
  const rows = selected(src, sel);
  if (rows.length === 0) return '';
  const line = (cells: string[]) => cells.map(tsv).join('\t');
  return [line(src.columns.map((g) => g.label)), ...rows.map((r) => line(src.columns.map((g) => read(r, g, o))))].join('\n');
}

/**
 * Whether the focused cell has nothing to copy: NULL, an empty string, or no cell there — ⌘C then copies nothing
 * and says nothing. Spaces are a value.
 */
export function blankAt(src: GridSource, at: { row: number; col: number }): boolean {
  const g = src.columns.find((c) => c.index === at.col);
  const v = g ? src.rows[at.row]?.[g.index]?.v : undefined;
  return v === undefined || v === null || v === '';
}

/** A JSON number as Postgres prints numbers (NaN, Infinity and money aren't). */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
/**
 * DEL and the C1 controls written as \u escapes: JSON allows them raw, but a paste sanitizer may
 * drop them. In JSON text they can only stand inside a string, so the escape changes no value — a JSON value printed by
 * Postgres included.
 */
const escapeC1 = (s: string) => s.replace(/[\u007f-\u009f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const jsonString = (s: string) => escapeC1(JSON.stringify(s));

/**
 * A value in Copy as JSON, as JSON text: NULL null, booleans true/false, numbers as Postgres printed them, json/jsonb
 * as they are (a value cut at 64 KB, no longer JSON, as its text), a JSON column's object or array as it is, anything
 * else a string of what one reads. Masked: the dots.
 */
function jsonValue(row: readonly DbCell[], g: GridColumn, o: FormatOpts): string {
  const cell = row[g.index];
  const v = raw(row, g, o);
  if (v === null) return 'null';
  if (isMasked(g.col, o)) return jsonString(MASK);
  const cls = typeClass(g.col);
  if (cls === 'bool' && (v === 't' || v === 'f')) return v === 't' ? 'true' : 'false';
  if (cls === 'number' && JSON_NUMBER.test(v)) return v;
  if (cell?.cut === undefined && isJson(g, v) && isJsonText(v)) return escapeC1(v.trim());
  return jsonString(cellText(v, g.col, o));
}

function jsonRow(row: readonly DbCell[], cols: readonly GridColumn[], o: FormatOpts, indent: string): string {
  if (cols.length === 0) return '{}';
  return `{\n${cols.map((g) => `${indent}  ${jsonString(g.label)}: ${jsonValue(row, g, o)}`).join(',\n')}\n${indent}}`;
}

/** Copy as JSON's object for row `i` as it stands inside its array. */
export const jsonObject = (src: GridSource, i: number, o: FormatOpts): string => jsonRow(src.rows[i]!, src.columns, o, '  ');
/** Copy as JSON's array of those objects (two spaces of indent). */
export const jsonArray = (objects: readonly string[]): string => (objects.length === 0 ? '[]' : `[\n${objects.map((x) => `  ${x}`).join(',\n')}\n]`);

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
// Backslashes first, so one before a pipe can't swallow the pipe's escape.
const mdCell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\n|\r/g, '<br>');
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** A value in an INSERT: NULL, true/false, a plain number as Postgres printed it, else a literal. */
function sqlValue(row: readonly DbCell[], g: GridColumn, o: FormatOpts): string {
  const v = raw(row, g, o);
  if (v === null) return 'NULL';
  if (isMasked(g.col, o)) return sqlString(MASK);
  const cls = typeClass(g.col);
  if (cls === 'bool' && (v === 't' || v === 'f')) return v === 't' ? 'true' : 'false';
  if (cls === 'number' && PLAIN_NUMBER.test(v)) return v;
  return sqlString(v);
}

/**
 * Copy Rows As, the selected rows in the grid's order: JSON (one row an object, more an array of them, two
 * spaces of indent), CSV (RFC 4180: CRLF, quoted when needed, NULL empty), Markdown (a table: pipes and backslashes
 * escaped, newlines as <br>, numbers right-aligned, NULL written), SQL INSERT (one statement per row into the table:
 * its columns and its hidden keys, never the JSON columns). Mask values on: every format carries the mask.
 */
export function rowsAs(src: GridSource, sel: readonly number[], fmt: CopyFormat, table: { schema: string; name: string }, o: FormatOpts): string {
  const rows = selected(src, sel);
  const cols = src.columns;
  switch (fmt) {
    case 'json':
      return rows.length === 1 ? jsonRow(rows[0]!, cols, o, '') : jsonArray(rows.map((r) => jsonRow(r, cols, o, '  ')));
    case 'csv': {
      const line = (cells: string[]) => `${cells.map(csvField).join(',')}\r\n`;
      return line(cols.map((g) => g.label)) + rows.map((r) => line(cols.map((g) => read(r, g, o)))).join('');
    }
    case 'markdown': {
      const line = (cells: string[]) => `| ${cells.join(' | ')} |\n`;
      return line(cols.map((g) => mdCell(g.label))) + line(cols.map((g) => (g.num ? '---:' : '---')))
        + rows.map((r) => line(cols.map((g) => (raw(r, g) === null ? 'NULL' : mdCell(read(r, g, o)))))).join('');
    }
    case 'insert': {
      const own = tableColumns(src);
      if (own.length === 0) return '';
      const head = `INSERT INTO ${quoteIdent(table.schema)}.${quoteIdent(table.name)} (${own.map((g) => quoteIdent(g.col.name)).join(', ')}) VALUES (`;
      return rows.map((r) => `${head}${own.map((g) => sqlValue(r, g, o)).join(', ')});`).join('\n');
    }
  }
}

/** How many values cut at 64 KB a copy of these rows carries: masked ones carry the dots instead. TSV: CSV's columns. */
export function cutCount(src: GridSource, sel: readonly number[], fmt: CopyFormat | 'tsv', o: FormatOpts): number {
  const cols = fmt === 'insert' ? tableColumns(src) : src.columns;
  let n = 0;
  for (const r of selected(src, sel)) {
    for (const g of cols) {
      const c = r[g.index];
      // What the copy wrote as dots (a masked column, a cut JSON value with the mask on) isn't cut in it.
      if (c?.cut !== undefined && c.v !== null && !isMasked(g.col, o) && !(o.masked && isJson(g, c.v, true))) n++;
    }
  }
  return n;
}

/**
 * Load full value's request for a cell: its column (a JSON column: its column and path) of the row its
 * row key names (the primary key, else a unique NOT NULL key). Null when the page has no row key or the
 * row's key holds a NULL.
 */
export function fullRequest(page: Pick<DbPage, 'columns' | 'rowKey'>, table: DbTableRef, row: readonly DbCell[], g: GridColumn): DbFullRequest | null {
  if (page.rowKey.length === 0) return null;
  const key: Record<string, string> = {};
  for (const name of page.rowKey) {
    const at = page.columns.findIndex((c) => c.name === name);
    const v = at < 0 ? null : row[at]?.v ?? null;
    if (v === null) return null;
    key[name] = v;
  }
  const ref = { connId: table.connId, schema: table.schema, name: table.name };
  return g.derived ? { ref, key, column: g.derived.column, path: [...g.derived.path] } : { ref, key, column: g.col.name };
}

/**
 * Copy Value: the value as one reads it; one main cut at 64 KB is read whole first (by the row's key, ≤ 16 MB,
 * through `full`), so the copy is never silently short. Masked values copy the dots and read nothing.
 */
export async function valueCopy(
  src: GridSource, page: Pick<DbPage, 'columns' | 'rowKey'>, table: DbTableRef, at: { row: number; col: number }, o: FormatOpts,
  full: (r: DbFullRequest) => Promise<DbResult<string>>
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const g = src.columns.find((c) => c.index === at.col);
  const row = src.rows[at.row];
  if (!g || !row) return { ok: true, text: '' };
  const cell = row[g.index];
  if (cell?.cut === undefined || cell.v === null || isMasked(g.col, o)) return { ok: true, text: read(row, g, o) };
  const req = fullRequest(page, table, row, g);
  if (!req) return { ok: false, message: tdt.grid.noKey };
  const r = await full(req);
  // Read whole: a JSON value is masked as the grid shows it.
  return r.ok ? { ok: true, text: cellText(o.masked && isJson(g, r.value) ? maskJson(r.value, true) : r.value, g.col, o) } : { ok: false, message: r.problem.message };
}

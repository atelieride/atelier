// The row inspector's pure parts: which columns label a row, the fields in
// grid order and "N more fields", Referenced by's counts, the row's primary key, every request built exactly as main's
// strict schemas take it (new objects, copied arrays — the tab's state is read-only), the FK peek card, the
// filters Open › and "N rows ›" open the other table with, the panel's width. No React, no DOM: Inspector.tsx draws
// them, inspector-data.ts reads. Lazy, with the table's chunk. Not `inspector.ts`: on a case-insensitive disk
// `./Inspector` would find it before Inspector.tsx (as grid-model.ts).
import type { DbCell, DbFk, DbFullRequest, DbPage, DbPeek, DbPeekRequest, DbRefCount, DbRefsRequest, DbTableRef } from '@shared/databases';
import { FILTER_VALUE_MAX, typeClass, type DbColumn, type DbFilter, type DbPath } from '@shared/databases-filters';
import { cellText, formatTimestamp, isMasked, type FormatOpts } from '@shared/pg-format';
import { tdt } from '../i18n/db-table';
import { rowsAs } from './grid-copy';
import { gridColumns, shortType } from './grid-model';
import type { DbTabState } from './store';

// ---------- the panel's width ----------

export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 560;
export const INSPECTOR_DEFAULT = 340;
/** The splitter's arrow keys move it by this much, as the app's other splitters (Resizer.tsx). */
export const RESIZE_STEP = 16;
/** The grid's usable width beside the inspector: below it the inspector goes over the grid instead of squeezing it. */
export const GRID_MIN = 320;

/** A width the panel takes: whole pixels within 280–560; anything unreadable is the default. */
export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return INSPECTOR_DEFAULT;
  return Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, Math.round(w)));
}

/** The splitter's keys (the panel is on the right): ← widens, → narrows, Home and End its bounds; null for any other key. */
export function resizeStep(key: string, width: number): number | null {
  switch (key) {
    case 'ArrowLeft': return clampWidth(width + RESIZE_STEP);
    case 'ArrowRight': return clampWidth(width - RESIZE_STEP);
    case 'Home': return INSPECTOR_MIN;
    case 'End': return INSPECTOR_MAX;
    default: return null;
  }
}

/**
 * Where the panel goes in a tab `paneW` wide: beside the grid while the grid keeps GRID_MIN — narrower than
 * asked, down to 280 px, before anything else —; else over the grid's right side (a floating panel), never wider than
 * the pane. Not measured yet (0: hidden): beside, as asked.
 */
export function inspectorLayout(paneW: number, width: number): { overlay: boolean; width: number } {
  if (paneW <= 0) return { overlay: false, width };
  const room = paneW - GRID_MIN;
  if (room >= INSPECTOR_MIN) return { overlay: false, width: Math.min(width, room) };
  return { overlay: true, width: Math.min(width, paneW) };
}

/**
 * How wide a drag or the splitter's keys may make the panel now: beside the grid, as far as the grid keeps GRID_MIN (it
 * never squeezes the grid); over it, the pane. Not measured yet: the bounds alone.
 */
export function widthCap(paneW: number, overlay: boolean): number {
  if (paneW <= 0) return INSPECTOR_MAX;
  return Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, overlay ? paneW : paneW - GRID_MIN));
}

// ---------- the row's label ----------

const LABEL_NAMES = ['name', 'title', 'full_name', 'display_name', 'label', 'email', 'username', 'slug', 'code'];

/** The label columns present, in LABEL_NAMES's order. */
const labelsOf = (cols: readonly DbColumn[]): DbColumn[] =>
  LABEL_NAMES.flatMap((n) => cols.filter((c) => c.name === n && !c.isArray));
const enumOf = (cols: readonly DbColumn[]): DbColumn | undefined => cols.find((c) => typeClass(c) === 'enum');

/**
 * What labels a row: the first present of name, title, full_name, display_name, label, email, username,
 * slug, code, then the first enum column — each once.
 */
export function labelColumns(cols: readonly DbColumn[]): string[] {
  const out: string[] = [];
  const first = labelsOf(cols)[0];
  if (first) out.push(first.name);
  const e = enumOf(cols);
  if (e && e.name !== first?.name) out.push(e.name);
  return out;
}

// ---------- the fields ----------

/**
 * The fields: the grid's columns in its order (all of them when none were chosen), then, folded under "N more
 * fields", the table's others in table order — a key kept only to name the row among them (it isn't in the grid).
 * `table`: the table's columns when known (the last read of every column); else the page's are all there is to name
 * until the hidden fields are read.
 */
export function fieldOrder(page: Pick<DbPage, 'columns' | 'hidden'>, visible: readonly string[] | null, table?: readonly DbColumn[] | null): { shown: string[]; more: string[] } {
  const own = page.columns.map((c) => c.name).filter((n) => !page.hidden.includes(n));
  const shown = visible === null ? own : visible.filter((n) => own.includes(n));
  const all = (table ?? page.columns).map((c) => c.name);
  return { shown, more: all.filter((n) => !shown.includes(n)) };
}

/**
 * One field: its column and its value; a JSON column has its path's type line and its column and
 * path (Load full value reads it by them).
 */
export interface Field { col: DbColumn; cell: DbCell; type?: string; derived?: { column: string; path: DbPath } }

/**
 * The JSON columns the grid shows: after the table's fields, named by their path ("metadata.
 * discount"), their type line the grid header's ("metadata → discount"), by their key in the grid.
 */
export function derivedFields(page: Pick<DbPage, 'columns' | 'hidden' | 'derived'>, cells: readonly DbCell[], schema: string): { key: string; name: string; field: Field }[] {
  return gridColumns(page, schema).flatMap((g) => (g.derived === null ? [] : [{
    key: g.key, name: g.label, field: { col: g.col, cell: cells[g.index] ?? { v: null }, type: g.type, derived: { column: g.derived.column, path: [...g.derived.path] } }
  }]));
}

/**
 * Load full value's request for a field: a column by its name, a JSON column by its
 * column and path (as grid-copy's fullRequest), of the row its key names. New objects and arrays.
 */
export function fullRequestOf(ref: DbTableRef, key: Record<string, string>, name: string, field: Field): DbFullRequest {
  const names = nameRef(ref);
  return field.derived ? { ref: names, key: { ...key }, column: field.derived.column, path: [...field.derived.path] } : { ref: names, key: { ...key }, column: name };
}

/**
 * Every field of the row known so far, by name: the page's (the grid's and the keys main added), then what the hidden
 * fields' read brought (this table's row by its primary key, every column).
 */
export function rowFields(page: Pick<DbPage, 'columns'>, cells: readonly DbCell[], read: DbPeek | null): Map<string, Field> {
  const out = new Map<string, Field>();
  page.columns.forEach((col, i) => out.set(col.name, { col, cell: cells[i] ?? { v: null } }));
  if (read?.row) read.columns.forEach((col, i) => { if (!out.has(col.name)) out.set(col.name, { col, cell: read.row![i] ?? { v: null } }); });
  return out;
}

/** A foreign key's table as the tab names it: with its schema when it's another one. */
export const tableName = (t: { schema: string; table: string }, schema: string): string => (t.schema === schema ? t.table : `${t.schema}.${t.table}`);

/**
 * A field's type line: Postgres's short type, then where a foreign key points ("int8 → customers") and
 * whether it is (part of) the primary key ("int8 · primary key").
 */
export function typeLine(col: DbColumn, schema: string): string {
  const fk = col.fk ? ` → ${tableName(col.fk, schema)}` : '';
  return `${shortType(col.type)}${fk}${col.isPk ? ` · ${tdt.insp.primary}` : ''}`;
}

/**
 * The whole row as JSON text (the JSON view): what Copy Row as JSON writes (grid-copy.ts: numbers and JSON
 * exactly as Postgres printed them, masks held) — every column the hidden fields' read brought when it is in, else the
 * page's.
 */
export function rowJsonText(page: Pick<DbPage, 'columns'>, cells: readonly DbCell[], read: DbPeek | null, table: { schema: string; name: string }, o: FormatOpts): string {
  const [columns, row] = read?.row ? [read.columns, read.row] : [page.columns, cells];
  return rowsAs({ columns: gridColumns({ columns, hidden: [], derived: [] }), rows: [row] }, [0], 'json', table, o);
}

// ---------- the row's key and the requests ----------

/** A value main's schemas take as a key value: loaded whole (not cut at 64 KB), at most 10,000 characters. */
const sendable = (c: DbCell | undefined): c is DbCell & { v: string } => !!c && c.v !== null && c.cut === undefined && c.v.length <= FILTER_VALUE_MAX;

/**
 * The row's key, by column name (Load full value, the hidden fields' read, the cache): the page's row key (the
 * primary key, else a unique NOT NULL key); null without one or when a value of it can't be sent (not loaded,
 * NULL, cut, too long).
 */
export function keyOf(page: Pick<DbPage, 'columns' | 'rowKey'>, cells: readonly DbCell[]): Record<string, string> | null {
  if (page.rowKey.length === 0) return null;
  const key: Record<string, string> = {};
  for (const name of page.rowKey) {
    const c = cells[page.columns.findIndex((x) => x.name === name)];
    if (!sendable(c)) return null;
    key[name] = c.v;
  }
  return key;
}

/** The row the inspector shows: the focused one, else the last selected; null for none, or one no longer loaded. */
export function shownRow(st: Pick<DbTabState, 'focus' | 'selection'> & { rows: readonly unknown[] }): number | null {
  const i = st.focus?.row ?? st.selection[st.selection.length - 1] ?? null;
  return i !== null && i >= 0 && i < st.rows.length ? i : null;
}

/** A row's place in the reads' cache: its row key's values, else its place among the rows loaded (per page). */
export function rowId(page: Pick<DbPage, 'columns' | 'rowKey'>, cells: readonly DbCell[], index: number): string {
  const key = keyOf(page, cells);
  return key ? JSON.stringify(key) : `#${index}`;
}

const nameRef = (r: DbTableRef): DbTableRef => ({ connId: r.connId, schema: r.schema, name: r.name });

/** How many columns a key names at most (main's IPC schema). */
const KEY_COLUMNS_MAX = 200;

/**
 * Referenced by: the row's value of every column an incoming foreign key could reference — any loaded one a
 * key could hold (NULL as null) — main reads those it needs. A value it can't take (cut, too long) is left out: main
 * leaves the foreign keys that need it uncounted (why: value), the others counted. A table wider than
 * main's 200 columns: the row's key and the keys main added to name the row first.
 */
export function refsRequest(ref: DbTableRef, page: Pick<DbPage, 'columns'> & Partial<Pick<DbPage, 'rowKey' | 'hidden'>>, cells: readonly DbCell[]): DbRefsRequest {
  const first = (n: string) => (page.rowKey?.includes(n) || page.hidden?.includes(n) ? 0 : 1);
  const order = page.columns.map((col, i) => ({ col, i })).sort((a, b) => first(a.col.name) - first(b.col.name));
  const key: Record<string, string | null> = {};
  let n = 0;
  for (const { col, i } of order) {
    if (n === KEY_COLUMNS_MAX) break;
    const c = cells[i];
    if (c && c.v === null) key[col.name] = null;
    else if (sendable(c)) key[col.name] = c.v;
    else continue;
    n++;
  }
  return { ref: nameRef(ref), key };
}

/** The foreign key a column belongs to (the first, as the catalog's own column.fk), or null. */
export function fkOf(column: string, out: readonly DbFk[]): DbFk | null {
  return out.find((fk) => fk.from.columns.includes(column)) ?? null;
}

/**
 * The FK peek: the row the foreign key points at — its table, its key columns, this row's values in the
 * key's order (a composite key whole). Null when the key isn't whole: a NULL in it (no reference), a value not read
 * yet, cut or too long.
 */
export function peekRequest(connId: string, fk: DbFk, valueOf: (column: string) => DbCell | undefined): DbPeekRequest | null {
  const values: string[] = [];
  for (const c of fk.from.columns) {
    const cell = valueOf(c);
    if (!sendable(cell)) return null;
    values.push(cell.v);
  }
  return { ref: { connId, schema: fk.to.schema, name: fk.to.table }, cols: [...fk.to.columns], values };
}

/** The hidden fields' read: this table's row by its row key, every column back. Null without a key. */
export function hiddenRequest(ref: DbTableRef, page: Pick<DbPage, 'columns' | 'rowKey'>, cells: readonly DbCell[]): DbPeekRequest | null {
  const key = keyOf(page, cells);
  if (!key) return null;
  // The row itself: main checks the key names one row.
  return { ref: nameRef(ref), cols: Object.keys(key), values: Object.values(key), row: true };
}

/** A key value main's schemas take (loaded whole, at most 10,000 characters), or null. */
const keyValue = (c: DbCell | undefined): string | null => (sendable(c) ? c.v : null);

/** Key parts, each [the other table's column, this side's column (its type), the value], when all are there. */
function whole(parts: (readonly [string, DbColumn | undefined, string | null])[]): DbFilter[] | null {
  if (parts.some(([, c, v]) => !c || v === null)) return null;
  return keyFilters(parts as (readonly [string, DbColumn, string])[]);
}

/**
 * Open › and Open Referenced Row: the referenced table filtered on its key columns equal to this row's
 * foreign key values (a composite key whole). Null for a key that isn't whole (a NULL: no reference) or no filter names.
 */
export function referencedFilters(fk: DbFk, fields: ReadonlyMap<string, Field>): DbFilter[] | null {
  return whole(fk.from.columns.map((c, i) => [fk.to.columns[i]!, fields.get(c)?.col, keyValue(fields.get(c)?.cell)] as const));
}

/** "N rows ›": the referencing table filtered on its foreign key columns equal to this row's key values. */
export function referencingFilters(fk: DbFk, fields: ReadonlyMap<string, Field>): DbFilter[] | null {
  return whole(fk.to.columns.map((c, i) => [fk.from.columns[i]!, fields.get(c)?.col, keyValue(fields.get(c)?.cell)] as const));
}

/**
 * The filters Open › and "N rows ›" open the other table with: per key column, the operator its type takes
 * for "is this value" — equals, an enum's "is any of", a time's "between" it and itself, a boolean's own; `type` is the
 * key column's on this side (a foreign key's columns have the same types on both). Null when a column of the key has
 * no such operator (JSON, an array): nothing opens on the wrong rows.
 */
export function keyFilters(parts: readonly (readonly [column: string, type: DbColumn, value: string])[]): DbFilter[] | null {
  const out: DbFilter[] = [];
  for (const [column, type, value] of parts) {
    switch (typeClass(type)) {
      case 'number': case 'text': case 'other': out.push({ column, op: 'eq', values: [value] }); break;
      case 'enum': out.push({ column, op: 'in', values: [value] }); break;
      case 'time': out.push({ column, op: 'between', values: [value, value] }); break;
      case 'bool': out.push({ column, op: value === 't' || value === 'true' ? 'true' : 'false', values: [] }); break;
      default: return null;
    }
  }
  return out;
}

// ---------- the FK peek card ----------

export interface PeekCard {
  /** The head: the label column's value (one line, ellipsized, its tooltip whole), else the key. */
  label: string;
  /** The enum column's value, tinted as the grid's enums (masked: no tint): a chip that never wraps. */
  chip: { text: string; tint: number | null } | null;
  /** The lines under it, one line each: the next label column's value, the table (and since when, if it says). */
  subs: string[];
  table: string;
}

const CREATED = ['created_at', 'inserted_at', 'created', 'created_on', 'createdAt', 'joined_at', 'signed_up_at'];

/** The card of the row a foreign key points at; null when there's none (the card says so). Masked as the grid. */
export function peekCard(peek: DbPeek, fk: DbFk, schema: string, o: FormatOpts): PeekCard | null {
  const row = peek.row;
  if (!row) return null;
  const at = (name: string) => peek.columns.findIndex((c) => c.name === name);
  const text = (c: DbColumn) => cellText(row[peek.columns.indexOf(c)]?.v ?? null, c, o);
  const labels = labelsOf(peek.columns).filter((c) => row[peek.columns.indexOf(c)]?.v != null);
  const table = tableName({ schema: fk.to.schema, table: fk.to.table }, schema);
  const keyText = fk.to.columns.map((c) => {
    const kc = peek.columns[at(c)];
    return kc ? `${c} ${cellText(row[at(c)]?.v ?? null, kc, o)}` : c;
  }).join(' · ');
  const e = enumOf(peek.columns);
  const ev = e ? row[peek.columns.indexOf(e)]?.v ?? null : null;
  // A masked enum's chip: dots in a neutral tint (its tint would tell the value).
  const chip = e && ev !== null ? { text: cellText(ev, e, o), tint: isMasked(e, o) ? null : Math.max(0, e.enumValues?.indexOf(ev) ?? 0) % 8 } : null;
  const created = CREATED.map((n) => peek.columns.find((c) => c.name === n && typeClass(c) === 'time')).find((c) => c && row[peek.columns.indexOf(c)]?.v);
  const since = created ? sinceOf(row[peek.columns.indexOf(created)]!.v!, created, o) : null;
  const subs = [
    ...(labels[1] ? [text(labels[1])] : []),
    since ? `${table} · ${tdt.insp.peek.since(since)}` : table
  ];
  return { label: labels[0] ? text(labels[0]) : keyText, chip, subs, table };
}

/** A creation time's date, per Settings › Times in (masked: the dots). */
function sinceOf(raw: string, c: DbColumn, o: FormatOpts): string {
  if (isMasked(c, o) || c.typeName === 'date') return cellText(raw, c, o);
  return formatTimestamp(raw, c.typeName === 'timestamptz' ? 'timestamptz' : 'timestamp', o).text.slice(0, 10);
}

// ---------- Referenced by ----------

/** A count as Referenced by says it: "none", "1 row", "3 rows", "1,000+ rows" (main counts up to 1001). */
export function refLabel(count: number): string {
  const r = tdt.insp.refs;
  if (count <= 0) return r.none;
  if (count === 1) return r.one;
  if (count > 1000) return r.capped;
  return r.many(count.toLocaleString('en-US'));
}

export interface RefRow {
  table: string;
  /** The referencing columns, after the table: ".order_id", ".(item_line, item_order)". */
  cols: string;
  /** "3 rows ›"; "none" (nothing to open); "Open ›" when not counted; why it can't count a value too long to send. */
  label: string;
  open: boolean;
  /** What opens, why there's no number, or — nothing to open — its name whole. */
  tip: string;
}

export function refRow(rc: DbRefCount, schema: string): RefRow {
  const cols = rc.fk.from.columns;
  const r = tdt.insp.refs;
  const table = tableName({ schema: rc.fk.from.schema, table: rc.fk.from.table }, schema);
  const base = { table, cols: cols.length === 1 ? `.${cols[0]}` : `.(${cols.join(', ')})` };
  const name = `${base.table}${base.cols}`;
  if (rc.count === null) {
    if (rc.why === 'value') return { ...base, label: r.tooLong, open: false, tip: name };
    return { ...base, label: r.open, open: true, tip: rc.why ? r.why[rc.why] : r.openTip(table) };
  }
  if (rc.count === 0) return { ...base, label: refLabel(0), open: false, tip: name };
  return { ...base, label: `${refLabel(rc.count)} ›`, open: true, tip: r.openTip(table) };
}

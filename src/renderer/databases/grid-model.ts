// The data grid's pure parts: which columns show and how their
// header reads, what a cell shows, the widths (one measure of what a cell shows, for first widths and fits), the sort
// a header click makes, the rows a click or a key selects, the rows on screen, how many chips a width holds, the cell
// menu. No React, no DOM: Grid.tsx and Cell.tsx draw them; the copies are grid-copy.ts's, JSON's text json-text.ts's.
// Lazy, with the table's chunk. Not `grid.ts`: on a case-insensitive disk `./Grid` would find it before Grid.tsx.
import type { DbCell, DbPage } from '@shared/databases';
import { typeClass, type DbColumn, type DbDerived, type DbPath, type DbSort } from '@shared/databases-filters';
import { formatCell, isMasked, MASK, type CellView, type FormatOpts } from '@shared/pg-format';
import { pathLabel, pathText } from '@shared/pg-json';
import { tdt } from '../i18n/db-table';
import { kbd } from '../kbd';
import type { MenuItem } from '../menu-model';
import { COPY_FORMATS, type CopyFormat } from './grid-copy';
import { isJsonText, looksJsonContainer, maskJson } from './json-text';

/** A row's height: one line. */
export const ROW_H = 30;
/** Wrap Cells: every row six lines of 18 px, its padding and its border — fixed, so nothing is measured. */
export const WRAP_ROW_H = 6 * 18 + 12;
export const HEAD_H = 44;
export const OVERSCAN = 8;
/** The row numbers' column: room for 10,000 (the cap), so it never widens as rows load. */
export const RN_W = 52;
/**
 * The action bar's room at the grid's foot (selbar.css): its 28 px buttons, 6 px of padding above and below,
 * 12 px off the bottom, 4 to spare. The rows always end with it and a row brought into view stops above it.
 */
export const BAR_ROOM = 56;
export const MIN_W = 64;
export const MAX_W = 420;
/** A double click on a header's edge fits the loaded values, up to this. */
export const FIT_MAX_W = 800;

export interface GridColumn {
  /** Dragged widths and React keys: the column's name; a JSON column's, its column and path. */
  key: string;
  /** Where its value is in a row's cells (main's order: the columns, then the JSON columns). */
  index: number;
  /** The header's name: the column's, a JSON column's last key. */
  name: string;
  /** Its name in copies (JSON keys, CSV and Markdown headers): a JSON column's whole path. */
  label: string;
  /** The header's type line: Postgres's short name, a foreign key's target ("int8 → customers"), a JSON column's path. */
  type: string;
  /** The header's tooltip: the whole name and Postgres's own words for the type. */
  tip: string;
  /** What formats and masks its values. A JSON column's is text named by its column and path: a mask on either holds. */
  col: DbColumn;
  derived: DbDerived | null;
  num: boolean;
}

// The SQL standard's names format_type() prints, in the short ones Postgres also takes ("int8", "timestamptz").
const SHORT_TYPES: readonly [RegExp, string][] = [
  [/^timestamp(\(\d+\))? with time zone/, 'timestamptz$1'],
  [/^timestamp(\(\d+\))? without time zone/, 'timestamp$1'],
  [/^time(\(\d+\))? with time zone/, 'timetz$1'],
  [/^time(\(\d+\))? without time zone/, 'time$1'],
  [/^character varying(?=$|\(|\[)/, 'varchar'],
  [/^character(?=$|\(|\[)/, 'char'],
  [/^bit varying(?=$|\(|\[)/, 'varbit'],
  [/^double precision(?=$|\[)/, 'float8'],
  [/^bigint(?=$|\[)/, 'int8'],
  [/^integer(?=$|\[)/, 'int4'],
  [/^smallint(?=$|\[)/, 'int2'],
  [/^boolean(?=$|\[)/, 'bool'],
  [/^real(?=$|\[)/, 'float4']
];

export function shortType(type: string): string {
  for (const [re, to] of SHORT_TYPES) if (re.test(type)) return type.replace(re, to);
  return type;
}

const textColumn = (name: string): DbColumn => ({
  name, type: 'text', typeSchema: 'pg_catalog', typeName: 'text', typeCat: 'S', isArray: false, nullable: true, isPk: false, isKey: false
});

function ownColumn(col: DbColumn, index: number, schema?: string): GridColumn {
  const fk = col.fk ? ` → ${schema === undefined || col.fk.schema === schema ? col.fk.table : `${col.fk.schema}.${col.fk.table}`}` : '';
  return {
    key: col.name, index, name: col.name, label: col.name, type: `${shortType(col.type)}${fk}`, tip: `${col.name} · ${col.type}${fk}`,
    col, derived: null, num: typeClass(col) === 'number'
  };
}

/**
 * The columns the grid shows, by the index of each value in a row: the selected ones in order (not those main added
 * only to name the row, `hidden`), then the JSON columns. `schema`: the tab's, so a foreign key into
 * another schema names it.
 */
export function gridColumns(page: Pick<DbPage, 'columns' | 'hidden' | 'derived'>, schema?: string): GridColumn[] {
  const out: GridColumn[] = [];
  page.columns.forEach((col, index) => { if (!page.hidden.includes(col.name)) out.push(ownColumn(col, index, schema)); });
  page.derived.forEach((d, j) => {
    const path = pathText(d.path);
    const label = `${d.column}${path.startsWith('[') ? '' : '.'}${path}`;
    const name = pathLabel(d.path) || d.column;
    const type = `${d.column} → ${path}`;
    out.push({
      key: JSON.stringify([d.column, d.path]), index: page.columns.length + j, name, label, type, tip: `${name} · ${type}`,
      col: textColumn(label), derived: { column: d.column, path: [...d.path] }, num: false
    });
  });
  return out;
}

/** The columns main loaded only to name the row (its keys, `hidden`): SQL INSERT carries them. */
export function hiddenColumns(page: Pick<DbPage, 'columns' | 'hidden'>, schema?: string): GridColumn[] {
  return page.columns.flatMap((col, index) => (page.hidden.includes(col.name) ? [ownColumn(col, index, schema)] : []));
}

/**
 * What a grid cell shows: formatCell's view of the value; JSON — a json/jsonb column's, and a JSON column's
 * text holding an object or an array — as its text, never parsed (the preview reads it); masked all the same
 * when its column or a key on its path asks for it. `cut`: the value's whole length when main cut it (DbCell.cut).
 */
export function cellView(v: string | null, g: GridColumn, o: FormatOpts, cut?: number): CellView {
  // Mask values on: a secret key's value inside it as dots, a value cut at 64 KB (no longer JSON) dots whole.
  if (v !== null && !isMasked(g.col, o) && typeClass(g.col) === 'json') return { k: 'json', value: undefined, raw: maskJson(v, o.masked) };
  const view = formatCell(v, g.col, o, cut);
  if (g.derived === null || view.k !== 'text' || !looksJsonContainer(view.text)) return view;
  if (isJsonText(view.text)) return { k: 'json', value: undefined, raw: maskJson(view.text, o.masked) };
  // A JSON column's object or array cut at 64 KB (`cut`): no key to mask it by — with the mask on, dots whole.
  return cut !== undefined && o.masked ? { k: 'masked' } : view;
}

/**
 * Whether the focused row moved from outside the grid: the inspector's ↑/↓, a row picked on opening — the
 * grid scrolls to it and puts its Shift anchor there —, never one the grid moved itself (a click, a right-click, its
 * keys: `own`, the row it focused last), which stays where it is (static UI).
 */
export const focusMovedOutside = (next: number | null, own: number | null): boolean => next !== null && next !== own;

/** A UUID's tail as the grid folds it: "-…-" and the last group; anything else as it is. */
export function uuidTail(tail: string): string {
  const m = /^-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})$/i.exec(tail);
  return m ? `-…-${m[1]}` : tail;
}

// ---------- widths ----------

/**
 * A character of the grid's 12 px mono, a cell's box around its value — padding 10 + 10 and its 1 px border-right (the
 * e2e found that without the border, a column's widest value ended in an ellipsis, "158.…") —, a header name's character (600
 * 12 px sans), the 11 px sans.
 */
const CH = 7.2;
const PAD = 21;
const HEAD_CH = 7.4;
const SANS = 6.2;
/** The foreign-key arrow after a value: its gap and its icon. */
const FK_W = 17;
/** A masked value's dot: a character and its .14em letter-spacing. */
const DOT_W = CH + 1.68;

/** A chip's words: an array item's text, or a lexeme's word and its position (drawn 4 px after it). */
export type ChipText = string | { text: string; pos?: string };
/** A chip of 10.5 px mono: its characters, its padding and the gap after it; a lexeme's position its own 4 px gap. */
const chipWidth = (c: ChipText) => {
  const s = typeof c === 'string' ? c : c.text + (c.pos ?? '');
  return Math.min(s.length, 40) * 6.3 + 16 + (typeof c !== 'string' && c.pos ? 4 : 0);
};

/**
 * How wide a cell's content is as Cell.tsx draws it (text up to `cap` characters): grouped numbers, the mask's spaced
 * dots, a folded UUID, chips, a time with its age. The one measure of first widths and fits.
 */
function viewWidth(v: CellView, cap: number): number {
  const text = (s: string) => Math.min(s.length, cap) * CH;
  switch (v.k) {
    case 'null': return 38;
    case 'empty': return 44;
    case 'blank': return Math.min(3, v.count) * CH + 6 + tdt.grid.spaces(v.count).length * SANS;
    case 'masked': return MASK.length * DOT_W;
    case 'num': return text(v.text);
    case 'bool': return 14 + (v.on ? 4 : 5) * 6.9;
    // Room for the longest relative age ("yesterday") whenever there is one: ages change, the column doesn't.
    case 'time': return text(v.text) + (v.rel ? 8 + 9 * SANS : 0);
    case 'uuid': return (v.head.length + uuidTail(v.tail).length) * CH;
    case 'json': return text(v.raw);
    case 'array': return v.items.slice(0, 4).reduce((w, x) => w + chipWidth(x ?? 'NULL'), 0) + (v.items.length > 4 ? 30 : 0);
    case 'lexemes': return v.items.slice(0, 4).reduce((w, x) => w + chipWidth({ text: x.word, pos: x.pos }), 0) + (v.items.length > 4 ? 30 : 0);
    case 'enum': return Math.min(v.text.length, cap) * 6.6 + 16;
    case 'bytes': return (v.head.length + 3) * CH + (v.mime ? chipWidth(mimeLabel(v.mime)) + 6 : 0) + 6 + bytesLabel(v.size).length * SANS;
    case 'range': case 'geo': case 'text': return text(v.text);
  }
}

/** The values' need: the widest shown, a foreign key's arrow counted. */
function bodyWidth(views: readonly CellView[], fk: boolean, cap: number): number {
  let w = 0;
  for (const v of views) w = Math.max(w, viewWidth(v, cap) + (fk && v.k !== 'null' && v.k !== 'masked' ? FK_W : 0));
  return w;
}

/**
 * The header button's box, as table.css draws it (.dbt-th-btn, .dbt-th-line: keep them in step): its padding 10 + 14, an
 * icon (PK, FK, sort arrow: 12 px) and the 5 px gap before it, a second sort key's digit.
 */
const HEAD_PAD = 24;
const HEAD_ICON = 17;
const SORT_DIGIT = 7;

/**
 * The header's need: the name, its icons and the sort arrow (always reserved, so sorting a short column never cuts its
 * name: "id" was "i…"); long names ellipsize past 240 px (their tooltip has them whole).
 */
function headWidth(c: DbColumn): number {
  return Math.min(240, c.name.length * HEAD_CH + HEAD_PAD + (c.isPk ? HEAD_ICON : 0) + (c.fk ? HEAD_ICON : 0) + HEAD_ICON + SORT_DIGIT);
}

// Rounded up: a fraction of a pixel short is enough for the ellipsis.
const clamp = (w: number, max: number) => Math.max(MIN_W, Math.min(max, Math.ceil(w)));
/** A JSON column starts wide enough to read its preview, whatever its first values. */
const floorOf = (c: DbColumn) => (typeClass(c) === 'json' ? 280 : 0);
const BASE: FormatOpts = { times: 'stored', now: 0, masked: false, width: 'grid' };
const SAMPLE = 200;

/** A column's first width (64–420 px): its header's need or what its first values show (60 characters at most). */
export function initialWidth(c: DbColumn, sample: readonly (string | null)[], o: FormatOpts = BASE): number {
  const g = ownColumn(c, 0);
  const views = sample.slice(0, SAMPLE).map((v) => cellView(v ?? null, g, o));
  return clamp(Math.max(headWidth(c), floorOf(c), bodyWidth(views, !!c.fk, 60) + PAD), MAX_W);
}

function firstWidth(g: GridColumn, rows: readonly (readonly DbCell[])[], o: FormatOpts): number {
  const views = rows.slice(0, SAMPLE).map((r) => cellView(r[g.index]?.v ?? null, g, o, r[g.index]?.cut));
  return clamp(Math.max(headWidth(g.col), floorOf(g.col), bodyWidth(views, !!g.col.fk, 60) + PAD), MAX_W);
}

/**
 * First widths, once per tab and column: a column seen before keeps the width it had (`known`); only
 * the others are measured, from these rows, and returned as `added` (null when none) for the tab to keep.
 */
export function firstWidths(cols: readonly GridColumn[], rows: readonly (readonly DbCell[])[], known: Readonly<Record<string, number>>, o: FormatOpts): { widths: number[]; added: Record<string, number> | null } {
  let added: Record<string, number> | null = null;
  const widths = cols.map((g) => {
    const seen = known[g.key];
    if (seen !== undefined) return seen;
    const w = firstWidth(g, rows, o);
    (added ??= {})[g.key] = w;
    return w;
  });
  return { widths, added };
}

/** A double click on the edge: as wide as the loaded values show (the first 2,000 rows, 120 characters), 64–800 px. */
export function fitWidth(g: GridColumn, rows: readonly (readonly DbCell[])[], o: FormatOpts): number {
  const views = rows.slice(0, 2000).map((r) => cellView(r[g.index]?.v ?? null, g, o, r[g.index]?.cut));
  return clamp(Math.max(headWidth(g.col), bodyWidth(views, !!g.col.fk, 120) + PAD), FIT_MAX_W);
}

// ---------- sort ----------

const samePath = (a: DbPath | undefined, b: DbPath | undefined) => (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((p, i) => p === b![i]);
const entry = (column: string, dir: DbSort['dir'], path?: DbPath): DbSort => (path && path.length > 0 ? { column, path: [...path], dir } : { column, dir });
const copySort = (s: DbSort): DbSort => entry(s.column, s.dir, s.path);

/** Where a column (a JSON column: by its path) is in the sort, and which way; null when it isn't. */
export function sortOf(sort: readonly DbSort[], column: string, path?: DbPath): { at: number; dir: DbSort['dir'] } | null {
  const at = sort.findIndex((s) => s.column === column && samePath(s.path, path));
  return at < 0 ? null : { at, dir: sort[at]!.dir };
}

/**
 * A header click: ascending → descending → off, that column alone; Shift appends it as a secondary sort,
 * then cycles it in its place, then takes it out. A new array: the tab's state is frozen.
 */
export function nextSort(sort: readonly DbSort[], column: string, shift: boolean, path?: DbPath): DbSort[] {
  const cur = sortOf(sort, column, path);
  const next: DbSort['dir'] | null = cur === null ? 'asc' : cur.dir === 'asc' ? 'desc' : null;
  if (!shift) return next ? [entry(column, next, path)] : [];
  if (cur === null) return [...sort.map(copySort), entry(column, 'asc', path)];
  return sort.flatMap((s, i) => (i !== cur.at ? [copySort(s)] : next ? [entry(column, next, path)] : []));
}

// ---------- selection and the keyboard ----------

/** Every row from a to b, both included, in order. */
export function rangeOf(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  return Array.from({ length: Math.abs(a - b) + 1 }, (_, k) => lo + k);
}

const ascending = (sel: Iterable<number>): number[] => [...new Set(sel)].sort((x, y) => x - y);

/**
 * The rows a click leaves selected: a click, that row; ⌘-click toggles it; Shift-click, the range from
 * the anchor (the last row clicked without Shift); ⌘⇧-click adds that range. In order.
 */
export function selectRow(sel: readonly number[], i: number, mod: { meta: boolean; shift: boolean }, anchor: number | null): number[] {
  if (mod.shift) {
    const range = rangeOf(anchor ?? i, i);
    return mod.meta ? ascending([...sel, ...range]) : range;
  }
  if (mod.meta) return sel.includes(i) ? sel.filter((x) => x !== i) : ascending([...sel, i]);
  return [i];
}

/** What the keyboard reads: the rows loaded, the selection, the focused cell, the anchor, the first column's index. */
export interface GridKeyState {
  count: number;
  selection: readonly number[];
  focus: { row: number; col: number } | null;
  anchor: number | null;
  firstCol: number;
}
export type GridKeyAction =
  /** `reveal`: the row to scroll into view (none for ⌘A: the view stays where it is). */
  | { kind: 'select'; selection: number[]; focus: { row: number; col: number }; anchor: number; reveal: number | null }
  | { kind: 'clear' } | { kind: 'inspector' } | { kind: 'copy' } | { kind: 'wrap' }
  /** Tab: this row as a record — a record view, in the rows' place. */
  | { kind: 'record'; row: number }
  /** ⌥↩: these rows to the session — the selected ones, or the focused one. */
  | { kind: 'send'; rows: number[] };

/**
 * Whether a key is the grid's: it reached the grid itself. A control inside it (the bottom row's Retry, later a link)
 * keeps its own keys — Enter presses Retry, never the inspector.
 */
export const ownKey = (target: unknown, grid: unknown): boolean => target !== null && target === grid;

/**
 * A key in the grid: ↑/↓ move the focused row and the selection with it (from nothing: the first or the
 * last row), Shift extends from the anchor; ⌘A every row loaded; Esc clears what is selected; Enter shows or hides the
 * inspector; Tab opens the focused row as a record (it used to move the keyboard
 * to the inspector); ⌘C copies; ⌥Z wraps cells (`wrapKey`: word-wrap.ts's reading of the layout); ⌥↩ sends the
 * selected rows, or the focused one, to the session. Anything else — other chords, letters, Esc with nothing
 * to clear, Tab with no row focused, ⌥↩ with nothing to send — is null: the app's (or the browser's: Shift+Tab, Tab
 * without a row, move the keyboard as usual).
 */
export function gridKey(k: { key: string; code: string; mod: boolean; shift: boolean; alt: boolean; ctrl: boolean; wrapKey: boolean }, s: GridKeyState): GridKeyAction | null {
  if (k.wrapKey) return { kind: 'wrap' };
  const letter = k.key.toLowerCase();
  if (k.mod) {
    if (k.shift || k.alt) return null;
    if (k.code === 'KeyA' || letter === 'a') {
      if (s.count === 0) return null;
      const focus = s.focus ?? { row: 0, col: s.firstCol };
      return { kind: 'select', selection: rangeOf(0, s.count - 1), focus, anchor: s.anchor ?? focus.row, reveal: null };
    }
    return k.code === 'KeyC' || letter === 'c' ? { kind: 'copy' } : null;
  }
  // ⌥↩ alone: ⌃⌥↩ is another chord (`ctrl`: the Control key, apart from ⌘ on macOS), as RedisView reads it.
  if (k.alt && !k.shift && !k.ctrl && k.key === 'Enter') {
    const rows = s.selection.length > 0 ? [...s.selection] : s.focus ? [s.focus.row] : [];
    return rows.length > 0 ? { kind: 'send', rows } : null;
  }
  if (k.alt) return null;
  if (k.key === 'Tab') {
    const row = s.focus?.row ?? -1;
    return !k.shift && !k.ctrl && row >= 0 && row < s.count ? { kind: 'record', row } : null;
  }
  if (k.key === 'ArrowDown' || k.key === 'ArrowUp') {
    if (s.count === 0) return null;
    const down = k.key === 'ArrowDown';
    const from = s.focus?.row ?? (down ? -1 : s.count);
    const to = Math.max(0, Math.min(s.count - 1, from + (down ? 1 : -1)));
    const focus = { row: to, col: s.focus?.col ?? s.firstCol };
    if (!k.shift) return { kind: 'select', selection: [to], focus, anchor: to, reveal: to };
    const anchor = s.anchor ?? s.focus?.row ?? to;
    return { kind: 'select', selection: rangeOf(anchor, to), focus, anchor, reveal: to };
  }
  if (k.key === 'Escape') return s.selection.length > 0 || s.focus !== null ? { kind: 'clear' } : null;
  if (k.key === 'Enter' && !k.shift) return { kind: 'inspector' };
  return null;
}

/**
 * Where to scroll so row `row` is in view (null: it is, nothing moves — static UI): above the view, just under the
 * sticky header; below it, its bottom edge at the viewport's foot less `bottomInset` (the action bar's room, BAR_ROOM),
 * so a row reached by ↓, Shift+F10 or from outside never lies under the bar. A viewport too short for the room still
 * shows the row under the header.
 */
export function revealTop(row: number, rowH: number, scrollTop: number, clientHeight: number, bottomInset: number): number | null {
  if (row * rowH < scrollTop) return row * rowH;
  const foot = Math.max(HEAD_H + rowH, clientHeight - bottomInset);
  const bottom = HEAD_H + (row + 1) * rowH;
  return bottom > scrollTop + foot ? bottom - foot : null;
}

/**
 * The cell Shift+F10 opens a menu for: the focused one; none focused, the first row wholly under the header, its
 * first column. Null only without rows.
 */
export function menuCell(focus: { row: number; col: number } | null, scrollTop: number, rowH: number, count: number, firstCol: number): { row: number; col: number } | null {
  if (focus) return focus;
  if (count === 0) return null;
  return { row: Math.max(0, Math.min(count - 1, Math.ceil(scrollTop / rowH))), col: firstCol };
}

/**
 * Where Shift+F10's menu opens, in the grid's own coordinates: under the left part of the cell (column `k` of the
 * shown widths, row `row`), from the widths and the scroll alone — the row needn't be drawn yet — kept inside the grid
 * when the column is scrolled out of sight.
 */
export function menuPoint(a: { row: number; k: number; widths: readonly number[]; rowH: number; scrollTop: number; scrollLeft: number; viewW: number; viewH: number }): { x: number; y: number } {
  const left = RN_W + a.widths.slice(0, a.k).reduce((s, w) => s + w, 0) - a.scrollLeft;
  const x = Math.max(RN_W, Math.min(a.viewW - 8, left + Math.min(24, (a.widths[a.k] ?? 0) / 2)));
  const y = Math.max(HEAD_H, Math.min(a.viewH - 4, HEAD_H + (a.row + 1) * a.rowH - a.scrollTop - 4));
  return { x, y };
}

// ---------- the rows on screen ----------

/**
 * The rows to put in the DOM: those within the viewport — `scrollTop` and `viewport` measured from the
 * first row, under the sticky header — and `overscan` more on each side, within the rows loaded. `last` is exclusive.
 */
export function visibleRange(scrollTop: number, viewport: number, rowH: number, count: number, overscan = OVERSCAN): { first: number; last: number } {
  if (count <= 0) return { first: 0, last: 0 };
  const top = Math.max(0, scrollTop);
  const last = Math.min(count, Math.ceil((top + Math.max(0, viewport)) / rowH) + overscan);
  const first = Math.max(0, Math.min(count, Math.floor(top / rowH)) - overscan);
  return { first: Math.min(first, last), last };
}

// ---------- chips, bytes ----------

/**
 * How many chips (array items, lexemes) a cell of `width` shows before "+N" (at least one): the "+N" chip's room
 * measured as it will read ("+197" is wider than "+3").
 */
export function chipsThatFit(items: readonly ChipText[], width: number): number {
  if (items.length === 0) return 0;
  const room = width - PAD;
  const widths = items.map(chipWidth);
  if (widths.reduce((a, b) => a + b, 0) <= room) return items.length;
  let used = 0;
  let n = 0;
  for (const w of widths) {
    if (used + w + chipWidth(`+${items.length - n - 1}`) > room) break;
    used += w;
    n++;
  }
  return Math.max(1, n);
}

/** A size in bytes as people read it: "312 B", "24 KB", "1.2 MB". */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
}

const MIME_LABELS: Record<string, string> = {
  'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'application/pdf': 'PDF', 'application/gzip': 'gzip',
  'application/zip': 'zip'
};
export const mimeLabel = (mime: string): string => MIME_LABELS[mime] ?? mime;

// ---------- the cell menu ----------

/**
 * What the cell menu does. The later tasks' items show only when given: Filter by / Exclude This Value,
 * Open Referenced Row, Open in JSON View, Send to <session> and Ask in a New Session.
 */
export interface CellMenuActions {
  copyValue(): void;
  copyRow(): void;
  copyAs(fmt: CopyFormat): void;
  wrap(): void;
  filterBy?: () => void;
  exclude?: () => void;
  openRef?: () => void;
  openJson?: () => void;
  /** `label`: the target session's title; null with none (the press says why, as Docker's and Redis's sends do). */
  sendTo?: { label: string | null; run(): void };
  askNew?: () => void;
  /** The cell's column menu: the header's, reached from the keyboard. */
  columnMenu?: () => void;
}

/**
 * Whether a cell opens in the JSON view (Open in JSON View, a double click): a json/jsonb value —
 * one cut at 64 KB too, the view reads it whole —, or a JSON column's object or array.
 */
export function jsonCell(g: Pick<GridColumn, 'col' | 'derived'>, cell: DbCell | undefined): boolean {
  if (!cell || cell.v === null) return false;
  if (g.derived === null) return typeClass(g.col) === 'json';
  return looksJsonContainer(cell.v);
}

/** A cell's menu: `rows` selected (the cell's row among them), the tab's Wrap Cells, whether it holds JSON. */
export function cellMenu(ctx: { rows: number; wrap: boolean; json: boolean }, act: CellMenuActions): MenuItem[] {
  const m = tdt.grid.menu;
  const items: MenuItem[] = [
    { id: 'copy-value', label: m.copyValue, icon: 'copy', ...(ctx.rows <= 1 ? { hint: kbd('⌘C') } : {}), run: act.copyValue },
    { id: 'copy-row', label: m.copyRow, run: act.copyRow },
    { id: 'copy-as', label: m.copyAs(ctx.rows), submenu: COPY_FORMATS.map((f): MenuItem => ({ id: `copy-as-${f}`, label: m.formats[f], run: () => act.copyAs(f) })), run: () => {} }
  ];
  const values: MenuItem[] = [];
  if (act.filterBy) values.push({ id: 'filter-by', label: m.filterBy, icon: 'filter', run: act.filterBy });
  if (act.exclude) values.push({ id: 'exclude', label: m.exclude, run: act.exclude });
  if (act.openRef) values.push({ id: 'open-ref', label: m.openRef, icon: 'fkArrow', run: act.openRef });
  if (act.openJson && ctx.json) values.push({ id: 'open-json', label: m.openJson, icon: 'tree', run: act.openJson });
  if (values.length > 0) items.push('sep', ...values);
  const sessions: MenuItem[] = [];
  if (act.sendTo) sessions.push({ id: 'send-to', label: act.sendTo.label === null ? m.sendNone : m.sendTo(act.sendTo.label), icon: 'send', run: act.sendTo.run });
  if (act.askNew) sessions.push({ id: 'ask-new', label: m.askNew, icon: 'sparkle', run: act.askNew });
  if (sessions.length > 0) items.push('sep', ...sessions);
  items.push('sep');
  if (act.columnMenu) items.push({ id: 'column-menu', label: m.columnMenu, run: act.columnMenu });
  items.push({ id: 'wrap', label: m.wrap, checked: ctx.wrap, hint: kbd('⌥Z'), run: act.wrap });
  return items;
}

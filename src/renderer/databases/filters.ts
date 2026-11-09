// Filters and columns, the pure part the filter bar, its
// popover, the Columns chip and the cell menu share: the list's edits, the value editor each operator takes, Filter by /
// Exclude This Value, the chips' words (a masked value as dots), JSON paths typed as text, the popover's draft checked
// as main checks it (Apply never sends what main would refuse: a refusal would be an error card), an enum's checklist,
// the Columns chip's choice. The layout math: filter-layout.ts; the actions and the open popover: filter-actions.ts.
// Lazy, with the table's chunk.
import type { DbCell } from '@shared/databases';
import {
  arity, FILTER_VALUE_MAX, FILTER_VALUES_MAX, FILTERS_MAX, filterChip, INTEGER_TYPES, NUMBER_RE, opLabel, opsFor, PATH_INDEX_MAX, PATH_KEY_MAX,
  PATH_KEYS_MAX, typeClass, validFilter, type DbColumn, type DbDerived, type DbFilter, type DbFilterOp, type DbPath, type DbTypeClass
} from '@shared/databases-filters';
import { MASK, MASK_COLUMN } from '@shared/pg-format';
import { pathText } from '@shared/pg-json';
import { tdt } from '../i18n/db-table';
import { shortType } from './grid-model';
import type { DbTabState } from './store';

const tf = tdt.filters;

/** Main's IPC schema takes this many filters at most (shared with it). */
export const MAX_FILTERS = FILTERS_MAX;

// ---------- the list ----------

/** A filter as main's strict schema takes it: key for key, a path only when there is one, copies of the arrays. */
export function copyFilter(f: DbFilter): DbFilter {
  return { column: f.column, ...(f.path && f.path.length > 0 ? { path: [...f.path] } : {}), op: f.op, values: [...f.values] };
}

const samePath = (a?: DbPath, b?: DbPath) => (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((p, i) => p === b![i]);

function sameValues(op: DbFilterOp, a: readonly string[], b: readonly string[]): boolean {
  if (op !== 'in' && op !== 'notin') return a.length === b.length && a.every((v, i) => v === b[i]);
  const s = new Set(a);
  return s.size === new Set(b).size && b.every((v) => s.has(v));
}

/** The same filter: column, path, operator, values (an `is any of` in any order). */
export function sameFilter(a: DbFilter, b: DbFilter): boolean {
  return a.column === b.column && a.op === b.op && samePath(a.path, b.path) && sameValues(a.op, a.values, b.values);
}

/** A filter added at the end (a copy); the list itself back when it is there already or main's 30 are reached. */
export function addFilter(list: readonly DbFilter[], f: DbFilter): readonly DbFilter[] {
  if (list.length >= MAX_FILTERS || list.some((x) => sameFilter(x, f))) return list;
  return [...list, copyFilter(f)];
}

/** An edit in its place; another filter it now equals goes. The list itself back when nothing changes. */
export function replaceFilter(list: readonly DbFilter[], i: number, f: DbFilter): readonly DbFilter[] {
  if (i < 0 || i >= list.length || sameFilter(list[i]!, f)) return list;
  const out: DbFilter[] = [];
  list.forEach((x, j) => {
    if (j === i) out.push(copyFilter(f));
    else if (!sameFilter(x, f)) out.push(x);
  });
  return out;
}

export function removeFilter(list: readonly DbFilter[], i: number): readonly DbFilter[] {
  if (i < 0 || i >= list.length) return list;
  return list.filter((_, j) => j !== i);
}

// ---------- operators and their editors ----------

export type ValueEditor = 'none' | 'text' | 'number' | 'two' | 'checklist' | 'bool' | 'days' | 'hours' | 'path';

/** Element types of an array whose `contains` takes a number. */
const NUMERIC_TYPES = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8']);

/**
 * The editor an operator's value takes: nothing (is null, is not null), a text, a number (kept as typed:
 * a string, never a JS number — R64), two of them (between), a checklist (an enum's values, or values typed for "is any
 * of"), true · false, a count of days or hours (in the last N), a JSON path with its value.
 */
export function valueEditor(c: DbColumn, op: DbFilterOp): ValueEditor {
  switch (op) {
    case 'null': case 'notnull': return 'none';
    case 'true': case 'false': return 'bool';
    case 'pathEq': case 'pathContains': case 'pathExists': case 'pathNull': return 'path';
    case 'between': return 'two';
    case 'in': case 'notin': return 'checklist';
    case 'lastDays': return 'days';
    case 'lastHours': return 'hours';
    default: break;
  }
  const cls = typeClass(c);
  return cls === 'number' || (cls === 'array' && NUMERIC_TYPES.has(c.typeName)) ? 'number' : 'text';
}

/**
 * The operator menu: the type's operators (shared table), is null and is not null last; a boolean's is true and
 * is false are one choice, "is", with a true · false switch (its editor).
 */
export function opChoices(c: DbColumn): { op: DbFilterOp; label: string }[] {
  const ops = opsFor(c);
  const order = [...ops.filter((o) => o !== 'null' && o !== 'notnull'), ...ops.filter((o) => o === 'null' || o === 'notnull')];
  return order.filter((o) => !(o === 'false' && ops.includes('true'))).map((op) => ({ op, label: op === 'true' ? tf.is : opLabel(op) }));
}

/** The menu's choice an operator shows as (is false is "is", its switch says false). */
export const opChoice = (op: DbFilterOp): DbFilterOp => (op === 'false' ? 'true' : op);

// ---------- Filter by / Exclude This Value ----------

/** What main takes whatever the column: values within its bounds, a path within its bounds. */
function inBounds(f: DbFilter): boolean {
  return !f.values.some((v) => v.length > FILTER_VALUE_MAX || v.includes('\0')) && !(f.path && pathProblem(f.path));
}

/**
 * The cell menu's Filter by This Value (`by`) and Exclude This Value, or null when the value can't be one:
 * equals / not equals the value as Postgres printed it; NULL → is null / is not null; an enum's is any of / is none of;
 * a boolean's is true / false (Exclude only without NULLs: is false would drop them too); a time between itself and
 * itself; a JSON column (a key added as a column) at path equals. Never for part of a value (cut at 64 KB) or one past
 * what main takes. A masked value is offered all the same: its chip shows dots (chipParts).
 */
export function cellFilter(g: { col: DbColumn; derived: DbDerived | null }, cell: DbCell | undefined, kind: 'by' | 'exclude'): DbFilter | null {
  if (!cell || cell.cut !== undefined) return null;
  const v = cell.v;
  const by = kind === 'by';
  if (g.derived) {
    if (v === null || !by) return null;
    const f: DbFilter = { column: g.derived.column, path: [...g.derived.path], op: 'pathEq', values: [v] };
    return inBounds(f) ? f : null;
  }
  const c = g.col;
  if (v === null) return { column: c.name, op: by ? 'null' : 'notnull', values: [] };
  const take = (op: DbFilterOp, values: string[]): DbFilter | null => {
    const f: DbFilter = { column: c.name, op, values };
    return inBounds(f) && validFilter(c, f) ? f : null;
  };
  switch (typeClass(c)) {
    case 'text': case 'number': return take(by ? 'eq' : 'ne', [v]);
    case 'enum': return take(by ? 'in' : 'notin', [v]);
    case 'bool': {
      if (!by && c.nullable) return null;
      const on = v === 't' || v === 'true';
      return take(on === by ? 'true' : 'false', []);
    }
    case 'time': return by ? take('between', [v, v]) : null;
    case 'other': return by ? take('eq', [v]) : null;
    default: return null;
  }
}

// ---------- chips ----------

/** Whether Mask values hides this filter's values: its column's name, or a key on its path, asks for it. */
export function filterMasked(f: Pick<DbFilter, 'column' | 'path'>, masked: boolean): boolean {
  return masked && (MASK_COLUMN.test(f.column) || (!!f.path && f.path.length > 0 && MASK_COLUMN.test(pathText(f.path))));
}

/**
 * A chip's words ("created_at · in the last · 7 days"), from filterChip: a JSON path as pathText writes it, an
 * empty string as "", a masked column's values as dots — in the chip, its tooltip and every label made from it. A
 * masked boolean reads "is ••••": its operator is its value.
 */
export function chipParts(f: DbFilter, masked: boolean): { col: string; op: string; val: string; tip: string } {
  const base = filterChip(f);
  const col = f.path && f.path.length > 0 ? `${f.column} → ${pathText(f.path)}` : f.column;
  let op = base.op;
  let val = base.val;
  if ((f.op === 'true' || f.op === 'false') && filterMasked(f, masked)) {
    op = tf.is;
    val = MASK;
  } else if (f.op === 'lastDays' || f.op === 'lastHours') {
    op = tf.inTheLast;
    val = tf.lastN(f.values[0] ?? '', f.op === 'lastDays' ? 'days' : 'hours');
  } else if (arity(f.op) === 0) val = '';
  else if (filterMasked(f, masked)) val = MASK;
  else if (f.values.length === 1 && f.values[0] === '') val = tf.emptyValue;
  return { col, op, val, tip: [col, op, val].filter(Boolean).join(' ') };
}

// ---------- JSON paths ----------

const BARE = /^[^.[\]]+/;

/**
 * A JSON path typed as pathText writes it: keys joined by dots, `[n]` an array item, `["…"]` a
 * key with other characters (JSON string escapes). Null when it isn't one.
 */
export function parsePath(text: string): DbPath | null {
  const s = text.trim();
  if (s === '') return null;
  const out: DbPath = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '[') {
      if (s[i + 1] === '"') {
        let j = i + 2;
        while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
        if (j >= s.length || s[j + 1] !== ']') return null;
        let key: unknown;
        try {
          key = JSON.parse(s.slice(i + 1, j + 1));
        } catch {
          return null;
        }
        if (typeof key !== 'string') return null;
        out.push(key);
        i = j + 2;
      } else {
        const m = /^\[(\d+)\]/.exec(s.slice(i));
        if (!m) return null;
        out.push(Number(m[1]));
        i += m[0].length;
      }
      continue;
    }
    // A dot joins two parts (never first, never last, never twice); a bare key starts the path or follows a dot.
    let at = i;
    if (ch === '.') {
      if (out.length === 0) return null;
      at = i + 1;
    } else if (out.length > 0) return null;
    const m = BARE.exec(s.slice(at));
    if (!m) return null;
    out.push(m[0]);
    i = at + m[0].length;
  }
  return out;
}

/** What main's schema would refuse in a path (shared bounds: 16 keys, 256 characters a key, no NUL, int4 indexes). */
export function pathProblem(path: DbPath): string | null {
  if (path.length > PATH_KEYS_MAX) return tf.err.pathLong(PATH_KEYS_MAX);
  for (const p of path) {
    if (typeof p === 'number') {
      if (!Number.isSafeInteger(p) || p < 0 || p > PATH_INDEX_MAX) return tf.err.index(PATH_INDEX_MAX.toLocaleString('en-US'));
    } else if (p.length > PATH_KEY_MAX) return tf.err.keyLong(PATH_KEY_MAX);
    else if (p.includes('\0')) return tf.err.keyNul;
  }
  return null;
}

// ---------- the popover's draft ----------

/** What the popover edits: the operator, its values as typed (strings, always), a JSON path as typed. */
export interface Draft { op: DbFilterOp; values: string[]; path: string }

/** Where a new filter starts: the last 7 days for a time, is any of for an enum, at path equals for JSON… */
const START: Record<DbTypeClass, DbFilterOp> = { text: 'eq', number: 'eq', bool: 'true', enum: 'in', time: 'lastDays', array: 'has', json: 'pathEq', other: 'eq' };
const COUNT_START = { days: '7', hours: '24' } as const;
const ONE = new Set<ValueEditor>(['text', 'number', 'path']);

/** A new filter on a column — on a JSON column's key when `path` is given: at path equals, its path written. */
export function draftFor(c: DbColumn, path?: DbPath | null): Draft {
  if (path && path.length > 0) return { op: 'pathEq', values: [''], path: pathText(path) };
  return withOp({ op: 'null', values: [], path: '' }, c, START[typeClass(c)]);
}

/** An existing filter, as it is. */
export function draftOf(f: DbFilter): Draft {
  const values = arity(f.op) === 2 ? [f.values[0] ?? '', f.values[1] ?? ''] : [...f.values];
  return { op: f.op, values, path: f.path && f.path.length > 0 ? pathText(f.path) : '' };
}

/** Another operator: what was typed is kept where it still fits (a value, a count, the path). */
export function withOp(d: Draft, c: DbColumn, op: DbFilterOp): Draft {
  const was = valueEditor(c, d.op);
  const to = valueEditor(c, op);
  const first = d.values[0] ?? '';
  const keep = (values: string[]): Draft => ({ op, values, path: d.path });
  switch (to) {
    case 'none': case 'bool': return keep([]);
    case 'two': return keep(was === 'two' ? [d.values[0] ?? '', d.values[1] ?? ''] : [ONE.has(was) ? first : '', '']);
    case 'checklist': return keep(was === 'checklist' ? [...d.values] : ONE.has(was) && first.trim() !== '' ? [first] : []);
    case 'days': case 'hours': return keep(was === 'days' || was === 'hours' ? [first] : [COUNT_START[to]]);
    case 'path': return keep(arity(op) === 0 ? [] : [ONE.has(was) ? first : '']);
    default: return keep([ONE.has(was) || was === 'two' ? first : '']);
  }
}

/** Where a problem is: a value's place (0, 1), the checklist, the path. */
export type DraftField = number | 'values' | 'path';
export type DraftResult = { ok: true; filter: DbFilter } | { ok: false; problem: string; field: DraftField };

/** Text types whose empty string is no value at all (Postgres refuses '' for them). */
const NO_EMPTY = new Set(['uuid', 'inet', 'cidr', 'macaddr', 'macaddr8']);
/** The words Postgres reads as a date or a time. */
const TIME_WORDS = new Set(['now', 'today', 'yesterday', 'tomorrow', 'epoch', 'infinity', '+infinity', '-infinity', 'allballs']);
const TIME_OPS = new Set<DbFilterOp>(['before', 'after', 'between']);

/**
 * A light check of a date or a time typed for before / after / between: refused only when it can't be one
 * — no digit and none of Postgres's words, or an ISO date whose month or day is out of range. Anything else Postgres
 * decides (when in doubt, take it).
 */
export function timeProblem(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (TIME_WORDS.has(s)) return false;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(s);
  if (iso) {
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    return m < 1 || m > 12 || d < 1 || d > 31;
  }
  return !/\d/.test(s);
}

/**
 * The draft as the filter Apply sends, or the first problem and where it is — said before main would refuse (its IPC
 * schema, then validFilter against the catalog's column): a value to type, a number, a whole number, a date, a count of
 * 1 to 100,000, at least one and at most 100 values, an enum's values still in its type, 10,000 characters, no NUL, a
 * path within main's bounds. Text goes as typed (its spaces may be the point); numbers, times and counts without the
 * spaces around them — strings all the way. No message names a value: a masked one stays hidden.
 */
export function draftFilter(c: DbColumn, d: Draft): DraftResult {
  const no = (problem: string, field: DraftField): DraftResult => ({ ok: false, problem, field });
  const ed = valueEditor(c, d.op);
  const cls = typeClass(c);
  let path: DbPath | undefined;
  if (ed === 'path') {
    if (d.path.trim() === '') return no(tf.err.path, 'path');
    const p = parsePath(d.path);
    if (!p) return no(tf.err.badPath, 'path');
    const why = pathProblem(p);
    if (why) return no(why, 'path');
    path = p;
  }
  const n = arity(d.op);
  const raw = n === 0 ? [] : n === 'many' ? d.values : Array.from({ length: n }, (_, i) => d.values[i] ?? '');
  const asTyped = ed === 'checklist' || ed === 'path' || (ed === 'text' && cls !== 'time');
  const values = asTyped ? [...raw] : raw.map((v) => v.trim());
  if (n === 'many' && values.length === 0) return no(tf.err.none, 'values');
  if (n === 'many' && values.length > FILTER_VALUES_MAX) return no(tf.err.many(FILTER_VALUES_MAX), 'values');
  // An empty text equals is a real ask (rows whose value is "", not NULL) — not for a uuid or an address —; so is a JSON
  // value "".
  const emptyOk = (cls === 'text' && (d.op === 'eq' || d.op === 'ne') && !NO_EMPTY.has(c.typeName)) || d.op === 'pathEq';
  const integer = INTEGER_TYPES.has(c.typeName);
  for (const [i, v] of values.entries()) {
    const at: DraftField = n === 'many' ? 'values' : i;
    if (v.includes('\0')) return no(tf.err.nul, at);
    if (v.length > FILTER_VALUE_MAX) return no(tf.err.long(FILTER_VALUE_MAX), at);
    if (v === '' && !emptyOk) return no(tf.err.value, at);
    if (ed === 'days' || ed === 'hours') {
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 100_000) return no(tf.err.range, at);
    } else if (ed === 'number' || (ed === 'two' && cls === 'number')) {
      if (!NUMBER_RE.test(v) || !Number.isFinite(Number(v))) return no(tf.err.number, at);
      if (integer && !/^[+-]?\d+$/.test(v)) return no(tf.err.integer, at);
    } else if (cls === 'time' && TIME_OPS.has(d.op) && timeProblem(v)) return no(tf.err.time, at);
  }
  if (cls === 'enum' && c.enumValues && values.some((v) => !c.enumValues!.includes(v))) return no(tf.err.stale, 'values');
  const filter: DbFilter = { column: c.name, ...(path ? { path } : {}), op: d.op, values };
  if (!validFilter(c, filter)) return no(tf.err.fit(c.name), n === 'many' ? 'values' : 0);
  return { ok: true, filter };
}

/**
 * "Is any of" a text: the values typed so far, then what is still in the field (each line of a pasted list a value; an
 * empty line or one already there adds nothing) — Apply and a field left take it, never drop it.
 */
export function commitPending(values: readonly string[], pending: string): string[] {
  const out = [...values];
  for (const v of pending.split(/\r?\n/)) if (v !== '' && !out.includes(v)) out.push(v);
  return out;
}

// ---------- an enum's checklist ----------

/**
 * An enum's checklist: the catalog's values in order, checked as chosen, then a chosen value the type no
 * longer has, marked, checked — to uncheck. `hidden` (Mask values on, an existing filter):
 * nothing checked and no gone value named, the values being what Mask hides.
 */
export function enumItems(catalog: readonly string[], chosen: readonly string[], hidden: boolean): { value: string; label: string; checked: boolean }[] {
  const on = new Set(hidden ? [] : chosen);
  const items = catalog.map((v) => ({ value: v, label: v, checked: on.has(v) }));
  if (!hidden) for (const v of chosen) if (!catalog.includes(v)) items.push({ value: v, label: tf.staleValue(v), checked: true });
  return items;
}

/**
 * A value toggled: the catalog's order, then the gone values still chosen (one unchecked goes). While hidden, the
 * first toggle starts a new choice — of that value alone — rather than change one the user can't see.
 */
export function enumToggle(catalog: readonly string[], chosen: readonly string[], v: string, hidden: boolean): string[] {
  if (hidden) return [v];
  const on = new Set(chosen);
  if (on.has(v)) on.delete(v);
  else on.add(v);
  return [...catalog.filter((x) => on.has(x)), ...chosen.filter((x) => !catalog.includes(x) && on.has(x))];
}

// ---------- the column list ----------

/** A column to filter on: the table's own, or a JSON column (its column and path). */
export interface FilterTarget { key: string; col: DbColumn; path: DbPath | null; label: string; type: string }

/** The popover's first step: the table's columns in order, then the tab's JSON columns (their keys as the grid's). */
export function filterTargets(cols: readonly DbColumn[], derived: readonly DbDerived[]): FilterTarget[] {
  const out: FilterTarget[] = cols.map((c) => ({ key: c.name, col: c, path: null, label: c.name, type: shortType(c.type) }));
  for (const d of derived) {
    const c = cols.find((x) => x.name === d.column);
    if (c) out.push({ key: JSON.stringify([d.column, d.path]), col: c, path: [...d.path], label: `${d.column} → ${pathText(d.path)}`, type: tf.jsonPath });
  }
  return out;
}

/** Typed to find a column: those starting with it first, then those holding it; everything for nothing typed. */
export function matchTargets(ts: readonly FilterTarget[], q: string): FilterTarget[] {
  const s = q.trim().toLowerCase();
  if (s === '') return [...ts];
  const starts = ts.filter((t) => t.label.toLowerCase().startsWith(s));
  return [...starts, ...ts.filter((t) => !starts.includes(t) && t.label.toLowerCase().includes(s))];
}

// ---------- the Columns chip ----------

/** The choice as the tab keeps it: null when every column is on (main selects them all), else names in table order. */
export function chosenColumns(all: readonly DbColumn[], on: ReadonlySet<string>): string[] | null {
  const names = all.filter((c) => on.has(c.name)).map((c) => c.name);
  return names.length === all.length ? null : names;
}

/** The columns a choice shows (a name the table no longer has is left out). */
export function shownColumns(all: readonly DbColumn[], chosen: readonly string[] | null): Set<string> {
  return new Set(all.filter((c) => chosen === null || chosen.includes(c.name)).map((c) => c.name));
}

export const columnsLabel = (shown: number, all: number): string => tdt.columns.label(shown, all);

/**
 * The table's columns the filter bar, the Columns chip and their popovers list: the last read of every column, else
 * this read's when it read them all, else the catalog's (the Structure read's, as plain columns) — so a table whose
 * read of every column fails stays rescuable: fewer columns chosen, then read.
 * Null until one is known.
 */
export function barColumns(
  st: Pick<DbTabState, 'tableCols' | 'columns' | 'data'>, catalog: readonly (DbColumn & Partial<CatalogExtras>)[] | null
): readonly DbColumn[] | null {
  return st.tableCols ?? (st.columns === null && st.data ? st.data.columns : null) ?? (catalog ? catalog.map(plainColumn) : null);
}

/** What Structure's columns carry beyond a column. */
interface CatalogExtras { comment: string | null; identity: boolean; generated: string | null; check: string | null }
function plainColumn(c: DbColumn & Partial<CatalogExtras>): DbColumn {
  const { comment: _c, identity: _i, generated: _g, check: _k, ...col } = c;
  return col;
}

/**
 * Whether the bar asks the catalog for the table's columns: none known and the read failed — never while it loads, nor
 * on a connection main holds or a read it answered 'held' (nothing connects it by itself).
 */
export function wantsCatalogColumns(st: Pick<DbTabState, 'tableCols' | 'columns' | 'data' | 'loading' | 'problem'>, held: boolean): boolean {
  return !held && !st.loading && st.problem !== null && st.problem.kind !== 'held' && barColumns(st, null) === null;
}

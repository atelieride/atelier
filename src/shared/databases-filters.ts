// Databases view: filter operators by column type. Pure: it runs in
// main (the SQL builders compile these filters) and in the renderer (the filter popover and chips).

import { pathText } from './pg-json';

export type DbTypeClass = 'text' | 'number' | 'bool' | 'enum' | 'time' | 'array' | 'json' | 'other';

export interface DbColumn {
  name: string;
  type: string; // format_type(), e.g. "timestamp with time zone": for display, never written into SQL
  // The type the SQL builders cast to, by its catalog names: the namespace and pg_type.typname of the element type for
  // an array (isArray), of the base type for a domain (a filter value must not trip the domain's CHECK).
  typeSchema: string;
  typeName: string;
  typeCat: string; // pg_type.typcategory
  isArray: boolean;
  enumValues?: string[];
  nullable: boolean;
  isPk: boolean;
  isKey: boolean; // PK, FK, identity/serial: no digit grouping
  fk?: { schema: string; table: string; column: string };
  default?: string;
}

export type DbPath = (string | number)[];

export type DbFilterOp =
  | 'null' | 'notnull' | 'eq' | 'ne' | 'contains' | 'starts' | 'ends' | 'in' | 'notin'
  | 'lt' | 'le' | 'gt' | 'ge' | 'between' | 'true' | 'false' | 'before' | 'after' | 'lastHours' | 'lastDays'
  | 'has' | 'pathEq' | 'pathContains' | 'pathExists' | 'pathNull';

export interface DbFilter { column: string; path?: DbPath; op: DbFilterOp; values: string[] }
export interface DbSort { column: string; path?: DbPath; dir: 'asc' | 'desc' }
export interface DbDerived { column: string; path: DbPath }

const TIME_TYPES = new Set(['date', 'timestamp', 'timestamptz']);
const JSON_TYPES = new Set(['json', 'jsonb']);
const TEXT_TYPES = new Set(['uuid', 'inet', 'cidr', 'macaddr', 'citext', 'name']);

export function typeClass(c: Pick<DbColumn, 'typeName' | 'typeCat' | 'isArray' | 'enumValues'>): DbTypeClass {
  // An array is checked first: an int4[] must not get number operators (its category is 'A', but the element's
  // typeName/typeCat may be reported instead).
  if (c.isArray) return 'array';
  if (c.typeCat === 'N') return 'number';
  if (c.typeCat === 'B') return 'bool';
  if (c.typeCat === 'E' || (c.enumValues && c.enumValues.length > 0)) return 'enum';
  if (TIME_TYPES.has(c.typeName)) return 'time';
  if (JSON_TYPES.has(c.typeName)) return 'json';
  if (c.typeCat === 'S' || TEXT_TYPES.has(c.typeName)) return 'text';
  return 'other';
}

const BY_CLASS: Record<DbTypeClass, DbFilterOp[]> = {
  text: ['eq', 'ne', 'contains', 'starts', 'ends', 'in'],
  number: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between'],
  bool: ['true', 'false'],
  enum: ['in', 'notin'],
  time: ['before', 'after', 'between', 'lastHours', 'lastDays'],
  array: ['has'],
  // pathNull: a JSON null at the path — #>> reads it as SQL NULL, as it reads a missing key.
  json: ['pathEq', 'pathContains', 'pathExists', 'pathNull'],
  other: ['eq']
};

// `path` is accepted so a derived column (a JSON path) can be asked about later; today the operators depend on the
// column's type alone.
export function opsFor(c: DbColumn, _path?: DbPath): DbFilterOp[] {
  return ['null', 'notnull', ...BY_CLASS[typeClass(c)]];
}

export function arity(op: DbFilterOp): 0 | 1 | 2 | 'many' {
  switch (op) {
    case 'null': case 'notnull': case 'true': case 'false': case 'pathExists': case 'pathNull': return 0;
    case 'between': return 2;
    case 'in': case 'notin': return 'many';
    default: return 1;
  }
}

const LABELS: Record<DbFilterOp, string> = {
  null: 'is null', notnull: 'is not null', eq: 'equals', ne: 'not equals', contains: 'contains', starts: 'starts with',
  ends: 'ends with', in: 'is any of', notin: 'is none of', lt: '<', le: '≤', gt: '>', ge: '≥', between: 'between',
  true: 'is true', false: 'is false', before: 'before', after: 'after', lastHours: 'in the last N hours',
  lastDays: 'in the last N days', has: 'contains', pathEq: 'at path equals', pathContains: 'at path contains',
  pathExists: 'at path exists', pathNull: 'at path is JSON null'
};

export function opLabel(op: DbFilterOp): string {
  return LABELS[op];
}

/** Every operator (the labels' keys: the Record keeps the list complete). */
export const DB_FILTER_OPS = Object.keys(LABELS) as DbFilterOp[];

/** A filter value's length at most, and how many values an `in` / `notin` takes at most. */
export const FILTER_VALUE_MAX = 10000;
export const FILTER_VALUES_MAX = 100;
/**
 * How many filters a request takes at most, and a JSON path's bounds: its elements, a key's length, an index (`#>`
 * takes int4). Main's IPC schema checks them; the filter popover says so before Apply.
 */
export const FILTERS_MAX = 30;
export const PATH_KEYS_MAX = 16;
export const PATH_KEY_MAX = 256;
export const PATH_INDEX_MAX = 2_147_483_647;
/** JSON columns a tab adds at most: main's IPC schema takes this many, the JSON tools stop there. */
export const DERIVED_MAX = 20;
const MAX_INTERVAL = 100000;
/** A number as a numeric parameter takes it (the filter popover says so before Apply: one regex for both). */
export const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER_RE = /^[+-]?\d+$/;
/** Integer types by typname and by the names they are written with: a fraction would fail on the server (22P02). */
export const INTEGER_TYPES: ReadonlySet<string> = new Set(['int2', 'int4', 'int8', 'smallint', 'integer', 'bigint', 'serial', 'smallserial', 'bigserial', 'serial2', 'serial4', 'serial8', 'oid']);
const NUMBER_OPS = new Set<DbFilterOp>(['lt', 'le', 'gt', 'ge']);
const PATH_OPS = new Set<DbFilterOp>(['pathEq', 'pathContains', 'pathExists', 'pathNull']);

/** A JSON path within main's bounds: PATH_KEYS_MAX elements, keys of PATH_KEY_MAX characters without NUL, int4 indexes. */
function validPath(path: unknown): boolean {
  return Array.isArray(path) && path.length <= PATH_KEYS_MAX && path.every((p: unknown) => typeof p === 'string'
    ? p.length <= PATH_KEY_MAX && !p.includes('\0')
    : typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= PATH_INDEX_MAX);
}

/**
 * What a filter must be whatever its column (main's IPC checks it before any catalog is at hand): as many values as its
 * operator takes, each a bounded string, and a path only on a JSON operator, which needs one. Malformed input (values
 * that aren't an array, a path element out of bounds) is refused, never thrown on.
 */
export function validFilterShape(f: DbFilter): boolean {
  if (!Array.isArray(f.values)) return false;
  const ar = arity(f.op);
  const n = f.values.length;
  if (ar === 'many' ? n < 1 || n > FILTER_VALUES_MAX : n !== ar) return false;
  if (f.values.some((v) => typeof v !== 'string' || v.length > FILTER_VALUE_MAX)) return false;
  if (f.path !== undefined && !validPath(f.path)) return false;
  const isPathOp = PATH_OPS.has(f.op);
  return isPathOp ? !!f.path && f.path.length > 0 : f.path === undefined || f.path.length === 0;
}

export function validFilter(c: DbColumn, f: DbFilter): boolean {
  if (f.column !== c.name) return false;
  if (!opsFor(c).includes(f.op)) return false;
  if (!validFilterShape(f)) return false;
  const cls = typeClass(c);
  if (cls === 'number' && (NUMBER_OPS.has(f.op) || f.op === 'between' || f.op === 'eq' || f.op === 'ne')) {
    if (!f.values.every((v) => NUMBER_RE.test(v.trim()) && Number.isFinite(Number(v)))) return false;
  }
  const integer = INTEGER_TYPES.has(c.typeName) && (cls === 'number' || (cls === 'array' && f.op === 'has'));
  if (integer && !f.values.every((v) => INTEGER_RE.test(v.trim()))) return false;
  if (f.op === 'lastHours' || f.op === 'lastDays') {
    const v = f.values[0] ?? '';
    if (!/^\d+$/.test(v)) return false;
    const k = Number(v);
    if (k < 1 || k > MAX_INTERVAL) return false;
  }
  if ((f.op === 'before' || f.op === 'after' || f.op === 'between') && cls === 'time') {
    if (f.values.some((v) => v.trim() === '')) return false;
  }
  // An enum's labels when read; without them any non-empty value (a label never is empty; the server's cast checks it).
  if (cls === 'enum' && !f.values.every((v) => (c.enumValues ? c.enumValues.includes(v) : v !== ''))) return false;
  return true;
}

export function filterChip(f: DbFilter): { col: string; op: string; val: string } {
  const col = f.path && f.path.length > 0 ? `${f.column} → ${pathText(f.path)}` : f.column;
  const val = f.op === 'between' ? f.values.join(' – ') : f.values.join(', ');
  return { col, op: opLabel(f.op), val };
}

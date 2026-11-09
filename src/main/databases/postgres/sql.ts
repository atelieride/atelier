// The statement builders for table data: the only place where the SQL
// of a user-driven read is written. Identifiers go through quoteIdent, values are $n parameters (JSON paths text[]
// ones), operators and directions come from the closed tables below, and a name the target doesn't have is refused
// before any SQL exists. A cast names its type by the catalog's names through quoteIdent too (never format_type
// text), every function is pg_catalog-qualified and so is every operator on a pg_catalog type (OPERATOR(
// pg_catalog.=)), so a search_path can't shadow them. Template literals interpolate only quoteIdent(…), a $n index or a
// constant of this module (a static guard holds sql.ts to it); fragments built that way are joined with +. The client
// still runs each statement inside a read-only transaction.
import { typeClass, validFilter, type DbColumn, type DbDerived, type DbFilter, type DbPath, type DbSort } from '@shared/databases-filters';
import { pathText, quoteIdent } from '@shared/pg-json';
import { DbError, type Stmt } from '../driver';

/**
 * A table or view resolved against the catalog: its columns, its primary key ([] when it has none) and its unique keys
 * whose columns are all NOT NULL ([] when none): the keys that name one row.
 */
export interface TableTarget { schema: string; name: string; columns: DbColumn[]; pk: string[]; uniqueKeys: string[][] }
export interface PageSpec { columns: string[]; derived: DbDerived[]; filters: DbFilter[]; sort: DbSort[]; page: number; size: number }

/**
 * How a page, peek or row read brings a value: `whole` — a type whose text is always short, as the server
 * prints it; `text` — cut on the server to CUT_CHARS characters; `hex` — a bytea, its hex cut to CUT_HEX_CHARS.
 */
export type CellCut = 'whole' | 'text' | 'hex';
/**
 * A read whose rows hold one value per entry of `cuts`, then the whole size of each value cut on the server, in the same
 * order: octet_length of its text ('text'), of its bytes ('hex').
 */
export interface CellStmt extends Stmt { cuts: CellCut[] }

/** Cells past this many bytes are cut: on the server first, then to the byte by the queries. */
export const CUT_BYTES = 65536;
/** A value that can be long travels as its first CUT_CHARS characters: one past CUT_BYTES, so the reader sees the cut. */
export const CUT_CHARS = CUT_BYTES + 1;
/** A bytea's text is hex, '\x' then two characters a byte: HEX_CHARS of it hold CUT_BYTES bytes. */
export const HEX_CHARS = 2 + 2 * CUT_BYTES;
/** A bytea travels as its first CUT_HEX_CHARS characters: one past HEX_CHARS. */
export const CUT_HEX_CHARS = HEX_CHARS + 1;
/** Load full value reads up to this many characters; its second column is the whole value's length in bytes. */
export const FULL_CHARS = 16777216;
/** References are counted up to this many: a count of REFS_CAP reads "1,000+". */
export const REFS_CAP = 1001;
/** The largest page (Settings offers 50–500 rows). */
export const MAX_PAGE_SIZE = 500;

const IS = { null: 'IS NULL', notnull: 'IS NOT NULL', true: 'IS TRUE', false: 'IS FALSE' } as const;
/** Comparisons by the server's own operators, for pg_catalog types and enums (their `=` is anyenum's). */
const PG_CMP = {
  eq: 'OPERATOR(pg_catalog.=)', lt: 'OPERATOR(pg_catalog.<)', le: 'OPERATOR(pg_catalog.<=)', gt: 'OPERATOR(pg_catalog.>)',
  ge: 'OPERATOR(pg_catalog.>=)', before: 'OPERATOR(pg_catalog.<)', after: 'OPERATOR(pg_catalog.>)'
} as const;
/** The same for an extension's type (citext, a vector…): its operators live with it, found as Postgres finds them. */
const BARE_CMP = { eq: '=', lt: '<', le: '<=', gt: '>', ge: '>=', before: '<', after: '>' } as const;
/** ILIKE as its operator: the default escape is the backslash, the one likeValue escapes with. */
const ILIKE = 'OPERATOR(pg_catalog.~~*)';
/** JSON at a path, as JSON (#>) and as text (#>>). */
const JSON_AT = 'OPERATOR(pg_catalog.#>)';
const JSON_TEXT_AT = 'OPERATOR(pg_catalog.#>>)';
const TEXT_EQ = 'OPERATOR(pg_catalog.=)';
const MINUS = 'OPERATOR(pg_catalog.-)';
const LIKE = { contains: ['%', '%'], starts: ['', '%'], ends: ['%', ''], pathContains: ['%', '%'] } as const;
const INTERVAL = { lastHours: 'hours', lastDays: 'days' } as const;
const DIR = { asc: 'ASC', desc: 'DESC' } as const;
/** pg_catalog types without a default btree ordering: ORDER BY on them fails on the server. */
const UNORDERED = new Set([
  'json', 'xml', 'jsonpath', 'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle', 'aclitem', 'xid', 'cid', 'pg_snapshot', 'txid_snapshot'
]);
/**
 * pg_catalog types whose text is short whatever the value: read as the server prints them.
 * Their own text, too: a cast to text would change some (bool → true, inet → with its mask, character(n) → without
 * its padding, "char" → unescaped).
 */
const SHORT = new Set([
  'bool', 'int2', 'int4', 'int8', 'oid', 'float4', 'float8', 'money', 'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval', 'uuid',
  'inet', 'cidr', 'macaddr', 'macaddr8', 'char', 'bpchar', 'name', 'pg_lsn', 'tid', 'xid', 'xid8', 'cid', 'point', 'line', 'lseg', 'box', 'circle',
  'regclass', 'regtype', 'regproc', 'regprocedure', 'regoper', 'regoperator', 'regconfig', 'regdictionary', 'regnamespace', 'regrole', 'regcollation'
]);

class Params {
  readonly values: unknown[] = [];
  /** Adds a value; returns its $ index. */
  add(v: unknown): number {
    this.values.push(v);
    return this.values.length;
  }
}

function refuse(message: string): never {
  throw new DbError({ kind: 'other', message });
}

function columnOf(t: TableTarget, name: string): DbColumn {
  const c = t.columns.find((x) => x.name === name);
  if (!c) throw new DbError({ kind: 'unknown-table', message: 'No column ' + name + ' in ' + t.schema + '.' + t.name });
  return c;
}

/** A JSON column read at a path: a derived column, a sort by key, Load full value of a part. */
function jsonColumn(t: TableTarget, name: string, path: DbPath): DbColumn {
  const c = columnOf(t, name);
  if (typeClass(c) !== 'json') refuse(name + ' is not a JSON column');
  if (path.length === 0) refuse('A JSON path needs at least one key');
  return c;
}

/** The path as the text[] parameter #> and #>> take: array indexes as their digits. */
function pathParam(path: DbPath): string[] {
  return path.map((p) => {
    if (typeof p === 'string') return p;
    if (typeof p === 'number' && Number.isFinite(p)) return String(Math.trunc(p));
    return refuse('A JSON path holds keys and indexes only');
  });
}

const rel = (t: TableTarget): string => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;

/** Whether c's (element's) operators are the server's own: a pg_catalog type, or an enum (anyenum's, in pg_catalog). */
const catalogOps = (c: DbColumn): boolean => c.typeSchema === 'pg_catalog' || c.typeCat === 'E' || (c.enumValues?.length ?? 0) > 0;

/** The comparison operator for c's type, qualified when it is the server's own. */
function cmpOp(c: DbColumn, op: keyof typeof PG_CMP): string {
  return catalogOps(c) ? PG_CMP[op] : BARE_CMP[op];
}

/** How a read brings c: whole when its text is always short, else cut on the server (a bytea as hex). */
export function cutOf(c: DbColumn): CellCut {
  if (c.isArray) return 'text';
  if (c.typeCat === 'E') return 'whole';
  if (c.typeSchema !== 'pg_catalog') return 'text';
  if (c.typeName === 'bytea') return 'hex';
  return SHORT.has(c.typeName) ? 'whole' : 'text';
}

/** c in a read's SELECT list: itself, or its text cut on the server under its own name. */
function valueSql(c: DbColumn, cut: CellCut): string {
  if (cut === 'whole') return quoteIdent(c.name);
  const chars = cut === 'hex' ? CUT_HEX_CHARS : CUT_CHARS;
  return 'pg_catalog.left(' + quoteIdent(c.name) + '::pg_catalog.text, ' + chars + ') AS ' + quoteIdent(c.name);
}

/** The whole size of a value cut on the server: its text's bytes, a bytea's own bytes. */
function sizeSql(c: DbColumn, cut: CellCut): string {
  if (cut === 'hex') return `pg_catalog.octet_length(${quoteIdent(c.name)})`;
  return `pg_catalog.octet_length(${quoteIdent(c.name)}::pg_catalog.text)`;
}

/** A read of columns: the SELECT list (values, then the sizes of those cut) and how each value comes. */
function cellsSql(cols: DbColumn[], cut: boolean): { values: string[]; sizes: string[]; cuts: CellCut[] } {
  const cuts = cols.map((c): CellCut => (cut ? cutOf(c) : 'whole'));
  return {
    values: cols.map((c, k) => valueSql(c, cuts[k]!)),
    sizes: cols.flatMap((c, k) => (cuts[k] === 'whole' ? [] : [sizeSql(c, cuts[k]!)])),
    cuts
  };
}

/** `$n` cast to the column's type (its element's for an array) by its catalog names: no typmod to cut the value. */
function typed(c: DbColumn, n: number): string {
  return `$${n}::${quoteIdent(c.typeSchema)}.${quoteIdent(c.typeName)}`;
}

/** `$n` as an array of the column's type (is any of / is none of); enum labels travel as text[] first. */
function typedArray(c: DbColumn, n: number): string {
  if (typeClass(c) === 'enum') return `$${n}::pg_catalog.text[]::${quoteIdent(c.typeSchema)}.${quoteIdent(c.typeName)}[]`;
  return `$${n}::${quoteIdent(c.typeSchema)}.${quoteIdent(c.typeName)}[]`;
}

function compare(c: DbColumn, op: keyof typeof PG_CMP, n: number): string {
  // Anything without operators of its own (interval, bytea, xml…) equals as text.
  if (typeClass(c) === 'other') return `${quoteIdent(c.name)}::pg_catalog.text ${PG_CMP[op]} $${n}`;
  return quoteIdent(c.name) + ' ' + cmpOp(c, op) + ' ' + typed(c, n);
}

/** ILIKE's pattern for the value: its own %, _ and \ match themselves. */
function likeValue(op: keyof typeof LIKE, v: string): string {
  return LIKE[op][0] + v.replace(/[\\%_]/g, '\\$&') + LIKE[op][1];
}

function filterSql(t: TableTarget, f: DbFilter, ps: Params): string {
  const c = columnOf(t, f.column);
  if (!validFilter(c, f)) refuse('This filter does not fit column ' + c.name);
  const [a = '', b = ''] = f.values;
  switch (f.op) {
    case 'null': case 'notnull': case 'true': case 'false':
      return `${quoteIdent(c.name)} ${IS[f.op]}`;
    case 'eq': case 'lt': case 'le': case 'gt': case 'ge': case 'before': case 'after':
      return compare(c, f.op, ps.add(a));
    case 'ne':
      // Not equals keeps the NULL rows: "Exclude This Value" hides that value, not the rows without one —
      // the comparison is NULL there, and NULL IS NOT TRUE. (IS DISTINCT FROM would find its `=` through the search_path.)
      return '(' + compare(c, 'eq', ps.add(a)) + ') IS NOT TRUE';
    case 'between': {
      const n = ps.add(a);
      const i = ps.add(b);
      return '(' + quoteIdent(c.name) + ' ' + cmpOp(c, 'ge') + ' ' + typed(c, n) + ' AND ' + quoteIdent(c.name) + ' ' + cmpOp(c, 'le') + ' ' + typed(c, i) + ')';
    }
    case 'contains': case 'starts': case 'ends': {
      const n = ps.add(likeValue(f.op, a));
      return `${quoteIdent(c.name)}::pg_catalog.text ${ILIKE} $${n}`;
    }
    case 'in': case 'notin': {
      const n = ps.add([...f.values]);
      const test = quoteIdent(c.name) + ' ' + cmpOp(c, 'eq') + ' ANY(' + typedArray(c, n) + ')';
      // Is none of keeps the NULL rows, as not equals does.
      return f.op === 'in' ? test : '(NOT (' + test + `) OR ${quoteIdent(c.name)} IS NULL)`;
    }
    case 'lastHours': case 'lastDays': {
      const n = ps.add(a);
      return quoteIdent(c.name) + ' ' + cmpOp(c, 'ge') + ` (pg_catalog.now() ${MINUS} pg_catalog.make_interval(${INTERVAL[f.op]} => $${n}::pg_catalog.int4))`;
    }
    case 'has':
      return typed(c, ps.add(a)) + ' ' + cmpOp(c, 'eq') + ` ANY(${quoteIdent(c.name)})`;
    case 'pathEq': {
      const p = ps.add(pathParam(f.path ?? []));
      const n = ps.add(a);
      return `(${quoteIdent(c.name)} ${JSON_TEXT_AT} $${p}::pg_catalog.text[]) ${TEXT_EQ} $${n}`;
    }
    case 'pathContains': {
      const p = ps.add(pathParam(f.path ?? []));
      const n = ps.add(likeValue(f.op, a));
      return `(${quoteIdent(c.name)} ${JSON_TEXT_AT} $${p}::pg_catalog.text[]) ${ILIKE} $${n}`;
    }
    case 'pathExists': {
      const p = ps.add(pathParam(f.path ?? []));
      return `(${quoteIdent(c.name)} ${JSON_AT} $${p}::pg_catalog.text[]) IS NOT NULL`;
    }
    case 'pathNull': {
      // The JSON at the path is a JSON null (#>> reads one as SQL NULL, as it reads a missing key); as jsonb,
      // so a json column compares too.
      const p = ps.add(pathParam(f.path ?? []));
      return `(${quoteIdent(c.name)} ${JSON_AT} $${p}::pg_catalog.text[])::pg_catalog.jsonb ${TEXT_EQ} 'null'::pg_catalog.jsonb`;
    }
  }
}

/** ' WHERE …' with the filters AND-ed, or '' without any. */
function whereSql(t: TableTarget, filters: DbFilter[], ps: Params): string {
  if (filters.length === 0) return '';
  return ' WHERE ' + filters.map((f) => filterSql(t, f, ps)).join(' AND ');
}

function sortSql(t: TableTarget, s: DbSort, ps: Params): string {
  if (s.dir !== 'asc' && s.dir !== 'desc') refuse('A sort is ascending or descending');
  if (s.path && s.path.length > 0) {
    // #>> gives text, which always sorts.
    const c = jsonColumn(t, s.column, s.path);
    const n = ps.add(pathParam(s.path));
    return `(${quoteIdent(c.name)} ${JSON_TEXT_AT} $${n}::pg_catalog.text[]) ${DIR[s.dir]}`;
  }
  const c = columnOf(t, s.column);
  if (c.typeSchema === 'pg_catalog' && UNORDERED.has(c.typeName)) refuse("Can't sort by " + c.name);
  return `${quoteIdent(c.name)} ${DIR[s.dir]}`;
}

/**
 * Whether ORDER BY c works whatever the server has installed (the tiebreakers: one that failed would fail the
 * page): a pg_catalog type with a btree ordering (arrays of one too), or an enum. An extension's type may have none.
 */
function ordersSurely(c: DbColumn): boolean {
  return c.typeCat === 'E' || (c.typeSchema === 'pg_catalog' && !UNORDERED.has(c.typeName));
}

/** A row named by its key (peek, references, full value): every column compared with its value, cast to its type. */
function keySql(t: TableTarget, cols: string[], values: string[], ps: Params): string {
  if (cols.length === 0 || cols.length !== values.length) refuse('A key needs one value per column');
  return cols
    .map((name, k) => {
      const c = columnOf(t, name);
      const v = values[k];
      if (typeof v !== 'string') refuse('A key value is text');
      return quoteIdent(c.name) + ' ' + cmpOp(c, 'eq') + ' ' + typed(c, ps.add(v));
    })
    .join(' AND ');
}

/** True when cols are exactly the primary key's columns or one unique not-null key's, in any order. */
function namesOneRow(t: TableTarget, cols: string[]): boolean {
  const same = (key: string[]) => key.length > 0 && key.length === cols.length && key.every((k) => cols.includes(k));
  return same(t.pk) || t.uniqueKeys.some(same);
}

/**
 * What names one row: the primary key, else the first unique key whose columns are all NOT NULL and
 * whose index compares as its columns do (catalog.ts), else none. Pages order by it last; the inspector keys rows by it.
 */
export function rowKeyOf(t: TableTarget): string[] {
  return t.pk.length > 0 ? t.pk : t.uniqueKeys[0] ?? [];
}

const whole = (v: number, min: number): boolean => Number.isSafeInteger(v) && v >= min;

/**
 * A page of rows: the chosen columns (all when none), derived JSON columns, filters, then the user's sorts followed
 * by the row's key ascending (rowKeyOf: the primary key) — ties would otherwise
 * repeat or skip rows from one OFFSET page to the next. Without a key, a sorted page is tied by every selected column
 * that surely orders (an unsorted one keeps the scan's order, steady under the client's wrapper). Values
 * that can be long are cut on the server, their whole sizes after them (CellStmt); `cut` false selects
 * every value whole: the statement the SQL popover shows and copies, the same read without the transport's cut.
 */
export function pageStmt(t: TableTarget, p: PageSpec, cut = true): CellStmt {
  if (!whole(p.page, 0) || !whole(p.size, 1) || p.size > MAX_PAGE_SIZE || !whole(p.page * p.size, 0)) {
    throw new RangeError('page must be a whole number ≥ 0, size 1–500');
  }
  const ps = new Params();
  const cols = p.columns.length > 0 ? p.columns.map((name) => columnOf(t, name)) : t.columns;
  const sel = cellsSql(cols, cut);
  for (const d of p.derived) {
    const c = jsonColumn(t, d.column, d.path);
    const n = ps.add(pathParam(d.path));
    const at = `(${quoteIdent(c.name)} ${JSON_TEXT_AT} $${n}::pg_catalog.text[])`;
    const alias = quoteIdent(c.name + '→' + pathText(d.path));
    if (cut) {
      sel.values.push('pg_catalog.left(' + at + `, ${CUT_CHARS}) AS ` + alias);
      sel.sizes.push('pg_catalog.octet_length(' + at + ')');
      sel.cuts.push('text');
    } else {
      sel.values.push(at + ' AS ' + alias);
      sel.cuts.push('whole');
    }
  }
  const where = whereSql(t, p.filters, ps);
  const order = p.sort.map((s) => sortSql(t, s, ps));
  const sorted = new Set(p.sort.filter((s) => !s.path || s.path.length === 0).map((s) => s.column));
  const key = rowKeyOf(t);
  const ties = key.length > 0 ? key : p.sort.length > 0 ? cols.filter(ordersSurely).map((c) => c.name) : [];
  for (const k of ties) {
    if (!sorted.has(k)) order.push(`${quoteIdent(columnOf(t, k).name)} ASC`);
  }
  const n = ps.add(p.size);
  const i = ps.add(p.page * p.size);
  const orderBy = order.length > 0 ? ' ORDER BY ' + order.join(', ') : '';
  const list = [...sel.values, ...sel.sizes].join(', ');
  return {
    text: 'SELECT ' + list + ' FROM ' + rel(t) + where + orderBy + ` LIMIT $${n} OFFSET $${i}`, values: ps.values, shape: 'page', cuts: sel.cuts,
    // Without a row key, the stable wrapper keeps its OFFSET pages in one order.
    ...(key.length === 0 ? { stable: true as const } : {})
  };
}

/** The planner's row estimate for the filters (its JSON plan's "Plan Rows"); nothing runs. */
export function estimateStmt(t: TableTarget, filters: DbFilter[]): Stmt {
  const ps = new Params();
  return { text: 'EXPLAIN (FORMAT JSON) SELECT 1 FROM ' + rel(t) + whereSql(t, filters, ps), values: ps.values, shape: 'estimate' };
}

/** Count exactly: count(*) with the filters, only when asked. */
export function countStmt(t: TableTarget, filters: DbFilter[]): Stmt {
  const ps = new Params();
  return { text: 'SELECT pg_catalog.count(*) FROM ' + rel(t) + whereSql(t, filters, ps), values: ps.values, shape: 'count' };
}

/** The row a foreign key points at, every column (the FK peek card), long values cut on the server. */
export function peekStmt(t: TableTarget, cols: string[], values: string[]): CellStmt {
  const ps = new Params();
  const where = keySql(t, cols, values, ps);
  const sel = cellsSql(t.columns, true);
  const list = [...sel.values, ...sel.sizes].join(', ');
  return { text: 'SELECT ' + list + ' FROM ' + rel(t) + ' WHERE ' + where + ' LIMIT 1', values: ps.values, shape: 'peek', cuts: sel.cuts };
}

/**
 * The row itself, every column, by a key that names one row (the inspector's hidden fields): the primary
 * key or a unique NOT NULL key, else "No key to read this row" before any SQL. Two rows at most come back: the reader
 * refuses a second one rather than picking one. Long values cut on the server.
 */
export function rowStmt(t: TableTarget, cols: string[], values: string[]): CellStmt {
  if (!namesOneRow(t, cols)) refuse('No key to read this row');
  const ps = new Params();
  const where = keySql(t, cols, values, ps);
  const sel = cellsSql(t.columns, true);
  const list = [...sel.values, ...sel.sizes].join(', ');
  return { text: 'SELECT ' + list + ' FROM ' + rel(t) + ' WHERE ' + where + ' LIMIT 2', values: ps.values, shape: 'row', cuts: sel.cuts };
}

/** How many rows of t point at a row through cols, counted up to REFS_CAP. */
export function refCountStmt(t: TableTarget, cols: string[], values: string[]): Stmt {
  const ps = new Params();
  const where = keySql(t, cols, values, ps);
  return {
    text: 'SELECT pg_catalog.count(*) FROM (SELECT 1 FROM ' + rel(t) + ' WHERE ' + where + ` LIMIT ${REFS_CAP}) s`,
    values: ps.values, shape: 'refs'
  };
}

/**
 * Load full value: a column (or a JSON path in it) of the row the primary key or a unique not-null key names. One row
 * of two columns: the value as text cut at FULL_CHARS characters, and the whole value's length in bytes (larger than
 * the first column's when it was cut). No key that names one row: "No key to read the whole value".
 */
export function fullValueStmt(t: TableTarget, key: Record<string, string>, column: string, path?: DbPath): Stmt {
  const cols = Object.keys(key);
  if (!namesOneRow(t, cols)) refuse('No key to read the whole value');
  const ps = new Params();
  let value: string;
  if (path && path.length > 0) {
    const c = jsonColumn(t, column, path);
    const p = ps.add(pathParam(path));
    value = `(${quoteIdent(c.name)} ${JSON_TEXT_AT} $${p}::pg_catalog.text[])`;
  } else {
    value = `${quoteIdent(columnOf(t, column).name)}::pg_catalog.text`;
  }
  const where = keySql(t, cols, Object.values(key), ps);
  return {
    text: 'SELECT pg_catalog.left(' + value + `, ${FULL_CHARS}), pg_catalog.octet_length(` + value + ') FROM ' + rel(t) + ' WHERE ' + where + ' LIMIT 1',
    values: ps.values, shape: 'full'
  };
}

/**
 * A value as a literal for reading: quotes doubled, and a backslash in it written as an escape string (E'a\\b'), which
 * reads the same whatever standard_conforming_strings says.
 */
function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return 'ARRAY[' + v.map(literal).join(', ') + ']';
  const s = String(v).replace(/'/g, "''");
  return s.includes('\\') ? "E'" + s.replace(/\\/g, '\\\\') + "'" : "'" + s + "'";
}

const CATALOG = 'pg_catalog.';
const QUOTED_CATALOG = '"pg_catalog".';
const CATALOG_OP = 'OPERATOR(pg_catalog.';
/** A pg_catalog type name that reads the same unquoted… */
const SHORT_NAME = /"([a-z_][a-z0-9_]*)"/y;
/** …except these: unquoted, char is character(1) and bit is bit(1), not the types the cast names. */
const KEEP_QUOTED = new Set(['char', 'bit']);
/** How a qualified operator reads: as its symbol, ILIKE's as the word. */
const OP_WORDS: Readonly<Record<string, string>> = { '~~*': 'ILIKE' };

/**
 * The statement for the SQL popover: each $n outside quotes replaced by its value as a literal (quotes doubled, a
 * backslash in an E'' string, arrays as ARRAY[…]), pg_catalog names short (count(*), ::text) and its operators as
 * written by hand (=, #>>, ILIKE). For reading and copying only; what runs is always the parameterized Stmt.
 */
export function displaySql(s: Stmt): string {
  const text = s.text;
  const param = /\$(\d+)/y;
  let out = '';
  let quote: string | null = null;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k] ?? '';
    if (quote !== null) {
      // A doubled quote closes and reopens: the state comes out right.
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    const tokenStart = k === 0 || !/[\w$]/.test(text[k - 1] ?? '');
    if (tokenStart && text.startsWith(CATALOG_OP, k)) {
      const end = text.indexOf(')', k + CATALOG_OP.length);
      if (end > 0) {
        const op = text.slice(k + CATALOG_OP.length, end);
        out += OP_WORDS[op] ?? op;
        k = end;
        continue;
      }
    }
    if (tokenStart && text.startsWith(CATALOG, k)) {
      k += CATALOG.length - 1;
      continue;
    }
    if (tokenStart && text.startsWith(QUOTED_CATALOG, k)) {
      SHORT_NAME.lastIndex = k + QUOTED_CATALOG.length;
      const m = SHORT_NAME.exec(text);
      if (m && !KEEP_QUOTED.has(m[1] ?? '')) {
        out += m[1];
        k = SHORT_NAME.lastIndex - 1;
      } else {
        k += QUOTED_CATALOG.length - 1; // the quoted name follows, scanned as usual
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '$') {
      param.lastIndex = k;
      const m = param.exec(text);
      const index = m ? Number(m[1]) : 0;
      if (m && index >= 1 && index <= s.values.length) {
        out += literal(s.values[index - 1]);
        k += m[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

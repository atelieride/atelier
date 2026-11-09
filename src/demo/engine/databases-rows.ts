// The Databases view in the live demo, the rows' half: what Postgres itself
// does to a table's rows when main's statements read them — compare by type, keep the rows a filter keeps, sort, read
// JSON at a path, cut long values — done again in plain JS over the world's arrays. Values stay text as Postgres prints
// them: numbers compare digit by digit, JSON is read losslessly (an integer past 2^53 keeps its digits). Nothing here
// writes or reads a statement: the bundle ships no query builder.
import type { DbCell } from '@shared/databases';
import { typeClass, type DbColumn, type DbFilter, type DbPath } from '@shared/databases-filters';
import { parsePgArray } from '@shared/pg-format';

type Text = string | null;

/** A problem Postgres would answer with (its SQLSTATE in `code`): the reads turn it into a DbProblem. */
export class PgError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// ── JSON, losslessly ───────────────────────────────────────────────────────────────────────────────────────────────

/** A JSON value with its numbers as their text: o(bject) entries in stored order, a(rray), s(tring), n(umber), b(oolean), z (null). */
export type JNode =
  | { k: 'o'; e: [string, JNode][] }
  | { k: 'a'; v: JNode[] }
  | { k: 's'; v: string }
  | { k: 'n'; v: string }
  | { k: 'b'; v: boolean }
  | { k: 'z' };

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** jsonb's text read into nodes, never through JSON.parse (its numbers are doubles). Throws on anything else. */
export function parseJson(text: string): JNode {
  let i = 0;
  const fail = (): never => { throw new SyntaxError(`invalid JSON at ${i}`); };
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r')) i++; };
  const str = (): string => {
    i++;
    let out = '';
    let from = i;
    for (;;) {
      const ch = text[i];
      if (ch === undefined) fail();
      if (ch === '"') { out += text.slice(from, i++); return out; }
      if (ch !== '\\') { i++; continue; }
      out += text.slice(from, i);
      const e = text[i + 1] ?? '';
      if (e === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
      else if (e in ESCAPES) { out += ESCAPES[e]; i += 2; }
      else fail();
      from = i;
    }
  };
  const value = (): JNode => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const e: [string, JNode][] = [];
      ws();
      if (text[i] === '}') { i++; return { k: 'o', e }; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = str();
        ws();
        if (text[i++] !== ':') fail();
        e.push([key, value()]);
        ws();
        const c = text[i++];
        if (c === '}') return { k: 'o', e };
        if (c !== ',') fail();
      }
    }
    if (ch === '[') {
      i++;
      const v: JNode[] = [];
      ws();
      if (text[i] === ']') { i++; return { k: 'a', v }; }
      for (;;) {
        v.push(value());
        ws();
        const c = text[i++];
        if (c === ']') return { k: 'a', v };
        if (c !== ',') fail();
      }
    }
    if (ch === '"') return { k: 's', v: str() };
    for (const [word, node] of [['true', { k: 'b', v: true }], ['false', { k: 'b', v: false }], ['null', { k: 'z' }]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return node; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail();
    i += m[0].length;
    return { k: 'n', v: m[0] };
  };
  const v = value();
  ws();
  if (i !== text.length) fail();
  return v;
}

/** A node as jsonb prints it: ", " and ": ", keys as stored. */
export function jsonText(n: JNode): string {
  switch (n.k) {
    case 'o': return `{${n.e.map(([k, v]) => `${JSON.stringify(k)}: ${jsonText(v)}`).join(', ')}}`;
    case 'a': return `[${n.v.map(jsonText).join(', ')}]`;
    case 's': return JSON.stringify(n.v);
    case 'n': return n.v;
    case 'b': return String(n.v);
    case 'z': return 'null';
  }
}

/** `#>`: the node at a path (keys of objects, indexes of arrays, negative from the end), or undefined. */
export function nodeAt(n: JNode, path: DbPath): JNode | undefined {
  let cur: JNode | undefined = n;
  for (const p of path) {
    if (!cur) return undefined;
    const key = String(p);
    if (cur.k === 'o') cur = cur.e.findLast(([k]) => k === key)?.[1];
    else if (cur.k === 'a' && /^-?\d+$/.test(key)) {
      const at = Number(key);
      cur = cur.v[at < 0 ? cur.v.length + at : at];
    } else return undefined;
  }
  return cur;
}

/** `#>` (json) and `#>>` (text: a string unquoted, a JSON null as SQL NULL) at a path; undefined when nothing is there. */
export function atJson(n: JNode, path: DbPath): { text: string | null; json: string } | undefined {
  const hit = nodeAt(n, path);
  if (!hit) return undefined;
  return { text: hit.k === 'z' ? null : hit.k === 's' ? hit.v : jsonText(hit), json: jsonText(hit) };
}

/** Each JSON value read once (the world's payloads repeat across reads). */
const parsed = new Map<string, JNode | null>();
export function jsonOf(text: string): JNode | null {
  let n = parsed.get(text);
  if (n === undefined) {
    try { n = parseJson(text); } catch { n = null; }
    parsed.set(text, n);
  }
  return n;
}

/** `value #>> path` of a cell, NULL when the cell is NULL or nothing (or a JSON null) is there. */
export function textAt(v: Text, path: DbPath): Text {
  const n = v === null ? null : jsonOf(v);
  return n ? atJson(n, path)?.text ?? null : null;
}

// ── Comparing as Postgres does ─────────────────────────────────────────────────────────────────────────────────────

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;
const sign = (d: number) => (d < 0 ? -1 : d > 0 ? 1 : 0);

/** Two numbers as Postgres prints them, compared exactly (digits, never doubles); anything else as numbers. */
export function cmpDecimal(a: string, b: string): number {
  const x = DECIMAL.exec(a.trim());
  const y = DECIMAL.exec(b.trim());
  if (!x || !y || (x[2] === '' && !x[3]) || (y[2] === '' && !y[3])) return sign(Number(a) - Number(b));
  const parts = (m: RegExpExecArray) => {
    const int = m[2]!.replace(/^0+/, '');
    const frac = (m[3] ?? '').replace(/0+$/, '');
    return { neg: m[1] === '-' && (int !== '' || frac !== ''), int, frac };
  };
  const p = parts(x);
  const q = parts(y);
  if (p.neg !== q.neg) return p.neg ? -1 : 1;
  let d = sign(p.int.length - q.int.length);
  if (!d && p.int !== q.int) d = p.int < q.int ? -1 : 1;
  if (!d) {
    const n = Math.max(p.frac.length, q.frac.length);
    const fa = p.frac.padEnd(n, '0');
    const fb = q.frac.padEnd(n, '0');
    d = fa === fb ? 0 : fa < fb ? -1 : 1;
  }
  return p.neg && d !== 0 ? -d : d;
}

/**
 * The database's collation: the demo's container is postgres:16-alpine (world/docker.ts), whose musl libc collates
 * en_US.utf8 by code point, as C does — so text compares code point by code point (UTF-16 units mapped to code-point
 * order: a surrogate pair sorts after U+E000–U+FFFF), then the shorter first.
 */
export function cmpText(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      x += x >= 0xe000 ? -0x800 : 0x2000;
      y += y >= 0xe000 ? -0x800 : 0x2000;
    }
    return x - y;
  }
  return a.length - b.length;
}

const TIME = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,6}))?)?)?\s*(?:(Z)|([+-])(\d\d)(?::?(\d\d))?)?$/i;

/**
 * A date or timestamptz literal as microseconds since the epoch (a value without a zone is in UTC, the server's
 * TimeZone); null when it isn't one.
 */
export function instantOf(text: string): number | null {
  const m = TIME.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', s = '0'] = [m[1], m[2], m[3], m[4], m[5], m[6]];
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(ms)) return null;
  const off = m[9] ? (m[9] === '-' ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11] ?? 0)) : 0;
  return (ms - off * 60_000) * 1000 + Number((m[7] ?? '').padEnd(6, '0') || 0);
}

/** A filter's time, as the server casts it (22007 when it can't); a date column's at its day's midnight. */
function timeArg(c: DbColumn, v: string): number {
  const t = instantOf(v);
  if (t === null) throw new PgError(`invalid input syntax for type ${c.type}: "${v}"`, '22007');
  if (c.typeName !== 'date') return t;
  const day = 86_400_000_000;
  return Math.floor(t / day) * day;
}

/** RANK of a JSON node in jsonb's order: null < string < number < boolean < array < object. */
const RANK = { z: 0, s: 1, n: 2, b: 3, a: 4, o: 5 } as const;

/** jsonb's btree order: by kind; arrays and objects by size first, then item by item (an object's keys as stored). */
export function cmpJson(a: JNode, b: JNode): number {
  if (a.k !== b.k) return RANK[a.k] - RANK[b.k];
  switch (a.k) {
    case 'z': return 0;
    case 's': return cmpText(a.v, (b as typeof a).v);
    case 'n': return cmpDecimal(a.v, (b as typeof a).v);
    case 'b': return Number(a.v) - Number((b as typeof a).v);
    case 'a': {
      const y = (b as typeof a).v;
      if (a.v.length !== y.length) return a.v.length - y.length;
      for (let i = 0; i < y.length; i++) { const d = cmpJson(a.v[i]!, y[i]!); if (d) return d; }
      return 0;
    }
    case 'o': {
      const y = (b as typeof a).e;
      if (a.e.length !== y.length) return a.e.length - y.length;
      for (let i = 0; i < y.length; i++) {
        const d = cmpText(a.e[i]![0], y[i]![0]) || cmpJson(a.e[i]![1], y[i]![1]);
        if (d) return d;
      }
      return 0;
    }
  }
}

/** How two non-NULL values of a column compare, as ORDER BY on it would. */
export function comparerOf(c: Pick<DbColumn, 'typeName' | 'typeCat' | 'isArray' | 'enumValues'>): (a: string, b: string) => number {
  if (c.isArray) {
    const el = comparerOf({ ...c, isArray: false });
    return (a, b) => {
      const x = parsePgArray(a);
      const y = parsePgArray(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const p = x[i]!;
        const q = y[i]!;
        if (p === null || q === null) { if (p !== q) return p === null ? 1 : -1; continue; }
        const d = el(p, q);
        if (d) return d;
      }
      return x.length - y.length;
    };
  }
  switch (typeClass(c)) {
    case 'number': return cmpDecimal;
    case 'bool': return (a, b) => Number(a === 't') - Number(b === 't');
    case 'enum': return (a, b) => (c.enumValues?.indexOf(a) ?? 0) - (c.enumValues?.indexOf(b) ?? 0);
    case 'time': return (a, b) => sign((instantOf(a) ?? 0) - (instantOf(b) ?? 0));
    case 'json': return (a, b) => {
      const x = jsonOf(a);
      const y = jsonOf(b);
      return x && y ? cmpJson(x, y) : cmpText(a, b);
    };
    default: return cmpText;
  }
}

/** Whether a cell equals a value as `column = value::type` compares them (keys, equals filters). */
export function equalAs(c: DbColumn, cell: Text, value: string): boolean {
  if (cell === null) return false;
  switch (typeClass(c)) {
    case 'number': return cmpDecimal(cell, value) === 0;
    case 'time': return instantOf(cell) === timeArg(c, value);
    case 'bool': return (cell === 't') === /^(t|true|y|yes|on|1)$/i.test(value.trim());
    // character(n) compares without its padding.
    default: return c.typeName === 'bpchar' ? cell.trimEnd() === value.trimEnd() : cell === value;
  }
}

// ── Filters ────────────────────────────────────────────────────────────────────────────────────────────────────────

const lower = (s: string) => s.toLowerCase();
/** ILIKE with the value's own %, _ and \ taken literally (main escapes them): contains, starts with, ends with. */
function like(op: 'contains' | 'starts' | 'ends' | 'pathContains', cell: string, v: string): boolean {
  const x = lower(cell);
  const y = lower(v);
  return op === 'starts' ? x.startsWith(y) : op === 'ends' ? x.endsWith(y) : x.includes(y);
}

/**
 * Whether a row's cell passes a filter on its column (validated against it before: validFilter). `now` in ms (the
 * last N hours or days). Mirrors main's SQL builders (postgres/sql.ts): not equals and is none of keep the NULL rows
 *; a JSON path reads `#>>` (equals, contains), `#>` (exists, is JSON null).
 */
export function passes(c: DbColumn, f: DbFilter, cell: Text, now: number): boolean {
  const [a = '', b = ''] = f.values;
  const cmp = comparerOf(c);
  const time = typeClass(c) === 'time';
  const order = (v: string, arg: string) => (time ? sign((instantOf(v) ?? 0) - timeArg(c, arg)) : cmp(v, arg));
  switch (f.op) {
    case 'null': return cell === null;
    case 'notnull': return cell !== null;
    case 'true': return cell === 't';
    case 'false': return cell === 'f';
    case 'eq': return equalAs(c, cell, a);
    case 'ne': return cell === null || !equalAs(c, cell, a);
    case 'lt': case 'before': return cell !== null && order(cell, a) < 0;
    case 'le': return cell !== null && order(cell, a) <= 0;
    case 'gt': case 'after': return cell !== null && order(cell, a) > 0;
    case 'ge': return cell !== null && order(cell, a) >= 0;
    case 'between': return cell !== null && order(cell, a) >= 0 && order(cell, b) <= 0;
    case 'contains': case 'starts': case 'ends': return cell !== null && like(f.op, cell, a);
    case 'in': return f.values.some((v) => equalAs(c, cell, v));
    case 'notin': return cell === null || !f.values.some((v) => equalAs(c, cell, v));
    case 'lastHours': case 'lastDays': {
      const span = Number(a) * (f.op === 'lastHours' ? 3_600_000 : 86_400_000);
      return cell !== null && (instantOf(cell) ?? -Infinity) >= (now - span) * 1000;
    }
    case 'has': {
      if (cell === null) return false;
      const el = { ...c, isArray: false };
      return parsePgArray(cell).some((x) => x !== null && equalAs(el, x, a));
    }
    case 'pathEq': return textAt(cell, f.path ?? []) === a;
    case 'pathContains': { const t = textAt(cell, f.path ?? []); return t !== null && like('pathContains', t, a); }
    case 'pathExists': { const n = cell === null ? null : jsonOf(cell); return !!n && nodeAt(n, f.path ?? []) !== undefined; }
    case 'pathNull': { const n = cell === null ? null : jsonOf(cell); return !!n && nodeAt(n, f.path ?? [])?.k === 'z'; }
  }
}

// ── Cells ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Values past this many bytes arrive cut. */
export const CUT_BYTES = 65_536;
/** pg_catalog types whose text is always short: they travel whole (main's postgres/sql.ts SHORT, those the world has and kin). */
const SHORT = new Set(['bool', 'int2', 'int4', 'int8', 'oid', 'float4', 'float8', 'money', 'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval', 'uuid', 'inet', 'cidr', 'macaddr', 'char', 'bpchar', 'name']);
/** Whether a column's values can arrive cut: anything but an enum or a short pg_catalog type. */
export const cutsOf = (c: DbColumn): boolean => c.isArray || (c.typeCat !== 'E' && (c.typeSchema !== 'pg_catalog' || !SHORT.has(c.typeName)));

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** A value as the reply carries it: whole up to CUT_BYTES of UTF-8, else its first CUT_BYTES (on a whole character) and its length. */
export function cellOf(v: Text, cut: boolean): DbCell {
  if (v === null || !cut || v.length * 3 <= CUT_BYTES) return { v };
  const bytes = utf8.encode(v);
  if (bytes.length <= CUT_BYTES) return { v };
  let end = CUT_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { v: fromUtf8.decode(bytes.subarray(0, end)), cut: bytes.length };
}

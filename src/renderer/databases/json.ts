// The JSON tools' pure part: the JSON view's rows — folded at depth 3, arrays
// past 50 items and objects past 1,000 keys as "… N more" rows that show more in place, Expand all, strings holding JSON
// parsed in place and marked, unix times and URLs recognized, Mask values' dots —, find over the tree's data (never the
// DOM: folded and unshown nodes are found, then revealed), the keys of the tree view, the Table view's columns, a node's
// Path, SQL, Filter and JSON column, its copy, the Raw view's text, the column menu's key profile. Every tree is
// json-text.ts's lossless one: numbers are JsonNum leaves, shown and copied as Postgres printed them,
// never through JSON.parse. Iterative throughout: a deeply nested value never overflows the stack. Lazy, with the
// table's chunk. Not `Json.tsx`'s twin: no module here differs from another only by case.
import { FILTER_VALUE_MAX, type DbDerived, type DbFilter, type DbPath } from '@shared/databases-filters';
export { DERIVED_MAX } from '@shared/databases-filters';
import { formatTimestamp, MASK, type DbTimes } from '@shared/pg-format';
import { keyProfile, looksUnixTime, pathLiteral, pathSql, pathText, quoteIdent, type JsonKind, type KeyStat } from '@shared/pg-json';
import { tdt } from '../i18n/db-table';
import { JsonNum } from '../redis/view';
import { pathProblem } from './filters';
import { clipText, looksJsonContainer, maskJson, parseJson, secretKey } from './json-text';

/** A lossless JSON value (json-text.ts parseJson): objects without a prototype, numbers as their source text. */
export type JsonNode = null | boolean | string | number | JsonNum | JsonNode[] | { [key: string]: JsonNode };
type Obj = { [key: string]: JsonNode };
export type NodeKind = Extract<JsonKind, 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'>;

/** Containers fold from this depth at first ("depth ≥ 3 folded at first"; the root is depth 0). */
export const FOLD_DEPTH = 3;
/** An array shows this many items, then "… N more". */
export const MAX_ITEMS = 50;
/** An object shows this many keys, then "… N more": a map of 100,000 keys stays a few rows. */
export const MAX_KEYS = 1000;
/** "… N more" shows this many more at a time. */
export const MORE_STEP = 500;
/** Find stops counting here ("5,000+"). */
export const MAX_HITS = 5000;
/** A string's characters shown in its row (it is one line with an ellipsis; Copy takes the whole of it). */
const STR_SHOWN = 500;
/** A folded object's preview: its first string, this long at most. */
const PREVIEW_STR = 16;
const MASKED_TEXT = JSON.stringify(MASK);

const isNum = (v: unknown): v is JsonNum | number => v instanceof JsonNum || typeof v === 'number';
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNum);
const isLeaf = (v: unknown): boolean => v === null || typeof v !== 'object' || v instanceof JsonNum;
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function nodeKind(v: JsonNode | undefined): NodeKind {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (isNum(v)) return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  return 'object';
}

/** A number's text: as written (a JsonNum), or JavaScript's for a plain one. */
const numText = (v: JsonNum | number) => (v instanceof JsonNum ? v.text : String(v));

/** What Mask values hides (jsonMaskText's rule): a secret key's value, its whole subtree; null and "" stay. */
const masks = (secret: ((k: string) => boolean) | null | undefined, key: string | number | null, v: JsonNode): boolean =>
  !!secret && typeof key === 'string' && v !== null && v !== '' && secret(key);

export { secretKey };

// ---------- ids and paths ----------

const seg = (k: string | number) => (typeof k === 'number' ? `[${k}]` : `.${JSON.stringify(k)}`);
const childId = (parent: string, k: string | number) => parent + seg(k);

/** A node's id (folds, parsed strings, "… N more"): its path, unambiguous. The root is "$". */
export function idOf(path: readonly (string | number)[]): string {
  let id = '$';
  for (const k of path) id += seg(k);
  return id;
}

// A string's JSON, read once (losslessly) while it is shown: the last few kept, by their text.
const PARSED_MAX = 32;
const parsedCache = new Map<string, JsonNode | undefined>();

/** A string holding a JSON object or array, read losslessly; undefined when it isn't whole JSON. */
export function parseString(s: string): JsonNode | undefined {
  if (parsedCache.has(s)) return parsedCache.get(s);
  const v = looksJsonContainer(s) ? (parseJson(s) as JsonNode | undefined) : undefined;
  parsedCache.set(s, v);
  if (parsedCache.size > PARSED_MAX) parsedCache.delete(parsedCache.keys().next().value as string);
  return v;
}

/** A string that may hold JSON: an object or an array starts it (whether it is whole JSON is read when parsed). */
const jsonish = (s: string) => looksJsonContainer(s);

/**
 * An http(s) URL, whole (one token, no spaces): its normalized target (what the browser gets —
 * the tooltip shows it, punycode for a name in another script), or null. shared/links.ts's isSafeUrl's test (pinned by a
 * corpus test; main's openUrl checks it again), here: importing it from this lazy chunk would make the first paint export
 * it. C0 controls at either end are stripped first, as the URL parser strips them.
 */
export function urlOf(s: string): string | null {
  if (s.length > 8192 || /\s/.test(s) || !/^https?:/i.test(s.replace(/^[\u0000-\u001f]+/, ''))) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// ---------- the rows ----------

export interface JsonRow {
  /** Unique among the rows: the node's id; its closing line's and its "… N more" row's derived from it. */
  id: string;
  /** A node's line (an open or folded container: 'open'), a container's closing line, or its "… N more". */
  role: 'open' | 'leaf' | 'close' | 'more';
  depth: number;
  /** From the value's root (through parsed strings). A closing line's and a "… N more"'s: their container's. */
  path: DbPath;
  key: string | number | null;
  kind: NodeKind;
  /** As drawn: a string quoted (its start), a number as written, '{', '{…}', '}', '[]'. */
  text: string;
  folded: boolean;
  /** A container's members; a "… N more" row's not shown. */
  count: number | null;
  /** Dim words after the value: "2026-11-04 18:28 · unix time", "2 items", a folded container's preview. */
  hint: string | null;
  /** Inside a string parsed in place (or that string itself). */
  parsedFromString: boolean;
  comma: boolean;
  /** Mask values on and a secret key: dots. */
  masked: boolean;
  /** An http(s) URL: a link to open in the browser — its normalized target (what the browser gets, the tooltip shows). */
  url: string | null;
  /** A string that looks like JSON: "JSON in a string · Parse". */
  jsonString: boolean;
  /** This string is shown parsed. */
  parsed: boolean;
}

export interface RowsOpts {
  foldDepth?: number;
  maxItems?: number;
  maxKeys?: number;
  /** Expand all: nothing folded at first (folds still flip one). */
  all?: boolean;
  /** Members shown past the caps, by container id ("… N more" pressed). */
  shown?: ReadonlyMap<string, number>;
  /** Mask values on: the secret keys. */
  secret?: ((key: string) => boolean) | null;
  /** Settings › Times for the unix time hint (local: their zone, or `tz`). */
  zone?: { times: DbTimes; tz?: string };
  /** Lines built at most: past them, each level still open ends on its "… N more". */
  budget?: number;
}

/** The tree's lines at most, by default: Expand all on a huge value never builds millions. */
export const ROW_BUDGET = 50_000;

/** "2026-11-04 18:28 · unix time": a unix time in their zone (Settings › Times: UTC or local; "as stored" has no zone). */
export function unixHint(sec: number, zone: { times: DbTimes; tz?: string } = { times: 'local' }): string | null {
  const ms = Math.floor(sec) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  const iso = new Date(ms).toISOString();
  if (!/^\d{4}-/.test(iso)) return null;
  const t = formatTimestamp(`${iso.slice(0, 19).replace('T', ' ')}+00`, 'timestamptz', { times: zone.times === 'utc' ? 'utc' : 'local', tz: zone.tz, now: 0, masked: false });
  return tdt.json.unixHint(t.text);
}

/** A leaf's text as drawn: a string quoted (its start), a number as written, a literal. */
function leafText(v: JsonNode): string {
  if (typeof v === 'string') return JSON.stringify(clipText(v, STR_SHOWN));
  if (isNum(v)) return numText(v);
  return String(v);
}

/** A folded container's preview: "2 items"; an object's one member, or its key count and its first string. */
function preview(v: JsonNode[] | Obj, secret: RowsOpts['secret']): string {
  if (Array.isArray(v)) return tdt.json.items(v.length);
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const k = keys[0]!;
    const x = v[k]!;
    if (isLeaf(x)) return `${k}: ${masks(secret, k, x) ? MASKED_TEXT : leafText(x)}`;
  }
  let first: string | null = null;
  for (const k of keys) {
    const x = v[k]!;
    if (typeof x === 'string' && x !== '' && !masks(secret, k, x)) { first = x; break; }
  }
  return first === null ? tdt.json.keys(keys.length) : `${tdt.json.keys(keys.length)} · ${clipText(first, PREVIEW_STR)}`;
}

interface Frame { node: JsonNode[] | Obj; keys: string[] | null; id: string; path: DbPath; depth: number; i: number; end: number; len: number; inParsed: boolean; comma: boolean }

/**
 * The tree view's rows: a line per node — an open container, its members, its closing line —, folded
 * containers one line with their count and preview; containers at depth ≥ `foldDepth` folded at first (Expand all: none),
 * `folds` flipping each; an array past `maxItems` items (an object past `maxKeys` keys) then "… N more", `shown` taking
 * it further; strings whose id is in `parsed` shown parsed (losslessly), their subtree marked; Mask values' dots.
 */
export function jsonRows(tree: JsonNode, folds: ReadonlySet<string>, parsed: ReadonlySet<string>, o: RowsOpts = {}): JsonRow[] {
  const foldDepth = o.foldDepth ?? FOLD_DEPTH;
  const maxItems = o.maxItems ?? MAX_ITEMS;
  const maxKeys = o.maxKeys ?? MAX_KEYS;
  const zone = o.zone ?? { times: 'local' as DbTimes };
  const out: JsonRow[] = [];
  const stack: Frame[] = [];
  const visit = (v0: JsonNode, key: string | number | null, path: DbPath, id: string, depth: number, comma: boolean, inParsed0: boolean) => {
    const base = { id, depth, path, key, comma, folded: false, count: null, hint: null, masked: false, url: null, jsonString: false, parsed: false, parsedFromString: inParsed0 };
    if (masks(o.secret, key, v0)) {
      out.push({ ...base, role: 'leaf', kind: nodeKind(v0), text: MASKED_TEXT, masked: true });
      return;
    }
    let v = v0;
    let inParsed = inParsed0;
    let parsedRoot = false;
    let failed = false;
    if (typeof v === 'string' && parsed.has(id)) {
      const p = parseString(v);
      if (p !== undefined) { v = p; inParsed = true; parsedRoot = true; } else failed = true;
    }
    if (isLeaf(v)) {
      const s = typeof v === 'string' ? v : null;
      const hint = isNum(v) && typeof key === 'string' && looksUnixTime(key, Number(numText(v))) ? unixHint(Number(numText(v)), zone) : null;
      out.push({ ...base, role: 'leaf', kind: nodeKind(v), text: leafText(v), hint, url: s === null ? null : urlOf(s), jsonString: s !== null && !failed && jsonish(s) });
      return;
    }
    const node = v as JsonNode[] | Obj;
    const arr = Array.isArray(node);
    const keys = arr ? null : Object.keys(node);
    const len = arr ? node.length : keys!.length;
    const kind: NodeKind = arr ? 'array' : 'object';
    const marks = { parsed: parsedRoot, parsedFromString: inParsed };
    if (len === 0) {
      out.push({ ...base, ...marks, role: 'leaf', kind, text: arr ? '[]' : '{}', count: 0 });
      return;
    }
    const folded = (!o.all && depth >= foldDepth && !parsedRoot) !== folds.has(id);
    if (folded) {
      out.push({ ...base, ...marks, role: 'open', kind, text: arr ? '[…]' : '{…}', folded: true, count: len, hint: preview(node, o.secret) });
      return;
    }
    out.push({ ...base, ...marks, role: 'open', kind, text: arr ? '[' : '{', comma: false, count: len, hint: arr ? tdt.json.items(len) : null });
    const limit = Math.max(0, o.shown?.get(id) ?? (arr ? maxItems : maxKeys));
    stack.push({ node, keys, id, path, depth, i: 0, end: Math.min(len, limit), len, inParsed, comma });
  };
  const budget = o.budget ?? ROW_BUDGET;
  visit(tree, null, [], '$', 0, false, false);
  while (stack.length > 0) {
    const f = stack[stack.length - 1]!;
    if (f.i < f.end) {
      // Over the budget: what is left of every level still open goes to its "… N more".
      if (out.length >= budget) { f.end = f.i; continue; }
      const i = f.i++;
      const k: string | number = f.keys ? f.keys[i]! : i;
      const child = f.keys ? (f.node as Obj)[k as string]! : (f.node as JsonNode[])[i]!;
      visit(child, k, [...f.path, k], childId(f.id, k), f.depth + 1, i < f.len - 1, f.inParsed);
      continue;
    }
    stack.pop();
    const kind: NodeKind = f.keys ? 'object' : 'array';
    const tail = { key: null, kind, folded: false, hint: null, masked: false, url: null, jsonString: false, parsed: false, parsedFromString: f.inParsed, path: f.path };
    if (f.len > f.end) out.push({ ...tail, id: `${f.id}…`, role: 'more', depth: f.depth + 1, text: '', count: f.len - f.end, comma: false });
    out.push({ ...tail, id: `${f.id}/`, role: 'close', depth: f.depth, text: f.keys ? '}' : ']', count: null, comma: f.comma });
  }
  return out;
}

/** The rows a find highlights: a key or a value holding `q`, any case; masked values only by their key. */
export function findHits(rows: readonly JsonRow[], q: string): number[] {
  const s = q.trim().toLowerCase();
  if (s === '') return [];
  const out: number[] = [];
  rows.forEach((r, i) => { if (rowMatches(r, s)) out.push(i); });
  return out;
}

/** Whether a row holds `s` (lower case already): its key, or a leaf's value as drawn (a string without its quotes). */
export function rowMatches(r: JsonRow, s: string): boolean {
  if (r.role === 'close' || r.role === 'more') return false;
  if (typeof r.key === 'string' && r.key.toLowerCase().includes(s)) return true;
  if (r.role !== 'leaf' || r.masked) return false;
  const text = r.kind === 'string' ? r.text.slice(1, -1) : r.text;
  return text.toLowerCase().includes(s);
}

// ---------- find over the tree ----------

export interface Finder {
  /** The hits so far, in document order (a node once). */
  readonly hits: DbPath[];
  /** Stopped at MAX_HITS. */
  readonly capped: boolean;
  /** Reads up to `budget` more nodes; true once done. */
  step(budget: number): boolean;
}

interface FindFrame { node: JsonNode[] | Obj; keys: string[] | null; i: number; path: DbPath; id: string }

/**
 * Find over the tree's data, never the DOM: every node — folded, past "… N more", inside parsed strings —
 * whose key or value holds `q` (any case); a masked value only by its key, never walked into. Step by step, so a 16 MB
 * value is searched a slice at a time without holding the window.
 */
export function startFind(tree: JsonNode, q: string, parsed: ReadonlySet<string>, secret: ((k: string) => boolean) | null): Finder {
  const s = q.trim().toLowerCase();
  const hits: DbPath[] = [];
  let capped = false;
  let done = s === '';
  const stack: FindFrame[] = [];
  const valueHolds = (v: JsonNode) => (typeof v === 'string' ? v : isNum(v) ? numText(v) : String(v)).toLowerCase().includes(s);
  /** One node: a hit by its key or its value; a container read next. */
  const visit = (v0: JsonNode, key: string | number | null, path: DbPath, id: string) => {
    let hit = typeof key === 'string' && key.toLowerCase().includes(s);
    if (masks(secret, key, v0)) {
      if (hit) hits.push(path);
      return;
    }
    let v = v0;
    if (typeof v === 'string' && parsed.has(id)) v = parseString(v) ?? v;
    if (isLeaf(v)) hit ||= valueHolds(v);
    if (hit) hits.push(path);
    if (!isLeaf(v)) stack.push({ node: v as JsonNode[] | Obj, keys: Array.isArray(v) ? null : Object.keys(v as Obj), i: 0, path, id });
  };
  let started = false;
  return {
    hits,
    get capped() { return capped; },
    step(budget: number): boolean {
      if (done) return true;
      let n = budget;
      if (!started) { started = true; visit(tree, null, [], '$'); n--; }
      while (n > 0 && stack.length > 0) {
        if (hits.length >= MAX_HITS) break;
        const f = stack[stack.length - 1]!;
        const len = f.keys ? f.keys.length : (f.node as JsonNode[]).length;
        if (f.i >= len) { stack.pop(); continue; }
        const i = f.i++;
        const k: string | number = f.keys ? f.keys[i]! : i;
        visit(f.keys ? (f.node as Obj)[k as string]! : (f.node as JsonNode[])[i]!, k, [...f.path, k], childId(f.id, k));
        n--;
      }
      if (hits.length >= MAX_HITS) {
        hits.length = MAX_HITS;
        capped = true;
        done = true;
      } else if (stack.length === 0) done = true;
      return done;
    }
  };
}

/**
 * What makes a node's row show (a find's hit, a breadcrumb's step): its ancestors open — a default-folded one flipped,
 * a default-open one the user folded unflipped — and every container's count shown far enough to hold the next step.
 */
export function revealPath(tree: JsonNode, path: DbPath, o: { folds: ReadonlySet<string>; shown: ReadonlyMap<string, number>; parsed: ReadonlySet<string>; all?: boolean; foldDepth?: number; maxItems?: number; maxKeys?: number }): { folds: Set<string>; shown: Map<string, number> } {
  const folds = new Set(o.folds);
  const shown = new Map(o.shown);
  const foldDepth = o.foldDepth ?? FOLD_DEPTH;
  let v: JsonNode | undefined = tree;
  let id = '$';
  for (let d = 0; d < path.length; d++) {
    let parsedRoot = false;
    if (typeof v === 'string' && o.parsed.has(id)) {
      const p = parseString(v);
      if (p !== undefined) { v = p; parsedRoot = true; }
    }
    if (v === undefined || isLeaf(v)) break;
    if (!o.all && d >= foldDepth && !parsedRoot) folds.add(id); else folds.delete(id);
    const k = path[d]!;
    const arr = Array.isArray(v);
    const at: number = arr ? (typeof k === 'number' ? k : -1) : typeof k === 'string' ? Object.keys(v as Obj).indexOf(k) : -1;
    if (at < 0) break;
    const step = arr ? o.maxItems ?? MAX_ITEMS : o.maxKeys ?? MAX_KEYS;
    const limit = shown.get(id) ?? step;
    if (at >= limit) shown.set(id, Math.ceil((at + 1) / step) * step);
    v = arr ? (v as JsonNode[])[at] : (v as Obj)[k as string];
    id = childId(id, k);
  }
  return { folds, shown };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const sameMap = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) => a.size === b.size && [...a].every(([k, n]) => b.get(k) === n);

/**
 * Whether a node that isn't among the rows is hidden by the line budget alone: every container on its way open and
 * it within their "… N more" — revealPath would change nothing. Only then does a bigger budget show it.
 */
export function budgetHidden(tree: JsonNode, path: DbPath, o: { folds: ReadonlySet<string>; shown: ReadonlyMap<string, number>; parsed: ReadonlySet<string>; all?: boolean }): boolean {
  const r = revealPath(tree, path, o);
  return sameSet(r.folds, o.folds) && sameMap(r.shown, o.shown);
}

/** The tree's line budget, grown for one value: another value (another row's, read again) starts from ROW_BUDGET. */
export interface TreeBudget { tree: JsonNode; n: number }
export const budgetOf = (b: TreeBudget, tree: JsonNode): number => (b.tree === tree ? b.n : ROW_BUDGET);

/**
 * The part of a selection still shown with Mask values on: down to its first secret key whose value is masked —
 * the key shows (its value as dots), nothing under it does. The whole path without the mask.
 */
export function visiblePath(tree: JsonNode, path: DbPath, parsed: ReadonlySet<string>, secret: ((k: string) => boolean) | null): DbPath {
  if (!secret) return path;
  for (let i = 0; i < path.length; i++) {
    const k = path[i]!;
    if (typeof k === 'string' && masks(secret, k, nodeAt(tree, path.slice(0, i + 1), parsed) ?? null)) return path.slice(0, i + 1);
  }
  return path;
}

// ---------- the tree's keys ----------

export type TreeAction = { kind: 'move'; to: number } | { kind: 'toggle'; id: string } | { kind: 'url'; url: string } | { kind: 'more'; id: string };

const selectable = (r: JsonRow | undefined) => r !== undefined && r.role !== 'close';

/**
 * A key in the tree: ↑/↓ the previous / next line (closing lines skipped), Home / End; ← folds an open
 * container, else goes to its parent; → unfolds a folded one, else goes into it; Enter opens a URL in the browser,
 * toggles a container, shows more items. Null: not the tree's (it goes on to the inspector, the app).
 */
export function treeKey(key: string, rows: readonly JsonRow[], at: number): TreeAction | null {
  const move = (to: number) => (to === at ? null : { kind: 'move' as const, to });
  const r = rows[at];
  switch (key) {
    case 'ArrowDown': {
      for (let i = at + 1; i < rows.length; i++) if (selectable(rows[i])) return move(i);
      return null;
    }
    case 'ArrowUp': {
      for (let i = Math.min(at, rows.length) - 1; i >= 0; i--) if (selectable(rows[i])) return move(i);
      return null;
    }
    case 'Home': {
      const i = rows.findIndex(selectable);
      return i < 0 ? null : move(i);
    }
    case 'End': {
      for (let i = rows.length - 1; i >= 0; i--) if (selectable(rows[i])) return move(i);
      return null;
    }
    case 'ArrowLeft': {
      if (!r) return null;
      if (r.role === 'open' && !r.folded) return { kind: 'toggle', id: r.id };
      for (let i = at - 1; i >= 0; i--) if (rows[i]!.role === 'open' && rows[i]!.depth === r.depth - 1) return move(i);
      return null;
    }
    case 'ArrowRight': {
      if (!r || r.role !== 'open') return null;
      return r.folded ? { kind: 'toggle', id: r.id } : move(at + 1);
    }
    case 'Enter': {
      if (!r) return null;
      if (r.role === 'leaf' && r.url) return { kind: 'url', url: r.url };
      if (r.role === 'open') return { kind: 'toggle', id: r.id };
      if (r.role === 'more') return { kind: 'more', id: idOf(r.path) };
      return null;
    }
    default: return null;
  }
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** A key a scroller (Table, Raw) keeps: it scrolls there, never moves the inspector's row. */
export const scrollKey = (key: string): boolean => SCROLL_KEYS.has(key);

/** Esc clears the find first only where the find shows — the Tree — and holds something. */
export const escClearsFind = (view: 'tree' | 'table' | 'raw', q: string): boolean => view === 'tree' && q !== '';

// ---------- a node ----------

/**
 * The node at `path` from the root, through strings shown parsed (a parsed string's own node: its JSON); undefined when
 * the path isn't there.
 */
export function nodeAt(tree: JsonNode, path: DbPath, parsed: ReadonlySet<string>): JsonNode | undefined {
  let v: JsonNode | undefined = tree;
  let id = '$';
  const open = () => { if (typeof v === 'string' && parsed.has(id)) v = parseString(v) ?? v; };
  for (const k of path) {
    open();
    if (Array.isArray(v) && typeof k === 'number') v = v[k];
    else if (isObj(v) && typeof k === 'string' && has(v, k)) v = v[k];
    else return undefined;
    id = childId(id, k);
  }
  open();
  return v;
}

/** The path cut where it goes into a parsed string: the first part reads the column, each next one the string's JSON. */
function segments(path: DbPath, parsed: ReadonlySet<string>): DbPath[] {
  const segs: DbPath[] = [[]];
  let id = '$';
  if (parsed.has(id)) segs.push([]);
  for (const k of path) {
    segs[segs.length - 1]!.push(k);
    id = childId(id, k);
    if (parsed.has(id)) segs.push([]);
  }
  return segs;
}

/** Only the strings actually parsed along `path` (a parsed id left from another row's value counts for nothing). */
export function parsedAlong(tree: JsonNode, path: DbPath, parsed: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (parsed.size === 0) return out;
  let v: JsonNode | undefined = tree;
  let id = '$';
  for (let d = 0; ; d++) {
    if (typeof v === 'string' && parsed.has(id)) {
      const p = parseString(v);
      if (p !== undefined) { out.add(id); v = p; }
    }
    if (d >= path.length) return out;
    const k = path[d]!;
    if (Array.isArray(v) && typeof k === 'number') v = v[k];
    else if (isObj(v) && typeof k === 'string' && has(v, k)) v = v[k];
    else return out;
    id = childId(id, k);
  }
}

const tailText = (p: DbPath) => {
  if (p.length === 0) return '';
  const t = pathText(p);
  return t.startsWith('[') ? t : `.${t}`;
};

/**
 * The bottom bar's Path (data.object.lines.data[0].price.unit_amount), from the column: a JSON column's own path
 * first. Inside a parsed string: JSON.parse(<the string's path>) and the path in it.
 */
export function jsonPathText(base: DbPath, path: DbPath, parsed: ReadonlySet<string>): string {
  const segs = segments(path, parsed);
  segs[0] = [...base, ...segs[0]!];
  let text = pathText(segs[0]!);
  for (const s of segs.slice(1)) text = `JSON.parse(${text || '$'})${tailText(s)}`;
  return text;
}

/**
 * The bottom bar's SQL (payload #>> '{data,object,…}'): the column, read at the path; the whole value is the
 * column itself. Inside a parsed string: the string read as jsonb, then the path in it (pg-json's pathSql and its literal).
 */
export function jsonPathSql(column: string, base: DbPath, path: DbPath, parsed: ReadonlySet<string>): string {
  const segs = segments(path, parsed);
  segs[0] = [...base, ...segs[0]!];
  if (segs.length === 1) return segs[0]!.length === 0 ? quoteIdent(column) : pathSql(column, segs[0]!);
  let sql = pathSql(column, segs[0]!);
  for (const s of segs.slice(1)) sql = `(${sql})::jsonb${s.length > 0 ? ` #>> ${pathLiteral(s)}` : ''}`;
  return sql;
}

/**
 * The hover action Filter: rows where this path equals this value — as #>> prints it: a string's text, a
 * number as written, true / false — the filter popover's pathEq; a JSON null, is JSON null (pathNull: #>>
 * reads one as SQL NULL, as it reads a missing key); a container, rows where the path exists (pathExists). Null when no
 * filter reaches it: the whole value, a path inside a parsed string, past main's bounds.
 */
export function nodeFilter(column: string, base: DbPath, path: DbPath, node: JsonNode | undefined, parsed: ReadonlySet<string>): DbFilter | null {
  if (node === undefined || segments(path, parsed).length > 1) return null;
  const full = [...base, ...path];
  if (full.length === 0 || pathProblem(full)) return null;
  if (node === null) return { column, path: full, op: 'pathNull', values: [] };
  if (!isLeaf(node)) return { column, path: full, op: 'pathExists', values: [] };
  const v = typeof node === 'string' ? node : isNum(node) ? numText(node) : String(node);
  if (v.length > FILTER_VALUE_MAX || v.includes('\0')) return null;
  return { column, path: full, op: 'pathEq', values: [v] };
}

/** The hover action + Column: its column and the whole path; null for the whole value, a parsed string's inside. */
export function nodeDerived(column: string, base: DbPath, path: DbPath, parsed: ReadonlySet<string>): DbDerived | null {
  if (segments(path, parsed).length > 1) return null;
  const full = [...base, ...path];
  if (full.length === 0 || pathProblem(full)) return null;
  return { column, path: full };
}

/** The breadcrumb's steps: keys, and [i] for an array's item. */
export const crumbs = (path: DbPath): string[] => path.map((k) => (typeof k === 'number' ? `[${k}]` : k));

/**
 * What Copy copies: a string its text, a number as written, a literal, a container pretty-printed (2 spaces,
 * numbers exact); masked (`masked`, or a secret key inside it), dots.
 */
export function nodeCopy(node: JsonNode | undefined, secret: ((k: string) => boolean) | null = null, masked = false): string {
  if (masked) return MASK;
  if (node === undefined) return '';
  if (typeof node === 'string') return node;
  if (isNum(node)) return numText(node);
  if (isLeaf(node)) return String(node);
  return prettyJson(node, { secret }).text;
}

interface PrettyFrame { node: JsonNode[] | Obj; keys: string[] | null; i: number; depth: number }

/**
 * The Raw view's text: pretty-printed with 2 spaces, as JSON.stringify(v, null, 2) lays it out but every
 * number as written; a secret key's value as dots. Stops past `max` characters (`cut`): a 16 MB value never builds a
 * 30 MB string to show its start.
 */
export function prettyJson(node: JsonNode, o: { secret?: ((k: string) => boolean) | null; max?: number } = {}): { text: string; cut: boolean } {
  const max = o.max ?? Infinity;
  const out: string[] = [];
  let len = 0;
  let cut = false;
  const push = (s: string) => { out.push(s); len += s.length; if (len > max) cut = true; };
  const stack: PrettyFrame[] = [];
  const pad = (d: number) => '  '.repeat(d);
  const value = (v: JsonNode, depth: number) => {
    if (isLeaf(v)) { push(typeof v === 'string' ? JSON.stringify(v) : isNum(v) ? numText(v) : String(v)); return; }
    const arr = Array.isArray(v);
    const keys = arr ? null : Object.keys(v as Obj);
    if ((arr ? (v as JsonNode[]).length : keys!.length) === 0) { push(arr ? '[]' : '{}'); return; }
    push(arr ? '[' : '{');
    stack.push({ node: v as JsonNode[] | Obj, keys, i: 0, depth });
  };
  value(node, 0);
  while (stack.length > 0 && !cut) {
    const f = stack[stack.length - 1]!;
    const n = f.keys ? f.keys.length : (f.node as JsonNode[]).length;
    if (f.i < n) {
      push(f.i === 0 ? '\n' : ',\n');
      push(pad(f.depth + 1));
      const i = f.i++;
      if (!f.keys) value((f.node as JsonNode[])[i]!, f.depth + 1);
      else {
        const k = f.keys[i]!;
        const v = (f.node as Obj)[k]!;
        push(`${JSON.stringify(k)}: `);
        value(masks(o.secret, k, v) ? MASK : v, f.depth + 1);
      }
      continue;
    }
    stack.pop();
    push(`\n${pad(f.depth)}${f.keys ? '}' : ']'}`);
  }
  const text = out.join('');
  return cut ? { text: text.slice(0, max), cut } : { text, cut };
}

// ---------- the Table view ----------

const TABLE_COLUMNS_MAX = 200;

/** An array of objects' columns: the union of their keys, in order of first appearance (200 at most); null otherwise. */
export function tableColumns(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isObj)) return null;
  const seen = new Set<string>();
  for (const item of value as Obj[]) {
    for (const k in item) {
      seen.add(k);
      if (seen.size >= TABLE_COLUMNS_MAX) return [...seen];
    }
  }
  return [...seen];
}

/** The Table view: for an array of objects, columns = the union of keys, a row per item (a missing key undefined). */
export function tableOf(value: unknown): { columns: string[]; rows: unknown[][] } | null {
  const columns = tableColumns(value);
  if (!columns) return null;
  return { columns, rows: (value as Obj[]).map((item) => columns.map((c) => (has(item, c) ? item[c] : undefined))) };
}

/** Whether a path goes through a key Mask values hides (its whole subtree hides with it). */
const crossesSecret = (path: DbPath, secret: ((k: string) => boolean) | null): boolean => !!secret && path.some((k) => typeof k === 'string' && secret(k));

/**
 * Which array the Table view shows: the selected node's, else its nearest ancestor's (the root's last) that is one. Mask
 * values on, one under a secret key is refused — the tree shows it as dots —, the next one out
 * taken; 'masked' when only refused ones were there (the Table segment says why).
 */
export function tableTargetOf(tree: JsonNode, path: DbPath, parsed: ReadonlySet<string>, secret: ((k: string) => boolean) | null): DbPath | 'masked' | null {
  let refused = false;
  for (let n = path.length; n >= 0; n--) {
    const p = path.slice(0, n);
    if (!tableColumns(nodeAt(tree, p, parsed))) continue;
    if (!crossesSecret(p, secret)) return p;
    refused = true;
  }
  return refused ? 'masked' : null;
}

/**
 * A Table view cell (its path: the table's, the item's index, the column's key): a string's text (its start), a number as
 * written, a literal, a container folded, nothing for a missing key; dots when a key on its path names a secret (Mask
 * values on; null and "" stay, as jsonMaskText's rule).
 */
export function tableCell(v: unknown, path: DbPath, secret: ((k: string) => boolean) | null): { text: string; cls: string } {
  if (v === undefined) return { text: '', cls: 'is-none' };
  if (v !== null && v !== '' && crossesSecret(path, secret)) return { text: MASK, cls: 'is-mask' };
  if (v === null) return { text: 'null', cls: 'is-l' };
  if (typeof v === 'string') return { text: clipText(v, 200), cls: 'is-s' };
  if (typeof v === 'boolean') return { text: String(v), cls: 'is-l' };
  if (isNum(v)) return { text: numText(v), cls: 'is-n' };
  if (Array.isArray(v)) return { text: v.length === 0 ? '[]' : `[…${v.length}]`, cls: 'is-fo' };
  return { text: Object.keys(v as object).length === 0 ? '{}' : '{…}', cls: 'is-fo' };
}

// ---------- sizes and copies of a column ----------

/** A text's UTF-8 size (the field's "jsonb · 214 B", the JSON view's "row 88213 · 3.4 KB"). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

/**
 * A JSON text on one line (JSON Lines): the whitespace between its tokens dropped, its strings and numbers exactly as
 * written. jsonb's text is one line already; a json column keeps what was stored, newlines too. Never parsed.
 */
export function oneLine(s: string): string {
  if (!/[\n\r]/.test(s)) return s;
  let out = '';
  let from = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 32 || c === 9 || c === 10 || c === 13) {
      out += s.slice(from, i);
      from = i + 1;
    }
  }
  return out + s.slice(from);
}

/**
 * Copy Column as JSON Lines: a line per loaded row — its value as Postgres printed it (numbers exact), NULL as
 * null —, masked as the grid shows it (a secret key's value, a masked column's every value, as a JSON string of dots); a
 * value cut at 64 KB as loaded, counted for the toast (masked).
 */
export function columnJsonLines(cells: readonly ({ v: string | null; cut?: number } | undefined)[], o: { masked: boolean; column: boolean }): { text: string; cut: number } {
  let cut = 0;
  const lines = cells.map((c) => {
    if (!c || c.v === null) return 'null';
    if (o.column) return MASKED_TEXT;
    if (c.cut !== undefined) {
      cut++;
      return o.masked ? MASKED_TEXT : oneLine(c.v);
    }
    const m = maskJson(c.v, o.masked);
    return m === MASK ? MASKED_TEXT : oneLine(m);
  });
  return { text: lines.join('\n'), cut };
}

// ---------- a line's menu ----------

export type LineMenuId = 'copy' | 'path' | 'sql' | 'filter' | 'column' | 'url' | 'parse' | 'unparse';
export interface LineItem { id: LineMenuId; label: string; detail?: string; disabled: boolean; tip?: string; checked?: boolean }

/**
 * A tree line's right-click menu (Shift+F10 on the tree): its hover actions as menu items (Title Case) — Copy Value, Copy
 * Path, Copy SQL; Filter by This Value (a JSON null too; Filter Where This Path Exists for a container), Add as Column (checked
 * when it is one); a URL's Open Link; Parse JSON in String or Show as String. Off with why: no path (the whole value),
 * out of reach (`reach`: inside a parsed string, past main's bounds).
 */
export function lineMenu(r: JsonRow, c: { hasPath: boolean; reach: boolean; shown: boolean }): (LineItem | 'sep')[] {
  const m = tdt.json.menu;
  const a = tdt.json.act;
  const why = (no: string) => (c.reach ? {} : { tip: r.parsedFromString ? a.inString : no });
  const exists = r.kind === 'object' || r.kind === 'array';
  const items: (LineItem | 'sep')[] = [
    { id: 'copy', label: m.copy, disabled: false },
    { id: 'path', label: m.path, disabled: !c.hasPath },
    { id: 'sql', label: m.sql, disabled: false },
    'sep',
    { id: 'filter', label: exists ? m.filterExists : m.filter, disabled: !c.reach, ...why(a.noFilter) },
    { id: 'column', label: m.column, disabled: !c.reach || c.shown, ...(c.shown ? { checked: true } : {}), ...why(a.noColumn) }
  ];
  if (r.url && !r.masked) items.push('sep', { id: 'url', label: m.openLink, detail: clipText(r.url, 48), disabled: false });
  if (r.jsonString) items.push('sep', { id: 'parse', label: m.parse, disabled: false });
  if (r.parsed) items.push('sep', { id: 'unparse', label: m.unparse, disabled: false });
  return items;
}

// ---------- the column menu ----------

export type ColMenuId = 'filter-key' | 'sort-key' | 'sort-asc' | 'sort-desc' | 'filter' | 'hide' | 'remove' | 'copy-name' | 'copy-lines' | 'wrap';

/**
 * The column menu's items, after a JSON column's key profile: Filter by Key…, Sort by Key…, then the
 * sorts, Hide Column, Copy Column Name, Copy Column as JSON Lines, Wrap Cells; any other column Sort Ascending, Sort
 * Descending, Filter…, Hide Column (a JSON column added from a key: Remove Column), Copy Column Name, Wrap Cells.
 */
export function colMenuItems(c: { json: boolean; derived: boolean }): (ColMenuId | 'sep')[] {
  if (c.json) return ['filter-key', 'sort-key', 'sep', 'sort-asc', 'sort-desc', 'sep', 'hide', 'copy-name', 'copy-lines', 'sep', 'wrap'];
  return ['sort-asc', 'sort-desc', 'filter', 'sep', c.derived ? 'remove' : 'hide', 'copy-name', 'sep', 'wrap'];
}

// ---------- the key profile ----------

/**
 * A key path as the profile shows it: pathText's own segments — the prefix dim, the last key
 * bright —, so a key "a.b" reads ["a.b"], never the path a.b.
 */
export function profileLabel(path: DbPath): { pre: string; leaf: string } {
  const pre = pathText(path.slice(0, -1));
  const rest = pathText(path).slice(pre.length);
  return rest.startsWith('.') ? { pre: `${pre}.`, leaf: rest.slice(1) } : { pre, leaf: rest };
}

export interface ColumnProfile {
  /** Values read (rows). */
  read: number;
  /** Of them, the JSON objects (the presence bars' whole). */
  objects: number;
  stats: KeyStat[];
}

/**
 * The column menu's "Keys in these N rows": pg-json's keyProfile over the rows' values read losslessly —
 * numbers are numbers (unix time under a time-like key), never JSON.parse —; Mask values on, a secret key says masked and
 * its subtree isn't read. At most `maxRows` values and about `maxChars` characters: a page of big values stays quick.
 */
export function columnProfile(values: readonly (string | null)[], masked: boolean, o: { maxRows?: number; maxChars?: number } = {}): ColumnProfile {
  const maxRows = o.maxRows ?? 1000;
  const maxChars = o.maxChars ?? 4_000_000;
  const trees: Obj[] = [];
  let read = 0;
  let chars = 0;
  for (const v of values) {
    if (read >= maxRows || chars >= maxChars) break;
    read++;
    if (v === null) continue;
    chars += v.length;
    if (!/^\s*\{/.test(v)) continue;
    const t = parseJson(v);
    if (isObj(t)) trees.push(t);
  }
  const leaf = (key: string, v: unknown): JsonKind | undefined => {
    if (masked && masks(secretKey, key, v as JsonNode)) return 'masked';
    if (v instanceof JsonNum) return looksUnixTime(key, Number(v.text)) ? 'unix' : 'number';
    return undefined;
  };
  return { read, objects: trees.length, stats: keyProfile(trees, { leaf }) };
}

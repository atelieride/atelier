// Structure's pure helpers: the layout at every width, the columns'
// badges and notes, an index's keys and the WHERE of a partial one, "never used", the Size card's numbers, the wording
// of constraints and triggers, and the DDL's colors (a small tokenizer: the code view stays text, no editor). Lazy,
// with the table's chunk.
import { compactCount, type DbConstraint, type DbIndex, type DbStructure } from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { tdt } from '../i18n/db-table';

// ── Layout ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Below this width (the tab's) the cards go under the tables: one column. */
export const STACK_BELOW = 720;
const SIDE_MIN = 320;
const SIDE_MAX = 420;

/**
 * Two columns — the tables, and the cards beside them at ~36% (320–420 px) — or, narrower than STACK_BELOW, one column.
 * A tab not measured yet (0: hidden) gets the wide layout: never a stacked flash when it shows.
 */
export function structureLayout(width: number): { stacked: boolean; side: number } {
  if (width > 0 && width < STACK_BELOW) return { stacked: true, side: 0 };
  if (width <= 0) return { stacked: false, side: SIDE_MAX };
  return { stacked: false, side: Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(width * 0.36))) };
}

// ── Columns ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type StructColumn = DbStructure['columns'][number];

/** The text inside the outermost parentheses that open at `from` (the end when they never close). */
function group(s: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return s.slice(from + 1, i);
  }
  return s.slice(from + 1);
}

/** Splits at commas outside parentheses and quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

/** An index's first key column, when it is a plain column (an expression has none): from pg_get_indexdef's text. */
function leadingColumn(def: string): string | null {
  const using = / USING \w+ \(/.exec(def);
  if (!using) return null;
  const first = splitTop(group(def, using.index + using[0].length - 1))[0] ?? '';
  const m = /^(?:"((?:[^"]|"")*)"|([a-z_][a-z0-9_$]*))(?:\s|$)/.exec(first);
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]!;
}

/** A badge's rank when a column leads several indexes: a unique one says most, then a btree, then another method. */
const rank = (b: string) => (b === 'UNIQUE' ? 2 : b === 'IDX' ? 1 : 0);

/**
 * The columns the indexes lead (not the primary key's), each with its badge: UNIQUE for a unique index, IDX for a
 * btree, the method's name otherwise (GIN, GIST, BRIN…). Only a leading key column counts (it is what makes the column
 * searchable). Read once per structure (StructureView memoizes it): a 300-column table never parses its indexes per row.
 */
export function indexBadges(indexes: readonly DbIndex[]): Map<string, string> {
  const led = new Map<string, string>();
  for (const i of indexes) {
    if (i.primary) continue;
    const col = leadingColumn(i.def);
    if (col === null) continue;
    const badge = i.unique ? 'UNIQUE' : i.method === 'btree' ? 'IDX' : i.method.toUpperCase();
    const had = led.get(col);
    if (had === undefined || rank(badge) > rank(had)) led.set(col, badge);
  }
  return led;
}

/** Board 4's badges: PK, FK; else the one of the index the column leads (`led`: indexBadges). */
export function columnBadges(col: Pick<DbColumn, 'name' | 'isPk' | 'fk'>, led: ReadonlyMap<string, string>): string[] {
  if (col.isPk) return ['PK'];
  if (col.fk) return ['FK'];
  const badge = led.get(col.name);
  return badge ? [badge] : [];
}

/** A check without its keyword and outer parentheses: "CHECK ((total >= (0)::numeric))" → "total >= (0)::numeric". */
export function checkText(def: string): string {
  const parts = def.split(/,\s*(?=CHECK \()/);
  if (!parts.every((p) => p.startsWith('CHECK ('))) return def;
  return parts.map((p) => {
    const inner = group(p, 6);
    const rest = p.slice(6 + inner.length + 2).trim();
    const bare = inner.startsWith('(') && group(inner, 0).length === inner.length - 2 ? inner.slice(1, -1) : inner;
    return rest ? `${bare} ${rest}` : bare;
  }).join(', ');
}

export type ColumnNote =
  | { kind: 'fk'; text: string; target: { schema: string; name: string } }
  | { kind: 'text'; text: string }
  | { kind: 'comment'; text: string };

/** The Notes cell: the FK target (a link), an enum's values, its checks, a generated expression, the comment. */
export function columnNotes(col: StructColumn, schema: string): ColumnNote[] {
  const s = tdt.struct;
  const out: ColumnNote[] = [];
  if (col.fk) {
    const table = col.fk.schema === schema ? col.fk.table : `${col.fk.schema}.${col.fk.table}`;
    out.push({ kind: 'fk', text: `→ ${table}.${col.fk.column}`, target: { schema: col.fk.schema, name: col.fk.table } });
  }
  if (col.enumValues) out.push({ kind: 'text', text: s.enumValues(col.enumValues.length) });
  if (col.check) out.push({ kind: 'text', text: s.check(checkText(col.check)) });
  if (col.generated) out.push({ kind: 'text', text: s.generatedAs(col.generated) });
  if (col.comment) out.push({ kind: 'comment', text: `“${col.comment}”` });
  return out;
}

// ── Indexes ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Outer parentheses off, when they wrap the whole text. */
const unwrap = (s: string): string => (s.startsWith('(') && group(s, 0).length === s.length - 2 ? s.slice(1, -1) : s);

/**
 * What an index is on: the keys after its method (INCLUDE columns too), and a partial index's WHERE apart, as pg_get_expr
 * wrote it (outer parentheses off). Something unexpected: the whole definition, rather than a wrong cut.
 */
export function indexKeys(i: Pick<DbIndex, 'def' | 'partial'>): { keys: string; where: string | null } {
  const using = / USING \w+ (?=\()/.exec(i.def);
  if (!using) return { keys: i.def, where: null };
  let keys = i.def.slice(using.index + using[0].length);
  let where: string | null = null;
  if (i.partial !== null) {
    const tail = ` WHERE ${i.partial}`;
    const at = keys.endsWith(tail) ? keys.length - tail.length : keys.lastIndexOf(' WHERE ');
    if (at >= 0) {
      where = unwrap(i.partial);
      keys = keys.slice(0, at);
    }
  }
  return { keys, where };
}

/** Scans: "2.1M scans"; "never used" (amber) for a non-unique index main found never scanned (DbIndex.neverUsed); "—" without statistics. */
export function scansLabel(i: Pick<DbIndex, 'scans' | 'neverUsed'>): { text: string; never: boolean } {
  if (i.scans === null) return { text: '—', never: false };
  if (i.neverUsed) return { text: tdt.struct.neverUsed, never: true };
  return { text: tdt.struct.scans(compactCount(i.scans), i.scans), never: false };
}

// ── Size ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const UNITS = ['KB', 'MB', 'GB', 'TB'];

/** "512 B", "40 KB", "1.1 MB", "18.3 MB", "2.4 GB": kilobytes whole, the larger units to one decimal. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
  return `${u === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${UNITS[u]}`;
}

export type SizePart = 'table' | 'indexes' | 'toast';
/** A part with bytes always shows: at least this share of the bar. */
const MIN_PCT = 2;

/**
 * The stacked bar: table, indexes and TOAST in shares of their sum, to a tenth; a part with bytes never
 * thinner than MIN_PCT (the others give way), empty ones left out; the shares add up to 100.
 */
export function sizeBar(size: Pick<DbStructure['size'], SizePart>): { part: SizePart; bytes: number; pct: number }[] {
  const parts = (['table', 'indexes', 'toast'] as const).map((part) => ({ part, bytes: size[part] })).filter((p) => p.bytes > 0);
  const sum = parts.reduce((s, p) => s + p.bytes, 0);
  if (sum === 0) return [];
  const raw = parts.map((p) => (p.bytes / sum) * 100);
  const small = raw.map((r) => r < MIN_PCT);
  const room = 100 - MIN_PCT * small.filter(Boolean).length;
  const big = raw.reduce((s, r, i) => s + (small[i] ? 0 : r), 0);
  const pct = raw.map((r, i) => (small[i] ? MIN_PCT : Math.round(((r / big) * room) * 10) / 10));
  // The rounding's remainder goes to the largest part: the bar always fills.
  const top = pct.indexOf(Math.max(...pct));
  pct[top] = Math.round((100 - pct.reduce((s, x, i) => (i === top ? s : s + x), 0)) * 10) / 10;
  return parts.map((p, i) => ({ ...p, pct: pct[i]! }));
}

/** Dead rows as a share of all rows (live estimate + dead): "1.2%", "<0.1%"; null when neither is known. */
export function deadShare(stats: DbStructure['stats']): string | null {
  if (stats.dead === null) return null;
  const all = (stats.estimate ?? 0) + stats.dead;
  if (stats.dead === 0 || all === 0) return '0%';
  const pct = (stats.dead / all) * 100;
  if (pct < 0.1) return '<0.1%';
  return `${Math.round(pct * 10) / 10}%`;
}

/** "2 h ago" from an ISO time; null for never. */
export function since(iso: string | null, now: number): string | null {
  if (iso === null) return null;
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  const a = tdt.ago;
  if (s < 5) return a.now;
  if (s < 60) return a.sec(s);
  if (s < 3600) return a.min(Math.floor(s / 60));
  if (s < 86_400) return a.hour(Math.floor(s / 3600));
  return tdt.struct.days(Math.floor(s / 86_400));
}

// ── Constraints and triggers ───────────────────────────────────────────────────────────────────────────────────────

const LEADS: [DbConstraint['kind'], string][] = [['p', 'PRIMARY KEY'], ['f', 'FOREIGN KEY'], ['u', 'UNIQUE'], ['c', 'CHECK'], ['x', 'EXCLUDE']];
const TRIGGER = /^CREATE TRIGGER \S+ (BEFORE|AFTER|INSTEAD OF) (.+?) ON \S+ (?:FOR EACH (?:ROW|STATEMENT) )?(?:WHEN \(.*\) )?EXECUTE (?:FUNCTION|PROCEDURE) (.+)$/s;

/**
 * Board 4's wording: the kind's words (dimmed) and the rest as Postgres wrote it; a trigger as when and what it runs
 * ("TRIGGER BEFORE UPDATE", "→ set_updated_at()"), its whole definition when it reads otherwise.
 */
export function constraintParts(c: DbConstraint): { kw: string; rest: string } {
  if (c.kind === 't') {
    const m = TRIGGER.exec(c.def);
    return m ? { kw: `TRIGGER ${m[1]} ${m[2]}`, rest: `→ ${m[3]}` } : { kw: 'TRIGGER', rest: c.def };
  }
  const lead = LEADS.find(([k, w]) => k === c.kind && c.def.startsWith(w + ' '));
  return lead ? { kw: lead[1], rest: c.def.slice(lead[1].length + 1) } : { kw: '', rest: c.def };
}

// ── The DDL's colors ───────────────────────────────────────────────────────────────────────────────────────────────

export type SqlKind = 'kw' | 'type' | 'str' | 'num' | 'com' | 'id' | 'p' | 'ws';
export interface SqlToken { k: SqlKind; s: string }

/** Postgres writes these upper case in what it prints (pg_get_*def, our DDL): names stay lower case or quoted. */
const KEYWORDS = new Set((
  'ADD ALL ALWAYS AND AS ASC BEFORE AFTER BEGIN BY CASCADE CASE CHECK COLLATE COLUMN COMMENT CONSTRAINT CREATE CROSS CURRENT_DATE '
  + 'CURRENT_TIMESTAMP DEFAULT DEFERRABLE DEFERRED DELETE DESC DISTINCT EACH ELSE END EXCLUDE EXECUTE EXISTS FALSE FILTER FIRST FOR FOREIGN '
  + 'FROM FULL FUNCTION GENERATED GROUP HASH HAVING IDENTITY IMMEDIATE IN INCLUDE INDEX INITIALLY INNER INSERT INSTEAD INTERVAL IS JOIN KEY '
  + 'LANGUAGE LAST LEFT LIKE LIMIT LIST MATCH MATERIALIZED MODULUS NO NOT NULL NULLS OF OFFSET ON OR ORDER OUTER OVER PARTITION PRIMARY '
  + 'PROCEDURE RANGE REFERENCES REMAINDER REPLACE RESTRICT RETURN RETURNS RIGHT ROW SELECT SET SIMPLE STATEMENT STORED TABLE THEN TO '
  + 'TRIGGER TRUE TRUNCATE UNION UNIQUE UNLOGGED UPDATE USING VALID VALUES VIEW VIRTUAL WHEN WHERE WITH WITHOUT ACTION BY DO'
).split(' '));
/** format_type's words: a type in the column list (a column of that name would be quoted). */
const TYPES = new Set((
  'bigint bigserial bit boolean bool box bytea char character cidr circle citext date decimal double float4 float8 inet int int2 int4 '
  + 'int8 integer interval json jsonb line lseg macaddr macaddr8 money numeric path point polygon precision real serial smallint '
  + 'smallserial text time timestamp timestamptz timetz tsquery tsvector uuid varbit varchar varying with without zone xml'
).split(' '));

const TOKEN = /(\s+)|(--[^\n]*)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\$[A-Za-z_]*\$)|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_$]*(?:\.(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")*"))*)|(::|[^\s\w])/y;

/** The DDL as colored tokens, line by line (a string or a dollar-quoted body over several lines is split at each). */
export function sqlLines(text: string): SqlToken[][] {
  const tokens: SqlToken[] = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < text.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(text);
    if (!m) { tokens.push({ k: 'p', s: text[i]! }); i++; continue; }
    const [all, ws, com, str, quoted, dollar, num, word] = m;
    if (dollar !== undefined) {
      // A dollar-quoted body: whole, up to its closing tag.
      const end = text.indexOf(dollar, i + dollar.length);
      const stop = end < 0 ? text.length : end + dollar.length;
      tokens.push({ k: 'str', s: dollar });
      if (stop > i + dollar.length) {
        const body = text.slice(i + dollar.length, end < 0 ? stop : end);
        if (body) tokens.push({ k: 'str', s: body });
        if (end >= 0) tokens.push({ k: 'str', s: dollar });
      }
      i = stop;
      continue;
    }
    const k: SqlKind = ws !== undefined ? 'ws' : com !== undefined ? 'com' : str !== undefined ? 'str' : quoted !== undefined ? 'id'
      : num !== undefined ? 'num' : word !== undefined ? (KEYWORDS.has(word) ? 'kw' : TYPES.has(word) ? 'type' : 'id') : 'p';
    tokens.push({ k, s: all });
    i += all.length;
  }
  // Lines: a token over several lines is cut at each break (same kind on each side).
  const lines: SqlToken[][] = [[]];
  for (const t of tokens) {
    const parts = t.s.split('\n');
    parts.forEach((s, j) => {
      if (j > 0) lines.push([]);
      if (s) lines[lines.length - 1]!.push({ k: t.k, s });
    });
  }
  return lines;
}

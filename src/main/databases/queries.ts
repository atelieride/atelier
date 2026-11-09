// The query resolver: the renderer's structured requests (a table, columns,
// derived JSON columns, filters, sorts, a page) turned into reads. Every name is resolved against the catalog read
// from the server before any statement is built: the table's columns and keys come from readColumns (cached 30 s per
// table), and an unknown schema, table or column is refused with nothing sent but that catalog lookup, which carries
// the names as parameters. Statements come only from the builders (postgres/sql.ts) and go through the read-only
// session one at a time; cells past 64 KB come back cut (on the server), with their whole length.
import type {
  DbCell, DbFk, DbFunctionRef, DbPage, DbPageRequest, DbPeek, DbRefCount, DbRelKind, DbRelations, DbStructure, DbTableRef
} from '@shared/databases';
import type { DbColumn, DbFilter, DbPath } from '@shared/databases-filters';
import { DbError, type DbRows, type DbSession, type Stmt } from './driver';
import { readColumns, readDdl, readFunctionDef, readRelations, readStructure } from './postgres/catalog';
import {
  countStmt, CUT_BYTES, displaySql, estimateStmt, FULL_CHARS, fullValueStmt, HEX_CHARS, MAX_PAGE_SIZE, pageStmt, peekStmt,
  refCountStmt, rowKeyOf, rowStmt, type CellCut, type CellStmt, type PageSpec, type TableTarget
} from './postgres/sql';

/** How long a table's columns and keys (and the foreign keys pointing at it) are used without reading them again. */
export const CACHE_MS = 30_000;
/** Tables kept at most (per cache): past it, the oldest read goes first. */
export const CACHE_CAP = 500;

/** Errors that mean the cache is out of date: a column or a table gone since it was read. */
const STALE = new Set(['42703', '42P01']);

const PAGE_RANGE = 'A page is a whole number from 0, its size 1–500 rows';

/** A table or view as the builders take it, plus what the reads need: its kind and its statistics' row estimate. */
interface Target extends TableTarget { kind: DbRelKind; estimate: number | null }
interface Entry<T> { at: number; value: Promise<T> }

/**
 * A value as the reply carries it: whole up to CUT_BYTES bytes (UTF-8); past it, the first CUT_BYTES bytes ending on
 * a whole character, and `cut` = the whole value's length in bytes. One the server cut first (`how`
 * 'text', its first CUT_CHARS characters) has its whole length in `size`, as the server measured it (never less than
 * what arrived: a server in another encoding counts other bytes). A bytea ('hex') is whole up to HEX_CHARS characters
 * of hex — 64 KB of its bytes —, past that cut there, `cut` its whole length in bytes.
 */
export function cellOf(v: string | null, how: CellCut = 'whole', size?: number): DbCell {
  if (v === null) return { v };
  if (how === 'hex') return v.length <= HEX_CHARS ? { v } : { v: v.slice(0, HEX_CHARS), cut: size ?? Math.floor((v.length - 2) / 2) };
  // A UTF-16 unit is at most 3 bytes in UTF-8: a string this short can't be over the limit.
  if (v.length * 3 <= CUT_BYTES) return { v };
  const bytes = Buffer.byteLength(v, 'utf8');
  if (bytes <= CUT_BYTES) return { v };
  // The first CUT_BYTES units encode to at least CUT_BYTES bytes (a huge value is never encoded whole); the cut backs
  // off to the start of the character it falls in.
  const head = Buffer.from(v.slice(0, CUT_BYTES), 'utf8');
  let end = CUT_BYTES;
  while (end > 0 && ((head[end] ?? 0) & 0xc0) === 0x80) end--;
  return { v: head.toString('utf8', 0, end), cut: Math.max(bytes, size ?? 0) };
}

/** A read's row (CellStmt) as cells: its values, each with the size the server sent after them when it cut one. */
export function cellsOf(row: (string | null)[], cuts: CellCut[]): DbCell[] {
  let at = cuts.length;
  return cuts.map((how, k) => {
    const v = row[k] ?? null;
    if (how === 'whole') return cellOf(v);
    const size = row[at++];
    return cellOf(v, how, size === null || size === undefined ? undefined : Number(size));
  });
}

function refuse(message: string, kind: 'other' | 'norow' | 'toolarge' = 'other'): never {
  throw new DbError({ kind, message });
}

function columnIn(t: Target, name: string): DbColumn {
  const c = t.columns.find((x) => x.name === name);
  if (!c) throw new DbError({ kind: 'unknown-table', message: 'No column ' + name + ' in ' + t.schema + '.' + t.name });
  return c;
}

/**
 * The page statement (`cut` false: the same read with every value whole, as the SQL popover shows it); a page × size
 * past what a number holds exactly is refused like any bad page.
 */
function pageOf(t: Target, spec: PageSpec, cut = true): CellStmt {
  try {
    return pageStmt(t, spec, cut);
  } catch (e) {
    if (e instanceof RangeError) refuse(PAGE_RANGE);
    throw e;
  }
}

/** A key's value for a column, or undefined when the key has none (own properties only). */
function valueOf<V>(key: Record<string, V>, column: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(key, column) ? key[column] : undefined;
}

/** EXPLAIN (FORMAT JSON)'s top "Plan Rows", or null when the plan doesn't say. */
function planRows(text: string | null | undefined): number | null {
  try {
    const rows: unknown = (JSON.parse(text ?? '') as { Plan?: { 'Plan Rows'?: unknown } }[])[0]?.Plan?.['Plan Rows'];
    return typeof rows === 'number' && Number.isFinite(rows) && rows >= 0 ? Math.round(rows) : null;
  } catch {
    return null;
  }
}

const keyOf = (ref: { schema: string; name: string }): string => ref.schema + '\0' + ref.name;

/**
 * The reads of one session (one connection). Rejects with a DbError: kind 'unknown-table' for a name the catalog
 * doesn't have, 'other' for a request the builders refuse, the client's kinds for what the server says.
 */
export class DbQueries {
  private readonly targets = new Map<string, Entry<Target | null>>();
  private readonly incoming = new Map<string, Entry<DbRelations>>();

  /** `now`: the clock the cache ages by (tests move it). */
  constructor(private readonly session: DbSession, private readonly now: () => number = Date.now) {}

  /**
   * A page of rows; a size over 500 reads 500. The row's key (`rowKey`: the primary key, else the first
   * unique NOT NULL key) and every column an incoming foreign key references are always selected (the inspector names
   * the row with them): those the request left out come after its own columns, in table order, and are listed in
   * `hidden`. When the foreign keys pointing at the table can't be read, the page still comes, with the row's key alone
   * (the inspector then has no Referenced by keys, the grid loses nothing).
   */
  async page(req: DbPageRequest): Promise<DbPage> {
    if (!Number.isSafeInteger(req.page) || req.page < 0 || !Number.isSafeInteger(req.size) || req.size < 1) refuse(PAGE_RANGE);
    const t = await this.target(req.ref);
    let spec: PageSpec = { columns: req.columns, derived: req.derived, filters: req.filters, sort: req.sort, page: req.page, size: Math.min(req.size, MAX_PAGE_SIZE) };
    const rowKey = rowKeyOf(t);
    // Built once as asked: every name is checked before anything more is read.
    let st = pageOf(t, spec);
    let hidden: string[] = [];
    if (req.columns.length > 0) {
      const referenced = await this.incomingOf(req.ref).then((rel) => rel.in.flatMap((fk) => fk.to.columns), (e: unknown) => {
        if (e instanceof DbError) return [];
        throw e;
      });
      const keys = new Set([...rowKey, ...referenced]);
      hidden = t.columns.map((c) => c.name).filter((name) => keys.has(name) && !req.columns.includes(name));
      if (hidden.length > 0) {
        spec = { ...spec, columns: [...req.columns, ...hidden] };
        st = pageOf(t, spec);
      }
    }
    const r = await this.exec(st);
    const columns = req.columns.length > 0 ? [...req.columns, ...hidden].map((name) => columnIn(t, name)) : t.columns;
    // Values (the selected columns, then the derived ones) and the sizes of those the server cut come by position:
    // aliases can't be trusted (Postgres cuts them at 63 bytes, and two can be the same).
    return {
      columns, hidden, derived: req.derived, rows: r.rows.map((row) => cellsOf(row, st.cuts)), ms: r.ms,
      sql: displaySql(pageOf(t, spec, false)), pk: t.pk, rowKey, kind: t.kind
    };
  }

  /**
   * Rows the filters keep, estimated: without filters a table's statistics (no statement), else, and for a view or a
   * table never analyzed, the planner's.
   */
  async estimate(ref: DbTableRef, filters: DbFilter[]): Promise<number | null> {
    const t = await this.target(ref);
    if (filters.length === 0 && t.kind !== 'view' && t.estimate !== null) return t.estimate;
    return planRows((await this.exec(estimateStmt(t, filters))).rows[0]?.[0]);
  }

  /** Count exactly: count(*) with the filters. */
  async count(ref: DbTableRef, filters: DbFilter[]): Promise<number> {
    const t = await this.target(ref);
    return Number((await this.exec(countStmt(t, filters))).rows[0]?.[0] ?? 0);
  }

  /** The row `cols` = `values` names (a foreign key's target), every column; null when there's none. */
  async peek(ref: DbTableRef, cols: string[], values: string[], self = false): Promise<DbPeek> {
    const t = await this.target(ref);
    // The row itself (`self`: the inspector's hidden fields): by a key that names one row, checked here.
    const st = self ? rowStmt(t, cols, values) : peekStmt(t, cols, values);
    const rows = (await this.exec(st)).rows;
    if (rows.length > 1) refuse('No key to read this row');
    const row = rows[0];
    return { columns: t.columns, row: row ? cellsOf(row, st.cuts) : null };
  }

  /**
   * Referenced by: for each foreign key pointing at ref, how many rows point at the row `key` describes,
   * counted up to 1001. `key` holds the row's value of every column an incoming key references, null for a NULL
   * (nothing points at it: 0, not asked); a key whose value was left out (one too long to send) isn't counted (why:
   * value), the others are. A key no index finds isn't counted (a count would scan that table); a count
   * past the timeout or on a table the role can't read comes back without a number, and the others still come back.
   */
  async refs(ref: DbTableRef, key: Record<string, string | null>): Promise<DbRefCount[]> {
    const t = await this.target(ref);
    for (const name of Object.keys(key)) columnIn(t, name);
    const rel = await this.incomingOf(ref);
    const asked = rel.in.map((fk) => ({ fk, values: fk.to.columns.map((c) => valueOf(key, c)) }));
    const out: DbRefCount[] = [];
    let stalled = false;
    for (const { fk, values } of asked) {
      if (values.some((v) => v === undefined)) out.push({ fk, count: null, why: 'value' });
      else if (values.some((v) => v === null)) out.push({ fk, count: 0 });
      else if (!fk.indexed) out.push({ fk, count: null, why: 'no-index' });
      // The timeout closed the session: what's left would fail as lost.
      else if (stalled && this.session.closed) out.push({ fk, count: null, why: 'slow' });
      else {
        const c = await this.refCount(ref, fk, values as string[], stalled);
        if (c.why === 'slow') stalled = true;
        out.push(c);
      }
    }
    return out;
  }

  /**
   * Load full value: `column` (or the JSON at `path` in it) of the row the primary key or a unique not-null key names,
   * up to 16 MB. No such key: "No key to read the whole value". A NULL reads as ''.
   */
  async full(ref: DbTableRef, key: Record<string, string>, column: string, path?: DbPath): Promise<string> {
    const t = await this.target(ref);
    for (const name of Object.keys(key)) columnIn(t, name);
    const row = (await this.exec(fullValueStmt(t, key, column, path))).rows[0];
    // Kinds of their own: reading again changes nothing (the inspector offers no Retry for them).
    if (!row) refuse('This row no longer exists', 'norow');
    // The statement reads FULL_CHARS characters at most: a value past 16 MB would come back cut, so none comes back.
    if (Number(row[1] ?? 0) > FULL_CHARS) refuse('This value is over 16 MB', 'toolarge');
    return row[0] ?? '';
  }

  structure(ref: DbTableRef): Promise<DbStructure> {
    return readStructure(this.session, ref.schema, ref.name);
  }

  /** Read fresh; pages and Referenced by use what this read. */
  async relations(ref: DbTableRef): Promise<DbRelations> {
    const r = await readRelations(this.session, ref.schema, ref.name);
    this.keep(this.incoming, keyOf(ref), { at: this.now(), value: Promise.resolve(r) });
    return r;
  }

  /** A table's DDL; with `args`, a function's definition (the sidebar's Copy Definition). */
  ddl(ref: DbTableRef | DbFunctionRef): Promise<string> {
    if ('args' in ref) return readFunctionDef(this.session, ref.schema, ref.name, ref.args);
    return readDdl(this.session, ref.schema, ref.name);
  }

  /** Drops every cached table (the catalog was read again). */
  forget(): void {
    this.targets.clear();
    this.incoming.clear();
  }

  /** Tables held by the caches (tests, diagnostics). */
  cacheSize(): number {
    return this.targets.size + this.incoming.size;
  }

  /** One foreign key's count; a timeout is 'slow' (and so is a lost connection after one), a table it can't read 'denied'. */
  private async refCount(ref: DbTableRef, fk: DbFk, values: string[], stalled: boolean): Promise<DbRefCount> {
    try {
      const from = await this.target({ connId: ref.connId, schema: fk.from.schema, name: fk.from.table });
      const r = await this.exec(refCountStmt(from, fk.from.columns, values));
      return { fk, count: Number(r.rows[0]?.[0] ?? 0) };
    } catch (e) {
      if (!(e instanceof DbError)) throw e;
      const kind = e.problem.kind;
      if (kind === 'canceled' || (kind === 'lost' && stalled)) return { fk, count: null, why: 'slow' };
      if (kind === 'denied' || kind === 'unknown-table') return { fk, count: null, why: 'denied' };
      throw e;
    }
  }

  /** The table ref names, from the cache or the catalog; requests at the same time share one read. */
  private async target(ref: { connId: string; schema: string; name: string }): Promise<Target> {
    const t = await this.cached(this.targets, ref, async () => {
      const c = await readColumns(this.session, ref.schema, ref.name);
      return c ? { schema: ref.schema, name: ref.name, ...c } : null;
    });
    if (!t) throw new DbError({ kind: 'unknown-table', message: 'No table or view ' + ref.schema + '.' + ref.name });
    return t;
  }

  /** The foreign keys pointing at ref, from the cache or the catalog. */
  private incomingOf(ref: DbTableRef): Promise<DbRelations> {
    return this.cached(this.incoming, ref, () => readRelations(this.session, ref.schema, ref.name));
  }

  /** A read kept CACHE_MS; a failed one isn't kept. */
  private cached<T>(map: Map<string, Entry<T>>, ref: { schema: string; name: string }, load: () => Promise<T>): Promise<T> {
    const k = keyOf(ref);
    const hit = map.get(k);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.value;
    const entry: Entry<T> = { at: this.now(), value: load() };
    this.keep(map, k, entry);
    entry.value.catch(() => {
      if (map.get(k) === entry) map.delete(k);
    });
    return entry.value;
  }

  /** Stores an entry as the newest; expired ones go first, then the oldest past CACHE_CAP. */
  private keep<T>(map: Map<string, Entry<T>>, k: string, entry: Entry<T>): void {
    for (const [other, e] of map) if (entry.at - e.at >= CACHE_MS) map.delete(other);
    map.delete(k);
    for (const oldest of map.keys()) {
      if (map.size < CACHE_CAP) break;
      map.delete(oldest);
    }
    map.set(k, entry);
  }

  /** Runs a builder's statement; a column or table gone under the cache drops it, so the next request reads afresh. */
  private async exec(st: Stmt): Promise<DbRows> {
    try {
      return await this.session.run(st);
    } catch (e) {
      if (e instanceof DbError && e.problem.code !== undefined && STALE.has(e.problem.code)) this.forget();
      throw e;
    }
  }
}

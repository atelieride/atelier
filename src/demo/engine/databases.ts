// The Databases view's live part in the demo, a chunk of its own: the bridge
// (bridge/databases.ts) loads it when the visitor first connects or reads. It plays main's DbHub and DbQueries for the
// acme-store's Postgres (world/databases.ts), imitated, never imported (src/main stays out of the bundle):
// - reads (createDbReads): the catalog, pages — the chosen columns with the row key and the referenced columns hidden
//   after them, derived JSON columns, filters, sorts with the key as tiebreaker, LIMIT/OFFSET, values past 64 KB cut —,
//   estimates and counts, the inspector's peeks, references and full values, structure, relations, DDL. Filters and
//   sorts are plain JS over the world's arrays (engine/databases-rows.ts); no statement is written or parsed;
// - the connection (createDatabasesLive): connecting, the catalog, Disconnect's hold and what lets it go,
//   the schema chip, Mask values, Refresh, a read connecting an idle connection, every answer in DbResult form;
// - the overview: its tiles tick on the demo's clock (transactions, the api's pool, the reporting job), only while it
//   is read, and stop a while after the last read;
// - what needs the Mac (add, edit, test, passwords, duplicate, remove) says so, as the demo's other main-only actions.
import type { AtelierApi } from '@shared/api';
import type {
  DbActivity, DbCatalog, DbConnView, DbFk, DbFullRequest, DbFunctionRef, DbOverview, DbPage, DbPageRequest, DbPeek, DbPeekRequest, DbProblem,
  DbRefCount, DbRefsRequest, DbRelations, DbResult, DbServerInfo, DbSnapshot, DbStructure, DbTableRef
} from '@shared/databases';
import { typeClass, validFilter, type DbColumn, type DbFilter, type DbPath, type DbSort } from '@shared/databases-filters';
import type { DemoContext } from '../bridge/context';
import { notInDemo } from '../bridge/not-in-demo';
import { ACME_DATABASES, ACME_SERVER, acmeDatabase, type AcmeDatabase, type PgRelation } from '../world/databases';
import { ACME_DB } from '../world/databases-conn';
import type { Cancel } from './clock';
import { cellOf, comparerOf, cutsOf, equalAs, passes, PgError, textAt } from './databases-rows';

/** How long connecting takes (a local container answers fast; long enough to see "Connecting…"). */
export const CONNECT_MS = 280;
/** The overview's tick, and how long it goes on after the last read (the renderer reads every 5 s while it shows). */
export const OVERVIEW_TICK_MS = 1000;
export const OVERVIEW_IDLE_MS = 15_000;
/** Transactions a second, as the api and the workers make them. */
export const TX_MIN = 18;
export const TX_MAX = 40;

/** Main's largest page (postgres/sql.ts MAX_PAGE_SIZE). */
const MAX_PAGE_SIZE = 500;
/** References are counted up to this many (main's REFS_CAP): 1001 reads "1,000+". */
const REFS_CAP = 1001;
/** Main's refusal of a page out of range (queries.ts PAGE_RANGE). */
const PAGE_RANGE = 'A page is a whole number from 0, its size 1–500 rows';
/**
 * pg_catalog types without a btree ordering: a sort on them fails on the server (main's postgres/sql.ts UNORDERED, the
 * whole list though the world has none of them: a sort the app refuses, the demo refuses too).
 */
const UNORDERED = new Set([
  'json', 'xml', 'jsonpath', 'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle', 'aclitem', 'xid', 'cid', 'pg_snapshot', 'txid_snapshot'
]);

/** A read the server or main refuses: its problem, as main's reply would carry it. */
export class DbRefusal extends Error {
  problem: DbProblem;
  constructor(problem: DbProblem) {
    super(problem.message);
    this.problem = problem;
  }
}
const refuse = (message: string, kind: DbProblem['kind'] = 'other'): never => { throw new DbRefusal({ kind, message }); };

type Row = (string | null)[];
interface Table {
  rel: PgRelation;
  columns: DbColumn[];
  at: Map<string, number>;
  rowKey: string[];
  out: DbFk[];
  in: DbFk[];
  /** Columns an incoming foreign key references (the inspector's keys). */
  referenced: Set<string>;
}

export interface DbReads {
  catalog(schema: string | null, connId: string): DbCatalog;
  page(req: DbPageRequest): DbPage;
  estimate(ref: DbTableRef, filters: DbFilter[]): number | null;
  count(ref: DbTableRef, filters: DbFilter[]): number;
  peek(req: DbPeekRequest): DbPeek;
  refs(req: DbRefsRequest): DbRefCount[];
  full(req: DbFullRequest): string;
  structure(ref: DbTableRef): DbStructure;
  relations(ref: DbTableRef): DbRelations;
  ddl(ref: DbTableRef | DbFunctionRef): string;
}

const keyOf = (schema: string, name: string) => `${schema}\0${name}`;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const byFkName = (a: DbFk, b: DbFk) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The reads of the world's database (main's DbQueries, and the catalog reader's answers). Throws DbRefusal. */
export function createDbReads(db: AcmeDatabase, o: { now: () => number; rand?: () => number }): DbReads {
  const rand = o.rand ?? Math.random;
  const tables = new Map<string, Table>();
  const fkOf = (r: PgRelation, f: PgRelation['fks'][number]): DbFk => ({
    name: f.name,
    from: { schema: r.schema, table: r.name, columns: [...f.columns] },
    to: { schema: f.to.schema, table: f.to.table, columns: [...f.to.columns] },
    // An index that finds the rows pointing at one row: a btree or hash one, not partial, led by exactly these columns.
    indexed: r.indexes.some((i) => (i.method === 'btree' || i.method === 'hash') && i.partial === null && i.columns.length >= f.columns.length && sameSet(i.columns.slice(0, f.columns.length), f.columns))
  });
  for (const r of db.relations) {
    const columns = r.columns.map((c): DbColumn => {
      const fk = r.fks.find((f) => f.columns.includes(c.name));
      const isPk = r.pk.includes(c.name);
      const col: DbColumn = {
        name: c.name, type: c.type, typeSchema: c.typeSchema, typeName: c.typeName, typeCat: c.typeCat, isArray: c.isArray === true, nullable: c.nullable,
        isPk, isKey: isPk || fk !== undefined || c.identity !== undefined || (c.default?.startsWith('nextval(') ?? false)
      };
      if (c.enumValues) col.enumValues = [...c.enumValues];
      if (fk) col.fk = { schema: fk.to.schema, table: fk.to.table, column: fk.to.columns[fk.columns.indexOf(c.name)] ?? '' };
      if (c.default !== undefined) col.default = c.default;
      return col;
    });
    tables.set(keyOf(r.schema, r.name), {
      rel: r, columns, at: new Map(r.columns.map((c, k) => [c.name, k])), rowKey: r.pk.length > 0 ? [...r.pk] : [...(r.uniqueKeys[0] ?? [])],
      out: r.fks.map((f) => fkOf(r, f)).sort(byFkName), in: [], referenced: new Set()
    });
  }
  for (const t of tables.values()) {
    for (const fk of t.out) {
      const target = tables.get(keyOf(fk.to.schema, fk.to.table));
      if (!target) continue;
      target.in.push(fk);
      for (const c of fk.to.columns) target.referenced.add(c);
    }
  }
  // As the catalog orders them: by schema, table, name (names compare byte by byte).
  const fromOf = (f: DbFk) => `${f.from.schema}\0${f.from.table}\0${f.name}`;
  for (const t of tables.values()) t.in.sort((a, b) => (fromOf(a) < fromOf(b) ? -1 : fromOf(a) > fromOf(b) ? 1 : 0));

  const tableOf = (ref: { schema: string; name: string }): Table => tables.get(keyOf(ref.schema, ref.name)) ?? refuse(`No table or view ${ref.schema}.${ref.name}`, 'unknown-table');
  const columnIn = (t: Table, name: string): DbColumn => t.columns.find((c) => c.name === name) ?? refuse(`No column ${name} in ${t.rel.schema}.${t.rel.name}`, 'unknown-table');
  const cell = (t: Table, row: Row, name: string) => row[t.at.get(name)!] ?? null;
  const jsonColumn = (t: Table, name: string, path: DbPath): DbColumn => {
    const c = columnIn(t, name);
    if (typeClass(c) !== 'json') refuse(`${name} is not a JSON column`);
    if (path.length === 0) refuse('A JSON path needs at least one key');
    return c;
  };
  /** The primary key's columns or a unique NOT NULL key's, in any order: a key that names one row. */
  const namesOneRow = (t: Table, cols: string[]) => [t.rel.pk, ...t.rel.uniqueKeys].some((k) => k.length > 0 && sameSet(k, cols));
  /** Postgres's own errors as main's reply carries them (asProblem: the message and the SQLSTATE). */
  const asServer = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof PgError) throw new DbRefusal({ kind: 'other', message: e.message, code: e.code });
      throw e;
    }
  };

  /** The rows the filters keep (each checked against its column first, as main's builders do). */
  const filtered = (t: Table, filters: DbFilter[]): Row[] => {
    const checks = filters.map((f) => {
      const c = columnIn(t, f.column);
      if (!validFilter(c, f)) refuse(`This filter does not fit column ${c.name}`);
      return { c, f, k: t.at.get(c.name)! };
    });
    if (checks.length === 0) return t.rel.rows;
    const now = o.now();
    return asServer(() => t.rel.rows.filter((row) => checks.every(({ c, f, k }) => passes(c, f, row[k] ?? null, now))));
  };

  /** Sorted as main's page reads it: the sorts, then the row key ascending (without one, every selected column that orders). */
  const sorted = (t: Table, rows: Row[], sort: DbSort[], selected: DbColumn[]): Row[] => {
    type Key = { get: (r: Row) => string | null; cmp: (a: string, b: string) => number; desc: boolean };
    const keys: Key[] = sort.map((s): Key => {
      if (s.dir !== 'asc' && s.dir !== 'desc') refuse('A sort is ascending or descending');
      if (s.path && s.path.length > 0) {
        const c = jsonColumn(t, s.column, s.path);
        const k = t.at.get(c.name)!;
        const path = s.path;
        // #>> gives text, which always sorts.
        return { get: (r) => textAt(r[k] ?? null, path), cmp: comparerOf({ typeName: 'text', typeCat: 'S', isArray: false }), desc: s.dir === 'desc' };
      }
      const c = columnIn(t, s.column);
      if (c.typeSchema === 'pg_catalog' && UNORDERED.has(c.typeName)) refuse(`Can't sort by ${c.name}`);
      const k = t.at.get(c.name)!;
      return { get: (r) => r[k] ?? null, cmp: comparerOf(c), desc: s.dir === 'desc' };
    });
    const bySort = new Set(sort.filter((s) => !s.path || s.path.length === 0).map((s) => s.column));
    const ties = t.rowKey.length > 0 ? t.rowKey : sort.length > 0
      ? selected.filter((c) => c.typeCat === 'E' || (c.typeSchema === 'pg_catalog' && !UNORDERED.has(c.typeName))).map((c) => c.name) : [];
    for (const name of ties) {
      if (bySort.has(name)) continue;
      const c = columnIn(t, name);
      const k = t.at.get(name)!;
      keys.push({ get: (r) => r[k] ?? null, cmp: comparerOf(c), desc: false });
    }
    if (keys.length === 0) return rows;
    return [...rows].sort((r1, r2) => {
      for (const key of keys) {
        const a = key.get(r1);
        const b = key.get(r2);
        // NULLS LAST ascending, NULLS FIRST descending (Postgres's defaults).
        let d = a === null || b === null ? (a === b ? 0 : a === null ? 1 : -1) : key.cmp(a, b);
        if (key.desc) d = -d;
        if (d) return d;
      }
      return 0;
    });
  };

  const rowsAt = (t: Table, cols: string[], values: string[]): Row[] => {
    if (cols.length === 0 || cols.length !== values.length) refuse('A key needs one value per column');
    const cs = cols.map((n) => columnIn(t, n));
    return asServer(() => t.rel.rows.filter((row) => cs.every((c, k) => equalAs(c, cell(t, row, c.name), values[k]!))));
  };
  const cellsOf = (t: Table, row: Row) => t.columns.map((c) => cellOf(cell(t, row, c.name), cutsOf(c)));

  return {
    catalog(schema, connId) {
      const schemas = ['public', ...db.schemas.filter((s) => s !== 'public').sort()];
      const chosen = schema !== null && schemas.includes(schema) ? schema : 'public';
      const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const rels = db.relations.filter((r) => r.schema === chosen).sort(byName).map((r) => ({ schema: r.schema, name: r.name, kind: r.kind, estimate: r.kind === 'view' ? null : r.rows.length }));
      const names = [...db.relations].sort((a, b) => Number(a.schema !== 'public') - Number(b.schema !== 'public') || (a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : 0) || byName(a, b))
        .map((r) => ({ schema: r.schema, name: r.name, kind: r.kind }));
      return {
        connId, database: ACME_DB.database, databases: [...ACME_DATABASES], schemas, schema: chosen, rels, noRels: db.relations.length === 0,
        enums: db.enums.filter((e) => e.schema === chosen).sort(byName).map((e) => ({ schema: e.schema, name: e.name, values: [...e.values] })),
        functions: db.functions.filter((f) => f.schema === chosen).sort(byName).map((f) => ({ schema: f.schema, name: f.name, args: f.args, returns: f.returns, oid: f.oid })),
        names, namesMore: false, readAt: o.now()
      };
    },

    page(req) {
      if (!Number.isSafeInteger(req.page) || req.page < 0 || !Number.isSafeInteger(req.size) || req.size < 1) refuse(PAGE_RANGE);
      const t = tableOf(req.ref);
      const size = Math.min(req.size, MAX_PAGE_SIZE);
      if (!Number.isSafeInteger(req.page * size)) refuse(PAGE_RANGE);
      // Every name checked before anything is read, in the builders' order: columns, JSON columns, filters, sorts.
      const asked = req.columns.length > 0 ? req.columns.map((n) => columnIn(t, n)) : t.columns;
      for (const d of req.derived) jsonColumn(t, d.column, d.path);
      const rows = sorted(t, filtered(t, req.filters), req.sort, asked);
      const hidden = req.columns.length > 0 ? t.columns.map((c) => c.name).filter((n) => (t.rowKey.includes(n) || t.referenced.has(n)) && !req.columns.includes(n)) : [];
      const columns = req.columns.length > 0 ? [...asked, ...hidden.map((n) => columnIn(t, n))] : t.columns;
      const from = req.page * size;
      const slice = rows.slice(from, from + size);
      return {
        columns, hidden, derived: req.derived,
        rows: slice.map((row) => [
          ...columns.map((c) => cellOf(cell(t, row, c.name), cutsOf(c))),
          ...req.derived.map((d) => cellOf(textAt(cell(t, row, d.column), d.path), true))
        ]),
        ms: Math.max(1, Math.round(1 + slice.length / 80 + rand() * 3)),
        // No statement exists in the demo: the SQL popover has nothing to show (no query builder ships).
        sql: '',
        pk: [...t.rel.pk], rowKey: [...t.rowKey], kind: t.rel.kind
      };
    },

    estimate(ref, filters) {
      const t = tableOf(ref);
      const rows = filtered(t, filters);
      // Without filters a table's statistics (an ANALYZE ago: these rows); else the planner's guess, here the rows kept.
      return filters.length === 0 && t.rel.kind !== 'view' ? t.rel.rows.length : rows.length;
    },

    count(ref, filters) {
      return filtered(tableOf(ref), filters).length;
    },

    peek(req) {
      const t = tableOf(req.ref);
      // The row itself (the inspector's hidden fields) by a key that names one row.
      if (req.row && !namesOneRow(t, req.cols)) refuse('No key to read this row');
      const hits = rowsAt(t, req.cols, req.values);
      if (req.row && hits.length > 1) refuse('No key to read this row');
      const hit = hits[0];
      return { columns: t.columns, row: hit ? cellsOf(t, hit) : null };
    },

    refs(req) {
      const t = tableOf(req.ref);
      for (const name of Object.keys(req.key)) columnIn(t, name);
      return t.in.map((fk): DbRefCount => {
        const values = fk.to.columns.map((c) => (Object.prototype.hasOwnProperty.call(req.key, c) ? req.key[c] : undefined));
        if (values.some((v) => v === undefined)) return { fk, count: null, why: 'value' };
        if (values.some((v) => v === null)) return { fk, count: 0 };
        if (!fk.indexed) return { fk, count: null, why: 'no-index' };
        const from = tableOf({ schema: fk.from.schema, name: fk.from.table });
        return { fk, count: Math.min(REFS_CAP, rowsAt(from, fk.from.columns, values as string[]).length) };
      });
    },

    full(req) {
      const t = tableOf(req.ref);
      const cols = Object.keys(req.key);
      for (const name of cols) columnIn(t, name);
      if (!namesOneRow(t, cols)) refuse('No key to read the whole value');
      const path = req.path && req.path.length > 0 ? req.path : null;
      if (path) jsonColumn(t, req.column, path);
      else columnIn(t, req.column);
      const hit = rowsAt(t, cols, cols.map((c) => req.key[c]!))[0] ?? refuse('This row no longer exists', 'norow');
      const v = cell(t, hit, req.column);
      return (path ? textAt(v, path) : v) ?? '';
    },

    structure(ref) {
      const t = tableOf(ref);
      const r = t.rel;
      const RANK = 'pfuxc';
      const view = r.kind === 'view';
      return {
        schema: r.schema, name: r.name, kind: r.kind, owner: r.owner, comment: r.comment,
        columns: t.columns.map((c, k) => {
          const checks = r.constraints.filter((x) => x.kind === 'c' && x.column === c.name).map((x) => x.def);
          return { ...c, comment: r.columns[k]!.comment ?? null, identity: r.columns[k]!.identity !== undefined, generated: null, check: checks.length > 0 ? checks.join(', ') : null };
        }),
        indexes: [...r.indexes].sort((a, b) => Number(b.primary) - Number(a.primary) || (a.name < b.name ? -1 : 1)).map((i) => ({
          name: i.name, def: i.def, method: i.method, bytes: i.bytes, scans: i.scans, unique: i.unique, primary: i.primary, partial: i.partial,
          neverUsed: i.scans === 0 && !i.unique && !i.primary
        })),
        constraints: [...r.constraints].sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind) || (a.name < b.name ? -1 : 1)).map((x) => ({ name: x.name, kind: x.kind, def: x.def })),
        size: { ...r.size, total: r.size.table + r.size.indexes + r.size.toast, measured: !view && (r.stats.lastAnalyze !== null || r.stats.lastVacuum !== null) },
        stats: { estimate: view ? null : r.rows.length, dead: r.stats.dead, lastAnalyze: r.stats.lastAnalyze, lastVacuum: r.stats.lastVacuum },
        partitions: [],
        viewDef: r.viewDef
      };
    },

    relations(ref) {
      const t = tableOf(ref);
      return { out: [...t.out], in: [...t.in] };
    },

    ddl(ref) {
      if ('args' in ref) {
        const f = db.functions.find((x) => x.schema === ref.schema && x.name === ref.name && x.args === ref.args);
        return f ? f.def : refuse('This function no longer exists', 'gone');
      }
      return tableOf(ref).rel.ddl;
    }
  };
}

// ── The connection, as main's DbHub plays it ───────────────────────────────────────────────────────────────────────

const UNKNOWN: DbResult<never> = { ok: false, problem: { kind: 'other', message: 'Unknown connection' } };
const HELD: DbResult<never> = { ok: false, problem: { kind: 'held', message: 'Disconnected' } };
const RUNS_ON_YOUR_MAC: DbResult<never> = { ok: false, problem: { kind: 'other', message: 'Runs on your Mac' } };
const NOT_CONNECTED: DbResult<never> = { ok: false, problem: { kind: 'other', message: 'Connect first: the script depends on the server version' } };

/**
 * `window.atelier.databases` once the engine is loaded, from the snapshot the bridge showed until then (one saved
 * connection, selected, idle). `start`: when the demo started (the bridge's first moment): the database's times are
 * placed then, so its ages agree with the Redis stream and the Docker containers however late the view opens; now
 * when not given. `rand`: tests pass a seeded one.
 */
export function createDatabasesLive(ctx: DemoContext, initial: DbSnapshot, o: { start?: number; rand?: () => number } = {}): AtelierApi['databases'] {
  const rand = o.rand ?? Math.random;
  const start = o.start ?? ctx.now();
  const db = acmeDatabase(start);
  const reads = createDbReads(db, { now: ctx.now, rand });
  let view: DbConnView = { ...initial.connections[0]!, conn: { ...initial.connections[0]!.conn } };
  const id = view.conn.id;
  let selected = initial.selected;
  let catalog: DbCatalog | null = null;
  let connecting: Promise<DbResult<DbServerInfo>> | null = null;
  /** Bumped by Disconnect: a connect still under way then ends held. */
  let generation = 0;

  const snapshot = (): DbSnapshot => ({
    connections: [view], selected, catalog: selected === id && view.state === 'connected' ? catalog : null
  });
  const emit = () => ctx.events.emit('databases', snapshot());
  const set = (p: Partial<DbConnView>) => { view = { ...view, ...p }; };
  const readCatalog = () => { catalog = reads.catalog(view.conn.schema ?? null, id); };

  const connectNow = (): Promise<DbResult<DbServerInfo>> => {
    if (view.state === 'connected' && view.server) return Promise.resolve({ ok: true, value: view.server });
    if (connecting) return connecting;
    set({ state: 'connecting', problem: null });
    emit();
    const g = generation;
    connecting = new Promise((resolve) => {
      ctx.clock.after(CONNECT_MS, () => {
        if (g !== generation) { resolve(HELD); return; }
        connecting = null;
        const server: DbServerInfo = { ...ACME_SERVER, role: view.conn.user, latencyMs: 2 + Math.round(rand() * 3) };
        set({ state: 'connected', server, problem: null });
        readCatalog();
        emit();
        resolve({ ok: true, value: server });
      });
    });
    return connecting;
  };

  const release = () => { if (view.held) set({ held: false }); };
  const gate = (connId: string): DbResult<never> | null => (connId !== id ? UNKNOWN : view.held ? HELD : null);
  /** A read through the connection: refused while held, connecting an idle one first (a read the user caused). */
  const read = async <T>(connId: string, fn: () => T): Promise<DbResult<T>> => {
    const g = gate(connId);
    if (g) return g;
    if (view.state !== 'connected') {
      const c = await connectNow();
      if (!c.ok) return c;
    }
    const again = gate(connId);
    if (again) return again;
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      if (e instanceof DbRefusal) return { ok: false, problem: e.problem };
      throw e;
    }
  };
  const mac = (what: string): Promise<DbResult<never>> => { notInDemo(what); return Promise.resolve(RUNS_ON_YOUR_MAC); };

  // —— the overview's live part ——
  const ov = db.overview;
  const tick = { sec: 0, lastRead: 0, xacts: ov.xacts, task: null as Cancel | null };
  /** The api's pool: each connection idle since a second, or running a statement this second. */
  const pool = new Map(ov.pool.pids.map((pid, k) => [pid, { active: false, since: -(7 + k * 13), query: ov.pool.queries[k % ov.pool.queries.length]! }]));
  const step = () => {
    tick.sec++;
    tick.xacts += TX_MIN + Math.floor(rand() * (TX_MAX - TX_MIN + 1));
    for (const [pid, p] of pool) {
      if (rand() < 0.22) pool.set(pid, { active: true, since: tick.sec, query: ov.pool.queries[Math.floor(rand() * ov.pool.queries.length)]! });
      else if (p.active) pool.set(pid, { ...p, active: false, since: tick.sec });
    }
    if (tick.sec - tick.lastRead >= OVERVIEW_IDLE_MS / OVERVIEW_TICK_MS) stopTicking();
  };
  const stopTicking = () => { tick.task?.(); tick.task = null; };
  const overview = (): DbOverview => {
    tick.lastRead = tick.sec;
    tick.task ??= ctx.clock.every(OVERVIEW_TICK_MS, step);
    const cycle = ov.report.activeSec + ov.report.idleSec;
    const phase = (ov.report.startSec + tick.sec) % cycle;
    const report = phase < ov.report.activeSec;
    const activity: DbActivity[] = [
      { pid: ov.ours.pid, role: ov.ours.role, app: ov.ours.app, state: 'active', seconds: 0, query: ov.ours.query, ours: true },
      ...[...pool].map(([pid, p]): DbActivity => ({ pid, role: ov.pool.role, app: ov.pool.app, state: p.active ? 'active' : 'idle', seconds: tick.sec - p.since, query: p.query, ours: false })),
      { pid: ov.report.pid, role: ov.report.role, app: ov.report.app, state: report ? 'active' : 'idle', seconds: report ? phase : phase - ov.report.activeSec, query: ov.report.query, ours: false }
    ].sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active') || (b.seconds ?? -1) - (a.seconds ?? -1) || a.pid - b.pid);
    const longest = activity.filter((a) => a.state === 'active' && !a.ours).sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0))[0];
    const tables = db.relations.filter((r) => r.kind === 'table').map((r) => ({ schema: r.schema, name: r.name, bytes: r.size.table + r.size.indexes + r.size.toast }));
    return {
      server: view.server!, uptimeSec: ov.uptimeSec + Math.floor((ctx.now() - start) / 1000), sizeBytes: ov.sizeBytes,
      connections: { total: activity.length, max: ov.maxConnections, active: activity.filter((a) => a.state === 'active').length, idleInTx: 0 },
      cacheHit: ov.cacheHit,
      longest: longest ? { pid: longest.pid, seconds: longest.seconds ?? 0, query: longest.query ?? '' } : null,
      xacts: tick.xacts,
      biggest: [...tables].sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1)).slice(0, 6),
      schemas: [...new Set(db.relations.map((r) => r.schema))].sort().map((name) => ({
        name, bytes: tables.filter((x) => x.schema === name).reduce((s, x) => s + x.bytes, 0),
        tables: db.relations.filter((r) => r.schema === name && r.kind === 'table').length, views: db.relations.filter((r) => r.schema === name && r.kind === 'view').length
      })),
      extensions: ov.extensions.map((e) => ({ ...e })),
      activity,
      slowest: ov.slowest.map((s) => ({ ...s })),
      at: ctx.now()
    };
  };

  return {
    snapshot: () => Promise.resolve(snapshot()),
    async select(connId) {
      if (connId === null) { selected = null; emit(); return; }
      if (connId !== id) return;
      release();
      selected = connId;
      emit();
      await connectNow();
    },
    connect(connId) {
      if (connId !== id) return Promise.resolve(UNKNOWN);
      release();
      return connectNow();
    },
    async disconnect(connId) {
      if (connId !== id) return;
      generation++;
      connecting = null;
      stopTicking();
      set({ state: 'idle', server: null, problem: null, held: true });
      catalog = null;
      emit();
    },
    password: () => mac('Passwords'),
    test: () => mac('Test Connection'),
    save: (a) => mac(a.id === null ? 'Add Connection' : 'Edit Connection'),
    duplicate: () => mac('Duplicate Connection'),
    async remove() { notInDemo('Remove Connection'); },
    async setMask(connId, on) {
      if (connId !== id) return;
      set({ conn: { ...view.conn, mask: on } });
      emit();
    },
    async noteWrite(connId) {
      if (connId !== id) return;
      set({ conn: { ...view.conn, writeNoted: true } });
      emit();
    },
    async setSchema(connId, schema) {
      if (connId !== id) return;
      set({ conn: { ...view.conn, schema } });
      if (view.state === 'connected') readCatalog();
      emit();
    },
    async refresh() {
      if (view.state === 'connected') readCatalog();
      emit();
    },
    page: (req) => read(req.ref.connId, () => reads.page(req)),
    estimate: (a) => read(a.ref.connId, () => reads.estimate(a.ref, a.filters)),
    count: (a) => read(a.ref.connId, () => reads.count(a.ref, a.filters)),
    peek: (a) => read(a.ref.connId, () => reads.peek(a)),
    refs: (a) => read(a.ref.connId, () => reads.refs(a)),
    full: (a) => read(a.ref.connId, () => reads.full(a)),
    structure: (ref) => read(ref.connId, () => reads.structure(ref)),
    relations: (ref) => read(ref.connId, () => reads.relations(ref)),
    ddl: (ref) => read(ref.connId, () => reads.ddl(ref)),
    overview: (connId) => read(connId, overview),
    async readOnlySql(connId) {
      if (connId !== id) return UNKNOWN;
      return view.server ? { ok: true, value: db.readOnlyRoleSql } : NOT_CONNECTED;
    }
  };
}

// The catalog reader: the server and its role, the sidebar's lists, a table's
// columns and keys (what the SQL builders resolve names against), its structure, relations and DDL. Every statement is
// a Stmt shaped `cat.*` that the client runs in a read-only transaction; schema and table names travel as $n
// parameters, never in the text. The text is put together with + from this module's constants only, some chosen by
// server_version_num (servers 9.6+ work; newer catalog columns appear only on the servers that have them). Lists come
// back as JSON aggregates, so a read takes one or two statements: the remote databases this view is for are far away.
import {
  DB_NAMES_CAP, type DbCatalog, type DbConstraint, type DbEnum, type DbFk, type DbFunction, type DbIndex, type DbRel, type DbRelKind,
  type DbRelName, type DbRelations, type DbServerInfo, type DbStructure
} from '@shared/databases';
import type { DbColumn } from '@shared/databases-filters';
import { quoteIdent } from '@shared/pg-json';
import { DbError, isCockroach, type DbSession, type Stmt } from '../driver';

const V10 = 100000; // partitions (relispartition, relpartbound, pg_get_partkeydef), identity columns
const V11 = 110000; // INCLUDE columns (indnkeyatts), prokind, conparentid
const V12 = 120000; // generated columns (attgenerated)
const V14 = 140000; // pg_read_all_data

/** What the view browses: tables, partitioned tables, views, materialized views, foreign tables. */
const REL_KINDS = "('r', 'p', 'v', 'm', 'f')";
/** Schemas that are the server's own: pg_catalog, pg_toast, temp schemas, information_schema. */
const USER_SCHEMA = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";
/** The relation $1.$2 as `c` (pg_class) and `n` (its namespace). */
const REL_MATCH = 'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace '
  + 'WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ' + REL_KINDS;
/** The privilege scan looks at this many relations at most (capped); past it the role counts as one that can write. */
const WRITE_SCAN_CAP = 10000;

/**
 * Rows of the relation `r` (a pg_class alias) from the statistics: its reltuples once an ANALYZE or a
 * VACUUM measured it; never measured — reltuples -1 from Postgres 14, 0 rows in 0 pages before — the live rows the
 * statistics count as rows come and go (pg_stat_user_tables.n_live_tup, no lock); null when that is 0 too (or absent).
 */
const ROWS = (v: number, r: string): string =>
  'CASE WHEN ' + r + '.reltuples < 0' + (v >= V14 ? '' : ' OR (' + r + '.reltuples = 0 AND ' + r + '.relpages = 0)')
  + ' THEN (SELECT CASE WHEN st.n_live_tup > 0 THEN st.n_live_tup END FROM pg_catalog.pg_stat_user_tables st WHERE st.relid = ' + r + '.oid)'
  + ' ELSE ' + r + '.reltuples::pg_catalog.int8 END';

/**
 * Rows of `c` (ROWS): null for a view; a partitioned table's are the sum of its leaf partitions' (it holds no rows
 * itself), null when none of them says.
 */
const ESTIMATE = (v: number): string => "(CASE WHEN c.relkind = 'v' THEN NULL "
  + "WHEN c.relkind = 'p' THEN (WITH RECURSIVE parts(oid) AS (SELECT ih.inhrelid FROM pg_catalog.pg_inherits ih WHERE ih.inhparent = c.oid "
  + 'UNION ALL SELECT ih.inhrelid FROM parts JOIN pg_catalog.pg_inherits ih ON ih.inhparent = parts.oid) '
  + 'SELECT pg_catalog.sum(' + ROWS(v, 'pc') + ')::pg_catalog.int8 FROM parts JOIN pg_catalog.pg_class pc ON pc.oid = parts.oid '
  + "WHERE pc.relkind <> 'p') "
  + 'ELSE ' + ROWS(v, 'c') + ' END)';

/** Block size, for turning pages into bytes. */
const BLOCK = "pg_catalog.current_setting('block_size')::pg_catalog.int8";
/**
 * The pages of every index of the relation `t` (a table, a partition) or `tt` (its TOAST table), from pg_class.relpages:
 * no lock, unlike pg_indexes_size. An index never measured counts 0.
 */
const INDEX_PAGES = (of: 't' | 'tt'): string => 'COALESCE((SELECT pg_catalog.sum(GREATEST(ip.relpages, 0)) FROM pg_catalog.pg_index ix '
  + 'JOIN pg_catalog.pg_class ip ON ip.oid = ix.indexrelid WHERE ix.indrelid = ' + (of === 'tt' ? 'tt.oid' : 't.oid') + '), 0)::pg_catalog.int8';

/**
 * The type a column's casts name, from its attribute `a`: a domain's base type and an array's
 * element, through any nesting of both (an array of a domain over int4 is int4), and whether an array was crossed. An
 * array is the type its element's typarray names: int2vector and oidvector have a typelem and category 'A' too, but
 * they are types of their own.
 */
const BASE_TYPE = 'WITH RECURSIVE walk(tid, arr, depth) AS (SELECT a.atttypid, false, 0 '
  + "UNION ALL SELECT CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.typelem END, walk.arr OR t.typtype <> 'd', walk.depth + 1 "
  + 'FROM walk JOIN pg_catalog.pg_type t ON t.oid = walk.tid '
  + "WHERE walk.depth < 8 AND (t.typtype = 'd' OR (t.typelem <> 0 "
  + 'AND EXISTS (SELECT 1 FROM pg_catalog.pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid)))) '
  + 'SELECT walk.tid, walk.arr FROM walk ORDER BY walk.depth DESC LIMIT 1';

/**
 * Whether attribute `a` (default `d`) is a serial: its default is nextval of a sequence the column owns ('a'; an
 * identity's is 'i'). The DDL writes it as serial, which brings its sequence along.
 */
const SERIAL = 'EXISTS (SELECT 1 FROM pg_catalog.pg_depend sd JOIN pg_catalog.pg_class sq ON sq.oid = sd.objid '
  + "WHERE sd.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND sd.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass "
  + "AND sd.refobjid = a.attrelid AND sd.refobjsubid = a.attnum AND sd.deptype = 'a' AND sq.relkind = 'S' "
  + "AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = 'nextval(' || pg_catalog.quote_literal(sq.oid::pg_catalog.regclass::pg_catalog.text) || '::regclass)')";

/**
 * Foreign keys `con` with both ends: names, the columns in key order, and whether the referencing table has an index
 * that finds the rows pointing at one row: a valid, non-partial btree or hash index (a BRIN or GIN one would
 * scan) whose first key columns (not INCLUDE ones, from 11) are exactly the foreign key's, in any order (Referenced by
 * counts only those). Continue with ` AND …`.
 */
function fkSelect(v: number): string {
  const keyAtts = v >= V11 ? 'i.indnkeyatts' : 'i.indnatts';
  return 'SELECT con.conname AS name, sn.nspname AS from_schema, sc.relname AS from_table, '
    + '(SELECT pg_catalog.json_agg(a.attname ORDER BY k.n) FROM pg_catalog.unnest(con.conkey) WITH ORDINALITY k(num, n) '
    + 'JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num) AS from_cols, '
    + 'tn.nspname AS to_schema, tc.relname AS to_table, '
    + '(SELECT pg_catalog.json_agg(a.attname ORDER BY k.n) FROM pg_catalog.unnest(con.confkey) WITH ORDINALITY k(num, n) '
    + 'JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num) AS to_cols, '
    // As many leading key columns as the foreign key has, holding all of its (distinct) columns: the same set.
    + 'EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = con.conrelid AND i.indisvalid AND i.indpred IS NULL '
    + "AND (SELECT am.amname FROM pg_catalog.pg_class ic JOIN pg_catalog.pg_am am ON am.oid = ic.relam WHERE ic.oid = i.indexrelid) IN ('btree', 'hash') "
    + 'AND ' + keyAtts + ' >= pg_catalog.cardinality(con.conkey) '
    + 'AND (SELECT pg_catalog.array_agg(i.indkey[k]) FROM pg_catalog.generate_series(0, pg_catalog.cardinality(con.conkey) - 1) k) @> con.conkey) AS indexed '
    + 'FROM pg_catalog.pg_constraint con '
    + 'JOIN pg_catalog.pg_class sc ON sc.oid = con.conrelid JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace '
    + 'JOIN pg_catalog.pg_class tc ON tc.oid = con.confrelid JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace '
    + "WHERE con.contype = 'f'";
}
/** Postgres 11+ copies a partitioned table's foreign keys onto each partition: only the originals. */
const NO_CLONES = ' AND con.conparentid = 0';

/**
 * Whether the operator class `oc` of a unique index compares as the column `a` does: the default class of
 * its access method for the column's own type — or, when that type (or a domain's base, at any depth) has none of its
 * own, any default class that takes it (varchar → text_ops). A citext column under text_ops compares case-sensitively:
 * two of its rows can be equal as the column compares, so that index names no row.
 */
const OWN_OPCLASS = 'oc.opcdefault AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_opclass od WHERE od.opcmethod = oc.opcmethod AND od.opcdefault '
  + 'AND od.oid <> oc.oid AND od.opcintype IN (WITH RECURSIVE dom(tid, depth) AS (SELECT a.atttypid, 0 UNION ALL '
  + "SELECT t.typbasetype, dom.depth + 1 FROM dom JOIN pg_catalog.pg_type t ON t.oid = dom.tid WHERE t.typtype = 'd' AND dom.depth < 8) "
  + 'SELECT dom.tid FROM dom))';

const SERVER = "SELECT pg_catalog.current_setting('server_version'), pg_catalog.current_setting('server_version_num'), "
  + 'current_user::pg_catalog.text, (SELECT s.ssl FROM pg_catalog.pg_stat_ssl s WHERE s.pid = pg_catalog.pg_backend_pid()), '
  // "can only read" is a promise, so every doubt reads as "can write". A superuser; the owner
  // (or a member of the owner) of a relation in a user schema, every relation looked at (EXISTS stops at the first);
  // or a role allowed to change one, a table or a column of it, looked for in the first $1 + 1 relations: more than $1
  // without one found also counts as "can write".
  + 'COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) '
  + 'OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace '
  + 'WHERE c.relkind IN ' + REL_KINDS + ' AND ' + USER_SCHEMA + " AND pg_catalog.pg_has_role(c.relowner, 'USAGE')) "
  + "OR (SELECT COALESCE(pg_catalog.bool_or(pg_catalog.has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') "
  + "OR pg_catalog.has_any_column_privilege(c.oid, 'INSERT, UPDATE')), false) OR pg_catalog.count(*) > $1::pg_catalog.int8 "
  + 'FROM (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace '
  + 'WHERE c.relkind IN ' + REL_KINDS + ' AND ' + USER_SCHEMA + ' LIMIT $1::pg_catalog.int8 + 1) c), '
  // CockroachDB says itself here (its server_version is a Postgres number).
  + 'pg_catalog.version()';

// ── The server version, once per session ─────────────────────────────────────────────────────────────────────────

const versions = new WeakMap<DbSession, number>();

export async function versionOf(s: DbSession): Promise<number> {
  const known = versions.get(s);
  if (known !== undefined) return known;
  const r = await s.run({ text: "SELECT pg_catalog.current_setting('server_version_num')", values: [], shape: 'cat.version' });
  return remember(s, r.rows[0]?.[0]);
}

function remember(s: DbSession, text: string | null | undefined): number {
  const v = Number(text);
  if (!Number.isInteger(v) || v <= 0) throw new DbError({ kind: 'other', message: "Couldn't read the server version" });
  versions.set(s, v);
  return v;
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A JSON value our own statement built; SQL NULL (json_agg over no rows) is `empty`. */
function json<T>(v: string | null | undefined, empty: T): T {
  return v === null || v === undefined ? empty : (JSON.parse(v) as T);
}

const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

function kindOf(relkind: string): DbRelKind {
  return relkind === 'v' ? 'view' : relkind === 'm' ? 'matview' : 'table';
}

function unknownTable(schema: string, name: string): DbError {
  return new DbError({ kind: 'unknown-table', message: 'No table or view ' + schema + '.' + name });
}

/** A string literal for the DDL text (standard_conforming_strings: only quotes are doubled). */
const literal = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

function functionFilter(v: number): string {
  // Aggregates (and, from 11, window functions) are not what a "Functions" list means; neither are an extension's
  // members (citext alone adds dozens to public).
  return (v >= V11 ? "p.prokind IN ('f', 'p')" : 'NOT EXISTS (SELECT 1 FROM pg_catalog.pg_aggregate g WHERE g.aggfnoid = p.oid)')
    + " AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep WHERE dep.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass "
    + "AND dep.objid = p.oid AND dep.deptype = 'e')";
}

const notPartition = (v: number): string => (v >= V10 ? ' AND NOT c.relispartition' : '');

// ── Server ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The server, the role and what it may do. `t0` is when the caller started connecting: latencyMs runs from it to this
 * first answer. TLS is what pg_stat_ssl says of our backend, or, when it says nothing (a pooler, a server that hides
 * it), whether our own link is encrypted. `writeScanCap`: how many relations the privilege scan looks at (tests lower it).
 */
export async function readServerInfo(s: DbSession, t0: number, writeScanCap = WRITE_SCAN_CAP): Promise<DbServerInfo> {
  if (!Number.isSafeInteger(writeScanCap) || writeScanCap < 0) throw new RangeError('writeScanCap must be a whole number ≥ 0');
  const r = await s.run({ text: SERVER, values: [writeScanCap], shape: 'cat.server' });
  const row = r.rows[0] ?? [];
  const versionNum = remember(s, row[1]);
  // Every session's first read (the hub's dial): a CockroachDB one keeps the plain wrapper from now on.
  if (isCockroach(row[5] ?? '')) s.plainOnly?.();
  const ssl = row[3];
  return {
    version: row[0] ?? '',
    versionNum,
    tls: ssl === null || ssl === undefined ? s.tlsActive : ssl === 't',
    role: row[2] ?? '',
    canWrite: row[4] === 't',
    latencyMs: Math.max(0, Date.now() - t0)
  };
}

/**
 * The script the sidebar's "Copy SQL for a Read-only Role" copies: pg_read_all_data from Postgres 14, a
 * GRANT SELECT on every schema there is before. Text to read and run by hand, never run by Atelier.
 */
export function readOnlyRoleSql(role: string, versionNum: number): string {
  // A line break would end the comment that names the role, and what follows would run.
  if (/[\x00-\x1f\x7f]/.test(role)) throw new TypeError('A role name has no control characters');
  const r = quoteIdent(role);
  const head = '-- A role that can only read. Run this as a superuser (or a role with CREATEROLE),\n'
    + '-- then give it a password: in psql, \\password ' + r + '\n'
    + 'CREATE ROLE ' + r + ' LOGIN;\n';
  if (versionNum >= V14) return head + 'GRANT pg_read_all_data TO ' + r + ';\n';
  let tag = '$grants$';
  for (let k = 1; role.includes(tag); k++) tag = '$grants' + k + '$';
  const to = literal(role);
  return head
    + '-- Before Postgres 14: SELECT on the tables and sequences of every schema there is now.\n'
    + 'DO ' + tag + '\nDECLARE s text;\nBEGIN\n'
    + "  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' LOOP\n"
    + "    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, " + to + ');\n'
    + "    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', s, " + to + ');\n'
    + "    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', s, " + to + ');\n'
    + '  END LOOP;\nEND ' + tag + ';\n'
    + '-- Tables created later need their own GRANT SELECT (or ALTER DEFAULT PRIVILEGES).\n';
}

// ── Sidebar lists ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether schema `n` holds a table, view or materialized view (partitions aside: their table counts). */
const HAS_RELS = (v: number): string => 'EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ' + REL_KINDS + notPartition(v) + ')';

/** The user schemas that hold anything, public first: each with whether it holds a relation. */
function schemasStmt(v: number): Stmt {
  return {
    text: 'SELECT n.nspname, ' + HAS_RELS(v) + ' FROM pg_catalog.pg_namespace n WHERE ' + USER_SCHEMA
      + ' AND (' + HAS_RELS(v)
      + " OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t WHERE t.typnamespace = n.oid AND t.typtype = 'e')"
      + ' OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid AND ' + functionFilter(v) + '))'
      + " ORDER BY n.nspname <> 'public', n.nspname",
    values: [], shape: 'cat.schemas'
  };
}

function listsStmt(v: number, schema: string): Stmt {
  return {
    text: 'SELECT (SELECT pg_catalog.json_agg(x ORDER BY x.name) FROM (SELECT c.relname AS name, c.relkind::pg_catalog.text AS kind, '
      + ESTIMATE(v) + ' AS estimate, '
      + "CASE WHEN c.relkind = 'p' THEN (SELECT pg_catalog.count(*) FROM pg_catalog.pg_inherits ih WHERE ih.inhparent = c.oid) END AS parts "
      + 'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace '
      + 'WHERE n.nspname = $1 AND c.relkind IN ' + REL_KINDS + notPartition(v) + ') x), '
      + '(SELECT pg_catalog.json_agg(x ORDER BY x.name) FROM (SELECT t.typname AS name, '
      + '(SELECT pg_catalog.json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid) AS labels '
      + "FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype = 'e') x), "
      + '(SELECT pg_catalog.json_agg(x ORDER BY x.name, x.args) FROM (SELECT p.proname AS name, '
      + 'pg_catalog.oidvectortypes(p.proargtypes) AS args, pg_catalog.pg_get_function_result(p.oid) AS result, p.oid::pg_catalog.int8 AS oid '
      + 'FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND ' + functionFilter(v) + ') x)',
    values: [schema], shape: 'cat.lists'
  };
}

/**
 * Every user schema's tables, views and materialized views the role may read, by name (for the
 * palette): a schema it has USAGE on, a relation it may SELECT (a column of it is enough); partitions left out. Only
 * pg_class, pg_namespace and the privilege functions: no lock, nothing else read. Public first, then by schema and
 * name; $1 + 1 rows at most, the one past the cap only saying there are more. As [schema, name, relkind] triples.
 */
function namesStmt(v: number, cap: number): Stmt {
  return {
    text: "SELECT pg_catalog.json_agg(pg_catalog.json_build_array(x.s, x.n, x.k) ORDER BY x.s <> 'public', x.s, x.n) FROM ("
      + 'SELECT n.nspname AS s, c.relname AS n, c.relkind::pg_catalog.text AS k '
      + 'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace '
      + 'WHERE c.relkind IN ' + REL_KINDS + notPartition(v) + ' AND ' + USER_SCHEMA
      + " AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') "
      + "AND (pg_catalog.has_table_privilege(c.oid, 'SELECT') OR pg_catalog.has_any_column_privilege(c.oid, 'SELECT')) "
      + "ORDER BY n.nspname <> 'public', n.nspname, c.relname LIMIT $1::pg_catalog.int8 + 1) x",
    values: [cap], shape: 'cat.names'
  };
}

/** The names read failed once already in this run of the app: it isn't said again. */
let namesWarned = false;

/**
 * Every schema's relations by name (namesStmt), `cap` at most. Only the palette's: a failure (a timeout, a privilege
 * quirk) leaves none — the palette then searches the sidebar's schema — and never costs the sidebar its catalog.
 */
async function readNames(s: DbSession, v: number, cap: number): Promise<{ names: DbRelName[]; namesMore: boolean }> {
  try {
    const all = json<[string, string, string][]>((await s.run(namesStmt(v, cap))).rows[0]?.[0], []);
    return { names: all.slice(0, cap).map(([schema, name, k]): DbRelName => ({ schema, name, kind: kindOf(k) })), namesMore: all.length > cap };
  } catch (e) {
    if (!namesWarned) {
      namesWarned = true;
      console.warn('Databases: every schema\'s table names could not be read; the palette searches the sidebar\'s schema:', e instanceof Error ? e.message : String(e));
    }
    return { names: [], namesMore: false };
  }
}

/** How many databases the chip lists at most: a menu, not a browser of a multi-tenant server. */
const DATABASES_CAP = 1000;

/**
 * The server's databases the role may connect to (the sidebar's database chip), by name: not a template,
 * open to connections, CONNECT granted. pg_database alone, a shared catalog: nothing of the user's is read or locked.
 */
function databasesStmt(): Stmt {
  return {
    text: 'SELECT pg_catalog.json_agg(x.n ORDER BY x.n) FROM (SELECT d.datname AS n FROM pg_catalog.pg_database d '
      + "WHERE d.datallowconn AND NOT d.datistemplate AND pg_catalog.has_database_privilege(d.oid, 'CONNECT') "
      + 'ORDER BY d.datname LIMIT $1::pg_catalog.int8) x',
    values: [DATABASES_CAP], shape: 'cat.databases'
  };
}

/** A name a connection can be saved with (connection-schema.ts: at most 128 characters, no control character). */
const savable = (n: string): boolean => n.length > 0 && n.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(n);

/** The databases read failed once already in this run of the app: it isn't said again. */
let databasesWarned = false;

/**
 * The server's databases (databasesStmt), those a connection can be saved with. Only the chip's: a failure (a pooler
 * that hides pg_database, a privilege quirk) leaves none — the chip then shows the connection's own — and never costs
 * the sidebar its catalog.
 */
async function readDatabases(s: DbSession): Promise<string[]> {
  try {
    return json<string[]>((await s.run(databasesStmt())).rows[0]?.[0], []).filter(savable);
  } catch (e) {
    if (!databasesWarned) {
      databasesWarned = true;
      console.warn("Databases: the server's databases could not be listed; the chip shows the connection's own:", e instanceof Error ? e.message : String(e));
    }
    return [];
  }
}

/**
 * The sidebar's catalog for one schema: the asked one when it holds anything, else public, else the first that does.
 * `schemas`: the schemas that hold a table, view, enum or function, public first; `noRels`: none holds a relation.
 * `names`: every schema's relations by name (readNames), `namesCap` at most (tests lower it; 1 or more). `databases`:
 * the server's (readDatabases). The caller adds the database it was read from.
 */
export async function readCatalog(s: DbSession, schema: string | null, namesCap = DB_NAMES_CAP): Promise<Omit<DbCatalog, 'connId' | 'database' | 'readAt'>> {
  if (!Number.isSafeInteger(namesCap) || namesCap <= 0) throw new RangeError('namesCap must be a whole number ≥ 1');
  const v = await versionOf(s);
  const found = (await s.run(schemasStmt(v))).rows.filter((r) => (r[0] ?? '') !== '');
  const schemas = found.map((r) => r[0]!);
  const noRels = !found.some((r) => r[1] === 't');
  const chosen = schema !== null && schemas.includes(schema) ? schema : schemas.includes('public') ? 'public' : schemas[0] ?? 'public';
  const row = (await s.run(listsStmt(v, chosen))).rows[0] ?? [];
  const rels = json<{ name: string; kind: string; estimate: number | null; parts: number | null }[]>(row[0], []).map((r): DbRel => ({
    schema: chosen, name: r.name, kind: kindOf(r.kind), estimate: r.estimate, ...(r.kind === 'p' ? { partitions: r.parts ?? 0 } : {})
  }));
  const enums = json<{ name: string; labels: string[] | null }[]>(row[1], []).map((e): DbEnum => ({ schema: chosen, name: e.name, values: e.labels ?? [] }));
  const functions = json<{ name: string; args: string; result: string | null; oid: number }[]>(row[2], []).map((f): DbFunction => ({
    schema: chosen, name: f.name, args: f.args, returns: f.result ?? '', oid: f.oid
  }));
  const names = await readNames(s, v, namesCap);
  return { schemas, schema: chosen, rels, noRels, enums, functions, ...names, databases: await readDatabases(s) };
}

// ── Columns and keys ───────────────────────────────────────────────────────────────────────────────────────────────

interface ColRow {
  num: number;
  name: string;
  /** The name as quote_ident writes it (the DDL). */
  q: string;
  type_text: string;
  base_schema: string;
  base_name: string;
  base_cat: string;
  is_array: boolean;
  labels: string[] | null;
  nullable: boolean;
  /** pg_attrdef: the default, or a generated column's expression. */
  expr: string | null;
  /** attidentity: '' | 'a' (always) | 'd' (by default). */
  ident: string;
  /** attgenerated: '' | 's' (stored) | 'v' (virtual, Postgres 18). */
  gen: string;
  note: string | null;
  serial: boolean;
}
interface FkRow { name: string; from_schema: string; from_table: string; from_cols: string[]; to_schema: string; to_table: string; to_cols: string[]; indexed: boolean }
interface Columns { relkind: string; estimate: number | null; cols: ColRow[]; pk: string[]; uniqueKeys: string[][]; fks: DbFk[] }

function columnsStmt(v: number, schema: string, name: string): Stmt {
  const keyAtts = v >= V11 ? 'i.indnkeyatts' : 'i.indnatts';
  /** The key columns of index `i` (not its INCLUDE ones), as `a`, in order `k`. */
  const keyCols = 'FROM pg_catalog.generate_series(0, ' + keyAtts + ' - 1) k '
    + 'JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k]';
  const ident = v >= V10 ? 'a.attidentity::pg_catalog.text' : "''::pg_catalog.text";
  const gen = v >= V12 ? 'a.attgenerated::pg_catalog.text' : "''::pg_catalog.text";
  return {
    text: 'SELECT c.relkind::pg_catalog.text, ' + ESTIMATE(v) + ', '
      // The columns, in order.
      + '(SELECT pg_catalog.json_agg(x ORDER BY x.num) FROM (SELECT a.attnum AS num, a.attname AS name, '
      + 'pg_catalog.quote_ident(a.attname) AS q, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_text, '
      + 'bn.nspname AS base_schema, bt.typname AS base_name, bt.typcategory::pg_catalog.text AS base_cat, w.arr AS is_array, '
      + "CASE WHEN bt.typtype = 'e' THEN (SELECT pg_catalog.json_agg(e.enumlabel ORDER BY e.enumsortorder) "
      + 'FROM pg_catalog.pg_enum e WHERE e.enumtypid = bt.oid) END AS labels, '
      + 'NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS expr, '
      + ident + ' AS ident, ' + gen + ' AS gen, pg_catalog.col_description(a.attrelid, a.attnum) AS note, ' + SERIAL + ' AS serial '
      + 'FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum '
      + 'CROSS JOIN LATERAL (' + BASE_TYPE + ') w '
      + 'JOIN pg_catalog.pg_type bt ON bt.oid = w.tid JOIN pg_catalog.pg_namespace bn ON bn.oid = bt.typnamespace '
      + 'WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) x), '
      // The primary key's columns, in key order.
      + '(SELECT (SELECT pg_catalog.json_agg(a.attname ORDER BY k) ' + keyCols + ') '
      + 'FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND i.indisprimary), '
      // Unique keys that name one row: valid, not partial, plain columns, every one NOT NULL — and compared as `=` on
      // the column compares: the column's own collation, a deterministic one, the default operator class.
      + '(SELECT pg_catalog.json_agg(u.cols ORDER BY u.name) FROM (SELECT ic.relname AS name, '
      + '(SELECT pg_catalog.json_agg(a.attname ORDER BY k) ' + keyCols + ') AS cols '
      + 'FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid '
      + 'WHERE i.indrelid = c.oid AND i.indisunique AND NOT i.indisprimary AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL '
      + 'AND NOT EXISTS (SELECT 1 ' + keyCols + ' WHERE NOT a.attnotnull OR i.indcollation[k] <> a.attcollation '
      + 'OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_opclass oc WHERE oc.oid = i.indclass[k] AND ' + OWN_OPCLASS + ')'
      + (v >= V12 ? ' OR EXISTS (SELECT 1 FROM pg_catalog.pg_collation co WHERE co.oid = a.attcollation AND NOT co.collisdeterministic)' : '')
      + ')) u), '
      // The foreign keys it holds.
      + '(SELECT pg_catalog.json_agg(f ORDER BY f.name) FROM (' + fkSelect(v) + ' AND con.conrelid = c.oid' + (v >= V11 ? NO_CLONES : '') + ') f) '
      + REL_MATCH,
    values: [schema, name], shape: 'cat.columns'
  };
}

function toFk(f: FkRow): DbFk {
  return {
    name: f.name,
    from: { schema: f.from_schema, table: f.from_table, columns: f.from_cols },
    to: { schema: f.to_schema, table: f.to_table, columns: f.to_cols },
    indexed: f.indexed === true
  };
}

async function loadColumns(s: DbSession, v: number, schema: string, name: string): Promise<Columns | null> {
  const row = (await s.run(columnsStmt(v, schema, name))).rows[0];
  if (!row) return null;
  const pk = json<string[]>(row[3], []);
  const seen = new Set([[...pk].sort().join('\0')]);
  const uniqueKeys = json<string[][]>(row[4], []).filter((key) => {
    const id = [...key].sort().join('\0');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { relkind: row[0] ?? '', estimate: num(row[1]), cols: json<ColRow[]>(row[2], []), pk, uniqueKeys, fks: json<FkRow[]>(row[5], []).map(toFk) };
}

function toColumn(c: ColRow, pk: string[], fks: DbFk[]): DbColumn {
  const fk = fks.find((f) => f.from.columns.includes(c.name));
  const def = c.gen === '' && c.expr !== null ? c.expr : undefined;
  const isPk = pk.includes(c.name);
  const col: DbColumn = {
    name: c.name, type: c.type_text, typeSchema: c.base_schema, typeName: c.base_name, typeCat: c.base_cat, isArray: c.is_array,
    nullable: c.nullable, isPk, isKey: isPk || fk !== undefined || c.ident !== '' || (def?.startsWith('nextval(') ?? false)
  };
  if (c.labels) col.enumValues = c.labels;
  if (fk) col.fk = { schema: fk.to.schema, table: fk.to.table, column: fk.to.columns[fk.from.columns.indexOf(c.name)] ?? '' };
  if (def !== undefined) col.default = def;
  return col;
}

/**
 * A table's or view's columns as the SQL builders resolve them (TableTarget): casts by the base type's catalog names,
 * the primary key in key order, the unique keys whose columns are all NOT NULL (Load full value without a primary
 * key), and the estimate. Null when schema.name is not a table, view or materialized view.
 */
export async function readColumns(s: DbSession, schema: string, name: string): Promise<{ columns: DbColumn[]; pk: string[]; kind: DbRelKind; estimate: number | null; uniqueKeys: string[][] } | null> {
  const c = await loadColumns(s, await versionOf(s), schema, name);
  if (!c) return null;
  return { columns: c.cols.map((col) => toColumn(col, c.pk, c.fks)), pk: c.pk, kind: kindOf(c.relkind), estimate: c.estimate, uniqueKeys: c.uniqueKeys };
}

// ── Structure and DDL ──────────────────────────────────────────────────────────────────────────────────────────────

/** `partitioned`: a partitioned table's own index (relkind 'I'), which stores nothing: its partitions' indexes do. */
interface IndexRow { name: string; def: string; method: string; bytes: number; scans: number | null; is_unique: boolean; is_primary: boolean; partial: string | null; by_constraint: boolean; partitioned: boolean }
interface ConRow { name: string; q: string; kind: string; def: string; col: string | null }
interface Facts {
  owner: string;
  comment: string | null;
  q: string;
  persistence: string;
  partKey: string | null;
  viewDef: string | null;
  size: DbStructure['size'];
  stats: { dead: number | null; analyzed: number | null; vacuumed: number | null } | null;
  /**
   * Every partition under the table, depth first (a partitioned partition then its own): `parent` the one it is a
   * partition of, `depth` 1 for the table's own, `part_key` when it is partitioned itself.
   */
  partitions: { schema: string; name: string; q: string; bound: string; parent: string; depth: number; part_key: string | null }[];
  indexes: IndexRow[];
  constraints: ConRow[];
  triggers: { name: string; def: string }[];
  /** A foreign table's server and options (quoted name, [quoted key, value] pairs); null for anything else. */
  foreign: { server: string; options: [string, string][] | null } | null;
}

function structureStmt(v: number, schema: string, name: string): Stmt {
  const partKey = v >= V10 ? "CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END" : 'NULL::pg_catalog.text';
  // Partitions of partitions too (a sub-partitioned one says PARTITION BY), in the order the DDL creates them.
  const partitions = v >= V10
    ? '(WITH RECURSIVE parts(oid, parent, depth, path) AS (SELECT ih.inhrelid, c.oid, 1, ARRAY[pc.relname::pg_catalog.text, pn.nspname::pg_catalog.text] '
      + 'FROM pg_catalog.pg_inherits ih JOIN pg_catalog.pg_class pc ON pc.oid = ih.inhrelid JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace '
      + "WHERE ih.inhparent = c.oid AND c.relkind = 'p' "
      + 'UNION ALL SELECT ih.inhrelid, parts.oid, parts.depth + 1, parts.path || ARRAY[pc.relname::pg_catalog.text, pn.nspname::pg_catalog.text] '
      + "FROM parts JOIN pg_catalog.pg_class pp ON pp.oid = parts.oid AND pp.relkind = 'p' JOIN pg_catalog.pg_inherits ih ON ih.inhparent = parts.oid "
      + 'JOIN pg_catalog.pg_class pc ON pc.oid = ih.inhrelid JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace WHERE parts.depth < 32) '
      + "SELECT pg_catalog.json_agg(x ORDER BY x.path) FROM (SELECT parts.path, pn.nspname AS schema, pc.relname AS name, pg_catalog.quote_ident(pn.nspname) || '.' || "
      + "pg_catalog.quote_ident(pc.relname) AS q, pg_catalog.pg_get_expr(pc.relpartbound, pc.oid) AS bound, pg_catalog.quote_ident(qn.nspname) || '.' || "
      + "pg_catalog.quote_ident(qc.relname) AS parent, parts.depth, CASE WHEN pc.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(pc.oid) END AS part_key "
      + 'FROM parts JOIN pg_catalog.pg_class pc ON pc.oid = parts.oid JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace '
      + 'JOIN pg_catalog.pg_class qc ON qc.oid = parts.parent JOIN pg_catalog.pg_namespace qn ON qn.oid = qc.relnamespace) x)'
    : 'NULL::pg_catalog.json';
  // A foreign table's server and options, as CREATE FOREIGN TABLE takes them.
  const foreign = "CASE WHEN c.relkind = 'f' THEN (SELECT pg_catalog.json_build_object('server', pg_catalog.quote_ident(fs.srvname), 'options', "
    + '(SELECT pg_catalog.json_agg(pg_catalog.json_build_array(pg_catalog.quote_ident(pg_catalog.split_part(o.opt, \'=\', 1)), '
    + "pg_catalog.substr(o.opt, pg_catalog.strpos(o.opt, '=') + 1)) ORDER BY o.n) FROM pg_catalog.unnest(ft.ftoptions) WITH ORDINALITY o(opt, n))) "
    + 'FROM pg_catalog.pg_foreign_table ft JOIN pg_catalog.pg_foreign_server fs ON fs.oid = ft.ftserver WHERE ft.ftrelid = c.oid) END';
  return {
    text: 'SELECT pg_catalog.pg_get_userbyid(c.relowner), pg_catalog.obj_description(c.oid, \'pg_class\'), '
      + "pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname), c.relpersistence::pg_catalog.text, "
      + partKey + ", CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(c.oid, true) END, "
      // Sizes (as the overview's): relpages × block size, read from pg_class without a lock — the heap, its
      // indexes, its TOAST table with its index —, as of the last VACUUM, ANALYZE or CREATE INDEX (-1: never, 0 here).
      // A partitioned table's are its partitions' (it stores nothing itself), partitions of partitions too.
      + '(WITH RECURSIVE tree(oid) AS (SELECT c.oid UNION ALL SELECT ih.inhrelid FROM tree '
      + "JOIN pg_catalog.pg_class pc ON pc.oid = tree.oid AND pc.relkind = 'p' JOIN pg_catalog.pg_inherits ih ON ih.inhparent = tree.oid), "
      + 'sz AS (SELECT GREATEST(t.relpages, 0)::pg_catalog.int8 AS tbl, ' + INDEX_PAGES('t') + ' AS idx, '
      + 'COALESCE((SELECT GREATEST(tt.relpages, 0) + ' + INDEX_PAGES('tt') + ' FROM pg_catalog.pg_class tt WHERE tt.oid = t.reltoastrelid), 0) AS toast '
      + 'FROM tree JOIN pg_catalog.pg_class t ON t.oid = tree.oid) '
      + "SELECT pg_catalog.json_build_object('table', pg_catalog.sum(sz.tbl) * " + BLOCK + ", 'indexes', pg_catalog.sum(sz.idx) * " + BLOCK + ', '
      + "'toast', pg_catalog.sum(sz.toast) * " + BLOCK + ", 'total', pg_catalog.sum(sz.tbl + sz.idx + sz.toast) * " + BLOCK + ', '
      // Measured: an ANALYZE or a VACUUM, manual or auto, seen on a relation that stores the rows (itself; a partitioned
      // table's partitions, never the parent: it stores nothing). Never: its relpages say nothing yet.
      + "'measured', EXISTS (SELECT 1 FROM tree JOIN pg_catalog.pg_class lc ON lc.oid = tree.oid AND lc.relkind <> 'p' "
      + 'JOIN pg_catalog.pg_stat_all_tables ls ON ls.relid = tree.oid '
      + 'WHERE COALESCE(ls.last_analyze, ls.last_autoanalyze, ls.last_vacuum, ls.last_autovacuum) IS NOT NULL)) FROM sz), '
      // Dead rows, the latest analyze and vacuum (manual or auto).
      + "(SELECT pg_catalog.json_build_object('dead', st.n_dead_tup, "
      + "'analyzed', pg_catalog.date_part('epoch', GREATEST(st.last_analyze, st.last_autoanalyze)), "
      + "'vacuumed', pg_catalog.date_part('epoch', GREATEST(st.last_vacuum, st.last_autovacuum))) "
      + 'FROM pg_catalog.pg_stat_all_tables st WHERE st.relid = c.oid), '
      + partitions + ', '
      + '(SELECT pg_catalog.json_agg(x ORDER BY x.is_primary DESC, x.name) FROM (SELECT ic.relname AS name, '
      + 'pg_catalog.pg_get_indexdef(i.indexrelid) AS def, am.amname AS method, GREATEST(ic.relpages, 0)::pg_catalog.int8 * ' + BLOCK + ' AS bytes, '
      + 'si.idx_scan AS scans, i.indisunique AS is_unique, i.indisprimary AS is_primary, pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS partial, '
      + 'EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid '
      + "AND k.contype IN ('p', 'u', 'x')) AS by_constraint, ic.relkind = 'I' AS partitioned "
      + 'FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_am am ON am.oid = ic.relam '
      + 'LEFT JOIN pg_catalog.pg_stat_all_indexes si ON si.indexrelid = i.indexrelid WHERE i.indrelid = c.oid) x), '
      // Constraints: primary key, foreign keys, unique, exclusion, checks (Postgres 18's NOT NULL ones are the columns').
      + '(SELECT pg_catalog.json_agg(x ORDER BY x.rank, x.name) FROM (SELECT k.conname AS name, pg_catalog.quote_ident(k.conname) AS q, '
      + 'k.contype::pg_catalog.text AS kind, pg_catalog.pg_get_constraintdef(k.oid) AS def, '
      + "pg_catalog.strpos('pfuxc', k.contype::pg_catalog.text) AS rank, "
      + "CASE WHEN k.contype = 'c' AND pg_catalog.array_length(k.conkey, 1) = 1 THEN (SELECT a.attname FROM pg_catalog.pg_attribute a "
      + 'WHERE a.attrelid = k.conrelid AND a.attnum = k.conkey[1]) END AS col '
      + "FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND k.contype IN ('p', 'f', 'u', 'x', 'c')) x), "
      + '(SELECT pg_catalog.json_agg(x ORDER BY x.name) FROM (SELECT tg.tgname AS name, pg_catalog.pg_get_triggerdef(tg.oid) AS def '
      + 'FROM pg_catalog.pg_trigger tg WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal) x), '
      + foreign + ' '
      + REL_MATCH,
    values: [schema, name], shape: 'cat.structure'
  };
}

const ZERO_SIZE: DbStructure['size'] = { table: 0, indexes: 0, toast: 0, total: 0, measured: false };

async function loadRelation(s: DbSession, schema: string, name: string): Promise<{ cols: Columns; facts: Facts }> {
  const v = await versionOf(s);
  const cols = await loadColumns(s, v, schema, name);
  if (!cols) throw unknownTable(schema, name);
  const row = (await s.run(structureStmt(v, schema, name))).rows[0];
  if (!row) throw unknownTable(schema, name);
  const size = json<Facts['size'] | null>(row[6], null);
  const facts: Facts = {
    owner: row[0] ?? '',
    comment: row[1] ?? null,
    q: row[2] ?? '',
    persistence: row[3] ?? 'p',
    partKey: row[4] ?? null,
    viewDef: row[5] ?? null,
    size: size
      ? { table: Number(size.table ?? 0), indexes: Number(size.indexes ?? 0), toast: Number(size.toast ?? 0), total: Number(size.total ?? 0), measured: size.measured === true }
      : ZERO_SIZE,
    stats: json<Facts['stats']>(row[7], null),
    partitions: json<Facts['partitions']>(row[8], []),
    indexes: json<IndexRow[]>(row[9], []),
    constraints: json<ConRow[]>(row[10], []),
    triggers: json<Facts['triggers']>(row[11], []),
    foreign: json<Facts['foreign']>(row[12], null)
  };
  return { cols, facts };
}

const iso = (epoch: number | null | undefined): string | null => (typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null);

/** Structure: columns with their notes, indexes, constraints and triggers, size, statistics, partitions, a view's definition. */
export async function readStructure(s: DbSession, schema: string, name: string): Promise<DbStructure> {
  const { cols, facts } = await loadRelation(s, schema, name);
  const checks = new Map<string, string[]>();
  for (const k of facts.constraints) {
    if (k.kind === 'c' && k.col !== null) checks.set(k.col, [...(checks.get(k.col) ?? []), k.def]);
  }
  const constraints: DbConstraint[] = [
    ...facts.constraints.map((k) => ({ name: k.name, kind: k.kind as DbConstraint['kind'], def: k.def })),
    ...facts.triggers.map((t) => ({ name: t.name, kind: 't' as const, def: t.def }))
  ];
  const indexes: DbIndex[] = facts.indexes.map((i) => ({
    name: i.name, def: i.def, method: i.method, bytes: i.partitioned ? null : Number(i.bytes), scans: i.scans, unique: i.is_unique, primary: i.is_primary,
    partial: i.partial, neverUsed: i.scans === 0 && !i.is_unique && !i.is_primary
  }));
  return {
    schema, name, kind: kindOf(cols.relkind), owner: facts.owner, comment: facts.comment,
    columns: cols.cols.map((c) => ({
      ...toColumn(c, cols.pk, cols.fks),
      comment: c.note, identity: c.ident !== '', generated: c.gen !== '' ? c.expr : null, check: checks.get(c.name)?.join(', ') ?? null
    })),
    indexes, constraints, size: facts.size,
    stats: { estimate: cols.estimate, dead: facts.stats?.dead ?? null, lastAnalyze: iso(facts.stats?.analyzed), lastVacuum: iso(facts.stats?.vacuumed) },
    partitions: facts.partitions.filter((p) => p.depth === 1).map((p) => ({ schema: p.schema, name: p.name, bound: p.bound })),
    viewDef: facts.viewDef
  };
}

const SERIALS: Record<string, string> = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' };

/** What follows a column's type: how it gets its value (a serial's nextval is in the word serial). */
function valueDdl(c: ColRow, serial: boolean): string {
  if (serial) return '';
  if (c.gen !== '' && c.expr !== null) return ' GENERATED ALWAYS AS (' + c.expr + ')' + (c.gen === 'v' ? ' VIRTUAL' : ' STORED');
  if (c.ident === 'a') return ' GENERATED ALWAYS AS IDENTITY';
  if (c.ident === 'd') return ' GENERATED BY DEFAULT AS IDENTITY';
  return c.expr !== null ? ' DEFAULT ' + c.expr : '';
}

function columnDdl(c: ColRow): string {
  const serial = c.serial ? SERIALS[c.type_text] : undefined;
  return c.q + ' ' + (serial ?? c.type_text) + valueDdl(c, serial !== undefined) + (c.nullable ? '' : ' NOT NULL');
}

/** A foreign table's `SERVER s OPTIONS (k 'v', …)`, as CREATE FOREIGN TABLE ends. */
function foreignDdl(f: NonNullable<Facts['foreign']>): string {
  const options = (f.options ?? []).map(([k, v]) => k + ' ' + literal(v));
  return ' SERVER ' + f.server + (options.length > 0 ? ' OPTIONS (' + options.join(', ') + ')' : '');
}

/**
 * The DDL rebuilt from the catalog: CREATE TABLE (columns, defaults, NOT NULL, identity, generated,
 * constraints) and its partitions — partitioned ones with their PARTITION BY and their own partitions —, a
 * foreign table's CREATE FOREIGN TABLE … SERVER … OPTIONS, or CREATE [MATERIALIZED] VIEW … AS; then CREATE INDEX for the
 * indexes no constraint made, COMMENT ON, and the triggers. A readable approximation (storage options, tablespaces and
 * privileges left out): text to read, copy and send, never run by Atelier.
 */
export async function readDdl(s: DbSession, schema: string, name: string): Promise<string> {
  const { cols, facts } = await loadRelation(s, schema, name);
  const sections: string[][] = [];
  const kind = kindOf(cols.relkind);
  const foreign = cols.relkind === 'f' && facts.foreign ? facts.foreign : null;
  if (kind === 'table') {
    const lines = [...cols.cols.map(columnDdl), ...facts.constraints.map((k) => 'CONSTRAINT ' + k.q + ' ' + k.def)];
    const create = foreign ? 'CREATE FOREIGN TABLE ' : facts.persistence === 'u' ? 'CREATE UNLOGGED TABLE ' : 'CREATE TABLE ';
    const tail = foreign ? foreignDdl(foreign) : facts.partKey ? ' PARTITION BY ' + facts.partKey : '';
    sections.push([create + facts.q + ' (\n' + lines.map((l) => '    ' + l).join(',\n') + '\n)' + tail + ';']);
    sections.push(facts.partitions.map((p) => 'CREATE TABLE ' + p.q + ' PARTITION OF ' + p.parent + ' ' + p.bound + (p.part_key ? ' PARTITION BY ' + p.part_key : '') + ';'));
  } else {
    sections.push([(kind === 'view' ? 'CREATE VIEW ' : 'CREATE MATERIALIZED VIEW ') + facts.q + ' AS\n' + (facts.viewDef ?? '')]);
  }
  sections.push(facts.indexes.filter((i) => !i.by_constraint).map((i) => i.def + ';'));
  const what = kind === 'view' ? 'VIEW ' : kind === 'matview' ? 'MATERIALIZED VIEW ' : foreign ? 'FOREIGN TABLE ' : 'TABLE ';
  sections.push([
    ...(facts.comment !== null ? ['COMMENT ON ' + what + facts.q + ' IS ' + literal(facts.comment) + ';'] : []),
    ...cols.cols.filter((c) => c.note !== null).map((c) => 'COMMENT ON COLUMN ' + facts.q + '.' + c.q + ' IS ' + literal(c.note ?? '') + ';')
  ]);
  sections.push(facts.triggers.map((t) => t.def + ';'));
  return sections.filter((lines) => lines.length > 0).map((lines) => lines.join('\n')).join('\n\n') + '\n';
}

// ── Functions ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A function of the sidebar's list by its schema, name and identity arguments as listsStmt wrote them (oidvectortypes,
 * compared as text: overloads apart), through the same filter (no aggregate, no extension member). Two rows at most:
 * one is the answer, none or two (never seen: types print apart) are refused.
 */
function functionDefStmt(v: number, schema: string, name: string, args: string): Stmt {
  return {
    text: 'SELECT pg_catalog.pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace '
      + 'WHERE n.nspname = $1 AND p.proname = $2 AND pg_catalog.oidvectortypes(p.proargtypes) = $3 AND ' + functionFilter(v) + ' LIMIT 2',
    values: [schema, name, args], shape: 'cat.functiondef'
  };
}

/**
 * A function's definition (the sidebar's Copy Definition): CREATE OR REPLACE FUNCTION (or PROCEDURE) as
 * pg_get_functiondef writes it — text to read and copy, never run by Atelier. Kind 'gone' when it no longer exists (or
 * its arguments changed since the list was read).
 */
export async function readFunctionDef(s: DbSession, schema: string, name: string, args: string): Promise<string> {
  const r = await s.run(functionDefStmt(await versionOf(s), schema, name, args));
  if (r.rows.length > 1) throw new DbError({ kind: 'other', message: 'More than one function matches these arguments' });
  const def = r.rows[0]?.[0];
  if (def === null || def === undefined) throw new DbError({ kind: 'gone', message: 'This function no longer exists' });
  return def;
}

// ── Relations ──────────────────────────────────────────────────────────────────────────────────────────────────────

function relationsStmt(v: number, schema: string, name: string): Stmt {
  const clones = v >= V11 ? NO_CLONES : '';
  return {
    text: 'SELECT (SELECT pg_catalog.json_agg(f ORDER BY f.name) FROM (' + fkSelect(v) + ' AND con.conrelid = c.oid' + clones + ') f), '
      + '(SELECT pg_catalog.json_agg(f ORDER BY f.from_schema, f.from_table, f.name) FROM (' + fkSelect(v) + ' AND con.confrelid = c.oid' + clones + ') f) '
      + REL_MATCH,
    values: [schema, name], shape: 'cat.relations'
  };
}

/** The foreign keys schema.name holds (out: the tables it points at) and those pointing at it (in). */
export async function readRelations(s: DbSession, schema: string, name: string): Promise<DbRelations> {
  const row = (await s.run(relationsStmt(await versionOf(s), schema, name))).rows[0];
  if (!row) throw unknownTable(schema, name);
  return { out: json<FkRow[]>(row[0], []).map(toFk), in: json<FkRow[]>(row[1], []).map(toFk) };
}

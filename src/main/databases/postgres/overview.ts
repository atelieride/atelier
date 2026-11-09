// The database overview: size, connections, cache hit, the longest query, the transactions
// counter, the biggest tables, schemas, extensions, what is running now and, when pg_stat_statements is there, the
// slowest statements. One statement (shape `ov.main`) answers all of it, lists as JSON aggregates, so a poll costs one
// round trip, plus one more (`ov.slowest`) only when the extension exists. Everything is `pg_catalog`-qualified and
// read-only; the text is put together from this module's constants and a version gate, never from input.
import type { DbActivity, DbOverview, DbServerInfo } from '@shared/databases';
import type { DbSession } from '../driver';
import { quoteIdent } from '@shared/pg-json';
import { versionOf } from './catalog';

const V10 = 100000; // pg_stat_activity.backend_type, pg_class.relispartition

/** Rows of the "Now running" list, and of the biggest tables. */
const ACTIVITY_LIMIT = 50;
const BIGGEST_LIMIT = 6;
const QUERY_MAX = 300;

/**
 * Our database's sessions as `a`. From 10, clients only; before 10 there is no backend_type, so background workers
 * (autovacuum, replication) can count as sessions here.
 */
const MINE = (v: number): string => 'FROM pg_catalog.pg_stat_activity a WHERE a.datname = pg_catalog.current_database()'
  + (v >= V10 ? " AND a.backend_type IN ('client backend', 'standalone backend')" : '');
/** Seconds `a` has been in its state (an active one: its query). */
const SECONDS = "pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp() - "
  + "CASE WHEN a.state = 'active' THEN a.query_start ELSE a.state_change END))::pg_catalog.int8";
/** The query on one line, cut to QUERY_MAX; null when Postgres hides it from this role. */
const ONE_LINE = "CASE WHEN a.query IS NULL OR a.query = '<insufficient privilege>' THEN NULL ELSE "
  + "pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(a.query, '\\s+', ' ', 'g')), " + QUERY_MAX + ') END';
/** Block size, for turning pages into bytes. */
const BLOCK = "pg_catalog.current_setting('block_size')::pg_catalog.int8";

/**
 * Sizes. pg_relation_size and friends lock every relation they look at (an AccessShareLock that queues
 * behind VACUUM FULL, TRUNCATE or ALTER) and stat its files, on every poll; relpages is a column read from pg_class
 * without a lock. So a relation's size is relpages of the table, its TOAST table and all their indexes, times the
 * block size: "total size" as the Structure tab shows it, approximate as of the last VACUUM or ANALYZE. A partitioned
 * table has no pages of its own: it is the sum of its whole tree, which `tree` walks (partitions of partitions too).
 */
const SIZES = (v: number): string => 'rel AS (SELECT c.oid, n.nspname, c.relname, c.relkind, '
  + (v >= V10 ? 'c.relispartition' : 'false') + ' AS ispart, '
  + '(GREATEST(c.relpages, 0) + COALESCE(GREATEST(t.relpages, 0), 0) + COALESCE((SELECT pg_catalog.sum(GREATEST(i.relpages, 0)) FROM pg_catalog.pg_index x '
  + 'JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid WHERE x.indrelid IN (c.oid, c.reltoastrelid)), 0))::pg_catalog.int8 * ' + BLOCK + ' AS bytes '
  + 'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace '
  + 'LEFT JOIN pg_catalog.pg_class t ON t.oid = c.reltoastrelid '
  + "WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r', 'p', 'f', 'v', 'm')), "
  + (v >= V10
    ? 'tree(oid, root) AS (SELECT oid, oid FROM rel WHERE NOT ispart UNION ALL SELECT ih.inhrelid, tree.root FROM tree '
      + 'JOIN pg_catalog.pg_inherits ih ON ih.inhparent = tree.oid JOIN rel r ON r.oid = ih.inhrelid AND r.ispart), '
    : 'tree(oid, root) AS (SELECT oid, oid FROM rel), ')
  // One row per table, view or matview that is not a partition, with the bytes of its tree.
  + 'tot AS (SELECT tree.root, pg_catalog.sum(m.bytes)::pg_catalog.int8 AS bytes FROM tree JOIN rel m ON m.oid = tree.oid GROUP BY tree.root), '
  + 'top AS (SELECT r.nspname, r.relname, r.relkind, tot.bytes FROM rel r JOIN tot ON tot.root = r.oid WHERE NOT r.ispart)';

function mainText(v: number): string {
  const activity = 'SELECT a.pid, a.usename::pg_catalog.text AS role, a.application_name, a.state, ' + SECONDS + ' AS seconds, '
    + ONE_LINE + ' AS query, a.pid = pg_catalog.pg_backend_pid() AS ours ' + MINE(v);
  return 'WITH RECURSIVE act AS (' + activity + '), ' + SIZES(v) + ' SELECT '
    + "pg_catalog.date_part('epoch', pg_catalog.clock_timestamp() - pg_catalog.pg_postmaster_start_time()), "
    + 'pg_catalog.pg_database_size(pg_catalog.current_database()), '
    + "pg_catalog.current_setting('max_connections'), "
    + "(SELECT pg_catalog.count(*) FROM act), (SELECT pg_catalog.count(*) FROM act WHERE state = 'active'), "
    + "(SELECT pg_catalog.count(*) FROM act WHERE state LIKE 'idle in transaction%'), "
    + '(SELECT d.blks_hit::pg_catalog.float8 / NULLIF(d.blks_hit + d.blks_read, 0) FROM pg_catalog.pg_stat_database d WHERE d.datname = pg_catalog.current_database()), '
    + '(SELECT d.xact_commit + d.xact_rollback FROM pg_catalog.pg_stat_database d WHERE d.datname = pg_catalog.current_database()), '
    + "(SELECT pg_catalog.json_build_object('pid', l.pid, 'seconds', l.seconds, 'query', COALESCE(l.query, '')) FROM "
    + "(SELECT * FROM act WHERE state = 'active' AND NOT ours AND seconds IS NOT NULL ORDER BY seconds DESC LIMIT 1) l), "
    + "(SELECT pg_catalog.json_agg(pg_catalog.json_build_object('schema', t.nspname, 'name', t.relname, 'bytes', t.bytes) ORDER BY t.bytes DESC, t.relname) FROM "
    + "(SELECT nspname, relname, bytes FROM top WHERE relkind IN ('r', 'p', 'm') ORDER BY bytes DESC, relname LIMIT " + BIGGEST_LIMIT + ') t), '
    + "(SELECT pg_catalog.json_agg(pg_catalog.json_build_object('name', s.nspname, 'bytes', s.bytes, 'tables', s.tables, 'views', s.views) ORDER BY s.nspname) FROM "
    + "(SELECT n.nspname, COALESCE(pg_catalog.sum(top.bytes) FILTER (WHERE top.relkind IN ('r', 'p', 'm')), 0)::pg_catalog.int8 AS bytes, "
    + "pg_catalog.count(top.relname) FILTER (WHERE top.relkind IN ('r', 'p', 'f')) AS tables, pg_catalog.count(top.relname) FILTER (WHERE top.relkind IN ('v', 'm')) AS views "
    + 'FROM pg_catalog.pg_namespace n LEFT JOIN top ON top.nspname = n.nspname '
    + "WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' GROUP BY n.nspname) s), "
    + "(SELECT pg_catalog.json_agg(pg_catalog.json_build_object('name', e.extname, 'version', e.extversion, 'schema', xn.nspname) ORDER BY e.extname) "
    + 'FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace xn ON xn.oid = e.extnamespace) AS extensions, '
    + "(SELECT pg_catalog.json_agg(pg_catalog.json_build_object('pid', x.pid, 'role', x.role, 'app', x.application_name, 'state', x.state, "
    + "'seconds', x.seconds, 'query', x.query, 'ours', x.ours) ORDER BY (x.state = 'active') DESC NULLS LAST, x.seconds DESC NULLS LAST, x.pid) FROM "
    + "(SELECT * FROM act ORDER BY (state = 'active') DESC NULLS LAST, seconds DESC NULLS LAST, pid LIMIT " + ACTIVITY_LIMIT + ') x)';
}

/** pg_stat_statements 1.8 (Postgres 13) renamed mean_time to mean_exec_time: the extension's version decides, not the server's. */
function slowestText(ext: { version: string; schema?: string }): string {
  const [major, minor] = ext.version.split('.').map(Number);
  const mean = (major ?? 0) > 1 || ((major ?? 0) === 1 && (minor ?? 0) >= 8) ? 'mean_exec_time' : 'mean_time';
  const view = (ext.schema ? quoteIdent(ext.schema) + '.' : '') + 'pg_stat_statements';
  return "SELECT pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(s.query, '\\s+', ' ', 'g')), " + QUERY_MAX + '), s.calls, s.' + mean
    + ' FROM ' + view + ' s WHERE s.dbid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())'
    + " AND s.query <> '<insufficient privilege>' ORDER BY s." + mean + ' DESC LIMIT 5';
}

const num = (v: string | null | undefined): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const list = <T>(v: string | null | undefined): T[] => (v === null || v === undefined ? [] : (JSON.parse(v) as T[]));

export async function readOverview(s: DbSession, server: DbServerInfo): Promise<DbOverview> {
  const v = await versionOf(s);
  const r = (await s.run({ text: mainText(v), values: [], shape: 'ov.main' })).rows[0] ?? [];
  const extensions = list<{ name: string; version: string; schema?: string }>(r[11]);
  const longest = r[8] ? (JSON.parse(r[8]) as { pid: number; seconds: number; query: string }) : null;
  const uptime = num(r[0]);
  return {
    server,
    uptimeSec: uptime === null || !Number.isFinite(uptime) || uptime < 0 ? null : Math.floor(uptime),
    sizeBytes: num(r[1]) ?? 0,
    connections: { total: num(r[3]) ?? 0, max: num(r[2]) ?? 0, active: num(r[4]) ?? 0, idleInTx: num(r[5]) ?? 0 },
    cacheHit: num(r[6]),
    longest,
    xacts: num(r[7]) ?? 0,
    biggest: list(r[9]),
    schemas: list(r[10]),
    extensions: extensions.map((e) => ({ name: e.name, version: e.version })),
    activity: list<DbActivity>(r[12]),
    slowest: extensions.some((e) => e.name === 'pg_stat_statements') ? await slowest(s, extensions.find((e) => e.name === 'pg_stat_statements')!) : null,
    at: Date.now()
  };
}

async function slowest(s: DbSession, ext: { version: string; schema?: string }): Promise<DbOverview['slowest']> {
  try {
    const rows = (await s.run({ text: slowestText(ext), values: [], shape: 'ov.slowest' })).rows;
    return rows.map((x) => ({ query: x[0] ?? '', calls: num(x[1]) ?? 0, meanMs: num(x[2]) ?? 0 }));
  } catch {
    return null;
  }
}

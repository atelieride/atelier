// Databases view: the shared model. Pure: it runs in main and in
// the renderer, so no Node APIs.
import type { DbColumn, DbDerived, DbFilter, DbPath, DbSort } from './databases-filters';

export type DbEngineId = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'clickhouse' | 'mongodb';
export interface DbEngineInfo { id: DbEngineId; label: string; mono: string; note: string; ready: boolean; port: number }

export const DB_ENGINES: readonly DbEngineInfo[] = [
  { id: 'postgres', label: 'PostgreSQL', mono: 'Pg', note: 'Tables, views, functions', ready: true, port: 5432 },
  { id: 'mysql', label: 'MySQL · MariaDB', mono: 'My', note: 'Tables and views', ready: false, port: 3306 },
  { id: 'sqlite', label: 'SQLite', mono: 'Lt', note: 'A file in the project', ready: false, port: 0 },
  { id: 'mssql', label: 'SQL Server', mono: 'Ms', note: 'Tables and views', ready: false, port: 1433 },
  { id: 'clickhouse', label: 'ClickHouse', mono: 'Ch', note: 'Columnar analytics', ready: false, port: 8123 },
  { id: 'mongodb', label: 'MongoDB', mono: 'Mo', note: 'Documents, not tables', ready: false, port: 27017 }
];

export type DbEnv = 'local' | 'dev' | 'staging' | 'prod';
export type DbTls = 'off' | 'prefer' | 'require' | 'verify';
export type DbScope = { kind: 'project'; root: string } | { kind: 'all' };
/** An SSH tunnel's bastion. `port` null and `user` '': ~/.ssh/config decides (a host alias works). */
export interface DbSsh { host: string; port: number | null; user: string }

export interface DbConnection {
  id: string;
  name: string;
  engine: 'postgres';
  env: DbEnv;
  host: string;
  port: number;
  database: string;
  user: string;
  socket?: string;
  tls: DbTls;
  ssh: DbSsh | null;
  scope: DbScope;
  mask: boolean;
  writeNoted: boolean;
  schema?: string;
  createdAt: number;
}
export type DbConnectionForm = Omit<DbConnection, 'id' | 'mask' | 'writeNoted' | 'schema' | 'createdAt'>;

export type DbConnState = 'idle' | 'connecting' | 'connected' | 'password' | 'error';
/**
 * `norow`: the row a key named no longer exists; `toolarge`: a value over Load full value's 16 MB; `held`: a read
 * on a connection explicitly disconnected — nothing was contacted, Connect releases it.
 */
export type DbProblemKind =
  | 'refused' | 'host' | 'timeout' | 'auth' | 'password' | 'nodb' | 'toomany' | 'notls' | 'needtls' | 'cert' | 'ssh'
  | 'canceled' | 'denied' | 'gone' | 'lost' | 'unknown-table' | 'norow' | 'toolarge' | 'held' | 'other';
export interface DbProblem { kind: DbProblemKind; message: string; code?: string; detail?: string; hint?: string }
/** `warning`: done, with something to tell (e.g. the Keychain refused a password, kept until quit instead). */
export type DbResult<T> = { ok: true; value: T; warning?: string } | { ok: false; problem: DbProblem };

export interface DbServerInfo { version: string; versionNum: number; tls: boolean; role: string; canWrite: boolean; latencyMs: number }
export interface DbActivity { pid: number; role: string; app: string; state: string | null; seconds: number | null; query: string | null; ours: boolean }
export interface DbOverview {
  server: DbServerInfo; uptimeSec: number | null; sizeBytes: number;
  connections: { total: number; max: number; active: number; idleInTx: number }; cacheHit: number | null;
  longest: { pid: number; seconds: number; query: string } | null; xacts: number;
  biggest: { schema: string; name: string; bytes: number }[]; schemas: { name: string; bytes: number; tables: number; views: number }[];
  extensions: { name: string; version: string }[]; activity: DbActivity[];
  slowest: { query: string; calls: number; meanMs: number }[] | null; at: number;
}
export interface DbConnView {
  conn: DbConnection;
  state: DbConnState;
  problem: DbProblem | null;
  server: DbServerInfo | null;
  hasPassword: boolean;
  provider: string | null;
  /**
   * Explicitly disconnected: no read connects it — they answer kind 'held' — until a window selects or
   * connects it (or a password is typed for it). One truth for every window, kept until quit, never saved: the
   * renderer's held selectors read it (hold.ts), nothing of its own.
   */
  held: boolean;
}

export type DbRelKind = 'table' | 'view' | 'matview';
export interface DbRel { schema: string; name: string; kind: DbRelKind; estimate: number | null; partitions?: number }
export interface DbEnum { schema: string; name: string; values: string[] }
export interface DbFunction { schema: string; name: string; args: string; returns: string; oid: number }
/**
 * A function of a connection for its DDL (the sidebar's Copy Definition): by its catalog names and its
 * identity arguments as the sidebar lists them (`args`, oidvectortypes: overloads apart; '' for none).
 */
export interface DbFunctionRef { connId: string; schema: string; name: string; args: string }
/** A table, view or materialized view of any user schema, by name only (the palette's tables). */
export interface DbRelName { schema: string; name: string; kind: DbRelKind }
/** How many relations `names` holds at most. */
export const DB_NAMES_CAP = 10000;
/**
 * The selected connection's catalog: the sidebar's schema (`schema`: its relations, enums and functions), the schemas
 * that hold anything, and — for the palette — every user schema's relations the role may read, by name (`names`,
 * partitions left out, public first, then by schema and name; up to DB_NAMES_CAP, `namesMore` when there were more).
 * `database`: the one it was read from (the connection's); `databases`: the server's databases the role may connect
 * to, by name, sorted ([] when they couldn't be read; for the database chip); `noRels`: no table, view or
 * materialized view in any user schema (the sidebar says so and offers the others).
 */
export interface DbCatalog {
  connId: string;
  database: string;
  databases: string[];
  schemas: string[];
  schema: string;
  rels: DbRel[];
  noRels: boolean;
  enums: DbEnum[];
  functions: DbFunction[];
  names: DbRelName[];
  namesMore: boolean;
  readAt: number;
}

// Structure and relations, read from the catalog by src/main/databases/postgres/catalog.ts.
/**
 * An index: `def` from pg_get_indexdef, `scans` from pg_stat (null when the server keeps none), `partial` its WHERE;
 * `bytes` null for a partitioned table's own index (it stores nothing: its partitions' indexes do).
 */
export interface DbIndex { name: string; def: string; method: string; bytes: number | null; scans: number | null; unique: boolean; primary: boolean; partial: string | null; neverUsed: boolean }
/** A constraint (`def` from pg_get_constraintdef) or, with kind 't', a trigger (`def` from pg_get_triggerdef). */
export interface DbConstraint { name: string; kind: 'p' | 'f' | 'u' | 'c' | 'x' | 't'; def: string }
/**
 * A foreign key: the columns in key order on both sides (from.columns[i] points at to.columns[i]); `indexed` when an
 * index of the referencing table starts with exactly its columns (any order): counting what points at a row is cheap.
 */
export interface DbFk { name: string; from: { schema: string; table: string; columns: string[] }; to: { schema: string; table: string; columns: string[] }; indexed: boolean }
export interface DbStructure {
  schema: string;
  name: string;
  kind: DbRelKind;
  owner: string;
  comment: string | null;
  columns: (DbColumn & { comment: string | null; identity: boolean; generated: string | null; check: string | null })[];
  indexes: DbIndex[];
  constraints: DbConstraint[];
  /**
   * Bytes from the statistics (relpages × block size), as of the last VACUUM, ANALYZE
   * or CREATE INDEX; a partitioned table's are its partitions'. DbIndex.bytes likewise. `measured`: an ANALYZE or a
   * VACUUM (manual or auto) was ever seen on it — a partitioned table's, on one of its partitions —; else the sizes say
   * nothing yet.
   */
  size: { table: number; indexes: number; toast: number; total: number; measured: boolean };
  /** lastAnalyze, lastVacuum: ISO times (manual or auto, the latest), null when never. */
  stats: { estimate: number | null; dead: number | null; lastAnalyze: string | null; lastVacuum: string | null };
  /** A partitioned table's partitions, each in its own schema (usually the table's). */
  partitions: { schema: string; name: string; bound: string }[];
  viewDef: string | null;
}
/** Foreign keys this table holds (out, N:1) and those pointing at it (in, 1:N); a self-reference is in both. */
export interface DbRelations { out: DbFk[]; in: DbFk[] }

// Table data: the renderer's structured requests and main's replies (src/main/databases/queries.ts).
/** A table or view of a connection, by its catalog names. */
export interface DbTableRef { connId: string; schema: string; name: string }
/**
 * A page: the columns to select ([] = all), derived JSON columns after them, filters (AND), sorts, page index and size.
 * `slot`: the tab asking, at most DB_SLOT_MAX characters — a page not started yet is dropped ("Superseded")
 * when a newer page for the same slot comes; estimates and counts the same, each among its own kind.
 */
export interface DbPageRequest { ref: DbTableRef; columns: string[]; derived: DbDerived[]; filters: DbFilter[]; sort: DbSort[]; page: number; size: number; slot?: string }
/** A request slot's length at most (a tab key; longer keys send none). */
export const DB_SLOT_MAX = 300;
/**
 * A value as Postgres prints it; past 64 KB only its first 64 KB, and `cut` is its whole length in bytes (cut on the
 * server). A bytea's text is hex: its first 64 KB of bytes ('\x' + 2 × 65,536 characters), `cut` its whole
 * length in bytes — the bytes, not their hex.
 */
export interface DbCell { v: string | null; cut?: number }
/**
 * A page's rows: one cell per column, then one per derived column; `sql` is the statement for reading (values inlined).
 * `rowKey` names a row: the primary key, else the first unique key whose columns are all NOT NULL, else
 * none. `columns` always holds the row's key and every column an incoming foreign key references (the inspector's
 * keys): those the request left out come last and are named in `hidden`, to build keys with, not to show.
 */
export interface DbPage { columns: DbColumn[]; hidden: string[]; derived: DbDerived[]; rows: DbCell[][]; ms: number; sql: string; pk: string[]; rowKey: string[]; kind: DbRelKind }
/** The row a foreign key points at (every column), or null when there is none. */
export interface DbPeek { columns: DbColumn[]; row: DbCell[] | null }
/**
 * How many rows point at a row through a foreign key; 1001 means "1,000+". Null when not counted: `why` says no index
 * finds them (a count would scan the table), the count ran past the timeout, the role can't read that table, or the
 * key's value wasn't sent (a value too long to send).
 */
export interface DbRefCount { fk: DbFk; count: number | null; why?: 'no-index' | 'slow' | 'denied' | 'value' }
/** How many rows the filters keep (estimate, count); `slot` as DbPageRequest's. */
export interface DbFilteredRef { ref: DbTableRef; filters: DbFilter[]; slot?: string }
/**
 * The row whose `cols` hold `values`: a foreign key's target; `row`: the table's own row by its row key (main
 * refuses a key that doesn't name one row).
 */
export interface DbPeekRequest { ref: DbTableRef; cols: string[]; values: string[]; row?: true }
/** Referenced by: the row's value of every column an incoming foreign key references, null for a NULL. */
export interface DbRefsRequest { ref: DbTableRef; key: Record<string, string | null> }
/** Load full value: `column` (or the JSON at `path` in it) of the row `key` names by its row key (DbPage.rowKey). */
export interface DbFullRequest { ref: DbTableRef; key: Record<string, string>; column: string; path?: DbPath }

/** A window's view of its databases: the saved connections it can see, its project's pick, the pick's catalog. */
export interface DbSnapshot {
  connections: DbConnView[];
  selected: string | null;
  catalog: DbCatalog | null;
}
// In a module of its own: the first paint imports it from there, and nothing else of this one (databases-empty.ts).
export { EMPTY_DB_SNAPSHOT } from './databases-empty';

/** localhost, 127.0.0.0/8, ::1, and a Unix socket directory (or nothing, which means the local socket). */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '' || h.startsWith('/')) return true;
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function defaultEnv(host: string, socket?: string): DbEnv {
  return socket || isLoopback(host) ? 'local' : 'dev';
}

export function defaultTls(host: string, socket?: string): DbTls {
  return socket || isLoopback(host) ? 'prefer' : 'require';
}

// The provider chip comes from the host suffix.
const PROVIDERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Railway', ['.rlwy.net', '.railway.app', '.railway.internal']],
  ['Neon', ['.neon.tech']],
  ['Supabase', ['.supabase.co', '.supabase.com']],
  ['Render', ['.render.com']],
  ['AWS RDS', ['.rds.amazonaws.com']],
  ['Azure', ['.postgres.database.azure.com']],
  ['Aiven', ['.aivencloud.com']],
  ['DigitalOcean', ['.db.ondigitalocean.com']],
  ['Timescale', ['.tsdb.cloud.timescale.com']],
  ['Crunchy Bridge', ['.postgresbridge.com']]
];

export function providerOf(host: string): string | null {
  // A fully qualified name's trailing dot names the same host.
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  for (const [name, suffixes] of PROVIDERS) if (suffixes.some((s) => h.endsWith(s))) return name;
  return null;
}

export function defaultName(f: { host: string; database: string }): string {
  const p = providerOf(f.host);
  return p ? `${p} · ${f.database}` : f.database;
}

/** `c` + 12 lowercase hex chars: it doubles as the Keychain secret id suffix (`db-<id>`). */
export function newConnId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return 'c' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function envLabel(env: DbEnv): string {
  return { local: 'Local', dev: 'Dev', staging: 'Staging', prod: 'Prod' }[env];
}

export function compactCount(n: number | null): string {
  if (n === null) return '—';
  const shown = (v: number): number => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  // Rounded first, then the unit: 999,999 reads "1M", never "1000k".
  if (n >= 1e6 || shown(n / 1000) >= 1000) return `${shown(n / 1e6)}M`;
  if (n >= 1000) return `${shown(n / 1000)}k`;
  return String(n);
}

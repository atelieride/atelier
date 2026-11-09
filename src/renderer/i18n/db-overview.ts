// The database overview's strings: the header, the tiles, the cards, Now running,
// the states. Loaded with the table tab's lazy chunk (DbTabView), like i18n/db-table.ts (the live demo's first-paint
// budget). Same rules as en.ts: written for macOS, in Windows' words there.
import { currentPlatform } from '@shared/platform';
import { localize } from '@shared/windows-words';

const n = (count: number, one: string, many: string) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

const strings = {
  // The header's version line: "PostgreSQL 17.2 · host:port/database · up 21d 3h · TLS verified".
  version: (v: string) => `PostgreSQL ${v}`,
  up: (d: string) => `up ${d}`,
  tls: { on: 'TLS', verified: 'TLS verified', off: 'no TLS' },
  // The role chip: green when it can only read, amber when it can write.
  roleRead: (role: string) => `role ${role} can only read`,
  roleWrite: (role: string) => `role ${role} can write`,
  roleReadTip: 'This role can’t change anything here. Atelier is read-only either way.',
  roleWriteTip: 'This role could change data. Atelier stays read-only anyway: every query runs in a read-only transaction.',
  mask: 'Mask values',
  maskTip: (on: boolean) => (on ? 'Mask values: on — query values show as dots' : 'Mask values: off'),
  tiles: {
    size: 'Size',
    sizeSub: (tables: number, views: number) => (views > 0 ? `${n(tables, 'table', 'tables')} · ${n(views, 'view', 'views')}` : n(tables, 'table', 'tables')),
    connections: 'Connections',
    of: (max: number) => `/ ${max.toLocaleString('en-US')}`,
    connSub: (active: number, idleTx: number) => (idleTx > 0 ? `${active.toLocaleString('en-US')} active · ${idleTx.toLocaleString('en-US')} idle in transaction` : `${active.toLocaleString('en-US')} active`),
    cache: 'Cache hit',
    cacheSub: 'reads served from memory',
    cacheNone: 'no reads yet',
    longest: 'Longest query',
    longestSub: (pid: number) => `pid ${pid} · still running`,
    longestNone: 'nothing running',
    tx: 'Transactions',
    perSec: '/s',
    // Each poll is a read-only transaction or two: an idle database shows a small rate of its own.
    txTip: (rate: string) => `${rate} transactions a second, this overview’s own reads included`,
    measuring: 'measuring…',
    spark: (count: number) => `Transactions per second, the last ${n(count, 'sample', 'samples')}`
  },
  biggest: 'Biggest tables',
  tables: (count: number) => n(count, 'table', 'tables'),
  biggestNone: 'No tables yet',
  openTip: (name: string, size: string) => `Open ${name} · ${size}`,
  schemas: 'Schemas and extensions',
  schemaSub: (size: string, tables: number, views: number) => [size, n(tables, 'table', 'tables'), ...(views > 0 ? [n(views, 'view', 'views')] : [])].join(' · '),
  // The slowest statements need pg_stat_statements, installed and readable.
  hint: {
    before: 'Slow queries come from ',
    after: ' when it’s installed.',
    unreadable: 'pg_stat_statements is installed, but this role can’t read it (needs pg_read_all_stats).'
  },
  running: 'Now running',
  sessions: (count: number) => n(count, 'session', 'sessions'),
  runningNote: 'pg_stat_activity · every 5 s while shown',
  cols: { pid: 'pid', role: 'Role', app: 'Application', state: 'State', for: 'For', query: 'Query' },
  thisView: 'this view',
  hidden: 'hidden by Postgres (needs pg_read_all_stats)',
  noState: '—',
  under: '<1s',
  noSessions: 'No sessions on this database',
  ask: 'Ask Claude',
  askTip: 'Ask Claude about this query',
  slowest: 'Slowest statements',
  slowestNote: 'pg_stat_statements · by mean time',
  slowCols: { query: 'Statement', calls: 'Calls', mean: 'Mean' },
  slowestNone: 'No statements recorded yet',
  menu: { copyQuery: 'Copy Query', copyPid: 'Copy pid' },
  // A read that failed: the first one shows the problem; later ones keep the numbers and pause.
  paused: (why: string) => `Paused · ${why}`,
  retry: 'Retry',
  readFailed: 'Couldn’t read the overview'
} as const;

/** Windows names its own places and tools. macOS: as written. */
export const tov = currentPlatform() === 'win32' ? localize(strings) : strings;

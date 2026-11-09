// The acme-store's Postgres as the live demo's one saved connection: only what
// the first paint needs to show it in the sidebar. The database and user are those of the project's own DATABASE_URL
// (world/docker.ts: postgres://acme:…@postgres:5432/acme), reached on the container's published port; everything else —
// where it comes from, the server, the database itself — is in world/databases.ts, a chunk of its own.

export const ACME_DB = {
  id: 'c4cbe2d0a7f13',
  /** As Add Connection names it from the project's DATABASE_URL: the database. */
  name: 'acme',
  env: 'local',
  host: '127.0.0.1',
  port: 5432,
  database: 'acme',
  user: 'acme',
  tls: 'prefer',
  /** Saved this long before the visit. */
  savedAgoMs: 9 * 86_400_000
} as const;

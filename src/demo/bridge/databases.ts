// databases.* in the demo: the acme-store's Postgres as one saved connection,
// selected and idle, so the activity bar offers the view and showing it connects (as in the app). That is
// all the first paint carries: the engine and the database it reads (engine/databases.ts over world/databases.ts) are a
// chunk of their own, loaded on the first call that needs them — a connect, a read, a menu action — and from then on
// they answer everything, the snapshot included.
import type { AtelierApi } from '@shared/api';
import type { DbSnapshot } from '@shared/databases';
import { ACME_DB } from '../world/databases-conn';
import { resolved, type DemoContext } from './context';

type Db = AtelierApi['databases'];
/** `start`: when the demo started — the database is placed then, as the Docker and Redis worlds are. */
type Load = (ctx: DemoContext, initial: DbSnapshot, start: number) => Promise<Db>;

/**
 * Every method but the snapshot, answered by the engine (typed in full there). A list rather than one line each: the
 * first paint's budget has little room.
 */
const METHODS = [
  'select', 'connect', 'disconnect', 'password', 'test', 'save', 'duplicate', 'remove', 'setMask', 'noteWrite', 'setSchema', 'refresh',
  'page', 'estimate', 'count', 'peek', 'refs', 'full', 'structure', 'relations', 'ddl', 'overview', 'readOnlySql'
] as const satisfies readonly (keyof Db)[];
/** A databases method api.ts gains is a type error here until it is listed above (no silent gaps). */
type Unlisted = Exclude<keyof Db, 'snapshot' | (typeof METHODS)[number]>;
export const LISTED: [Unlisted] extends [never] ? true : Unlisted = true;

/** The engine, on first use. */
const loadDatabases: Load = (ctx, initial, start) => import('../engine/databases').then((m) => m.createDatabasesLive(ctx, initial, { start }));

/** What the view shows before the engine loads: the saved connection, selected, not connected yet. */
function startSnapshot(ctx: DemoContext): DbSnapshot {
  const { id, name, env, host, port, database, user, tls, savedAgoMs } = ACME_DB;
  return {
    connections: [{
      conn: { id, name, engine: 'postgres', env, host, port, database, user, tls, ssh: null, scope: { kind: 'project', root: ctx.world.project.root }, mask: false, writeNoted: false, createdAt: ctx.now() - savedAgoMs },
      state: 'idle', problem: null, server: null, hasPassword: true, provider: null, held: false
    }],
    selected: id, catalog: null
  };
}

/** `load`: tests hand their own (the demo imports the engine's chunk). A load that failed is tried again by the next call. */
export function createDatabases(ctx: DemoContext, opts: { load?: Load } = {}): Db {
  const start = ctx.now();
  const initial = startSnapshot(ctx);
  let live: Promise<Db> | null = null;
  const load = () => (live ??= (opts.load ?? loadDatabases)(ctx, initial, start).catch((e: unknown) => { live = null; throw e; }));
  const api: Record<string, unknown> = { snapshot: () => (live ? live.then((d) => d.snapshot()) : resolved(initial)) };
  for (const k of METHODS) api[k] = (...a: unknown[]) => load().then((d) => (d[k] as (...x: unknown[]) => unknown)(...a));
  return api as Db;
}

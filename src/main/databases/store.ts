// Saved database connections: ATELIER_HOME/databases.json, 0600, written atomically.
// Endpoint details and the project picks only: passwords live in the Keychain (secret id `db-<connId>`), and the
// strict schema (connection-schema.ts) refuses any key it does not know, so a stray `password` can never reach the file.
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../daemon/fsutil';
import { isAbsPath } from '@shared/paths';
import type { DbConnection } from '@shared/databases';
import { DB_CONN_ID as ID, dbConnectionSchema } from './connection-schema';

export { dbConnectionFields, dbConnectionSchema, hasEndpoint } from './connection-schema';

const MAX_CONNECTIONS = 64;
const MAX_PICKS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The secret store id of a connection's password (ids there match /^[a-z][a-z0-9-]{0,31}$/). */
export const secretIdOf = (connId: string): string => `db-${connId}`;

export interface DbStore {
  list(): DbConnection[];
  get(id: string): DbConnection | null;
  /** Insert or replace by id; throws on an invalid connection or beyond 64. */
  put(c: DbConnection): void;
  remove(id: string): void;
  pick(root: string): string | null;
  setPick(root: string, id: string | null): void;
}

const renameFile = (from: string, to: string): void => renameSync(from, to);

/** Whether the file is gone: only ENOENT says so. */
function missing(file: string): boolean {
  try {
    statSync(file);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function createDbStore(home: string, log: (m: string) => void = (m) => console.error(m), rename: (from: string, to: string) => void = renameFile): DbStore {
  const file = join(home, 'databases.json');
  let conns: DbConnection[] | null = null;
  let picks: Record<string, string> = {};
  let warned = false;
  /** A failed rename aside was logged: said once, not on every save that tries again. */
  let asideWarned = false;
  // Set when the file could not be read whole (another version, corrupt, too big) or entries were dropped: the original
  // is renamed aside once, right before the first save would overwrite it.
  let keepAside = false;
  const load = (): DbConnection[] => {
    if (conns) return conns;
    conns = [];
    try {
      if (statSync(file).size > MAX_FILE_BYTES) { keepAside = true; log('databases.json is over 2 MB and was not read'); return conns; }
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; connections?: unknown; picks?: unknown };
      if (raw.version !== 1) { keepAside = true; log('databases.json has another version and was not read'); return conns; }
      const seen = new Set<string>();
      let dropped = 0;
      const list = Array.isArray(raw.connections) ? raw.connections : [];
      for (const e of list) {
        const r = dbConnectionSchema.safeParse(e);
        if (r.success && !seen.has(r.data.id) && conns.length < MAX_CONNECTIONS) { seen.add(r.data.id); conns.push(r.data); } else dropped++;
      }
      const p = raw.picks && typeof raw.picks === 'object' ? (raw.picks as Record<string, unknown>) : {};
      const good = Object.entries(p).filter((e): e is [string, string] => isAbsPath(e[0]) && typeof e[1] === 'string' && ID.test(e[1]));
      picks = Object.fromEntries(good.slice(0, MAX_PICKS));
      dropped += Object.keys(p).length - Math.min(good.length, MAX_PICKS);
      if (dropped > 0) { keepAside = true; log(`databases.json: ${dropped} unusable entr${dropped === 1 ? 'y' : 'ies'} dropped`); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { keepAside = true; log('databases.json is unreadable and was not read'); }
    }
    return conns;
  };
  const save = (): void => {
    // Gone since (removed by hand): nothing to keep aside. A file that can't be looked at now is still there.
    if (keepAside && missing(file)) keepAside = false;
    if (keepAside) {
      let aside = `${file}.bad-${Date.now()}`;
      for (let n = 1; existsSync(aside); n++) aside = `${file}.bad-${Date.now()}-${n}`;
      try { rename(file, aside); keepAside = false; }
      catch (e) {
        // The original must not be overwritten: keep the memory, try the rename again on the next save.
        if (!asideWarned) {
          asideWarned = true;
          log(`databases.json could not be set aside (${e instanceof Error ? e.message : String(e)}); not saved`);
        }
        return;
      }
    }
    try { writeFileAtomic(file, JSON.stringify({ version: 1, connections: load(), picks }, null, 2), 0o600); }
    catch (e) {
      // Kept in memory for this run; say so once.
      if (!warned) { warned = true; console.error('databases.json not saved:', e instanceof Error ? e.message : String(e)); }
    }
  };
  return {
    list: () => [...load()],
    get: (id) => load().find((c) => c.id === id) ?? null,
    put: (c) => {
      const r = dbConnectionSchema.safeParse(c);
      if (!r.success) throw new Error('Invalid connection');
      const cur = load();
      const i = cur.findIndex((x) => x.id === r.data.id);
      if (i < 0 && cur.length >= MAX_CONNECTIONS) throw new Error(`At most ${MAX_CONNECTIONS} connections`);
      conns = i < 0 ? [...cur, r.data] : cur.map((x, j) => (j === i ? r.data : x));
      save();
    },
    remove: (id) => {
      const cur = load();
      if (!cur.some((c) => c.id === id)) return;
      conns = cur.filter((c) => c.id !== id);
      picks = Object.fromEntries(Object.entries(picks).filter((e) => e[1] !== id));
      save();
    },
    pick: (root) => {
      load();
      const id = Object.hasOwn(picks, root) ? picks[root] : undefined;
      return id !== undefined && conns?.some((c) => c.id === id) ? id : null;
    },
    setPick: (root, id) => {
      load();
      if (!isAbsPath(root)) return;
      if (id === null) {
        if (!(root in picks)) return;
        picks = Object.fromEntries(Object.entries(picks).filter((e) => e[0] !== root));
      } else {
        if (!ID.test(id) || picks[root] === id || (!(root in picks) && Object.keys(picks).length >= MAX_PICKS)) return;
        picks = { ...picks, [root]: id };
      }
      save();
    }
  };
}

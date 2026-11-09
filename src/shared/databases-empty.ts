// The Databases view's snapshot before main answers, alone in its module: the first paint needs
// only this, so it reaches none of databases.ts — the engine table, the providers, the helpers stay with the view's lazy
// chunks (the live demo's first-paint budget). databases.ts exports it too.
import type { DbSnapshot } from './databases';

export const EMPTY_DB_SNAPSHOT: DbSnapshot = { connections: [], selected: null, catalog: null };

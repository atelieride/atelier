import type { OpenFileEntry } from './files';
import { isAbsPath } from './paths';

// A project's tabs across restarts: its file tabs, the order of file and terminal tabs, and
// the tab in front. Saved by main in ATELIER_HOME/tabs.json; restored when the project's window opens.

export const MAX_SAVED_TABS = 100;
/** The Shelf's outside files main keeps granted: the shelf's own limit. */
export const MAX_SAVED_SHELF = 50;
const MAX_PATH_BYTES = 4096;

export interface SavedTabs {
  /** Absolute paths of the file tabs (project files and files outside it the user opened). */
  files: string[];
  /** `f:<path>` (one of `files`), `t:<terminal id>` and `db:…` (table tabs), left to right. */
  order: string[];
  /** The key in front (a file or a terminal), or null. */
  active: string | null;
  /** The Shelf's files outside the project (its project files need no grant), granted again on restore. */
  shelf?: string[];
  /** The Databases space's table in front, one of the order's `db:` keys. */
  dbActive?: string | null;
}

/** What a window gets back: the files that are still there, with their labels. */
export interface RestoredTabs { files: OpenFileEntry[]; order: string[]; active: string | null; /** The Shelf's outside files granted again. */ shelf?: OpenFileEntry[]; /** The Databases space's table in front. */ dbActive?: string }

const utf8 = new TextEncoder();
const absPath = (v: unknown): v is string => typeof v === 'string' && isAbsPath(v) && utf8.encode(v).length <= MAX_PATH_BYTES;
const TERM_KEY = /^t:[\w.-]{1,64}$/;

/** A table tab's key is at most this long. */
export const MAX_DB_TAB_KEY = 300;
/** One URI-encoded part of a table tab's key, as encodeURIComponent writes it (never a slash, a space or a bare %). */
const DB_PART = "(?:[A-Za-z0-9\\-_.!~*'()]|%[0-9A-F]{2})+";
/** `db:<connId>/<schema>/<name>` (a table, view or materialized view) or `db:<connId>` (the connection's overview). */
const DB_TAB_KEY = new RegExp(`^db:c[0-9a-f]{12}(?:/${DB_PART}/${DB_PART})?$`);

/** A table tab's key, well formed: the renderer's dbTabKey writes them, a saved state or a pop-out only names them. */
export function isDbTabKey(k: string): boolean {
  return k.length <= MAX_DB_TAB_KEY && DB_TAB_KEY.test(k);
}

/** A saved state read field by field: junk entries are dropped, never the whole state; null if it isn't one. */
export function parseSavedTabs(raw: unknown): SavedTabs | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.files) || !Array.isArray(o.order)) return null;
  const files = [...new Set(o.files.filter(absPath))].slice(0, MAX_SAVED_TABS);
  const known = new Set(files);
  const order = [...new Set(o.order.filter((k): k is string => typeof k === 'string' && (TERM_KEY.test(k) || isDbTabKey(k) || (k.startsWith('f:') && known.has(k.slice(2))))))];
  // A terminal in front may not be in the order (its tab hidden): kept, the window checks it is alive.
  const active = typeof o.active === 'string' && (order.includes(o.active) || TERM_KEY.test(o.active)) ? o.active : null;
  const shelf = Array.isArray(o.shelf) ? [...new Set(o.shelf.filter(absPath))].slice(0, MAX_SAVED_SHELF) : null;
  // The Databases space's table in front: one of the order's tables, else none.
  const dbActive = typeof o.dbActive === 'string' && isDbTabKey(o.dbActive) && order.includes(o.dbActive) ? o.dbActive : null;
  return { files, order, active, ...(shelf ? { shelf } : {}), ...(dbActive ? { dbActive } : {}) };
}

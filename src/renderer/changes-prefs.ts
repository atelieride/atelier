// Viewer preferences of the Changes panel: compact rows, collapsed groups and the grouping. Saved in localStorage like
// the panel widths.

export type ChangesGrouping = 'repo' | 'session';

/**
 * compact: one-line rows without the folder. Rows with their folder are the default; the old `expanded` field (saved
 * while compact rows were the default, so mostly never chosen) is ignored on purpose, so everyone starts with folders.
 */
export interface ChangesPrefs { compact: boolean; collapsed: string[]; grouping: ChangesGrouping }

export const CHANGES_PREFS_DEFAULTS: ChangesPrefs = { compact: false, collapsed: [], grouping: 'repo' };
/** Session ids come and go: the oldest collapsed keys are forgotten past this many. */
export const MAX_COLLAPSED = 200;
const KEY = 'atelier.changesPrefs';

export function groupKey(grouping: ChangesGrouping, key: string): string {
  return `${grouping}:${key}`;
}

const capped = (keys: string[]) => keys.slice(-MAX_COLLAPSED);

/** From the saved value (whatever it contains) to valid prefs. */
export function parseChangesPrefs(raw: string | null): ChangesPrefs {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: use defaults */ }
  const collapsed = Array.isArray(o.collapsed) ? [...new Set(o.collapsed.filter((k): k is string => typeof k === 'string' && k.length > 0))] : [];
  return { compact: o.compact === true, collapsed: capped(collapsed), grouping: o.grouping === 'session' ? 'session' : 'repo' };
}

export function loadChangesPrefs(): ChangesPrefs {
  try { return parseChangesPrefs(localStorage.getItem(KEY)); } catch { return { ...CHANGES_PREFS_DEFAULTS, collapsed: [] }; }
}

export function saveChangesPrefs(p: ChangesPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* not saved: stays for this session */ }
}

/** Collapses an open group or expands a collapsed one. */
export function toggleGroup(collapsed: string[], key: string): string[] {
  return collapsed.includes(key) ? collapsed.filter((k) => k !== key) : capped([...collapsed, key]);
}

/** ⌥-click: every group in `keys` takes the opposite of the clicked group's state; keys of other groupings are kept. */
export function toggleAllGroups(collapsed: string[], keys: string[], clicked: string): string[] {
  const rest = collapsed.filter((k) => !keys.includes(k));
  return collapsed.includes(clicked) ? rest : capped([...rest, ...keys]);
}

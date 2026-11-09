// Split view layout per project: saved in localStorage per project root with the same rules
// as the pins and hidden tabs. What an entry holds — version 2 (every pane's tabs) or 1 (one key per pane, read for
// layouts saved before tab groups) — is checked when it is restored (split.ts restoreLayout).
import type { SavedLayout } from './split';

const KEY = 'atelier.splitLayout';
/** Projects come and go: the least recently saved ones are forgotten past this many. */
export const MAX_LAYOUT_PROJECTS = 50;

/** From the saved value (whatever it contains) to the entries that are objects, by project root. */
export function parseLayouts(raw: string | null): Record<string, unknown> {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: nothing saved */ }
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v)));
}

/** This project's saved layout, unchecked (restoreLayout validates it), or null. */
export function loadLayout(root: string): unknown {
  try { return parseLayouts(localStorage.getItem(KEY))[root] ?? null; } catch { return null; }
}

/** Saves this project's layout (it becomes the most recent one); null (one pane) removes it. */
export function saveLayout(root: string, layout: SavedLayout | null): void {
  try {
    const rest = Object.entries(parseLayouts(localStorage.getItem(KEY))).filter(([r]) => r !== root);
    if (layout) rest.push([root, layout]);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(rest.slice(-MAX_LAYOUT_PROJECTS))));
  } catch { /* not saved: stays for this session */ }
}

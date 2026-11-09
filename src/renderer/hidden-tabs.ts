// Terminal tabs closed while the terminal keeps running in atelierd (it stays in the sidebar, selecting it shows the tab
// again): terminal ids per project root, saved in localStorage with the same rules as the pins.
import { parsePins, withProjectPins } from './pins';

export const KEY = 'atelier.hiddenTabs';

export function loadHidden(root: string): string[] {
  try { return parsePins(localStorage.getItem(KEY))[root] ?? []; } catch { return []; }
}

export function saveHidden(root: string, ids: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(withProjectPins(parsePins(localStorage.getItem(KEY)), root, ids))); } catch { /* not saved: stays for this session */ }
}

/** The hidden ids with `ids` added (once each, in order). */
export function hideIds(hidden: string[], ids: string[]): string[] {
  return [...new Set([...hidden, ...ids])];
}

/** The hidden ids without `id` (the same list when it was not hidden). */
export function showId(hidden: string[], id: string): string[] {
  return hidden.includes(id) ? hidden.filter((x) => x !== id) : hidden;
}

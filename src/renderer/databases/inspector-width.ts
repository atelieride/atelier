// The row inspector's width: one app-wide preference, not a tab's — every table tab draws the width last
// chosen in any of them, a tab opened since included, and it comes back after a restart. Kept as the side panels' widths
// are (panels.ts): this installation's localStorage (the Chromium data under ATELIER_HOME), read once when the view's
// chunk loads; a page without storage keeps it for the run. Lazy, with the table tab (nothing of it in the
// first paint).
import { create } from 'zustand';
import { clampWidth, INSPECTOR_DEFAULT } from './inspector-model';

const KEY = 'atelier.dbInspectorWidth';

/** From the saved text (whatever it holds) to a width the inspector takes; nothing usable: the default. */
export function parseInspectorWidth(raw: string | null): number {
  if (raw === null || raw.trim() === '') return INSPECTOR_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? clampWidth(n) : INSPECTOR_DEFAULT;
}

function load(): number {
  try { return parseInspectorWidth(localStorage.getItem(KEY)); } catch { return INSPECTOR_DEFAULT; }
}

/** The app's inspector width, for every table tab. */
export const useInspectorWidth = create<{ width: number }>(() => ({ width: load() }));

/** The user resized it (a drag released, a key, a double click): every tab's, and saved for the next start. */
export function setInspectorWidth(w: number): void {
  const width = clampWidth(w);
  useInspectorWidth.setState({ width });
  try { localStorage.setItem(KEY, String(width)); } catch { /* not saved: kept for this run */ }
}

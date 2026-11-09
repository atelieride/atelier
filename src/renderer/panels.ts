// Width of the sessions sidebar (left) and the Changes panel (right), adjustable by dragging their edge.

export type Panel = 'sidebar' | 'changes';
export type PanelWidths = Record<Panel, number>;

export const PANEL_DEFAULTS: PanelWidths = { sidebar: 264, changes: 304 };
const LIMITS: Record<Panel, [number, number]> = { sidebar: [200, 480], changes: [240, 560] };
const KEY = 'atelier.panels';

export function clampPanel(p: Panel, w: number): number {
  const [min, max] = LIMITS[p];
  return Math.min(max, Math.max(min, Math.round(w)));
}

/**
 * A panel's width after its edge moved `delta` px (positive: wider), when a small window draws it at `drawn`, narrower
 * than its `saved` width: narrowing starts from what is drawn, so the edge follows at once;
 * widening never lowers the saved width (with no room, nothing changes); not moving keeps it.
 */
export function resizedWidth(saved: number, drawn: number, delta: number): number {
  if (delta === 0) return saved;
  return delta > 0 ? Math.max(saved, drawn + delta) : drawn + delta;
}

/** From the saved value (whatever it contains) to valid widths. */
export function parseLayout(raw: string | null): PanelWidths {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object') o = v as Record<string, unknown>; } catch { /* broken: use defaults */ }
  const pick = (p: Panel) => (typeof o[p] === 'number' && Number.isFinite(o[p]) ? clampPanel(p, o[p] as number) : PANEL_DEFAULTS[p]);
  return { sidebar: pick('sidebar'), changes: pick('changes') };
}

// Preference of this installation: localStorage (in the Chromium data under ATELIER_HOME). If absent, the defaults.
export function loadLayout(): PanelWidths {
  try { return parseLayout(localStorage.getItem(KEY)); } catch { return { ...PANEL_DEFAULTS }; }
}

export function saveLayout(w: PanelWidths): void {
  try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* not saved: stays for this session */ }
}

/**
 * Settings › Appearance › "Swap side panels" mirrors the window body (CSS row-reverse: nothing remounts). +1: dragging
 * a panel's edge to the right widens it (a panel on the left), -1 for a panel on the right.
 */
export const resizeDir = (p: Panel, swapped: boolean): 1 | -1 => ((p === 'sidebar') !== swapped ? 1 : -1);

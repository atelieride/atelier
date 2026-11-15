// The split view's measured geometry: the workspace body's size and each pane's rectangle in it, in px, as last laid
// out. Kept apart from the app store on purpose: it changes with every frame of a window resize or a divider drag, and
// only the few readers that need it subscribe (or read it once, with getState, when a command runs).
import { create } from 'zustand';
import type { Rect } from './split-tree';

export interface PaneArea {
  /** The workspace body's size; null until it has been measured. */
  area: { width: number; height: number } | null;
  /** Each pane's rectangle in the body, in pane order (one pane: the whole body). */
  panes: Rect[];
  /** A new measure: stored only when something changed, so subscribers see no change for the same layout. */
  set(area: { width: number; height: number } | null, panes: Rect[]): void;
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export const usePaneArea = create<PaneArea>()((set, get) => ({
  area: null,
  panes: [],
  set: (area, panes) => {
    const cur = get();
    const sameArea = cur.area === area || (!!cur.area && !!area && cur.area.width === area.width && cur.area.height === area.height);
    const samePanes = cur.panes.length === panes.length && cur.panes.every((r, i) => sameRect(r, panes[i]!));
    if (sameArea && samePanes) return;
    set({ ...(sameArea ? {} : { area }), ...(samePanes ? {} : { panes }) });
  }
}));

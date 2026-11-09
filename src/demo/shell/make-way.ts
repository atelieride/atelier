// "Things to try" makes way for the Changes panel: the list floats bottom right, which is where the
// panel keeps its commit bar and drawer. Drawer closed: the list stays on the right, lifted just above the bar (the
// workspace stays uncovered: Redis' "Ask Claude Why It Failed" sits bottom right there). Drawer open: the list sits just
// left of the panel, so ✦, the message and Commit stay reachable. An Ask panel docks at
// its pane's right edge with its composer at the bottom: a list that would touch it sits just left of it. Pure: the
// shell measures and sets `right`/`bottom`.

/** The list's usual distance from the window's right edge (and from the panel when it moves left of it). */
export const CHECK_GAP = 16;
/** The list's usual distance from the window's bottom (above the app's footer). */
export const CHECK_BOTTOM = 40;
/** Space left between the list and the commit bar under it. */
const OVER_BAR = 8;
/** The list's width when open (shell.css `.dm-check`); folded it is narrower, so this is the widest it covers. */
const CHECK_WIDTH = 300;

export interface PlaceInput {
  /** The Changes panel, null when it doesn't show. */
  changes: { left: number; width: number } | null;
  /** The commit bar's top edge, null when there is none (the drawer open, Read-only). */
  barTop: number | null;
  /** The commit drawer is open. */
  drawer: boolean;
  width: number;
  height: number;
  /** The right-most Ask panel on screen (docked or a sheet), null when none shows. */
  ask?: { left: number; width: number } | null;
}

function changesPlace(o: PlaceInput): { right: number; bottom: number } {
  const usual = { right: CHECK_GAP, bottom: CHECK_BOTTOM };
  if (!o.changes || o.changes.width <= 0) return usual;
  if (o.drawer) return { right: Math.max(CHECK_GAP, Math.round(o.width - o.changes.left + CHECK_GAP)), bottom: CHECK_BOTTOM };
  if (o.barTop === null) return usual;
  return { right: CHECK_GAP, bottom: Math.max(CHECK_BOTTOM, Math.round(o.height - o.barTop + OVER_BAR)) };
}

export function checklistPlace(o: PlaceInput): { right: number; bottom: number } {
  const at = changesPlace(o);
  const ask = o.ask;
  if (!ask || ask.width <= 0) return at;
  const right = o.width - at.right;
  if (right <= ask.left || right - CHECK_WIDTH >= ask.left + ask.width) return at;
  return { right: Math.max(at.right, Math.round(o.width - ask.left + CHECK_GAP)), bottom: CHECK_BOTTOM };
}

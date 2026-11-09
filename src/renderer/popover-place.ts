// Where a popover goes: below its anchor (flipped above without room) or to its
// right, always inside the window with an 8 px margin, its width min(wanted, window − 16). Pure.
export interface Box { left: number; top: number; right: number; bottom: number }
const MARGIN = 8;
const GAP = 6;
const MIN_HEIGHT = 160;

export function placePopover(anchor: Box, side: 'below' | 'right', size: { width: number; height: number }, view: { width: number; height: number }) {
  const width = Math.max(0, Math.min(size.width, view.width - 2 * MARGIN));
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, view.width - width - MARGIN));
  if (side === 'right') {
    const left = anchor.right + GAP + width + MARGIN <= view.width ? anchor.right + GAP : clampX(anchor.left);
    const top = Math.max(MARGIN, Math.min(anchor.top, view.height - MIN_HEIGHT - MARGIN));
    return { left, top, width, maxHeight: Math.max(0, view.height - top - MARGIN) };
  }
  const below = view.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  // Prefer shrinking below the anchor to overflowing; flip above only when it has clearly more room.
  if (below >= Math.min(size.height, MIN_HEIGHT) || below >= above) {
    return { left: clampX(anchor.left), top: anchor.bottom + GAP, width, maxHeight: Math.max(0, below) };
  }
  const maxHeight = Math.max(0, Math.min(size.height, above));
  return { left: clampX(anchor.left), top: Math.max(MARGIN, anchor.top - GAP - maxHeight), width, maxHeight };
}

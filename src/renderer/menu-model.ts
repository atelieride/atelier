import type { IconName } from './components/Icon';

/** submenu: the item opens a nested menu (hover, → or Enter) instead of running. */
/** tip: a tooltip on the item (e.g. why it is disabled). */
// detail: a second line in mono under the label (Copy Path As's formats); accent: a violet item (Mention in Session…).
// checked: a checkable item, on or off (the Windows menu's Word Wrap); radio: one choice among others (a workspace).
export type MenuItem = { id: string; label: string; detail?: string; icon?: IconName; hint?: string; tip?: string; danger?: boolean; accent?: boolean; disabled?: boolean; checked?: boolean; radio?: true; submenu?: MenuItem[]; run: () => void } | 'sep';

/** How an item is announced: a plain item, or a checkbox or radio with its state. */
export function itemRole(it: Exclude<MenuItem, 'sep'>): { role: 'menuitem' } | { role: 'menuitemcheckbox' | 'menuitemradio'; 'aria-checked': boolean } {
  if (it.checked === undefined) return { role: 'menuitem' };
  return { role: it.radio ? 'menuitemradio' : 'menuitemcheckbox', 'aria-checked': it.checked };
}

/**
 * Where the focus goes back when menus close: what had it before the first of them. A menu replacing another (a menu
 * bar switching drop-downs) keeps that, so the focus never bounces through a terminal (which would report it).
 */
export function menuFocus<E>() {
  let before: E | null = null;
  let open = false;
  return {
    /** A menu shown, opened or replacing another; `active`: what has the focus now. */
    shown(active: E | null): void { if (!open) { before = active; open = true; } },
    /** No menu any more: what to focus again. */
    closed(): E | null { const el = before; before = null; open = false; return el; }
  };
}

/** Menu position: where you click; if there is no room it opens to the left or above, always inside the window. */
export function placeMenu(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 8): { left: number; top: number } {
  let left = x + w > vw - margin ? x - w : x;
  let top = y + h > vh - margin ? y - h : y;
  left = Math.max(margin, Math.min(left, vw - margin - w));
  top = Math.max(margin, Math.min(top, vh - margin - h));
  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}

/**
 * Where a tooltip goes: centered under its element, sliding sideways to stay inside the window (a menu flips to the
 * other side of the pointer instead, which would take a wide tip far from what it describes); above when no room below.
 */
export function placeTip(el: { left: number; right: number; top: number; bottom: number }, w: number, h: number, vw: number, vh: number, margin = 6): { left: number; top: number } {
  const left = Math.max(margin, Math.min((el.left + el.right) / 2 - w / 2, vw - margin - w));
  const below = el.bottom + 8;
  const top = below + h > vh - margin ? Math.max(margin, el.top - 8 - h) : below;
  return { left, top };
}

const selectable = (it: MenuItem | undefined) => !!it && it !== 'sep' && !it.disabled;

/** Next item with the arrow keys: skips separators and disabled items, wraps around; -1 if none is selectable. */
export function nextIndex(items: MenuItem[], i: number, dir: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const j = (((i + dir * step) % n) + n) % n;
    if (selectable(items[j])) return j;
  }
  return -1;
}

/** Menu under a button: aligned to its left edge, or the right one if there is no room; always inside the window. */
/**
 * A menu bar's drop-down (Windows): under its title like an anchored menu, but never moved up over the bar (the other
 * titles must stay reachable); taller than the room left, it scrolls within maxHeight.
 */
export function placeDropDown(anchor: { left: number; right: number; bottom: number }, w: number, h: number, vw: number, vh: number, margin = 8): { left: number; top: number; maxHeight: number } {
  const top = anchor.bottom + 6;
  return { left: placeAnchored(anchor, w, h, vw, vh, margin).left, top, maxHeight: vh - margin - top };
}

export function placeAnchored(anchor: { left: number; right: number; bottom: number }, w: number, h: number, vw: number, vh: number, margin = 8): { left: number; top: number } {
  let left = anchor.left + w > vw - margin ? anchor.right - w : anchor.left;
  left = Math.max(margin, Math.min(left, vw - margin - w));
  const top = Math.max(margin, Math.min(anchor.bottom + 6, vh - margin - h));
  return { left, top };
}

/** Home/End in the menu: the first or last item that can be chosen (-1 if none). */
export function edgeIndex(items: MenuItem[], edge: 'first' | 'last'): number {
  return edge === 'first' ? nextIndex(items, -1, 1) : nextIndex(items, items.length, -1);
}

/** A submenu: to the right of its item (top aligned with the item's first entry), to the left without room; always inside the window. */
export function placeSubmenu(item: { left: number; right: number; top: number }, w: number, h: number, vw: number, vh: number, margin = 8): { left: number; top: number } {
  let left = item.right + 2 + w > vw - margin ? item.left - 2 - w : item.right + 2;
  left = Math.max(margin, Math.min(left, vw - margin - w));
  const top = Math.max(margin, Math.min(item.top - 5, vh - margin - h));
  return { left, top };
}

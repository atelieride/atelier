// The tab strip scrolls sideways. Chromium only does that for a horizontal wheel (or Shift+wheel): a plain mouse wheel
// over the tabs did nothing. These are the pure rules; Tabs.tsx wires them to the element.

const LINE_PX = 16;
// A mouse notch arrives as one big delta (or in lines/pages); a trackpad as a stream of small pixel deltas.
const NOTCH_PX = 50;

/** How far a wheel event moves the strip, or null when the browser should handle it (a horizontal gesture). */
export function wheelToStrip(e: { deltaX: number; deltaY: number; deltaMode: number }, page: number, reduced: boolean): { left: number; smooth: boolean } | null {
  if (e.deltaY === 0 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return null;
  const left = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * page : e.deltaY;
  return { left, smooth: !reduced && (e.deltaMode !== 0 || Math.abs(e.deltaY) >= NOTCH_PX) };
}

/** Where a wheel move takes the strip, given the goal of the glide in flight (null when idle). Everything that arrives
 *  mid-glide extends its goal, notches and small momentum deltas alike: Chromium restarts a programmatic smooth
 *  scroll from where it is, and an instant one cancels it, so either would lose distance. */
export function planWheel(move: { left: number; smooth: boolean }, goal: number | null, scrollLeft: number, max: number): { goal: number | null; to: number; smooth: boolean } {
  const clamp = (x: number) => Math.min(max, Math.max(0, x));
  if (!move.smooth && goal === null) return { goal: null, to: clamp(scrollLeft + move.left), smooth: false };
  const to = clamp(clamp(goal ?? scrollLeft) + move.left);
  // Nothing to travel: no glide starts, so no scrollend would ever clear the goal.
  return Math.abs(to - scrollLeft) < 0.5 ? { goal: null, to, smooth: false } : { goal: to, to, smooth: true };
}

/** Which edges fade: the ones with more tabs beyond them. */
export function stripFade(scrollLeft: number, scrollWidth: number, clientWidth: number): { start: boolean; end: boolean } {
  const max = scrollWidth - clientWidth;
  return { start: scrollLeft > 1, end: max > 1 && scrollLeft < max - 1 };
}

/** The scroll position that shows a tab clear of the edge fades (`pad`), or null when it is already in view. */
export function revealLeft(tab: { left: number; width: number }, view: { scrollLeft: number; width: number }, pad: number): number | null {
  const start = Math.max(0, tab.left - pad);
  if (start < view.scrollLeft || tab.width + 2 * pad > view.width) return start === view.scrollLeft ? null : start;
  const end = tab.left + tab.width + pad;
  return end > view.scrollLeft + view.width ? end - view.width : null;
}

/** The strip went from `before` to `after` px wide: where to scroll so the tab in front, whole before, stays whole (as
 *  `revealLeft`), or null. One the user had wheeled out of view is theirs: left there. Only narrowing can cut a tab. */
export function keepInView(tab: { left: number; width: number }, scrollLeft: number, before: number, after: number, pad: number): number | null {
  if (after >= before || revealLeft(tab, { scrollLeft, width: before }, 0) !== null) return null;
  return revealLeft(tab, { scrollLeft, width: after }, pad);
}

/** A clicked tab shown whole, as `revealLeft`, but the strip moves no farther than keeps the point clicked on the tab:
 *  the second click of a double click lands on it again. `at`: the pointer from the strip's left edge (null from the
 *  keyboard). */
export function revealClicked(tab: { left: number; width: number }, view: { scrollLeft: number; width: number }, pad: number, at: number | null): number | null {
  const left = revealLeft(tab, view, pad);
  if (left === null || at === null) return left;
  // The pointer then rests at left + at in the strip's content: a pixel inside the tab at either end.
  const held = Math.min(tab.left + tab.width - 1 - at, Math.max(tab.left + 1 - at, left));
  return held === view.scrollLeft ? null : held;
}

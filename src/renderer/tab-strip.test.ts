import { expect, test } from 'vitest';
import { keepInView, planWheel, revealClicked, revealLeft, stripFade, wheelToStrip } from './tab-strip';

const PX = 0; const LINE = 1; const PAGE = 2;

test('a vertical wheel scrolls the tab strip sideways: mouse notches glide, trackpad deltas stay 1:1', () => {
  expect(wheelToStrip({ deltaX: 0, deltaY: 100, deltaMode: PX }, 600, false)).toEqual({ left: 100, smooth: true });
  expect(wheelToStrip({ deltaX: 0, deltaY: -4, deltaMode: PX }, 600, false)).toEqual({ left: -4, smooth: false });
  expect(wheelToStrip({ deltaX: 0, deltaY: 3, deltaMode: LINE }, 600, false)).toEqual({ left: 48, smooth: true });
  expect(wheelToStrip({ deltaX: 0, deltaY: -1, deltaMode: PAGE }, 600, false)).toEqual({ left: -600, smooth: true });
});

test('a horizontal gesture is left to the browser, and Reduce motion never glides', () => {
  expect(wheelToStrip({ deltaX: 30, deltaY: 10, deltaMode: PX }, 600, false)).toBeNull();
  expect(wheelToStrip({ deltaX: 0, deltaY: 0, deltaMode: PX }, 600, false)).toBeNull();
  expect(wheelToStrip({ deltaX: 0, deltaY: 120, deltaMode: PX }, 600, true)).toEqual({ left: 120, smooth: false });
});

test('quick notches add up while the strip is still gliding, within the scrollable range', () => {
  const notch = (left: number) => ({ left, smooth: true });
  // Idle: from where the strip is.
  expect(planWheel(notch(100), null, 200, 900)).toEqual({ goal: 300, to: 300, smooth: true });
  // Mid-glide (at 230, heading for 300): the next notch extends the goal, it does not restart from 230.
  expect(planWheel(notch(100), 300, 230, 900)).toEqual({ goal: 400, to: 400, smooth: true });
  expect(planWheel(notch(100), 850, 800, 900)).toEqual({ goal: 900, to: 900, smooth: true });
  expect(planWheel(notch(-100), null, 40, 900)).toEqual({ goal: 0, to: 0, smooth: true });
});

test('small deltas follow the finger when idle, and join a glide in flight instead of cutting it short', () => {
  const small = (left: number) => ({ left, smooth: false });
  expect(planWheel(small(-4), null, 200, 900)).toEqual({ goal: null, to: 196, smooth: false });
  // A fast flick: big deltas started a glide towards 300, then momentum sends small ones.
  expect(planWheel(small(4), 300, 230, 900)).toEqual({ goal: 304, to: 304, smooth: true });
});

test('a goal never goes stale: nothing to travel clears it, and a shrunk strip clamps it first', () => {
  // Already at the end: no glide starts, so no scrollend would ever clear the goal.
  expect(planWheel({ left: 100, smooth: true }, null, 900, 900)).toEqual({ goal: null, to: 900, smooth: false });
  // Tabs closed mid-glide: the end moved from 900 to 600; the way back starts from 600.
  expect(planWheel({ left: -100, smooth: true }, 900, 600, 600)).toEqual({ goal: 500, to: 500, smooth: true });
});

test('the strip fades on the side that has more tabs', () => {
  expect(stripFade(0, 500, 500)).toEqual({ start: false, end: false });
  expect(stripFade(0, 1200, 500)).toEqual({ start: false, end: true });
  expect(stripFade(300, 1200, 500)).toEqual({ start: true, end: true });
  expect(stripFade(700, 1200, 500)).toEqual({ start: true, end: false });
  // Fractional scroll positions (zoom, retina) still count as the end.
  expect(stripFade(699.5, 1200, 500)).toEqual({ start: true, end: false });
});

test('the active tab is scrolled into view clear of the fades, and left alone when already visible', () => {
  const view = { scrollLeft: 400, width: 500 };
  expect(revealLeft({ left: 500, width: 150 }, view, 32)).toBeNull();
  expect(revealLeft({ left: 380, width: 150 }, view, 32)).toBe(348);
  expect(revealLeft({ left: 820, width: 150 }, view, 32)).toBe(502);
  expect(revealLeft({ left: 10, width: 150 }, view, 32)).toBe(0);
  // Wider than the strip: its start wins.
  expect(revealLeft({ left: 1000, width: 700 }, view, 32)).toBe(968);
});

// A tab cut at the strip's edge, clicked: shown whole (its × in reach), but the point clicked stays on it, so the
// second click of a double click lands on the same tab (`at`: the pointer from the strip's left edge).
test('a clicked tab comes whole into view and stays under the pointer', () => {
  const view = { scrollLeft: 400, width: 500 };
  // In view: left alone.
  expect(revealClicked({ left: 500, width: 150 }, view, 32, 200)).toBeNull();
  // Cut at the right, clicked near its start: as any reveal, clear of the fade.
  expect(revealClicked({ left: 820, width: 150 }, view, 32, 440)).toBe(502);
  // Clicked by the edge: the full reveal would put the next tab under the pointer; held on this one, still whole.
  expect(revealClicked({ left: 820, width: 150 }, view, 32, 495)).toBe(474);
  // Cut at the left: likewise.
  expect(revealClicked({ left: 380, width: 150 }, view, 32, 100)).toBe(348);
  expect(revealClicked({ left: 380, width: 150 }, view, 32, 5)).toBe(376);
  // Wider than the strip: its start, the pointer still on it.
  expect(revealClicked({ left: 1000, width: 700 }, { scrollLeft: 1100, width: 500 }, 32, 250)).toBe(968);
  // From the keyboard (no pointer): a plain reveal.
  expect(revealClicked({ left: 820, width: 150 }, view, 32, null)).toBe(502);
});

// The strip narrows (a smaller window, a divider dragged): the tab in front, whole before, stays whole; one the user
// had wheeled out of view stays where they left it.
test('a narrower strip keeps the tab in front whole if it was', () => {
  // Whole in 400..900, cut once the strip is 400 wide (400..800): shown again clear of the fade.
  expect(keepInView({ left: 700, width: 150 }, 400, 500, 400, 32)).toBe(482);
  // Still whole and clear of the fade: left alone.
  expect(keepInView({ left: 450, width: 150 }, 400, 500, 400, 32)).toBeNull();
  // Already cut before (scrolled away): left alone.
  expect(keepInView({ left: 850, width: 150 }, 400, 500, 400, 32)).toBeNull();
  expect(keepInView({ left: 100, width: 150 }, 400, 500, 400, 32)).toBeNull();
  // Wider: nothing a tab in view could lose.
  expect(keepInView({ left: 700, width: 150 }, 400, 500, 600, 32)).toBeNull();
});

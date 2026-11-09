import { describe, expect, test } from 'vitest';
import { fitChips, placeInBox } from './filter-layout';

// The filter bar's layout math: how many chips two lines hold, where a popover sits.

describe('fitChips: the chips row wraps to two lines at most, then "+N more"', () => {
  const o = { gap: 6, more: (n: number) => (n > 9 ? 80 : 72), add: 70 };
  test('all of them when they fit, with "+ Filter" after them', () => {
    expect(fitChips([100, 100], 400, o)).toBe(2);
    expect(fitChips([100, 100, 100, 100, 100], 400, o)).toBe(5); // 3 + 2, "+ Filter" on the second line
  });
  test('past two lines: as many as leave room for "+N more" and "+ Filter" on the second', () => {
    // 3 on the first line; the second holds 2, "+2 more" and "+ Filter" (6 would leave no room for both).
    expect(fitChips([100, 100, 100, 100, 100, 100, 100], 400, o)).toBe(5);
    expect(fitChips([100, 100, 100, 100, 100, 100, 100, 100, 100], 400, { ...o, more: () => 200 })).toBe(4);
    expect(fitChips([390, 390, 390], 400, o)).toBe(1);
  });
  test('a chip wider than the row takes the row (it ellipsizes); nothing measured yet: all of them', () => {
    expect(fitChips([900], 400, o)).toBe(1);
    expect(fitChips([100, 100, 100], 0, o)).toBe(3);
  });
});

describe('placeInBox: the popover inside its tab, within the window (a 430 px pane, a 600 px window)', () => {
  test('under its anchor, slid left to stay in the pane, narrower than the pane', () => {
    const box = { left: 470, top: 80, right: 900, bottom: 600 };
    const p = placeInBox({ left: 860, top: 140, right: 890, bottom: 166 }, box, { width: 340 });
    expect(p.width).toBe(340);
    expect(p.left + p.width).toBe(430 - 8);
    expect(p.top).toBe(166 - 80 + 6);
    expect(p.top + p.maxHeight).toBe(520 - 8);
    const narrow = placeInBox({ left: 480, top: 140, right: 520, bottom: 166 }, { left: 470, top: 80, right: 770, bottom: 600 }, { width: 340 });
    expect(narrow.width).toBe(300 - 16);
    expect(narrow.left).toBe(8);
    // Under the anchor at its left when there is room; a squeezed tab gives it no negative height.
    expect(placeInBox({ left: 500, top: 140, right: 560, bottom: 166 }, box, { width: 340 }).left).toBe(30);
    expect(placeInBox({ left: 500, top: 590, right: 560, bottom: 616 }, box, { width: 340 }).maxHeight).toBe(0);
  });
});

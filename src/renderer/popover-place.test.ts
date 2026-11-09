import { describe, expect, test } from 'vitest';
import { placePopover } from './popover-place';

const view = { width: 1280, height: 800 };
describe('placePopover', () => {
  test('below the anchor, left-aligned, kept in the window', () => {
    expect(placePopover({ left: 470, top: 90, right: 700, bottom: 112 }, 'below', { width: 400, height: 300 }, view)).toEqual({ left: 470, top: 118, width: 400, maxHeight: 674 });
    expect(placePopover({ left: 1100, top: 90, right: 1200, bottom: 112 }, 'below', { width: 400, height: 300 }, view).left).toBe(872);
  });
  test('flips above when the room below is too small', () => {
    const p = placePopover({ left: 100, top: 700, right: 200, bottom: 722 }, 'below', { width: 400, height: 300 }, view);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(694);
    expect(p.maxHeight).toBeGreaterThan(0);
  });
  test('short windows shrink the popover instead of overflowing', () => {
    const p = placePopover({ left: 10, top: 30, right: 100, bottom: 52 }, 'below', { width: 400, height: 300 }, { width: 1280, height: 200 });
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(192);
    expect(p.maxHeight).toBeGreaterThan(0);
  });
  test('never negative sizes, never above the top margin, in any tiny window', () => {
    const tiny = placePopover({ left: 5, top: 5, right: 50, bottom: 98 }, 'below', { width: 400, height: 300 }, { width: 1280, height: 100 });
    expect(tiny.maxHeight).toBeGreaterThanOrEqual(0);
    expect(tiny.top).toBeGreaterThanOrEqual(8);
    const flipped = placePopover({ left: 5, top: 12, right: 50, bottom: 90 }, 'below', { width: 400, height: 300 }, { width: 1280, height: 100 });
    expect(flipped.maxHeight).toBeGreaterThanOrEqual(0);
    expect(flipped.top).toBeGreaterThanOrEqual(8);
    const right = placePopover({ left: 5, top: 95, right: 50, bottom: 99 }, 'right', { width: 400, height: 300 }, { width: 1280, height: 100 });
    expect(right.maxHeight).toBeGreaterThanOrEqual(0);
    const narrow = placePopover({ left: 0, top: 10, right: 10, bottom: 20 }, 'below', { width: 400, height: 300 }, { width: 10, height: 600 });
    expect(narrow.width).toBeGreaterThanOrEqual(0);
  });
  test('each edge stays inside the window', () => {
    const box = (left: number, top: number) => ({ left, top, right: left + 40, bottom: top + 20 });
    for (const [l, t] of [[0, 0], [1240, 0], [0, 780], [1240, 780]] as const) {
      for (const side of ['below', 'right'] as const) {
        const p = placePopover(box(l, t), side, { width: 400, height: 300 }, view);
        expect(p.left).toBeGreaterThanOrEqual(8);
        expect(p.left + p.width).toBeLessThanOrEqual(1272);
        expect(p.top).toBeGreaterThanOrEqual(8);
        expect(p.top + p.maxHeight).toBeLessThanOrEqual(792);
      }
    }
  });
  test('to the right of a sidebar row; narrow windows shrink the width', () => {
    expect(placePopover({ left: 60, top: 200, right: 300, bottom: 250 }, 'right', { width: 400, height: 300 }, view)).toMatchObject({ left: 306, top: 200 });
    expect(placePopover({ left: 0, top: 10, right: 10, bottom: 20 }, 'below', { width: 400, height: 300 }, { width: 300, height: 600 }).width).toBe(284);
  });
});

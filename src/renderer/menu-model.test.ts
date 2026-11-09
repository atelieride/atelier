import { describe, expect, test } from 'vitest';
import { itemRole, menuFocus, nextIndex, placeDropDown, placeMenu, placeTip, type MenuItem } from './menu-model';

test('a menu bar’s drop-down never climbs over the bar: too tall, it stops at the window’s bottom and scrolls', () => {
  // View (≈900 px) under a 32 px bar in an 880 px window.
  expect(placeDropDown({ left: 160, right: 200, bottom: 34 }, 280, 900, 1400, 880)).toEqual({ left: 160, top: 40, maxHeight: 832 });
  // Room enough: no limit needed beyond the window's.
  expect(placeDropDown({ left: 80, right: 110, bottom: 34 }, 260, 300, 1400, 880)).toEqual({ left: 80, top: 40, maxHeight: 832 });
  // Near the right edge it opens leftwards, as anchored menus do.
  expect(placeDropDown({ left: 1300, right: 1340, bottom: 34 }, 280, 300, 1400, 880).left).toBe(1060);
});

test('focus goes back to what had it before the first menu: a menu replacing another (a menu bar switching) keeps it', () => {
  const f = menuFocus<string>();
  expect(f.closed()).toBe(null);
  f.shown('terminal');
  // The next drop-down: the focus is in the menu now, never bounced through the terminal.
  f.shown('menu');
  f.shown('menu');
  expect(f.closed()).toBe('terminal');
  expect(f.closed()).toBe(null);
  f.shown('editor');
  expect(f.closed()).toBe('editor');
});

test('the menu stays inside the window', () => {
  expect(placeMenu(100, 100, 200, 150, 1000, 800)).toEqual({ left: 100, top: 100 });
  // near the right edge: opens to the left of the cursor
  expect(placeMenu(950, 100, 200, 150, 1000, 800)).toEqual({ left: 750, top: 100 });
  // near the bottom: opens above
  expect(placeMenu(100, 750, 200, 150, 1000, 800)).toEqual({ left: 100, top: 600 });
  // bottom-right corner
  expect(placeMenu(990, 790, 200, 150, 1000, 800)).toEqual({ left: 790, top: 640 });
  // larger than the window: stuck to the margin
  expect(placeMenu(10, 10, 2000, 2000, 1000, 800)).toEqual({ left: 8, top: 8 });
});

const run = () => {};
const items: MenuItem[] = [
  { id: 'a', label: 'A', run }, 'sep', { id: 'b', label: 'B', run, disabled: true }, { id: 'c', label: 'C', run }
];

test('the keyboard skips separators and disabled items, and wraps around', () => {
  expect(nextIndex(items, -1, 1)).toBe(0);
  expect(nextIndex(items, 0, 1)).toBe(3);
  expect(nextIndex(items, 3, 1)).toBe(0);
  expect(nextIndex(items, 0, -1)).toBe(3);
  expect(nextIndex(['sep', { id: 'x', label: 'X', run, disabled: true }], -1, 1)).toBe(-1);
});

test('menu anchored to a button near the right edge: aligns to the right edge of the button', async () => {
  const { placeAnchored } = await import('./menu-model');
  // button from 1300 to 1420 in a 1440-wide window, 240-wide menu
  expect(placeAnchored({ left: 1300, right: 1420, bottom: 40 }, 240, 150, 1440, 900)).toEqual({ left: 1180, top: 46 });
  // button on the left: aligned to its left edge
  expect(placeAnchored({ left: 320, right: 350, bottom: 80 }, 240, 150, 1440, 900)).toEqual({ left: 320, top: 86 });
});

test('Home and End: first and last selectable item', async () => {
  const { edgeIndex } = await import('./menu-model');
  expect(edgeIndex(items, 'first')).toBe(0);
  expect(edgeIndex(items, 'last')).toBe(3);
  expect(edgeIndex(['sep'], 'first')).toBe(-1);
});

test('placeSubmenu: to the right of its item, aligned to its top; to the left when there is no room; inside the window', async () => {
  const { placeSubmenu } = await import('./menu-model');
  const item = { left: 100, right: 320, top: 200 };
  expect(placeSubmenu(item, 200, 150, 1000, 800)).toEqual({ left: 322, top: 195 });
  expect(placeSubmenu(item, 200, 150, 500, 800)).toEqual({ left: 8, top: 195 });
  expect(placeSubmenu({ left: 500, right: 720, top: 200 }, 200, 150, 800, 800)).toEqual({ left: 298, top: 195 });
  expect(placeSubmenu({ left: 100, right: 320, top: 700 }, 200, 150, 1000, 800)).toEqual({ left: 322, top: 642 });
});

describe('placeTip: a tooltip stays centered under its element and slides inside the window, never flipped like a menu', () => {
  // A 1000×700 window, a 300×40 tooltip, margin 6; the element spans x 900..980, y 100..124.
  const el = { left: 900, right: 980, top: 100, bottom: 124 };
  test('near the right edge: it slides left just enough, still under the element', () => {
    const p = placeTip(el, 300, 40, 1000, 700, 6);
    expect(p).toEqual({ left: 1000 - 6 - 300, top: 124 + 8 });
    expect(p.left + 300).toBeGreaterThanOrEqual(el.left);
  });
  test('room on both sides: centered on the element', () => {
    expect(placeTip({ left: 400, right: 500, top: 100, bottom: 124 }, 300, 40, 1000, 700, 6)).toEqual({ left: 300, top: 132 });
  });
  test('no room below: above the element', () => {
    expect(placeTip({ left: 400, right: 500, top: 660, bottom: 684 }, 300, 40, 1000, 700, 6).top).toBe(660 - 8 - 40);
  });
  test('near the left edge: it slides right', () => {
    expect(placeTip({ left: 0, right: 40, top: 100, bottom: 124 }, 300, 40, 1000, 700, 6).left).toBe(6);
  });
});

// Checkable items (View › Word Wrap and Go's workspaces in the Windows menu): announced as what they are, with their state.
test('itemRole: a plain item, a checkbox or a radio, with aria-checked only on the checkable ones', () => {
  const it = (extra: Partial<Exclude<MenuItem, 'sep'>>): Exclude<MenuItem, 'sep'> => ({ id: 'x', label: 'X', run() {}, ...extra });
  expect(itemRole(it({}))).toEqual({ role: 'menuitem' });
  expect(itemRole(it({ checked: false }))).toEqual({ role: 'menuitemcheckbox', 'aria-checked': false });
  expect(itemRole(it({ checked: true, radio: true }))).toEqual({ role: 'menuitemradio', 'aria-checked': true });
});

import { describe, expect, it } from 'vitest';
import { sidePlace } from './ConfirmPopover';

const viewport = { width: 1200, height: 800 };
const row = { left: 16, right: 280, top: 300, bottom: 346 };
const box = { width: 264, height: 140, pivot: 110 };

describe('sidePlace', () => {
  it('puts the bubble right of the row, its danger button level with the row', () => {
    const p = sidePlace(row, box, viewport)!;
    expect(p.left).toBe(290);
    expect(p.side).toBe('right');
    // The row's middle (323) meets the button's (110 inside the box).
    expect(p.top).toBe(213);
    expect(p.arrow).toBe(110);
  });

  it('stays inside the window near its top and bottom; the arrow still points at the row', () => {
    const top = sidePlace({ left: 16, right: 280, top: 40, bottom: 86 }, box, viewport)!;
    expect(top.top).toBe(12);
    expect(top.arrow).toBe(51);
    const bottom = sidePlace({ left: 16, right: 280, top: 760, bottom: 794 }, { ...box, pivot: 30 }, viewport)!;
    expect(bottom.top).toBe(648);
    expect(bottom.arrow).toBe(124);
  });

  it('goes left of the row when the right has no room (the sidebar at the window’s right edge), never over it', () => {
    const swapped = { left: 920, right: 1184, top: 300, bottom: 346 };
    const p = sidePlace(swapped, box, viewport)!;
    expect(p.side).toBe('left');
    expect(p.left).toBe(920 - 10 - 264);
    expect(p.left + box.width).toBeLessThan(swapped.left);
    expect(p.top).toBe(213);
    expect(p.arrow).toBe(110);
  });

  it('with no room on either side: the side with more room, kept inside the window', () => {
    const narrow = { width: 500, height: 800 };
    expect(sidePlace(row, box, narrow)).toMatchObject({ left: 224, side: 'right' });
    expect(sidePlace({ left: 220, right: 484, top: 300, bottom: 346 }, box, narrow)).toMatchObject({ left: 12, side: 'left' });
  });

  it('has no place without a row on screen', () => {
    expect(sidePlace(null, box, viewport)).toBeNull();
  });

  it('has no place for a row scrolled out of its list’s visible part (under the head, past the end)', () => {
    const list = { top: 120, bottom: 600 };
    expect(sidePlace({ left: 16, right: 280, top: 70, bottom: 104 }, box, viewport, list)).toBeNull();
    expect(sidePlace({ left: 16, right: 280, top: 610, bottom: 644 }, box, viewport, list)).toBeNull();
    // Its middle still in sight: the bubble points at it.
    expect(sidePlace({ left: 16, right: 280, top: 100, bottom: 146 }, box, viewport, list)).toMatchObject({ left: 290, side: 'right' });
    // Outside the window, with no list given.
    expect(sidePlace({ left: 16, right: 280, top: 820, bottom: 866 }, box, viewport)).toBeNull();
  });
});

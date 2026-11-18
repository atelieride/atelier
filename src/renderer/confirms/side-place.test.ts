import { describe, expect, it } from 'vitest';
import { sidePlace } from './ConfirmPopover';

const viewport = { width: 1200, height: 800 };
const row = { right: 280, top: 300, bottom: 346 };

describe('sidePlace', () => {
  it('puts the bubble right of the row, its danger button level with the row', () => {
    const p = sidePlace(row, { width: 264, height: 140, pivot: 110 }, viewport)!;
    expect(p.left).toBe(290);
    // The row's middle (323) meets the button's (110 inside the box).
    expect(p.top).toBe(213);
    expect(p.arrow).toBe(110);
  });

  it('stays inside the window near its top and bottom; the arrow still points at the row', () => {
    const top = sidePlace({ right: 280, top: 40, bottom: 86 }, { width: 264, height: 140, pivot: 110 }, viewport)!;
    expect(top.top).toBe(12);
    expect(top.arrow).toBe(51);
    const bottom = sidePlace({ right: 280, top: 760, bottom: 794 }, { width: 264, height: 140, pivot: 30 }, viewport)!;
    expect(bottom.top).toBe(648);
    expect(bottom.arrow).toBe(124);
  });

  it('stays inside a narrow window', () => {
    expect(sidePlace(row, { width: 264, height: 140, pivot: 110 }, { width: 500, height: 800 })!.left).toBe(224);
  });

  it('has no place without a row on screen', () => {
    expect(sidePlace(null, { width: 264, height: 140, pivot: 110 }, viewport)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { previewDocks } from './settings-dock';

describe('previewDocks', () => {
  it('docks a preview that leaves most of the pane to the controls', () => {
    expect(previewDocks(110, 470)).toBe(true);
  });

  it('docks up to exactly half of the pane', () => {
    expect(previewDocks(235, 470)).toBe(true);
    expect(previewDocks(235.5, 470)).toBe(false);
  });

  it('lets a preview taller than half the pane scroll away', () => {
    expect(previewDocks(272, 470)).toBe(false);
  });

  it('does not dock before the pane is laid out', () => {
    expect(previewDocks(0, 0)).toBe(false);
    expect(previewDocks(110, 0)).toBe(false);
  });
});

import { expect, test } from 'vitest';
import { grabStyle } from './PaneDivider';

// A divider's grab area: 9 px across its 1 px gap, never over the tab strip of the pane under a horizontal one (a
// press on a tab's top edge must pick the tab, not start a resize).

test('a vertical divider\'s grab area is centered on its gap, along the whole gap', () => {
  expect(grabStyle({ path: [], index: 0, dir: 'row', rect: { x: 500, y: 0, w: 1, h: 600 } })).toEqual({ left: 496, top: 0, width: 9, height: 600 });
});

test('a horizontal divider\'s grab area ends at its gap: none of it over the lower pane\'s strip', () => {
  const s = grabStyle({ path: [1], index: 0, dir: 'column', rect: { x: 501, y: 300, w: 500, h: 1 } });
  expect(s).toEqual({ left: 501, top: 292, width: 500, height: 9 });
  expect((s.top as number) + (s.height as number)).toBeLessThanOrEqual(301);
});

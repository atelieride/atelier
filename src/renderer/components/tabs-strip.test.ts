import { expect, test } from 'vitest';
import { PaneStrip } from './Tabs';

// Dragging a divider changes the panes' widths many times a second: the strips, memoized
// with a stable "+" handler, don't re-render for it.
test('a pane\'s strip is memoized', () => {
  expect((PaneStrip as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
});

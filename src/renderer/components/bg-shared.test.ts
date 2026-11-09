import { describe, expect, test } from 'vitest';
import { focusableFor, scrollClosesPopover, skipFocusReturn, takeSkipFocusReturn } from './bg-shared';

const el = (o: { focusable?: boolean; parent?: unknown; contains?: (n: unknown) => boolean } = {}) => ({
  matches: () => !!o.focusable,
  closest: () => o.parent ?? null,
  contains: o.contains ?? (() => false)
}) as never;

describe('scrollClosesPopover', () => {
  const opener = el();
  test('the document, or a scroller that contains the opener, closes it', () => {
    expect(scrollClosesPopover(globalThis.document ?? { nodeType: 9 }, opener, true)).toBe(true);
    expect(scrollClosesPopover(el({ contains: (n) => n === opener }), opener, false)).toBe(true);
  });
  test('a scroller elsewhere (a log tail, the tab strip) does not', () => {
    expect(scrollClosesPopover(el(), opener, false)).toBe(false);
    expect(scrollClosesPopover(null, opener, false)).toBe(false);
  });
});

describe('focusableFor', () => {
  test('a focusable opener is its own target; otherwise the closest focusable ancestor; none: null', () => {
    const own = el({ focusable: true });
    expect(focusableFor(own)).toBe(own);
    const parent = el({ focusable: true });
    expect(focusableFor(el({ parent }))).toBe(parent);
    expect(focusableFor(el())).toBeNull();
    expect(focusableFor(null)).toBeNull();
  });
});

describe('skipFocusReturn', () => {
  test('is taken once', () => {
    expect(takeSkipFocusReturn()).toBe(false);
    skipFocusReturn();
    expect(takeSkipFocusReturn()).toBe(true);
    expect(takeSkipFocusReturn()).toBe(false);
  });
});

import { describe, expect, test } from 'vitest';
import {
  canMoveStep, canMoveToNewPane, focusPane, focusStep, flatten, fronts, isSplit, lift, moveStep, moveTab, moveToNewPane, openToSide, paneCell, paneOf, pickableKeys, placeOpened, reconcile,
  removeKeys, renameKeys, single, splitRight, stripKeys, unsplit, unsplitAll, unsplitTarget, visibleKeys, type Pane, type Split
} from './split';
import type { TabKey } from './tabs-model';

// Split view with tab groups: each pane owns its tabs and its tab in front.

const P = (tabs: TabKey[], front: TabKey | null = tabs[0] ?? null): Pane => ({ tabs, front });
const S = (panes: Pane[], focus = 0, fractions = panes.map(() => 1 / panes.length)): Split => ({ panes, focus, fractions });
const near = (xs: number[], ys: number[]) => { expect(xs.length).toBe(ys.length); xs.forEach((x, i) => expect(x).toBeCloseTo(ys[i]!, 6)); };

describe('one pane', () => {
  test('single(): one placeholder pane, focused, full width; not split', () => {
    expect(single()).toEqual({ panes: [{ tabs: [], front: null }], focus: 0, fractions: [1] });
    expect(isSplit(single())).toBe(false);
    expect(isSplit(S([P(['t:a']), P([])]))).toBe(true);
  });
  test('lift materializes one pane from the strip order and the active key; a split is returned as is', () => {
    expect(lift(single(), ['t:a', 't:b'], 't:b')).toEqual(S([P(['t:a', 't:b'], 't:b')]));
    expect(lift(single(), [], null)).toEqual(S([P([], null)]));
    const s = S([P(['t:a']), P(['t:b'])]);
    expect(lift(s, ['t:x'], 't:x')).toBe(s);
  });
  test('lift never leaves tabs without a front (an active key not listed yet): the last tab', () => {
    expect(lift(single(), ['t:a', 't:b'], 't:z')).toEqual(S([P(['t:a', 't:b'], 't:b')]));
  });
  test('reconcile leaves one pane alone (same object): the store keeps today\'s code path', () => {
    const s = single();
    expect(reconcile(s, ['t:a', 't:b'], 't:b', [])).toBe(s);
  });
});

describe('queries', () => {
  const s = S([P(['t:a', 'f:x'], 't:a'), P(['t:b'], 't:b')]);
  test('flatten, fronts, visibleKeys, paneOf', () => {
    expect(flatten(s)).toEqual(['t:a', 'f:x', 't:b']);
    expect(fronts(s)).toEqual(['t:a', 't:b']);
    expect(visibleKeys(S([P(['t:a']), P([], null)]))).toEqual(['t:a']);
    expect(paneOf(s, 'f:x')).toBe(0);
    expect(paneOf(s, 't:b')).toBe(1);
    expect(paneOf(s, 't:z')).toBe(-1);
  });
  test('one pane: no fronts, no pane index (the strip order and the active key say it all)', () => {
    expect(fronts(single())).toEqual([]);
    expect(paneOf(single(), 't:a')).toBe(-1);
  });
  test('stripKeys: one pane shows the whole order; a split pane its own tabs', () => {
    expect(stripKeys(single(), ['t:a', 't:b'], 0)).toEqual(['t:a', 't:b']);
    expect(stripKeys(s, ['t:a', 'f:x', 't:b'], 1)).toEqual(['t:b']);
    expect(stripKeys(s, [], 5)).toEqual([]);
  });
});

describe('closing tabs (removeKeys): a pane goes back to its own previous tab', () => {
  test('the front closes: the pane shows its most recently used tab', () => {
    const s = S([P(['t:a', 'f:x', 't:c'], 'f:x'), P(['t:b'])]);
    expect(removeKeys(s, (k) => k === 'f:x', ['t:c', 't:a', 'f:x'])).toEqual(S([P(['t:a', 't:c'], 't:a'), P(['t:b'])]));
  });
  test('no history: the nearest tab on the right, then on the left', () => {
    const s = S([P(['t:a', 'f:x', 't:c'], 'f:x'), P(['t:b'])]);
    expect(removeKeys(s, (k) => k === 'f:x', []).panes[0]!.front).toBe('t:c');
    const t = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])]);
    expect(removeKeys(t, (k) => k === 'f:x', []).panes[0]!.front).toBe('t:a');
  });
  test('the history of other panes is ignored: only the pane\'s own tabs can come to its front', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])]);
    expect(removeKeys(s, (k) => k === 'f:x', ['t:a', 't:b']).panes[0]!.front).toBe('t:a');
  });
  test('an unfocused pane\'s front exits: that pane shows its previous tab; focus and the other panes stay', () => {
    const s = S([P(['t:a'], 't:a'), P(['t:b', 'f:y'], 't:b')], 0);
    const next = removeKeys(s, (k) => k === 't:b', ['f:y', 't:b']);
    expect(next).toEqual(S([P(['t:a'], 't:a'), P(['f:y'], 'f:y')], 0));
  });
  test('a non-front tab closes: the front stays', () => {
    const s = S([P(['t:a', 'f:x'], 't:a'), P(['t:b'])]);
    expect(removeKeys(s, (k) => k === 'f:x', [])).toEqual(S([P(['t:a'], 't:a'), P(['t:b'])]));
  });
  test('a pane that loses its last tab closes; the focused one hands the focus left first, then right', () => {
    const three = S([P(['t:a']), P(['t:b']), P(['t:c'])], 1, [0.5, 0.25, 0.25]);
    const mid = removeKeys(three, (k) => k === 't:b', []);
    expect(mid.panes).toEqual([P(['t:a']), P(['t:c'])]);
    expect(mid.focus).toBe(0);
    near(mid.fractions, [2 / 3, 1 / 3]);
    const first = removeKeys({ ...three, focus: 0 }, (k) => k === 't:a', []);
    expect(first.panes).toEqual([P(['t:b']), P(['t:c'])]);
    expect(first.focus).toBe(0);
  });
  test('an unfocused pane that closes keeps the focus on the same pane', () => {
    const s = S([P(['t:a']), P(['t:b']), P(['t:c'])], 2);
    const next = removeKeys(s, (k) => k === 't:a', []);
    expect(next.focus).toBe(1);
    expect(next.panes[next.focus]).toEqual(P(['t:c']));
  });
  test('down to one pane: a materialized pane with the survivor\'s tabs and front', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 1);
    expect(removeKeys(s, (k) => k === 't:b', [])).toEqual(S([P(['t:a', 'f:x'], 'f:x')]));
  });
  test('every tab gone: one empty pane (the last pane never closes)', () => {
    const s = S([P(['t:a']), P(['t:b'])]);
    expect(removeKeys(s, () => true, [])).toEqual(S([P([], null)]));
  });
  test('an empty pane that had no tab (Split Right) stays', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P([], null)], 1);
    expect(removeKeys(s, (k) => k === 'f:x', [])).toEqual(S([P(['t:a'], 't:a'), P([], null)], 1));
  });
  test('nothing removed: the same object', () => {
    const s = S([P(['t:a']), P(['t:b'])]);
    expect(removeKeys(s, () => false, [])).toBe(s);
  });
});

describe('reconcile: the store\'s order and active key against the panes', () => {
  test('a key closed elsewhere (not in the order any more) leaves its pane as removeKeys says', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    expect(reconcile(s, ['t:a', 't:b'], 't:a', ['t:a', 'f:x'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b'])], 0));
  });
  test('a new key goes to the focused pane, where the order put it (after the front), and comes to the front when active', () => {
    const s = S([P(['t:a', 't:c'], 't:a'), P(['t:b'])], 0);
    expect(reconcile(s, ['t:a', 'f:x', 't:c', 't:b'], 'f:x', [])).toEqual(S([P(['t:a', 'f:x', 't:c'], 'f:x'), P(['t:b'])], 0));
  });
  test('a new key that is not active (a terminal arriving unselected) joins the focused pane behind its front', () => {
    const s = S([P(['t:a'], 't:a'), P(['t:b'])], 1);
    expect(reconcile(s, ['t:a', 't:b', 't:n'], 't:b', [])).toEqual(S([P(['t:a'], 't:a'), P(['t:b', 't:n'], 't:b')], 1));
  });
  test('a new key not active while the focused pane is empty: it waits in the nearest pane with tabs (left first)', () => {
    const s = S([P(['t:a'], 't:a'), P([], null)], 1);
    expect(reconcile(s, ['t:a', 't:n'], null, [])).toEqual(S([P(['t:a', 't:n'], 't:a'), P([], null)], 1));
  });
  test('the active key is new while the focused pane is empty: it fills it', () => {
    const s = S([P(['t:a'], 't:a'), P([], null)], 1);
    expect(reconcile(s, ['t:a', 't:n'], 't:n', [])).toEqual(S([P(['t:a'], 't:a'), P(['t:n'], 't:n')], 1));
  });
  test('the active key sits in another pane: the focus goes there and it comes to that pane\'s front; nothing moves', () => {
    const s = S([P(['t:a'], 't:a'), P(['t:b', 'f:y'], 't:b')], 0);
    expect(reconcile(s, ['t:a', 't:b', 'f:y'], 'f:y', [])).toEqual(S([P(['t:a'], 't:a'), P(['t:b', 'f:y'], 'f:y')], 1));
  });
  test('the focused pane\'s own tab becomes active: it comes to the front', () => {
    const s = S([P(['t:a', 'f:x'], 't:a'), P(['t:b'])], 0);
    expect(reconcile(s, ['t:a', 'f:x', 't:b'], 'f:x', [])).toEqual(S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0));
  });
  test('an empty focused pane and the active key is another pane\'s non-front tab: it moves into the empty pane', () => {
    const s = S([P(['t:a', 't:c'], 't:a'), P([], null)], 1);
    expect(reconcile(s, ['t:a', 't:c'], 't:c', [])).toEqual(S([P(['t:a'], 't:a'), P(['t:c'], 't:c')], 1));
  });
  test('an empty focused pane and the active key is another pane\'s front: the focus goes there, the empty pane stays', () => {
    const s = S([P(['t:a', 't:c'], 't:a'), P([], null)], 1);
    expect(reconcile(s, ['t:a', 't:c'], 't:a', [])).toEqual(S([P(['t:a', 't:c'], 't:a'), P([], null)], 0));
  });
  test('the order decides the order inside each pane (a reorder in the strip)', () => {
    const s = S([P(['t:a', 'f:x'], 't:a'), P(['t:b'])], 0);
    expect(reconcile(s, ['f:x', 't:a', 't:b'], 't:a', [])).toEqual(S([P(['f:x', 't:a'], 't:a'), P(['t:b'])], 0));
  });
  test('nothing to do: the same object', () => {
    const s = S([P(['t:a', 'f:x'], 't:a'), P(['t:b'])], 0);
    expect(reconcile(s, ['t:a', 'f:x', 't:b'], 't:a', [])).toBe(s);
  });
  test('a pane with tabs always has one in front — its most recent, else its last', () => {
    const s = S([P(['t:a', 'f:x'], null), P(['t:b'])], 1);
    expect(reconcile(s, ['t:a', 'f:x', 't:b'], 't:b', ['f:x', 't:a', 't:b']).panes[0]).toEqual(P(['t:a', 'f:x'], 't:a'));
    expect(reconcile(s, ['t:a', 'f:x', 't:b'], 't:b', []).panes[0]).toEqual(P(['t:a', 'f:x'], 'f:x'));
  });
  test('no pane has tabs and a terminal arrives unselected: it is shown in the focused pane', () => {
    const s = S([P([], null), P([], null)], 1);
    expect(reconcile(s, ['t:n'], null, [])).toEqual(S([P([], null), P(['t:n'], 't:n')], 1));
  });
});

describe('split right', () => {
  test('one pane: its tabs stay left, an empty pane on the right takes the focus; fractions equal', () => {
    expect(splitRight(single(), ['t:a', 't:b'], 't:b')).toEqual(S([P(['t:a', 't:b'], 't:b'), P([], null)], 1));
  });
  test('inserted right of the focused pane, not at the end', () => {
    const s = S([P(['t:a']), P(['t:b'])], 0);
    expect(splitRight(s, [], 't:a')).toEqual(S([P(['t:a']), P([], null), P(['t:b'])], 1));
  });
  test('at three panes: refused (null)', () => {
    expect(splitRight(S([P(['t:a']), P(['t:b']), P(['t:c'])]), [], 't:a')).toBeNull();
  });
});

describe('moving tabs between panes', () => {
  test('into another pane before a tab: there, in front, that pane focused; the source shows its previous tab', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b', 't:c'], 't:b')], 0);
    expect(moveTab(s, 'f:x', 1, 't:c', ['t:a', 'f:x'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b', 'f:x', 't:c'], 'f:x')], 1));
  });
  test('to the end of another pane (before null)', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    expect(moveTab(s, 't:a', 1, null, []).panes[1]).toEqual(P(['t:b', 't:a'], 't:a'));
  });
  test('a pane\'s only tab: that pane closes; the target index follows', () => {
    const s = S([P(['t:a']), P(['t:b']), P(['t:c'])], 0);
    const next = moveTab(s, 't:a', 2, null, []);
    expect(next.panes).toEqual([P(['t:b']), P(['t:c', 't:a'], 't:a')]);
    expect(next.focus).toBe(1);
  });
  test('the last two panes merge into one: a materialized pane', () => {
    const s = S([P(['t:a']), P(['t:b'])], 1);
    expect(moveTab(s, 't:b', 0, 't:a', [])).toEqual(S([P(['t:b', 't:a'], 't:b')]));
  });
  test('within its own pane: only a reorder (as one pane\'s strip) — its front stays; the focus there', () => {
    const s = S([P(['t:a', 'f:x', 't:c'], 't:a'), P(['t:b'])], 1);
    expect(moveTab(s, 't:c', 0, 't:a', [])).toEqual(S([P(['t:c', 't:a', 'f:x'], 't:a'), P(['t:b'])], 0));
  });
  test('into an empty pane: it fills it', () => {
    const s = S([P(['t:a', 'f:x'], 't:a'), P([], null)], 0);
    expect(moveTab(s, 'f:x', 1, null, [])).toEqual(S([P(['t:a'], 't:a'), P(['f:x'], 'f:x')], 1));
  });
  test('a key in no pane: unchanged', () => {
    const s = S([P(['t:a']), P(['t:b'])]);
    expect(moveTab(s, 't:z', 1, null, [])).toBe(s);
  });
});

describe('a new pane for a tab', () => {
  test('on the right of a pane: holding only that tab, focused, fractions equal', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    expect(moveToNewPane(s, [], null, 'f:x', 0, 'right', ['t:a'])).toEqual(S([P(['t:a'], 't:a'), P(['f:x'], 'f:x'), P(['t:b'])], 1));
  });
  test('on the left of another pane', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    expect(moveToNewPane(s, [], null, 't:a', 1, 'left', [])).toEqual(S([P(['f:x'], 'f:x'), P(['t:a'], 't:a'), P(['t:b'])], 1));
  });
  test('one pane: lifted first', () => {
    expect(moveToNewPane(single(), ['t:a', 't:b'], 't:b', 't:b', 0, 'right', ['t:a', 't:b'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b'], 't:b')], 1));
  });
  test('another pane\'s only tab: its old pane closes (the pane moves)', () => {
    const s = S([P(['t:a', 'f:x'], 't:a'), P(['t:b'])], 1);
    expect(moveToNewPane(s, [], null, 't:b', 0, 'left', [])).toEqual(S([P(['t:b'], 't:b'), P(['t:a', 'f:x'], 't:a')], 0));
  });
  test('refused (null) at three panes and for a tab alone in its own target pane', () => {
    expect(moveToNewPane(S([P(['t:a', 'f:x']), P(['t:b']), P(['t:c'])]), [], null, 'f:x', 0, 'right', [])).toBeNull();
    expect(moveToNewPane(S([P(['t:a']), P(['t:b'])]), [], null, 't:a', 0, 'right', [])).toBeNull();
    expect(moveToNewPane(single(), ['t:a'], 't:a', 't:a', 0, 'right', [])).toBeNull();
  });
  test('canMoveToNewPane: room for a pane and not alone in its pane (one pane: the order)', () => {
    expect(canMoveToNewPane(single(), ['t:a', 't:b'], 't:a')).toBe(true);
    expect(canMoveToNewPane(single(), ['t:a'], 't:a')).toBe(false);
    expect(canMoveToNewPane(S([P(['t:a', 'f:x']), P(['t:b'])]), [], 'f:x')).toBe(true);
    expect(canMoveToNewPane(S([P(['t:a', 'f:x']), P(['t:b'])]), [], 't:b')).toBe(false);
    expect(canMoveToNewPane(S([P(['t:a', 'f:x']), P(['t:b']), P(['t:c'])]), [], 'f:x')).toBe(false);
  });
});

describe('⌃⌘← / ⌃⌘→ (moveStep): the focused pane\'s tab in front', () => {
  test('to the end of the neighbour, in front there, focused', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    expect(moveStep(s, [], 'f:x', 1, ['t:a'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b', 'f:x'], 'f:x')], 1));
  });
  test('from the edge pane with room and company: a new pane on that side (one pane splits the tab out)', () => {
    expect(moveStep(single(), ['t:a', 't:b'], 't:b', 1, ['t:a'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b'], 't:b')], 1));
    expect(moveStep(single(), ['t:a', 't:b'], 't:a', -1, ['t:b'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b'], 't:b')], 0));
  });
  test('back again: the last tab of a pane joins its neighbour and the pane closes', () => {
    const s = S([P(['t:a'], 't:a'), P(['t:b'], 't:b')], 1);
    expect(moveStep(s, [], 't:b', -1, [])).toEqual(S([P(['t:a', 't:b'], 't:b')]));
  });
  test('nothing to do (null): alone at the edge, three panes at the edge, an empty focused pane', () => {
    expect(moveStep(single(), ['t:a'], 't:a', 1, [])).toBeNull();
    expect(moveStep(S([P(['t:a']), P(['t:b']), P(['t:c', 'f:x'], 'f:x')], 2), [], 'f:x', 1, [])).toBeNull();
    expect(moveStep(S([P(['t:a']), P([], null)], 1), [], null, -1, [])).toBeNull();
  });
});

describe('canMoveStep: the palette offers ⌃⌘←/→ only when they act', () => {
  test('a neighbour, or room and company at the edge; never from an empty focused pane', () => {
    expect(canMoveStep(single(), ['t:a', 't:b'], 't:b', 1)).toBe(true);
    expect(canMoveStep(single(), ['t:a'], 't:a', 1)).toBe(false);
    expect(canMoveStep(S([P(['t:a']), P(['t:b'])], 0), [], 't:a', 1)).toBe(true);
    expect(canMoveStep(S([P(['t:a']), P([], null)], 1), [], null, -1)).toBe(false);
    expect(canMoveStep(S([P(['t:a']), P([], null)], 1), [], null, 1)).toBe(false);
  });
});

describe('placeOpened: a tab opened from a click, with a window\'s preview slot (files\' and tables\')', () => {
  test('one pane: openTab\'s placement — after the active tab, the preview replaced in place; the panes untouched', () => {
    const one = single();
    expect(placeOpened(one, ['t:a', 'f:/p/x.ts', 't:b'], 't:a', 'f:/p/y.ts', null, true))
      .toEqual({ order: ['t:a', 'f:/p/y.ts', 'f:/p/x.ts', 't:b'], preview: 'f:/p/y.ts', replaced: null, split: one });
    const r = placeOpened(one, ['t:a', 'f:/p/x.ts', 't:b'], 't:a', 'f:/p/y.ts', 'f:/p/x.ts', true);
    expect(r).toEqual({ order: ['t:a', 'f:/p/y.ts', 't:b'], preview: 'f:/p/y.ts', replaced: 'f:/p/x.ts', split: one });
    expect(r.split).toBe(one);
  });
  test('split: the focused pane\'s preview is replaced in place, its pane renamed in the same result', () => {
    const s = S([P(['t:a']), P(['t:b', 'db:c0123456789ab/public/x'], 'db:c0123456789ab/public/x')], 1);
    const r = placeOpened(s, flatten(s), 'db:c0123456789ab/public/x', 'db:c0123456789ab/public/y', 'db:c0123456789ab/public/x', true);
    expect(r.order).toEqual(['t:a', 't:b', 'db:c0123456789ab/public/y']);
    expect(r.replaced).toBe('db:c0123456789ab/public/x');
    expect(r.split).toEqual(S([P(['t:a']), P(['t:b', 'db:c0123456789ab/public/y'], 'db:c0123456789ab/public/y')], 1));
  });
  test('split: a preview in a pane that isn\'t focused is never replaced — the new tab opens after the active one, as the preview', () => {
    const s = S([P(['f:/p/x.ts']), P(['t:a'])], 1);
    const r = placeOpened(s, flatten(s), 't:a', 'f:/p/y.ts', 'f:/p/x.ts', true);
    expect(r).toEqual({ order: ['f:/p/x.ts', 't:a', 'f:/p/y.ts'], preview: 'f:/p/y.ts', replaced: null, split: s });
    // Opened as a kept tab: the other pane's preview is no preview any more (openTab's rule for a slot it can't touch).
    expect(placeOpened(s, flatten(s), 't:a', 'f:/p/y.ts', 'f:/p/x.ts', false).preview).toBeNull();
  });
});

describe('open to the side', () => {
  test('in an unfocused pane: the focus goes there and it comes to the front; nothing moves', () => {
    const s = S([P(['t:a']), P(['t:b', 'f:y'], 't:b')], 0);
    expect(openToSide(s, [], 't:a', 'f:y', [])).toEqual(S([P(['t:a']), P(['t:b', 'f:y'], 'f:y')], 1));
  });
  test('in no pane (just opened) with room: a new pane right of the focused one', () => {
    const s = S([P(['t:a']), P(['t:b'])], 0);
    expect(openToSide(s, [], 't:a', 'f:x', [])).toEqual(S([P(['t:a']), P(['f:x']), P(['t:b'])], 1));
  });
  test('one pane: the key the store just added moves out to a new pane on the right', () => {
    expect(openToSide(single(), ['t:a', 'f:x'], 't:a', 'f:x', [])).toEqual(S([P(['t:a'], 't:a'), P(['f:x'], 'f:x')], 1));
  });
  test('the focused pane\'s own tab with company: to a new pane on the right', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    expect(openToSide(s, [], 'f:x', 'f:x', ['t:a'])).toEqual(S([P(['t:a'], 't:a'), P(['f:x'], 'f:x'), P(['t:b'])], 1));
  });
  test('three panes: into the right neighbour (from the last pane, the left one)', () => {
    const s = S([P(['t:a']), P(['t:b']), P(['t:c'])], 1);
    expect(openToSide(s, [], 't:b', 'f:x', []).panes[2]).toEqual(P(['t:c', 'f:x'], 'f:x'));
    expect(openToSide({ ...s, focus: 2 }, [], 't:c', 'f:x', []).panes[1]).toEqual(P(['t:b', 'f:x'], 'f:x'));
  });
  test('alone in the focused pane: nothing to split off (same object)', () => {
    const s = S([P(['t:a']), P(['t:b'])], 0);
    expect(openToSide(s, [], 't:a', 't:a', [])).toBe(s);
    const one = single();
    expect(openToSide(one, ['t:a'], 't:a', 't:a', [])).toBe(one);
  });
});

describe('unsplit (the pane ×) and Unsplit All', () => {
  const two = S([P(['t:a', 'f:x'], 't:a'), P(['t:b', 'f:y'], 'f:y')], 1);
  test('a pane\'s tabs join its left neighbour, after its tabs; that pane\'s front stays and it takes the focus', () => {
    expect(unsplit(two, 1)).toEqual(S([P(['t:a', 'f:x', 't:b', 'f:y'], 't:a')]));
  });
  test('the first pane\'s tabs join the right neighbour, before its tabs (left-to-right order kept)', () => {
    expect(unsplit(two, 0)).toEqual(S([P(['t:a', 'f:x', 't:b', 'f:y'], 'f:y')]));
  });
  test('three panes: the middle one merges left; widths add up', () => {
    const s = S([P(['t:a']), P(['t:b']), P(['t:c'])], 1, [0.5, 0.25, 0.25]);
    const next = unsplit(s, 1);
    expect(next.panes).toEqual([P(['t:a', 't:b'], 't:a'), P(['t:c'])]);
    expect(next.focus).toBe(0);
    near(next.fractions, [0.75, 0.25]);
  });
  test('an empty pane just closes; an empty receiving pane takes the front of the one that leaves', () => {
    expect(unsplit(S([P(['t:a']), P([], null)], 1), 1)).toEqual(S([P(['t:a'])]));
    expect(unsplit(S([P([], null), P(['t:b'])], 0), 1)).toEqual(S([P(['t:b'])]));
  });
  test('one pane or out of range: the same object', () => {
    const one = single();
    expect(unsplit(one, 0)).toBe(one);
    expect(unsplit(two, 5)).toBe(two);
  });
  test('Unsplit All: every tab in pane order; the focused pane\'s front stays in front', () => {
    expect(unsplitAll(two)).toEqual(S([P(['t:a', 'f:x', 't:b', 'f:y'], 'f:y')]));
    expect(unsplitAll(S([P(['t:a']), P([], null)], 1))).toEqual(S([P(['t:a'])]));
  });
  test('unsplitTarget: where the × sends its tabs, for its tooltip', () => {
    expect(unsplitTarget(two, 1)).toEqual({ to: 'left', count: 2 });
    expect(unsplitTarget(two, 0)).toEqual({ to: 'right', count: 2 });
    expect(unsplitTarget(S([P(['t:a']), P([], null)]), 1)).toEqual({ to: 'left', count: 0 });
    expect(unsplitTarget(single(), 0)).toBeNull();
  });
});

describe('focus keys', () => {
  const s = S([P(['t:a']), P(['t:b'])], 0);
  test('focusPane picks a pane; out of range or the same pane is ignored', () => {
    expect(focusPane(s, 1)).toEqual({ ...s, focus: 1 });
    expect(focusPane(s, 2)).toBe(s);
    expect(focusPane(s, -1)).toBe(s);
    expect(focusPane(s, 0)).toBe(s);
  });
  test('next / previous wrap around; one pane: nothing moves', () => {
    const t = S([P(['t:a']), P(['t:b']), P(['t:c'])], 2);
    expect(focusStep(t, 1).focus).toBe(0);
    expect(focusStep(t, -1).focus).toBe(1);
    const one = single();
    expect(focusStep(one, 1)).toBe(one);
  });
});

describe('renamed tabs', () => {
  test('renameKeys follows a renamed file in its pane (tabs and front); unchanged: same object', () => {
    const s = S([P(['t:a', 'f:/p/x.ts'], 'f:/p/x.ts'), P([], null)]);
    expect(renameKeys(s, (k) => (k === 'f:/p/x.ts' ? 'f:/p/z.ts' : k))).toEqual(S([P(['t:a', 'f:/p/z.ts'], 'f:/p/z.ts'), P([], null)]));
    expect(renameKeys(s, (k) => k)).toBe(s);
  });
});

describe('grid cells', () => {
  test('a cell spans exactly one column and one row: an absolutely placed view with an `auto` end line would run to the grid\'s edge', () => {
    expect(paneCell(0, 'body')).toEqual({ gridColumn: '1 / 2', gridRow: '2 / 3' });
    expect(paneCell(2, 'head')).toEqual({ gridColumn: '3 / 4', gridRow: '1 / 2' });
  });
  test('a pane without a bar (anything but a Claude session) puts its view in both rows', () => {
    expect(paneCell(1, 'full')).toEqual({ gridColumn: '2 / 3', gridRow: '1 / 3' });
  });
});

describe('pickableKeys', () => {
  test('outside Sessions an empty pane offers the space\'s tabs not in front of any pane, left to right', () => {
    const s = S([P(['dk:overview', 'dk:c:aaaaaaaaaaaa'] as TabKey[], 'dk:overview'), P([], null)], 1);
    expect(pickableKeys(flatten(s), s)).toEqual(['dk:c:aaaaaaaaaaaa']);
    const all = S([P(['rd:keys'] as TabKey[], 'rd:keys'), P([], null)], 1);
    expect(pickableKeys(flatten(all), all)).toEqual([]);
  });
});

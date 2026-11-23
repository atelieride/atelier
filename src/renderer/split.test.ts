import { describe, expect, test } from 'vitest';
import {
  canMoveStep, canMoveToNewPane, dropZone, focusDir, focusPane, flatten, fronts, isSplit, lift, mapLayoutKeys, mapLayoutPanes, moveStep, moveTab, moveToNewPane, openToSide, paneOf,
  pickableKeys, placeOpened, reconcile, removeKeys, renameKeys, restoreLayout, savedKeys, serializeLayout, single, splitPane, stripKeys, unsplit, unsplitAll, unsplitTarget, visibleKeys,
  MAX_PANES, type Pane, type Split
} from './split';
import { arrivedPane, row, sizesAt, withSizes, type LayoutNode } from './split-tree';
import type { TabKey } from './tabs-model';

// Split view with tab groups: each pane owns its tabs and its tab in front; the layout tree says where each pane is.

const P = (tabs: TabKey[], front: TabKey | null = tabs[0] ?? null): Pane => ({ tabs, front });
const S = (panes: Pane[], focus = 0, tree: LayoutNode = row(panes.length)): Split => ({ panes, focus, tree });
const L: LayoutNode = { kind: 'pane' };
const R = (children: LayoutNode[], sizes = children.map(() => 1 / children.length)): LayoutNode => ({ kind: 'group', dir: 'row', children, sizes });
const C = (children: LayoutNode[], sizes = children.map(() => 1 / children.length)): LayoutNode => ({ kind: 'group', dir: 'column', children, sizes });
const near = (xs: number[] | null, ys: number[]) => { expect(xs).not.toBeNull(); expect(xs!.length).toBe(ys.length); xs!.forEach((x, i) => expect(x).toBeCloseTo(ys[i]!, 6)); };

describe('one pane', () => {
  test('single(): one placeholder pane, focused, full size; not split', () => {
    expect(single()).toEqual({ panes: [{ tabs: [], front: null }], focus: 0, tree: { kind: 'pane' } });
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
  test('a pane that loses its last tab closes, its width to the pane on its left (the first one\'s to the right); the focus follows', () => {
    const three = S([P(['t:a']), P(['t:b']), P(['t:c'])], 1, row(3, [0.5, 0.25, 0.25]));
    const mid = removeKeys(three, (k) => k === 't:b', []);
    expect(mid.panes).toEqual([P(['t:a']), P(['t:c'])]);
    expect(mid.focus).toBe(0);
    near(sizesAt(mid.tree, []), [0.75, 0.25]);
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
  test('a terminal exiting empties a nested pane: the group collapses and the focus stays on its pane', () => {
    const s = S([P(['t:a'], 't:a'), P(['t:b'], 't:b'), P(['t:c'], 't:c')], 0, R([L, C([L, L])]));
    const next = reconcile(s, ['t:a', 't:b'], 't:a', []);
    expect(next.tree).toEqual(R([L, L]));
    expect(next.panes).toEqual([P(['t:a'], 't:a'), P(['t:b'], 't:b')]);
    expect(next.focus).toBe(0);
    // The focused pane emptied: the focus follows its space to the pane above it.
    const mine = reconcile({ ...s, focus: 2 }, ['t:a', 't:b'], 't:b', []);
    expect(mine.focus).toBe(1);
    expect(mine.tree).toEqual(R([L, L]));
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

describe('split right and split down', () => {
  test('one pane: its tabs stay left, an empty pane on the right takes the focus; widths equal', () => {
    expect(splitPane(single(), ['t:a', 't:b'], 't:b', 'right')).toEqual(S([P(['t:a', 't:b'], 't:b'), P([], null)], 1));
  });
  test('inserted right of the focused pane, not at the end', () => {
    const s = S([P(['t:a']), P(['t:b'])], 0);
    expect(splitPane(s, [], 't:a', 'right')).toEqual(S([P(['t:a']), P([], null), P(['t:b'])], 1));
  });
  test('MAX_PANES is four; at four panes: refused (null)', () => {
    expect(MAX_PANES).toBe(4);
    expect(splitPane(S([P(['t:a']), P(['t:b']), P(['t:c'])]), [], 't:a', 'right')).not.toBeNull();
    expect(splitPane(S([P(['t:a']), P(['t:b']), P(['t:c']), P(['t:d'])]), [], 't:a', 'bottom')).toBeNull();
  });
  test('Split Down stacks an empty pane below the focused one', () => {
    const s = splitPane(lift(single(), ['t:a', 't:b'], 't:a'), ['t:a', 't:b'], 't:a', 'bottom')!;
    expect(s.panes).toEqual([P(['t:a', 't:b'], 't:a'), P([], null)]);
    expect(s.tree).toEqual(C([L, L]));
    expect(s.focus).toBe(1);
  });
  test('Split Right next to a stacked pane wraps only that pane', () => {
    const s = S([P(['t:a']), P(['t:b'])], 1, C([L, L]));
    const next = splitPane(s, [], 't:b', 'right')!;
    expect(next.tree).toEqual(C([L, R([L, L])]));
    expect(next.panes).toEqual([P(['t:a']), P(['t:b']), P([], null)]);
    expect(next.focus).toBe(2);
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
  test('refused (null) at four panes and for a tab alone in its own target pane', () => {
    expect(moveToNewPane(S([P(['t:a', 'f:x']), P(['t:b']), P(['t:c']), P(['t:d'])]), [], null, 'f:x', 0, 'right', [])).toBeNull();
    expect(moveToNewPane(S([P(['t:a']), P(['t:b'])]), [], null, 't:a', 0, 'right', [])).toBeNull();
    expect(moveToNewPane(single(), ['t:a'], 't:a', 't:a', 0, 'right', [])).toBeNull();
  });
  test('below or above a pane: stacked with it, the rest of the layout untouched', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    const down = moveToNewPane(s, [], null, 'f:x', 1, 'bottom', ['t:a'])!;
    expect(down.tree).toEqual(R([L, C([L, L])]));
    expect(down.panes).toEqual([P(['t:a'], 't:a'), P(['t:b']), P(['f:x'], 'f:x')]);
    expect(down.focus).toBe(2);
    const up = moveToNewPane(s, [], null, 'f:x', 0, 'top', ['t:a'])!;
    expect(up.tree).toEqual(R([C([L, L]), L]));
    expect(up.panes).toEqual([P(['f:x'], 'f:x'), P(['t:a'], 't:a'), P(['t:b'])]);
    expect(up.focus).toBe(0);
  });
  test('canMoveToNewPane: room for a pane and not alone in its pane (one pane: the order)', () => {
    expect(canMoveToNewPane(single(), ['t:a', 't:b'], 't:a')).toBe(true);
    expect(canMoveToNewPane(single(), ['t:a'], 't:a')).toBe(false);
    expect(canMoveToNewPane(S([P(['t:a', 'f:x']), P(['t:b'])]), [], 'f:x')).toBe(true);
    expect(canMoveToNewPane(S([P(['t:a', 'f:x']), P(['t:b'])]), [], 't:b')).toBe(false);
    expect(canMoveToNewPane(S([P(['t:a', 'f:x']), P(['t:b']), P(['t:c'])]), [], 'f:x')).toBe(true);
    expect(canMoveToNewPane(S([P(['t:a', 'f:x']), P(['t:b']), P(['t:c']), P(['t:d'])]), [], 'f:x')).toBe(false);
  });
});

describe('⌃⌘ with an arrow (moveStep): the focused pane\'s tab in front', () => {
  test('to the end of the neighbour, in front there, focused', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    expect(moveStep(s, [], 'f:x', 'right', ['t:a'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b', 'f:x'], 'f:x')], 1));
  });
  test('from the edge pane with room and company: a new pane on that side (one pane splits the tab out)', () => {
    expect(moveStep(single(), ['t:a', 't:b'], 't:b', 'right', ['t:a'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b'], 't:b')], 1));
    expect(moveStep(single(), ['t:a', 't:b'], 't:a', 'left', ['t:b'])).toEqual(S([P(['t:a'], 't:a'), P(['t:b'], 't:b')], 0));
    const down = moveStep(single(), ['t:a', 't:b'], 't:b', 'bottom', ['t:a'])!;
    expect(down.tree).toEqual(C([L, L]));
    expect(down.panes).toEqual([P(['t:a'], 't:a'), P(['t:b'], 't:b')]);
  });
  test('the neighbour below in a grid gets the tab', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b']), P(['t:c']), P(['t:d'])], 0, R([C([L, L]), C([L, L])]));
    const next = moveStep(s, [], 'f:x', 'bottom', ['t:a'])!;
    expect(next.panes[0]).toEqual(P(['t:a'], 't:a'));
    expect(next.panes[1]).toEqual(P(['t:b', 'f:x'], 'f:x'));
    expect(next.focus).toBe(1);
    expect(next.tree).toBe(s.tree);
  });
  test('back again: the last tab of a pane joins its neighbour and the pane closes', () => {
    const s = S([P(['t:a'], 't:a'), P(['t:b'], 't:b')], 1);
    expect(moveStep(s, [], 't:b', 'left', [])).toEqual(S([P(['t:a', 't:b'], 't:b')]));
  });
  test('nothing to do (null): alone at the edge, four panes at the edge, an empty focused pane', () => {
    expect(moveStep(single(), ['t:a'], 't:a', 'right', [])).toBeNull();
    expect(moveStep(S([P(['t:a']), P(['t:b']), P(['t:c']), P(['t:d', 'f:x'], 'f:x')], 3), [], 'f:x', 'right', [])).toBeNull();
    expect(moveStep(S([P(['t:a']), P([], null)], 1), [], null, 'left', [])).toBeNull();
  });
});

describe('canMoveStep: the palette offers ⌃⌘ moves only when they act', () => {
  test('a neighbour, or room and company at the edge; never from an empty focused pane', () => {
    expect(canMoveStep(single(), ['t:a', 't:b'], 't:b', 'right')).toBe(true);
    expect(canMoveStep(single(), ['t:a'], 't:a', 'right')).toBe(false);
    expect(canMoveStep(S([P(['t:a']), P(['t:b'])], 0), [], 't:a', 'right')).toBe(true);
    expect(canMoveStep(S([P(['t:a']), P([], null)], 1), [], null, 'left')).toBe(false);
    expect(canMoveStep(S([P(['t:a']), P([], null)], 1), [], null, 'right')).toBe(false);
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
  test('four panes: into the right neighbour (from the last pane, the left one; stacked, the one below)', () => {
    const s = S([P(['t:a']), P(['t:b']), P(['t:c']), P(['t:d'])], 1);
    expect(openToSide(s, [], 't:b', 'f:x', []).panes[2]).toEqual(P(['t:c', 'f:x'], 'f:x'));
    expect(openToSide({ ...s, focus: 3 }, [], 't:d', 'f:x', []).panes[2]).toEqual(P(['t:c', 'f:x'], 'f:x'));
    const stack = S([P(['t:a']), P(['t:b']), P(['t:c']), P(['t:d'])], 0, C([L, L, L, L]));
    expect(openToSide(stack, [], 't:a', 'f:x', []).panes[1]).toEqual(P(['t:b', 'f:x'], 'f:x'));
  });
  test('no room for a new pane: into the neighbour, as with four panes; one pane stays as it is', () => {
    const s = S([P(['t:a']), P(['t:b'])], 0);
    expect(openToSide(s, [], 't:a', 'f:x', [], false)).toEqual(S([P(['t:a']), P(['t:b', 'f:x'], 'f:x')], 1));
    const one = single();
    expect(openToSide(one, ['t:a', 'f:x'], 't:a', 'f:x', [], false)).toBe(one);
  });
  test('alone in the focused pane: nothing to split off (same object)', () => {
    const s = S([P(['t:a']), P(['t:b'])], 0);
    expect(openToSide(s, [], 't:a', 't:a', [])).toBe(s);
    const one = single();
    expect(openToSide(one, ['t:a'], 't:a', 't:a', [])).toBe(one);
  });
});

describe('the pane a change brings (arrivedPane: what springs in)', () => {
  test('a split of one pane: the new pane; the pane it was split from is the one there was', () => {
    const one = single();
    expect(arrivedPane(one.tree, splitPane(one, ['t:a'], 't:a', 'right')!.tree)).toBe(1);
    expect(arrivedPane(one.tree, splitPane(one, ['t:a'], 't:a', 'bottom')!.tree)).toBe(1);
    expect(arrivedPane(one.tree, moveToNewPane(one, ['t:a', 't:b'], 't:b', 't:b', 0, 'right', [])!.tree)).toBe(1);
  });
  test('a split of a split, a tab moved to a new pane on any side, another pane\'s only tab moved to one', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])], 0);
    expect(arrivedPane(s.tree, splitPane(s, [], 'f:x', 'right')!.tree)).toBe(1);
    expect(arrivedPane(s.tree, splitPane({ ...s, focus: 1 }, [], 't:b', 'bottom')!.tree)).toBe(2);
    expect(arrivedPane(s.tree, moveToNewPane(s, [], null, 't:a', 1, 'left', [])!.tree)).toBe(1);
    expect(arrivedPane(s.tree, moveToNewPane(s, [], null, 'f:x', 0, 'top', ['t:a'])!.tree)).toBe(0);
    const t = S([P(['t:a', 'f:x'], 't:a'), P(['t:b'])], 1);
    expect(arrivedPane(t.tree, moveToNewPane(t, [], null, 't:b', 0, 'left', [])!.tree)).toBe(0);
  });
  test('nothing new: the same tree, a divider moved, a pane closed, a tab moved between panes', () => {
    const s = S([P(['t:a', 'f:x'], 'f:x'), P(['t:b']), P(['t:c'])], 0);
    expect(arrivedPane(s.tree, s.tree)).toBeNull();
    expect(arrivedPane(s.tree, withSizes(s.tree, [], [0.5, 0.25, 0.25]))).toBeNull();
    expect(arrivedPane(s.tree, unsplit(s, 1).tree)).toBeNull();
    expect(arrivedPane(s.tree, moveTab(s, 'f:x', 1, null, []).tree)).toBeNull();
  });
  test('a layout read back (every pane new) or one pane again: none', () => {
    const s = S([P(['t:a']), P(['t:b'])], 1, C([L, L]));
    expect(arrivedPane(single().tree, restoreLayout(JSON.parse(JSON.stringify(serializeLayout(s))), ['t:a', 't:b'])!.tree)).toBeNull();
    expect(arrivedPane(s.tree, restoreLayout(JSON.parse(JSON.stringify(serializeLayout(s))), ['t:a', 't:b'])!.tree)).toBeNull();
    expect(arrivedPane(s.tree, unsplitAll(s).tree)).toBeNull();
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
    const s = S([P(['t:a']), P(['t:b']), P(['t:c'])], 1, row(3, [0.5, 0.25, 0.25]));
    const next = unsplit(s, 1);
    expect(next.panes).toEqual([P(['t:a', 't:b'], 't:a'), P(['t:c'])]);
    expect(next.focus).toBe(0);
    near(sizesAt(next.tree, []), [0.75, 0.25]);
  });
  test('in a nested layout: the tabs join the pane that takes the space, its side decides the order', () => {
    // A on the left, B over C on the right: A's tabs go to B (the right column's pane sharing the longest edge).
    const s = S([P(['t:a', 'f:x'], 't:a'), P(['t:b'], 't:b'), P(['t:c'], 't:c')], 0, R([L, C([L, L], [0.6, 0.4])]));
    expect(unsplitTarget(s, 0)).toEqual({ to: 'right', count: 2 });
    const next = unsplit(s, 0);
    expect(next.panes).toEqual([P(['t:a', 'f:x', 't:b'], 't:b'), P(['t:c'], 't:c')]);
    expect(next.tree).toEqual(C([L, L], [0.6, 0.4]));
    expect(next.focus).toBe(0);
    // C's tabs go up into B, after B's.
    expect(unsplitTarget(s, 2)).toEqual({ to: 'top', count: 1 });
    const up = unsplit(s, 2);
    expect(up.panes).toEqual([P(['t:a', 'f:x'], 't:a'), P(['t:b', 't:c'], 't:b')]);
    expect(up.tree).toEqual(R([L, L]));
    expect(up.focus).toBe(1);
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
  test('right / left wrap around a row; one pane: nothing moves', () => {
    const t = S([P(['t:a']), P(['t:b']), P(['t:c'])], 2);
    expect(focusDir(t, 'right').focus).toBe(0);
    expect(focusDir(t, 'left').focus).toBe(1);
    const one = single();
    expect(focusDir(one, 'right')).toBe(one);
  });
  test('directional in a grid: below, beside, and wrapping within the span', () => {
    const g = S([P(['t:a']), P(['t:b']), P(['t:c']), P(['t:d'])], 0, R([C([L, L]), C([L, L])]));
    expect(focusDir(g, 'bottom').focus).toBe(1);
    expect(focusDir(g, 'right').focus).toBe(2);
    expect(focusDir(g, 'top').focus).toBe(1);
    expect(focusDir({ ...g, focus: 3 }, 'left').focus).toBe(1);
  });
});

describe('drop zones', () => {
  const pane = { left: 100, top: 50, width: 800, height: 600 };
  test('left, right, top and bottom bands; the middle elsewhere', () => {
    expect(dropZone(pane, { x: 120, y: 350 }, 2)).toBe('left');
    expect(dropZone(pane, { x: 880, y: 350 }, 2)).toBe('right');
    expect(dropZone(pane, { x: 500, y: 60 }, 2)).toBe('top');
    expect(dropZone(pane, { x: 500, y: 640 }, 2)).toBe('bottom');
    expect(dropZone(pane, { x: 500, y: 350 }, 2)).toBe('middle');
  });
  test('in a corner, the edge the point is relatively nearer to wins', () => {
    // Bands: 192 px wide (24% of 800), 144 px tall (24% of 600). 20 px from the left is nearer (in band terms) than 100 px from the top.
    expect(dropZone(pane, { x: 120, y: 150 }, 2)).toBe('left');
    expect(dropZone(pane, { x: 250, y: 60 }, 2)).toBe('top');
  });
  test('bands are at least 48 px and at most a third of the pane', () => {
    const small = { left: 0, top: 0, width: 120, height: 90 };
    expect(dropZone(small, { x: 39, y: 45 }, 1)).toBe('left');
    expect(dropZone(small, { x: 60, y: 29 }, 1)).toBe('top');
    expect(dropZone(small, { x: 60, y: 45 }, 1)).toBe('middle');
  });
  test('at four panes: only the middle', () => {
    expect(dropZone(pane, { x: 120, y: 350 }, 4)).toBe('middle');
  });
});

describe('renamed tabs', () => {
  test('renameKeys follows a renamed file in its pane (tabs and front); unchanged: same object', () => {
    const s = S([P(['t:a', 'f:/p/x.ts'], 'f:/p/x.ts'), P([], null)]);
    expect(renameKeys(s, (k) => (k === 'f:/p/x.ts' ? 'f:/p/z.ts' : k))).toEqual(S([P(['t:a', 'f:/p/z.ts'], 'f:/p/z.ts'), P([], null)]));
    expect(renameKeys(s, (k) => k)).toBe(s);
  });
});

describe('saved layouts', () => {
  const order = ['t:a', 'f:x', 't:b', 't:c'] as TabKey[];
  const mixed = (focus = 2) => S([P(['t:a', 'f:x'], 'f:x'), P(['t:b']), P(['t:c'])], focus, R([L, C([L, L], [0.3, 0.7])], [0.6, 0.4]));
  test('v3 round-trip keeps a mixed layout, its sizes and the focus', () => {
    const saved = serializeLayout(mixed())!;
    expect(saved.v).toBe(3);
    expect(restoreLayout(JSON.parse(JSON.stringify(saved)), order)).toEqual(mixed());
  });
  test('a v2 layout from before stacking restores as a row with its widths', () => {
    const v2 = { v: 2, panes: [{ tabs: ['t:a'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], fractions: [0.3, 0.7], focus: 1 };
    const s = restoreLayout(v2, ['t:a', 't:b'])!;
    expect(s.panes).toEqual([P(['t:a']), P(['t:b'])]);
    expect(s.tree).toEqual(R([L, L], [0.3, 0.7]));
    expect(s.focus).toBe(1);
  });
  test('restore drops a pane with no open tab together with its leaf', () => {
    const s = restoreLayout(serializeLayout(mixed(0)), ['t:a', 'f:x', 't:b'])!;
    expect(s.panes).toEqual([P(['t:a', 'f:x'], 'f:x'), P(['t:b'])]);
    expect(s.tree).toEqual(R([L, L], [0.6, 0.4]));
    expect(s.focus).toBe(0);
  });
  test('without keepEmpty an empty pane is left out of what is saved; the focus follows its space', () => {
    const s = S([P(['t:a']), P(['t:b']), P([], null)], 2, R([L, C([L, L])]));
    const saved = serializeLayout(s)!;
    expect(saved.panes).toEqual([{ tabs: ['t:a'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }]);
    expect(saved.tree).toEqual(R([L, L]));
    expect(saved.focus).toBe(1);
  });
  test('keepEmpty: a nested empty pane comes back in its place', () => {
    const s = S([P(['t:a']), P(['t:b']), P([], null)], 2, R([L, C([L, L])]));
    expect(restoreLayout(serializeLayout(s, true), ['t:a', 't:b'], true)).toEqual(s);
  });
  test('mapLayoutPanes emptying a pane: restore drops it and keeps the panes and the tree aligned', () => {
    const mapped = mapLayoutPanes(serializeLayout(mixed(2)), (p) => (p.tabs.includes('t:b') ? { tabs: [], front: null } : p));
    const s = restoreLayout(mapped, order)!;
    // t:b is still open and named by no pane: it joins the focused pane (C).
    expect(s.panes).toEqual([P(['t:a', 'f:x'], 'f:x'), P(['t:c', 't:b'], 't:c')]);
    expect(s.tree).toEqual(R([L, L], [0.6, 0.4]));
    expect(s.focus).toBe(1);
  });
  test('a v3 with five panes, a leaf count that differs from its panes, or bad sizes restores as one pane (null)', () => {
    const p = (k: string) => ({ tabs: [k], front: k });
    const keys = ['t:a', 't:b', 't:c', 't:d', 't:e'] as TabKey[];
    expect(restoreLayout({ v: 3, panes: keys.map(p), tree: R([L, L, L, L, L]), focus: 0 }, keys)).toBeNull();
    expect(restoreLayout({ v: 3, panes: [p('t:a'), p('t:b')], tree: R([L, L, L]), focus: 0 }, keys)).toBeNull();
    expect(restoreLayout({ v: 3, panes: [p('t:a'), p('t:b')], tree: { kind: 'group', dir: 'row', children: [L, L], sizes: [1, -1] }, focus: 0 }, keys)).toBeNull();
    expect(restoreLayout({ v: 3, panes: [p('t:a'), p('t:b')], focus: 0 }, keys)).toBeNull();
  });
  test('savedKeys and mapLayoutKeys read v3; the tree is kept', () => {
    const saved = serializeLayout(mixed())!;
    expect(savedKeys(saved)).toEqual(['t:a', 'f:x', 't:b', 't:c']);
    const mapped = mapLayoutKeys(saved, (k) => (k === 't:b' ? 't:z' : k)) as typeof saved;
    expect(mapped.panes[1]).toEqual({ tabs: ['t:z'], front: 't:z' });
    expect(mapped.tree).toEqual(saved.tree);
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

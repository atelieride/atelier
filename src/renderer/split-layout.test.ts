import { describe, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { MIN_PANE_PX, PICKER_MAX, dragDivider, dropZone, flatten, gridColumns, pickable, restoreLayout, savedKeys, serializeLayout, single, type Pane, type Split } from './split';
import type { TabKey } from './tabs-model';

// Split view with tab groups: drop zones, dividers and the saved layout.

const P = (tabs: TabKey[], front: TabKey | null = tabs[0] ?? null): Pane => ({ tabs, front });
const S = (panes: Pane[], focus = 0, fractions = panes.map(() => 1 / panes.length)): Split => ({ panes, focus, fractions });
const near = (xs: number[], ys: number[]) => { expect(xs.length).toBe(ys.length); xs.forEach((x, i) => expect(x).toBeCloseTo(ys[i]!, 6)); };

describe('drop zones over a pane', () => {
  const pane = { left: 100, width: 600 };
  test('edge bands are 24% of the pane\'s width', () => {
    // 24% of 600 = 144 px.
    expect(dropZone(pane, 100 + 143, 2)).toBe('left');
    expect(dropZone(pane, 100 + 145, 2)).toBe('middle');
    expect(dropZone(pane, 700 - 143, 2)).toBe('right');
    expect(dropZone(pane, 700 - 145, 2)).toBe('middle');
    expect(dropZone(pane, 400, 2)).toBe('middle');
  });
  test('at least 48 px on a narrow pane', () => {
    const narrow = { left: 0, width: 150 };
    expect(dropZone(narrow, 47, 1)).toBe('left');
    expect(dropZone(narrow, 103, 1)).toBe('right');
    expect(dropZone(narrow, 75, 1)).toBe('middle');
  });
  test('at three panes the bands act as the middle', () => {
    expect(dropZone(pane, 101, 3)).toBe('middle');
    expect(dropZone(pane, 699, 3)).toBe('middle');
  });
});

describe('fractions and dividers', () => {
  test('a divider moves width between its two panes only', () => {
    near(dragDivider([0.5, 0.5], 0, 100, 1000), [0.6, 0.4]);
    near(dragDivider([0.3, 0.3, 0.4], 1, -50, 1000), [0.3, 0.25, 0.45]);
  });
  test('panes never go below 240 px when the workspace is wide enough', () => {
    near(dragDivider([0.5, 0.5], 0, 400, 1000), [0.76, 0.24]);
    near(dragDivider([0.5, 0.5], 0, -400, 1000), [0.24, 0.76]);
    near(dragDivider([0.3, 0.3, 0.4], 0, 500, 1000), [0.36, 0.24, 0.4]);
  });
  test('a workspace too narrow for 240 px panes: dragging changes nothing (they are shown equal)', () => {
    near(dragDivider([0.5, 0.5], 0, 50, 400), [0.5, 0.5]);
    expect(MIN_PANE_PX).toBe(240);
  });
  test('the grid columns: each fraction as fr, never below 240 px (or an equal share when too narrow)', () => {
    expect(gridColumns([0.25, 0.75])).toBe('minmax(min(240px, calc((100% - 1px) / 2)), 0.25fr) minmax(min(240px, calc((100% - 1px) / 2)), 0.75fr)');
  });
});

describe('saved layout (v2: every pane\'s tabs)', () => {
  const three = S([P(['t:a', 'f:/p/x.md'], 'f:/p/x.md'), P(['services', 't:b'], 't:b'), P(['t:c'])], 2, [0.2, 0.3, 0.5]);
  test('round trip: tabs of every kind, fronts, fractions and focus', () => {
    const saved = serializeLayout(three);
    expect(saved).toEqual({ v: 2, panes: [{ tabs: ['t:a', 'f:/p/x.md'], front: 'f:/p/x.md' }, { tabs: ['services', 't:b'], front: 't:b' }, { tabs: ['t:c'], front: 't:c' }], fractions: [0.2, 0.3, 0.5], focus: 2 });
    expect(restoreLayout(JSON.parse(JSON.stringify(saved)), flatten(three))).toEqual(three);
  });
  test('one pane is not saved; empty panes are left out (their width to the others), fewer than two left: nothing', () => {
    expect(serializeLayout(single())).toBeNull();
    const s = S([P(['t:a']), P([], null), P(['t:c'])], 1, [0.25, 0.25, 0.5]);
    expect(serializeLayout(s)).toEqual({ v: 2, panes: [{ tabs: ['t:a'], front: 't:a' }, { tabs: ['t:c'], front: 't:c' }], fractions: [1 / 3, 2 / 3], focus: 0 });
    expect(serializeLayout(S([P(['t:a']), P([], null)], 1))).toBeNull();
  });
  test('open tabs go to their saved pane in the saved order; tabs not named join the focused pane; named tabs not open are skipped', () => {
    const raw = { v: 2, panes: [{ tabs: ['t:b', 't:a'], front: 't:a' }, { tabs: ['f:/gone', 't:c'], front: 'f:/gone' }], fractions: [0.5, 0.5], focus: 1 };
    expect(restoreLayout(raw, ['t:a', 't:b', 't:c', 'f:/new'])).toEqual(S([P(['t:b', 't:a'], 't:a'), P(['t:c', 'f:/new'], 't:c')], 1));
  });
  test('a pane left without open tabs is dropped (never an empty pane); under two: nothing (one pane)', () => {
    const raw = { v: 2, panes: [{ tabs: ['t:a'], front: 't:a' }, { tabs: ['f:/gone.md'], front: 'f:/gone.md' }], fractions: [0.5, 0.5], focus: 1 };
    expect(restoreLayout(raw, ['t:a', 't:b'])).toBeNull();
    const raw3 = { v: 2, panes: [{ tabs: ['t:a'], front: 't:a' }, { tabs: ['t:gone'], front: 't:gone' }, { tabs: ['t:c'], front: 't:c' }], fractions: [0.2, 0.3, 0.5], focus: 1 };
    const r = restoreLayout(raw3, ['t:a', 't:c'])!;
    expect(r.panes).toEqual([P(['t:a']), P(['t:c'])]);
    expect(r.focus).toBe(0);
    near(r.fractions, [0.2 / 0.7, 0.5 / 0.7]);
  });
  test('a key named in two panes stays in the first; a front not open: the pane\'s first tab', () => {
    const raw = { v: 2, panes: [{ tabs: ['t:a', 't:b'], front: 't:x' }, { tabs: ['t:b', 't:c'], front: 't:b' }], fractions: [0.5, 0.5], focus: 0 };
    expect(restoreLayout(raw, ['t:a', 't:b', 't:c'])).toEqual(S([P(['t:a', 't:b'], 't:a'), P(['t:c'], 't:c')], 0));
  });
  // A space's view kept while another space is in front: its empty panes too.
  test('kept for a space switch: an empty pane stays, focus and widths with it; a pane emptied by closes meanwhile goes', () => {
    const s = S([P(['dk:overview']), P([], null), P(['dk:c:aaaaaaaaaaaa'])], 1, [0.25, 0.25, 0.5]);
    const kept = serializeLayout(s, true);
    expect(kept).toEqual({ v: 2, panes: [{ tabs: ['dk:overview'], front: 'dk:overview' }, { tabs: [], front: null }, { tabs: ['dk:c:aaaaaaaaaaaa'], front: 'dk:c:aaaaaaaaaaaa' }], fractions: [0.25, 0.25, 0.5], focus: 1 });
    expect(restoreLayout(kept, ['dk:overview', 'dk:c:aaaaaaaaaaaa'], true)).toEqual(s);
    // The container's tab closed meanwhile: its pane goes, the empty one stays.
    expect(restoreLayout(kept, ['dk:overview'], true)).toEqual(S([P(['dk:overview']), P([], null)], 1, [0.5, 0.5]));
    // Without keeping (a restart): the empty pane is left out, as before.
    expect(restoreLayout(kept, ['dk:overview', 'dk:c:aaaaaaaaaaaa'])).toEqual(S([P(['dk:overview']), P(['dk:c:aaaaaaaaaaaa'])], 0, [1 / 3, 2 / 3]));
  });
});

describe('saved layout (v1: one terminal per pane, before tab groups)', () => {
  test('each surviving terminal its own pane; every other open tab joins the pane that was focused, in strip order', () => {
    const raw = { panes: ['t:a', 'f:/x', 't:b'], fractions: [0.2, 0.3, 0.5], focus: 2 };
    const r = restoreLayout(raw, ['f:/y', 't:a', 't:b', 't:c'])!;
    expect(r.panes).toEqual([P(['t:a']), P(['f:/y', 't:b', 't:c'], 't:b')]);
    expect(r.focus).toBe(1);
    near(r.fractions, [0.2 / 0.7, 0.5 / 0.7]);
  });
  test('dead terminals, files, Services and the review never get a pane; under two: nothing', () => {
    expect(restoreLayout({ panes: ['t:a', 'f:/x', 't:dead', 'services'], fractions: [0.2, 0.2, 0.2, 0.4], focus: 0 }, ['t:a'])).toBeNull();
    expect(restoreLayout({ panes: ['review', 't:a'], fractions: [0.5, 0.5], focus: 0 }, ['review', 't:a'])).toBeNull();
  });
  test('the focus clamps to a surviving pane (left first)', () => {
    expect(restoreLayout({ panes: ['t:a', 't:b', 't:c'], fractions: [0.3, 0.3, 0.4], focus: 1 }, ['t:a', 't:c'])!.focus).toBe(0);
    expect(restoreLayout({ panes: ['t:a', 't:b', 't:c'], fractions: [0.3, 0.3, 0.4], focus: 0 }, ['t:b', 't:c'])!.focus).toBe(0);
    expect(restoreLayout({ panes: ['t:a', 't:b'], fractions: [0.5, 0.5], focus: 7 }, ['t:a', 't:b'])!.focus).toBe(1);
    expect(restoreLayout({ panes: ['t:a', 't:b'], fractions: [0.5, 0.5], focus: -1 }, ['t:a', 't:b'])!.focus).toBe(0);
  });
  test('too many panes: the first three survivors', () => {
    const r = restoreLayout({ panes: ['t:a', 't:b', 't:c', 't:d'], fractions: [0.25, 0.25, 0.25, 0.25], focus: 3 }, ['t:a', 't:b', 't:c', 't:d'])!;
    expect(r.panes.map((p) => p.front)).toEqual(['t:a', 't:b', 't:c']);
    expect(r.panes[2]!.tabs).toEqual(['t:c', 't:d']);
    near(r.fractions, [1 / 3, 1 / 3, 1 / 3]);
    expect(r.focus).toBe(2);
  });
});

describe('saved layout: what storage may hand back', () => {
  const order: TabKey[] = ['t:a', 't:b'];
  test('fractions that do not add up to 1, or are not positive numbers, are equalized', () => {
    const v2 = (fractions: unknown) => ({ v: 2, panes: [{ tabs: ['t:a'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], fractions, focus: 0 });
    for (const f of [[0.9, 0.9], [1, 0], ['x', 0.5], [0.5], undefined]) expect(restoreLayout(v2(f), order)!.fractions).toEqual([0.5, 0.5]);
    expect(restoreLayout({ panes: ['t:a', 't:b'], fractions: [0.9, 0.9], focus: 0 }, order)!.fractions).toEqual([0.5, 0.5]);
  });
  test('malformed data restores nothing', () => {
    const bad = [null, undefined, 3, 'x', [], {}, { panes: 'x' }, { panes: [1, 2] }, { panes: ['t:a', 't:a'], fractions: [0.5, 0.5], focus: 0 },
      { v: 2, panes: 'x' }, { v: 2, panes: [{ tabs: 'x' }, { tabs: ['t:b'] }] }, { v: 2, panes: [{ tabs: [1] }, { tabs: ['t:b'] }] }, { v: 3, panes: [] }];
    for (const raw of bad) expect(restoreLayout(raw, order)).toBeNull();
  });
  test('more than three panes: the first three', () => {
    const raw = { v: 2, panes: ['t:a', 't:b', 't:c', 't:d'].map((k) => ({ tabs: [k], front: k })), fractions: [0.25, 0.25, 0.25, 0.25], focus: 3 };
    const r = restoreLayout(raw, ['t:a', 't:b', 't:c', 't:d'])!;
    expect(r.panes.map((p) => p.front)).toEqual(['t:a', 't:b', 't:c']);
    expect(r.panes[2]!.tabs).toEqual(['t:c', 't:d']);
  });
});

describe('savedKeys: what a saved layout names (hidden terminals named there get their tab back)', () => {
  test('v2 and v1 shapes; anything else names nothing', () => {
    expect(savedKeys({ v: 2, panes: [{ tabs: ['t:a', 'f:/x'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], fractions: [0.5, 0.5], focus: 0 })).toEqual(['t:a', 'f:/x', 't:b']);
    expect(savedKeys({ panes: ['t:a', 't:b'], fractions: [0.5, 0.5], focus: 0 })).toEqual(['t:a', 't:b']);
    for (const raw of [null, 3, [], { v: 2, panes: 'x' }, { panes: [1] }, { v: 3, panes: [] }]) expect(savedKeys(raw)).toEqual([]);
  });
});

describe('picker: what an empty pane offers', () => {
  const term = (id: string, createdAt: number): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt, session: null });
  const list = [term('a', 1), term('b', 2), term('c', 3), term('d', 4)];
  test('not in front of any pane (a non-front tab of another pane is offered): pinned first, then the newest', () => {
    const s = S([P(['t:c', 't:b'], 't:c'), P([], null)], 1);
    expect(pickable(list, ['a'], s).map((x) => x.id)).toEqual(['a', 'd', 'b']);
  });
  test(`at most ${PICKER_MAX}`, () => {
    const many = Array.from({ length: 12 }, (_, i) => term(`t${i}`, i));
    expect(pickable(many, [], S([P(['t:x']), P([], null)], 1))).toHaveLength(PICKER_MAX);
  });
});

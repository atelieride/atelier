import { describe, expect, test } from 'vitest';
import { afterClose, closingKeys, cycle, moveTab, noteActive, nth, openTab, syncTerminals, type TabKey } from './tabs-model';

const o: TabKey[] = ['t:a', 'f:/x', 't:b', 'services'];

describe('syncTerminals', () => {
  test('a new terminal goes in after the active tab', () => {
    expect(syncTerminals(o, ['a', 'b', 'c'], 'f:/x')).toEqual(['t:a', 'f:/x', 't:c', 't:b', 'services']);
  });
  test('with no active tab it goes last; gone ones are removed', () => {
    expect(syncTerminals(o, ['b', 'c'], null)).toEqual(['f:/x', 't:b', 'services', 't:c']);
  });
  test('empty order', () => {
    expect(syncTerminals([], ['a', 'b'], null)).toEqual(['t:a', 't:b']);
  });
  test('no change → same array', () => {
    expect(syncTerminals(o, ['a', 'b'], 't:a')).toBe(o);
  });
});

describe('closingKeys', () => {
  test('one, others, right, all, files', () => {
    expect(closingKeys(o, 'f:/x', 'one')).toEqual(['f:/x']);
    expect(closingKeys(o, 'f:/x', 'others')).toEqual(['t:a', 't:b', 'services']);
    expect(closingKeys(o, 'f:/x', 'right')).toEqual(['t:b', 'services']);
    expect(closingKeys(o, 'services', 'right')).toEqual([]);
    expect(closingKeys(o, 't:a', 'all')).toEqual(o);
    expect(closingKeys(o, 't:a', 'files')).toEqual(['f:/x']);
  });
  test('unknown key → nothing', () => {
    expect(closingKeys(o, 't:zz', 'right')).toEqual([]);
  });
});

describe('afterClose', () => {
  test('closing the active one moves to the neighbor on the right, then on the left', () => {
    expect(afterClose(o, ['f:/x'], 'f:/x')).toBe('t:b');
    expect(afterClose(o, ['services'], 'services')).toBe('t:b');
    expect(afterClose(o, ['t:b', 'services'], 't:b')).toBe('f:/x');
  });
  test('if the active one stays, it stays; if everything is closed, null', () => {
    expect(afterClose(o, ['t:b'], 't:a')).toBe('t:a');
    expect(afterClose(o, o, 't:a')).toBeNull();
  });
  test('with a history: back to the tab used most recently before it (still open, not closing), else the neighbor', () => {
    // Opened from t:a, the file landed between t:a and t:b: closing it goes back to t:a, not to t:b.
    expect(afterClose(o, ['f:/x'], 'f:/x', ['t:b', 't:a', 'f:/x'])).toBe('t:a');
    expect(afterClose(o, ['f:/x', 't:a'], 'f:/x', ['t:b', 't:a', 'f:/x'])).toBe('t:b');
    // Tabs closed meanwhile are skipped; nothing usable: the neighbor rule.
    expect(afterClose(o, ['f:/x'], 'f:/x', ['t:gone', 'f:/x'])).toBe('t:b');
    expect(afterClose(o, ['f:/x'], 'f:/x', [])).toBe('t:b');
  });
});

describe('noteActive', () => {
  test('the active tab moves to the end, once; the history stays short', () => {
    expect(noteActive([], 't:a')).toEqual(['t:a']);
    expect(noteActive(['t:a', 'f:/x', 't:b'], 't:a')).toEqual(['f:/x', 't:b', 't:a']);
    const long = Array.from({ length: 80 }, (_, i) => `t:${i}` as TabKey);
    const next = noteActive(long, 'f:/new');
    expect(next).toHaveLength(50);
    expect(next.at(-1)).toBe('f:/new');
    const same = ['t:a'] as TabKey[];
    expect(noteActive(same, 't:a')).toBe(same);
  });
});

test('moveTab', () => {
  expect(moveTab(o, 'services', 't:a')).toEqual(['services', 't:a', 'f:/x', 't:b']);
  expect(moveTab(o, 't:a', null)).toEqual(['f:/x', 't:b', 'services', 't:a']);
  expect(moveTab(o, 't:a', 't:a')).toBe(o);
});

test('cycle e nth', () => {
  expect(cycle(o, 'services', 1)).toBe('t:a');
  expect(cycle(o, 't:a', -1)).toBe('services');
  expect(cycle([], null, 1)).toBeNull();
  expect(nth(o, 1)).toBe('t:a');
  expect(nth(o, 9)).toBe('services');
  expect(nth([], 1)).toBeNull();
});

test('dragging: on the right half of a tab, it is inserted after it', async () => {
  const { dropTarget } = await import('./tabs-model');
  const order: TabKey[] = ['t:a', 't:b', 't:c'];
  expect(dropTarget(order, 't:b', { left: 100, width: 100 }, 120)).toBe('t:b');
  expect(dropTarget(order, 't:b', { left: 100, width: 100 }, 180)).toBe('t:c');
  expect(dropTarget(order, 't:c', { left: 200, width: 100 }, 290)).toBeNull();
});

test('Close Files closes only the files (Services stays); cycle with no active tab goes to the last one with −1', () => {
  const order: TabKey[] = ['t:a', 'f:/x', 'services', 'f:/y'];
  expect(closingKeys(order, 't:a', 'files')).toEqual(['f:/x', 'f:/y']);
  expect(cycle(order, null, -1)).toBe('f:/y');
  expect(cycle(order, null, 1)).toBe('t:a');
});

describe('openTab (preview tabs)', () => {
  const base: TabKey[] = ['t:a', 'f:/x', 't:b'];
  test('a preview open replaces the preview tab in place', () => {
    expect(openTab(base, 'f:/y', 't:a', 'f:/x', true)).toEqual({ order: ['t:a', 'f:/y', 't:b'], preview: 'f:/y', replaced: 'f:/x' });
  });
  test('a preview open with no preview tab enters after the active tab and becomes the preview', () => {
    expect(openTab(base, 'f:/y', 't:a', null, true)).toEqual({ order: ['t:a', 'f:/y', 'f:/x', 't:b'], preview: 'f:/y', replaced: null });
  });
  test('a normal open enters after the active tab and leaves the preview alone', () => {
    expect(openTab(base, 'f:/y', 't:b', 'f:/x', false)).toEqual({ order: ['t:a', 'f:/x', 't:b', 'f:/y'], preview: 'f:/x', replaced: null });
  });
  test('an already open normal tab is just activated: the preview stays', () => {
    const r = openTab(['t:a', 'f:/x', 'f:/n'], 'f:/n', 't:a', 'f:/x', true);
    expect(r).toEqual({ order: ['t:a', 'f:/x', 'f:/n'], preview: 'f:/x', replaced: null });
  });
  test('opening the preview file normally (double click) promotes it; as preview it stays one', () => {
    expect(openTab(base, 'f:/x', 't:a', 'f:/x', false)).toEqual({ order: base, preview: null, replaced: null });
    expect(openTab(base, 'f:/x', 't:a', 'f:/x', true)).toEqual({ order: base, preview: 'f:/x', replaced: null });
  });
  test('a stale preview (no longer among the tabs) is ignored', () => {
    expect(openTab(base, 'f:/y', 't:a', 'f:/gone', true)).toEqual({ order: ['t:a', 'f:/y', 'f:/x', 't:b'], preview: 'f:/y', replaced: null });
    expect(openTab(base, 'f:/y', 't:a', 'f:/gone', false).preview).toBeNull();
  });
});

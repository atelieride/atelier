import { expect, test } from 'vitest';
import { serviceMenu, toggleLine } from './log-expand';

test('a line expands and folds by its key; the others stay as they are', () => {
  const a = toggleLine(new Set(), 7);
  expect([...a]).toEqual([7]);
  const b = toggleLine(a, 9);
  expect([...b].sort()).toEqual([7, 9]);
  const c = toggleLine(b, 7);
  expect([...c]).toEqual([9]);
  // A new set each time: React sees the change.
  expect(c).not.toBe(b);
});

test('the card menu: wrap (its label says what it will do) and maximize / back to grid', () => {
  const calls: string[] = [];
  const items = serviceMenu({ wrap: false, maximized: false, toggleWrap: () => calls.push('wrap'), toggleMax: () => calls.push('max') });
  expect(items.map((i) => (i === 'sep' ? 'sep' : i.label))).toEqual(['Wrap Lines', 'Maximize']);
  for (const i of items) if (i !== 'sep') i.run();
  expect(calls).toEqual(['wrap', 'max']);
  const on = serviceMenu({ wrap: true, maximized: true, toggleWrap: () => {}, toggleMax: () => {} });
  expect(on.map((i) => (i === 'sep' ? 'sep' : i.label))).toEqual(["Don't Wrap Lines", 'Back to Grid']);
});

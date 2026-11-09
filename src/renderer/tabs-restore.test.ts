import { expect, test } from 'vitest';
import { MAX_SAVED_TABS } from '@shared/tabs-state';
import { mergeOrder, restoredActive, snapshotTabs } from './tabs-restore';

test('the saved order wins for what came back; live tabs it did not know keep their order at the end', () => {
  const current = ['t:a', 't:new', 'f:/p/opened-now.ts'] as const;
  const saved = ['f:/p/x.ts', 't:a', 't:gone', 'f:/h/y.json', 'f:/p/deleted.ts'];
  expect(mergeOrder([...current], saved, new Set(['/p/x.ts', '/h/y.json'])))
    .toEqual(['f:/p/x.ts', 't:a', 'f:/h/y.json', 't:new', 'f:/p/opened-now.ts']);
});

test('a terminal not in the strip (closed, or its tab hidden) does not come back through the saved order', () => {
  expect(mergeOrder(['t:a'], ['t:b', 't:a'], new Set())).toEqual(['t:a']);
});

test('the tab in front comes back if it is still there: a file restored, or a terminal alive', () => {
  const order = ['t:a', 'f:/p/x.ts'] as const;
  expect(restoredActive('f:/p/x.ts', [...order], new Set(['a']))).toBe('f:/p/x.ts');
  expect(restoredActive('t:a', [...order], new Set(['a']))).toBe('t:a');
  expect(restoredActive('t:gone', [...order], new Set(['a']))).toBeNull();
  expect(restoredActive('f:/p/deleted.ts', [...order], new Set(['a']))).toBeNull();
  expect(restoredActive(null, [...order], new Set(['a']))).toBeNull();
});

test('a terminal in front with its tab hidden still comes back (alive is enough)', () => {
  expect(restoredActive('t:h', ['t:a'], new Set(['a', 'h']))).toBe('t:h');
});

test(`the snapshot keeps the first ${MAX_SAVED_TABS} files (main refuses more), and the tab in front even past them`, () => {
  const files = Array.from({ length: MAX_SAVED_TABS + 3 }, (_, i) => `f:/p/${i}.ts` as const);
  const last = files.at(-1)!;
  const s = snapshotTabs(['t:a', ...files], last);
  expect(s.files).toHaveLength(MAX_SAVED_TABS);
  expect(s.files).toContain('/p/0.ts');
  expect(s.files).toContain(last.slice(2));
  expect(s.order.filter((k) => k.startsWith('f:'))).toHaveLength(MAX_SAVED_TABS);
  expect(s.active).toBe(last);
});

test('the snapshot: file tabs in strip order (no untitled ones), terminals, the key in front', () => {
  const s = snapshotTabs(['t:a', 'f:/p/x.ts', 'f:untitled:1', 'services', 'f:/h/y.json', 'rev:abc:r.ts'], 'f:/h/y.json');
  expect(s).toEqual({ files: ['/p/x.ts', '/h/y.json'], order: ['t:a', 'f:/p/x.ts', 'f:/h/y.json'], active: 'f:/h/y.json' });
  expect(snapshotTabs(['t:a'], 'services').active).toBeNull();
  expect(snapshotTabs(['f:untitled:1'], 'f:untitled:1')).toEqual({ files: [], order: [], active: null });
});

test('the Databases space\'s tab in front is saved beside Sessions\', only when given and a table', () => {
  const orders = 'db:c0123456789ab/public/orders' as const;
  expect(snapshotTabs(['t:a', orders], 't:a', [], orders)).toEqual({ files: [], order: ['t:a', orders], active: 't:a', dbActive: orders });
  expect(snapshotTabs(['t:a', orders], 't:a')).toEqual({ files: [], order: ['t:a', orders], active: 't:a' });
  expect(snapshotTabs(['t:a'], 't:a', [], 't:a')).toEqual({ files: [], order: ['t:a'], active: 't:a' });
});

test('table tabs: saved by key in strip order, in front too; a malformed key never', () => {
  const s = snapshotTabs(['t:a', 'db:c0123456789ab/public/orders', 'f:/p/x.ts', 'db:c0123456789ab', 'db:nope'], 'db:c0123456789ab/public/orders');
  expect(s).toEqual({ files: ['/p/x.ts'], order: ['t:a', 'db:c0123456789ab/public/orders', 'f:/p/x.ts', 'db:c0123456789ab'], active: 'db:c0123456789ab/public/orders' });
  expect(snapshotTabs(['db:nope'], 'db:nope')).toEqual({ files: [], order: [], active: null });
});

test('table tabs restored to the strip (the store added them) take their saved place; others not open don\'t come back', () => {
  expect(mergeOrder(['t:a', 'db:c0123456789ab/public/orders', 't:new'], ['db:c0123456789ab/public/orders', 't:a', 'db:c0123456789ab/public/gone'], new Set()))
    .toEqual(['db:c0123456789ab/public/orders', 't:a', 't:new']);
});

test('the snapshot carries the Shelf\'s outside files (main keeps them granted across launches); none, no field', () => {
  expect(snapshotTabs(['t:a'], null, ['/h/x.sql'])).toEqual({ files: [], order: ['t:a'], active: null, shelf: ['/h/x.sql'] });
  expect(snapshotTabs(['t:a'], null, [])).toEqual({ files: [], order: ['t:a'], active: null });
});

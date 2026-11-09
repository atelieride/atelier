import { expect, test } from 'vitest';
import { MAX_DB_TAB_KEY, MAX_SAVED_TABS, isDbTabKey, parseSavedTabs } from './tabs-state';

test('a saved tab state is read field by field: absolute files, f:/t: keys, an active key among them', () => {
  expect(parseSavedTabs({ files: ['/p/a.ts', '/h/x.json'], order: ['t:abc', 'f:/p/a.ts', 'f:/h/x.json'], active: 'f:/h/x.json' }))
    .toEqual({ files: ['/p/a.ts', '/h/x.json'], order: ['t:abc', 'f:/p/a.ts', 'f:/h/x.json'], active: 'f:/h/x.json' });
});

test('junk is dropped, not the whole state', () => {
  expect(parseSavedTabs({ files: ['/p/a.ts', 'rel.ts', 3, '/p/a.ts'], order: ['f:/p/a.ts', 'f:/p/b.ts', 'rev:x', 't:', 't:bad id', 7, 'services'], active: 'services' }))
    .toEqual({ files: ['/p/a.ts'], order: ['f:/p/a.ts'], active: null });
  expect(parseSavedTabs({ files: [], order: [], active: 't:zzz' })).toEqual({ files: [], order: [], active: 't:zzz' });
});

test('the Shelf\'s outside files: absolute, once, bounded; absent when none were saved', () => {
  expect(parseSavedTabs({ files: [], order: [], active: null, shelf: ['/h/x.sql', 'rel', 3, '/h/x.sql', '/h/y.png'] }))
    .toEqual({ files: [], order: [], active: null, shelf: ['/h/x.sql', '/h/y.png'] });
  expect(parseSavedTabs({ files: [], order: [], active: null, shelf: 'x' })).toEqual({ files: [], order: [], active: null });
  expect(parseSavedTabs({ files: [], order: [], active: null, shelf: Array.from({ length: 80 }, (_, i) => `/h/${i}`) })!.shelf).toHaveLength(50);
});

test('not an object, or no arrays: nothing to restore', () => {
  expect(parseSavedTabs(null)).toBeNull();
  expect(parseSavedTabs('x')).toBeNull();
  expect(parseSavedTabs({ files: 'a', order: [] })).toBeNull();
});

test('table tabs: their db: keys are kept in the order, a malformed one is dropped', () => {
  const ok = ['db:c0123456789ab/public/orders', 'db:c0123456789ab/sales/Order%20%22Items%22', 'db:c0123456789ab/public/a%2Fb', 'db:c0123456789ab/public/%C3%BC', 'db:c0123456789ab'];
  const bad = ['db:', 'db:c0123456789ab/', 'db:c0123456789ab/public', 'db:c0123456789ab/public/', 'db:c0123456789ab/public/a/b', 'db:x0123456789ab/public/orders',
    'db:c0123456789AB/public/orders', 'db:c0123456789ab/pub lic/orders', 'db:c0123456789ab/public/%zz', 'db:c0123456789ab/public/%c3%bc', `db:c0123456789ab/public/${'x'.repeat(300)}`];
  expect(parseSavedTabs({ files: [], order: ['t:a', ...ok, ...bad], active: 'db:c0123456789ab/public/orders' }))
    .toEqual({ files: [], order: ['t:a', ...ok], active: 'db:c0123456789ab/public/orders' });
  // In front but not in the order (a malformed one): not kept.
  expect(parseSavedTabs({ files: [], order: [], active: 'db:c0123456789ab/public/orders' })!.active).toBeNull();
  for (const k of ok) expect(isDbTabKey(k), k).toBe(true);
  for (const k of bad) expect(isDbTabKey(k), k).toBe(false);
  // At most 300 characters.
  const at = `db:c0123456789ab/s/${'x'.repeat(MAX_DB_TAB_KEY - 'db:c0123456789ab/s/'.length)}`;
  expect(at).toHaveLength(MAX_DB_TAB_KEY);
  expect(isDbTabKey(at)).toBe(true);
  expect(isDbTabKey(`${at}x`)).toBe(false);
});

test('the Databases space\'s tab in front: a table of the order, else none', () => {
  const orders = 'db:c0123456789ab/public/orders';
  expect(parseSavedTabs({ files: [], order: ['t:a', orders], active: 't:a', dbActive: orders })).toEqual({ files: [], order: ['t:a', orders], active: 't:a', dbActive: orders });
  // Not a table, not in the order, junk: none (absent, as an older file has none).
  for (const dbActive of ['t:a', 'db:c0123456789ab/public/gone', 7, null]) expect(parseSavedTabs({ files: [], order: ['t:a', orders], active: null, dbActive })).toEqual({ files: [], order: ['t:a', orders], active: null });
});

test(`at most ${MAX_SAVED_TABS} files, paths up to 4096 bytes`, () => {
  const files = Array.from({ length: MAX_SAVED_TABS + 10 }, (_, i) => `/p/${i}`);
  expect(parseSavedTabs({ files, order: [], active: null })!.files).toHaveLength(MAX_SAVED_TABS);
  expect(parseSavedTabs({ files: ['/' + 'x'.repeat(5000)], order: [], active: null })!.files).toEqual([]);
});

import { expect, test } from 'vitest';
import { MAX_SHELF, MAX_SHELF_PROJECTS, missingIn, nudgeInShelf, outsideOf, shelfDirs, ungranted, parseShelf, placeInShelf, removeFromShelf, shelfIndexAt, shelvable, touchesShelf, withProjectShelf } from './shelf';

const f = (rel: string) => ({ path: `/p/${rel}`, rel });

test('saved shelves: missing, broken or wrong values give empty shelves; bad items are dropped, duplicates once', () => {
  expect(parseShelf(null)).toEqual({});
  expect(parseShelf('broken')).toEqual({});
  expect(parseShelf('[1]')).toEqual({});
  expect(parseShelf(JSON.stringify({ '/p': 'a', '/q': [1, null, { path: '' }, { path: '/q/a', rel: 'a' }, { path: '/q/a', rel: 'a' }, { path: '/q/b' }, { path: 'rel', rel: 'rel' }] })))
    .toEqual({ '/q': [{ path: '/q/a', rel: 'a' }] });
});

test('a project shelf replaces the old one and becomes the most recent; an empty one removes the project', () => {
  const all = { '/a': [f('x')], '/b': [f('y')] };
  expect(Object.keys(withProjectShelf(all, '/a', [f('z')]))).toEqual(['/b', '/a']);
  expect(withProjectShelf(all, '/a', [])).toEqual({ '/b': [f('y')] });
  const many = Object.fromEntries(Array.from({ length: MAX_SHELF_PROJECTS }, (_, i) => [`/r${i}`, [f('x')]]));
  const next = withProjectShelf(many, '/new', [f('x')]);
  expect(Object.keys(next)).toHaveLength(MAX_SHELF_PROJECTS);
  expect(next['/r0']).toBeUndefined();
  expect(next['/new']).toEqual([f('x')]);
});

test('placing a file: at the end or before another; one already there moves; never twice; capped', () => {
  const s = [f('a'), f('b'), f('c')];
  expect(placeInShelf(s, f('d'), null).map((x) => x.rel)).toEqual(['a', 'b', 'c', 'd']);
  expect(placeInShelf(s, f('d'), '/p/b').map((x) => x.rel)).toEqual(['a', 'd', 'b', 'c']);
  expect(placeInShelf(s, f('c'), '/p/a').map((x) => x.rel)).toEqual(['c', 'a', 'b']);
  expect(placeInShelf(s, f('a'), null).map((x) => x.rel)).toEqual(['b', 'c', 'a']);
  // Before itself, or before a file no longer there: it stays / goes last.
  expect(placeInShelf(s, f('b'), '/p/b').map((x) => x.rel)).toEqual(['a', 'b', 'c']);
  expect(placeInShelf(s, f('d'), '/p/gone').map((x) => x.rel)).toEqual(['a', 'b', 'c', 'd']);
  // The newest rel wins (a file renamed meanwhile).
  expect(placeInShelf([{ path: '/p/a', rel: 'old' }], f('a'), null)).toEqual([f('a')]);
  const full = Array.from({ length: MAX_SHELF }, (_, i) => f(`f${i}`));
  const placed = placeInShelf(full, f('new'), null);
  expect(placed).toHaveLength(MAX_SHELF);
  expect(placed.at(-1)!.rel).toBe('new');
  expect(placed[0]!.rel).toBe('f1');
  // Placed first on a full shelf: it stays; the oldest other file gives way.
  const top = placeInShelf(full, f('top'), full[0]!.path);
  expect(top).toHaveLength(MAX_SHELF);
  expect(top[0]!.rel).toBe('top');
  expect(top.map((x) => x.rel)).not.toContain('f0');
  // Moving a file within a full shelf drops nothing.
  expect(placeInShelf(full, full[5]!, full[0]!.path).map((x) => x.rel).sort()).toEqual(full.map((x) => x.rel).sort());
});

test('moving a file one place up or down; nothing past the ends', () => {
  const s = [f('a'), f('b'), f('c')];
  expect(nudgeInShelf(s, '/p/b', -1).map((x) => x.rel)).toEqual(['b', 'a', 'c']);
  expect(nudgeInShelf(s, '/p/b', 1).map((x) => x.rel)).toEqual(['a', 'c', 'b']);
  expect(nudgeInShelf(s, '/p/a', -1)).toBe(s);
  expect(nudgeInShelf(s, '/p/c', 1)).toBe(s);
  expect(nudgeInShelf(s, '/p/zz', 1)).toBe(s);
});

test('a disk change concerns the shelf when it names a shelved file or a folder holding one', () => {
  const s = [f('src/a.ts'), f('b.md')];
  expect(touchesShelf(s, ['/p/src/a.ts'])).toBe(true);
  expect(touchesShelf(s, ['/p/src'])).toBe(true);
  expect(touchesShelf(s, ['/p/other.ts', '/p/srcx/a.ts'])).toBe(false);
  expect(touchesShelf([], ['/p/a'])).toBe(false);
});

test('removing a file', () => {
  expect(removeFromShelf([f('a'), f('b')], '/p/a')).toEqual([f('b')]);
  expect(removeFromShelf([f('a')], '/p/zz')).toEqual([f('a')]);
});

test('any real file can be shelved, inside the project or outside it; never an untitled tab or the project itself', () => {
  expect(shelvable('/p/src/a.ts', '/p')).toBe(true);
  expect(shelvable('/p/src/a.ts', '/p/')).toBe(true);
  expect(shelvable('/elsewhere/dump.sql', '/p')).toBe(true);
  expect(shelvable('/p', '/p')).toBe(false);
  expect(shelvable('/p/', '/p')).toBe(false);
  expect(shelvable('untitled:Untitled-1', '/p')).toBe(false);
  expect(shelvable('rel/a.ts', '/p')).toBe(false);
  expect(shelvable('/p/a.ts', null)).toBe(false);
});

test('the outside files of a shelf (saved by main to stay granted), and those main did not grant again', () => {
  const s = [f('a.ts'), { path: '/h/dump.sql', rel: '~/dump.sql' }, { path: '/h/x.png', rel: '~/x.png' }];
  expect(outsideOf(s, '/p')).toEqual(['/h/dump.sql', '/h/x.png']);
  expect(outsideOf(s, null)).toEqual([]);
  expect([...ungranted(s, '/p', ['/h/x.png'])]).toEqual(['/h/dump.sql']);
  expect([...ungranted(s, '/p', null)]).toEqual(['/h/dump.sql', '/h/x.png']);
});

test('where a drop lands among the rows: before the first row whose middle is below the pointer, else last', () => {
  const rows = [{ path: '/p/a', top: 100, height: 32 }, { path: '/p/b', top: 134, height: 32 }];
  expect(shelfIndexAt(rows, 90)).toBe('/p/a');
  expect(shelfIndexAt(rows, 115)).toBe('/p/a');
  expect(shelfIndexAt(rows, 117)).toBe('/p/b');
  expect(shelfIndexAt(rows, 160)).toBe(null);
  expect(shelfIndexAt([], 10)).toBe(null);
});

test('the folders listed for the missing check: the project\'s only (an outside folder is never listed)', () => {
  expect(shelfDirs([f('src/a.ts'), f('src/b.ts'), f('c.md'), { path: '/h/dump.sql', rel: '~/dump.sql' }], '/p')).toEqual(['/p/src', '/p']);
});

test('missing files: listed folders that lack the name; folders not listed (or not read) say nothing', () => {
  const items = [f('src/a.ts'), f('src/b.ts'), f('gone/c.ts'), f('top.md'), f('other/d.ts')];
  const listings = new Map<string, string[] | null>([['/p/src', ['a.ts', 'z.ts']], ['/p/gone', []], ['/p', ['top.md']], ['/p/other', null]]);
  expect([...missingIn(items, listings)]).toEqual(['/p/src/b.ts', '/p/gone/c.ts']);
});

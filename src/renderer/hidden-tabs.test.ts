import { afterEach, expect, test } from 'vitest';
import { hideIds, loadHidden, saveHidden, showId } from './hidden-tabs';

const g = globalThis as { localStorage?: unknown };
const prev = g.localStorage;
afterEach(() => { g.localStorage = prev; });

test('hiding adds ids once, in order; showing removes one', () => {
  expect(hideIds([], ['a'])).toEqual(['a']);
  expect(hideIds(['a'], ['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  expect(showId(['a', 'b'], 'a')).toEqual(['b']);
  const same = ['a'];
  expect(showId(same, 'zz')).toBe(same);
});

test('saved per project, other projects kept; missing, broken or throwing storage gives none', () => {
  const saved = new Map<string, string>([['atelier.hiddenTabs', JSON.stringify({ '/q': ['x'] })]]);
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  saveHidden('/p', ['a', 'b']);
  expect(loadHidden('/p')).toEqual(['a', 'b']);
  expect(loadHidden('/q')).toEqual(['x']);
  saveHidden('/p', []);
  expect(JSON.parse(saved.get('atelier.hiddenTabs')!)).toEqual({ '/q': ['x'] });
  saved.set('atelier.hiddenTabs', 'broken');
  expect(loadHidden('/p')).toEqual([]);
  g.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(loadHidden('/p')).toEqual([]);
  expect(() => saveHidden('/p', ['a'])).not.toThrow();
});

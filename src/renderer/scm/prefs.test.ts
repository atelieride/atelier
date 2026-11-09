import { beforeEach, expect, test } from 'vitest';
import { loadScmPrefs, parseScmPrefs, saveScmPrefs } from './prefs';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
});

test('round trip per project, patches merge', () => {
  saveScmPrefs('/p', { repo: '/p/apps/web', collapsed: ['tags'] });
  saveScmPrefs('/p', { firstParent: true, detailHeight: 320 });
  saveScmPrefs('/q', { repo: '/q' });
  expect(loadScmPrefs('/p')).toEqual({ repo: '/p/apps/web', collapsed: ['tags'], firstParent: true, detailHeight: 320 });
  expect(loadScmPrefs('/q')).toEqual({ repo: '/q' });
  expect(loadScmPrefs('/none')).toEqual({});
});

test('a saved scope comes back only when it is well formed', () => {
  saveScmPrefs('/p', { scope: { repo: '/p', scope: { kind: 'refs', refs: 'refs/heads/main', firstParent: false } } });
  expect(loadScmPrefs('/p').scope).toEqual({ repo: '/p', scope: { kind: 'refs', refs: 'refs/heads/main', firstParent: false } });
  store.set('atelier.scm', JSON.stringify({ '/p': { scope: { repo: '/p', scope: { kind: 'refs', refs: '--all', firstParent: 1 } } } }));
  expect(loadScmPrefs('/p').scope).toBeUndefined();
});

test('garbage is ignored, field by field', () => {
  expect(parseScmPrefs('not json')).toEqual({});
  expect(parseScmPrefs(JSON.stringify({ '/p': { repo: 5, collapsed: ['a', 3], firstParent: 'yes', detailHeight: -4 } }))).toEqual({ '/p': { collapsed: ['a'] } });
  expect(parseScmPrefs(JSON.stringify([1]))).toEqual({});
});

test('at most 50 projects, the least recently saved forgotten', () => {
  for (let i = 0; i < 55; i++) saveScmPrefs(`/p${i}`, { repo: `/p${i}` });
  expect(loadScmPrefs('/p0')).toEqual({});
  expect(loadScmPrefs('/p54')).toEqual({ repo: '/p54' });
});

test('the All Repositories view and its folds: kept when well formed, capped', () => {
  saveScmPrefs('/p', { view: 'all', folds: { '/p/api': true, '/p/api/.wt/x': false } });
  expect(loadScmPrefs('/p')).toMatchObject({ view: 'all', folds: { '/p/api': true, '/p/api/.wt/x': false } });
  store.set('atelier.scm', JSON.stringify({ '/p': { view: 'x', folds: { 'rel/path': true, '/p/a': 'yes', '/p/b': false } } }));
  expect(loadScmPrefs('/p')).toEqual({ folds: { '/p/b': false } });
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`/p/r${i}`, true]));
  store.set('atelier.scm', JSON.stringify({ '/p': { folds: many } }));
  const kept = Object.keys(loadScmPrefs('/p').folds ?? {});
  // The newest ones (a fold saved last is the one just made).
  expect([kept.length, kept[0], kept.at(-1)]).toEqual([200, '/p/r50', '/p/r249']);
});

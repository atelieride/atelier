import { afterEach, expect, test } from 'vitest';
import { MAX_LANG_OVERRIDES, dropOverrides, effectiveLanguage, loadOverrides, parseOverrides, renameOverrides, saveOverrides, withOverride, type LangOverrides } from './lang-overrides';

const g = globalThis as { localStorage?: unknown };
afterEach(() => { delete g.localStorage; });

test('the chosen language wins over the extension; none: the extension decides', () => {
  expect(effectiveLanguage('/p/a.txt', {})).toBeNull();
  expect(effectiveLanguage('/p/a.txt', { '/p/a.txt': 'json' })).toBe('json');
  expect(effectiveLanguage('/p/a.md', {})).toBe('markdown');
  expect(effectiveLanguage('untitled:1', { 'untitled:1': 'markdown' })).toBe('markdown');
});

test('saved overrides are checked: only absolute paths and known languages survive', () => {
  expect(parseOverrides(null)).toEqual({});
  expect(parseOverrides('not json')).toEqual({});
  expect(parseOverrides('[1,2]')).toEqual({});
  expect(parseOverrides(JSON.stringify({ '/p/a.txt': 'json', 'untitled:1': 'markdown', '/p/b': 'cobol', '/p/c': 3, rel: 'yaml' }))).toEqual({ '/p/a.txt': 'json' });
});

test('setting moves the path to the newest end and keeps at most MAX entries; null (Auto) removes it', () => {
  let all = withOverride({}, '/p/a', 'json');
  all = withOverride(all, '/p/b', 'yaml');
  all = withOverride(all, '/p/a', 'markdown');
  expect(Object.entries(all)).toEqual([['/p/b', 'yaml'], ['/p/a', 'markdown']]);
  expect(withOverride(all, '/p/a', null)).toEqual({ '/p/b': 'yaml' });
  for (let i = 0; i < MAX_LANG_OVERRIDES + 5; i++) all = withOverride(all, `/p/f${i}`, 'json');
  expect(Object.keys(all)).toHaveLength(MAX_LANG_OVERRIDES);
  expect(all['/p/a']).toBeUndefined();
  expect(all[`/p/f${MAX_LANG_OVERRIDES + 4}`]).toBe('json');
});

test('overrides follow a renamed file or folder, and go with what is trashed', () => {
  const all: LangOverrides = { '/p/src/a.txt': 'json', '/p/src/sub/b': 'yaml', '/p/srcx/c': 'markdown', '/p/d': 'toml' };
  expect(renameOverrides(all, '/p/src', '/p/lib')).toEqual({ '/p/lib/a.txt': 'json', '/p/lib/sub/b': 'yaml', '/p/srcx/c': 'markdown', '/p/d': 'toml' });
  expect(renameOverrides(all, '/p/d', '/p/e')).toEqual({ '/p/src/a.txt': 'json', '/p/src/sub/b': 'yaml', '/p/srcx/c': 'markdown', '/p/e': 'toml' });
  expect(renameOverrides(all, '/p/none', '/p/x')).toBe(all);
  expect(dropOverrides(all, '/p/src')).toEqual({ '/p/srcx/c': 'markdown', '/p/d': 'toml' });
  expect(dropOverrides(all, '/p/none')).toBe(all);
});

test('storage: untitled tabs are never saved; missing or full storage never throws', () => {
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  saveOverrides({ '/p/a.txt': 'json', 'untitled:1': 'markdown' });
  expect(loadOverrides()).toEqual({ '/p/a.txt': 'json' });
  g.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
  expect(loadOverrides()).toEqual({});
  expect(() => saveOverrides({ '/p/a.txt': 'json' })).not.toThrow();
  delete g.localStorage;
  expect(loadOverrides()).toEqual({});
  expect(() => saveOverrides({})).not.toThrow();
});

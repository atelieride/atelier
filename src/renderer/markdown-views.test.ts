import { afterEach, expect, test } from 'vitest';
import { MAX_MD_VIEWS, dropMdViews, isMarkdownTab, loadMdViews, mdViewOf, parseMdViews, renameMdViews, saveMdViews, toggledView, withMdView } from './markdown-views';

const g = globalThis as { localStorage?: unknown };
afterEach(() => { delete g.localStorage; });

test('a Markdown tab is one whose effective language is Markdown (extension or Change Language Mode)', () => {
  expect(isMarkdownTab('/p/a.md', {})).toBe(true);
  expect(isMarkdownTab('/p/a.markdown', {})).toBe(true);
  expect(isMarkdownTab('/p/a.txt', {})).toBe(false);
  expect(isMarkdownTab('/p/a.txt', { '/p/a.txt': 'markdown' })).toBe(true);
  expect(isMarkdownTab('/p/a.md', { '/p/a.md': 'json' })).toBe(false);
  expect(isMarkdownTab('untitled:1', { 'untitled:1': 'markdown' })).toBe(true);
});

test('saved views are checked: absolute paths and known views only', () => {
  expect(parseMdViews(null)).toEqual({});
  expect(parseMdViews('nope')).toEqual({});
  expect(parseMdViews('[1]')).toEqual({});
  expect(parseMdViews(JSON.stringify({ '/p/a.md': 'preview', '/p/b.md': 'split', '/p/c.md': 'source', '/p/d.md': 'wide', rel: 'preview', 'untitled:1': 'preview' })))
    .toEqual({ '/p/a.md': 'preview', '/p/b.md': 'split', '/p/c.md': 'source' });
});

test('without an entry a file opens in the default view; choosing the default removes the entry', () => {
  expect(mdViewOf({}, '/p/a.md', 'source')).toBe('source');
  expect(mdViewOf({}, '/p/a.md', 'preview')).toBe('preview');
  let all = withMdView({}, '/p/a.md', 'preview', 'source');
  expect(all).toEqual({ '/p/a.md': 'preview' });
  expect(mdViewOf(all, '/p/a.md', 'source')).toBe('preview');
  all = withMdView(all, '/p/a.md', 'source', 'source');
  expect(all).toEqual({});
  // Against a Preview default, Source is a choice worth remembering.
  expect(withMdView({}, '/p/a.md', 'source', 'preview')).toEqual({ '/p/a.md': 'source' });
});

test('the newest choice moves to the end and at most MAX entries are kept', () => {
  let all = withMdView({}, '/p/a.md', 'split', 'source');
  all = withMdView(all, '/p/b.md', 'preview', 'source');
  all = withMdView(all, '/p/a.md', 'preview', 'source');
  expect(Object.keys(all)).toEqual(['/p/b.md', '/p/a.md']);
  for (let i = 0; i < MAX_MD_VIEWS + 3; i++) all = withMdView(all, `/p/f${i}.md`, 'preview', 'source');
  expect(Object.keys(all)).toHaveLength(MAX_MD_VIEWS);
  expect(all['/p/b.md']).toBeUndefined();
});

test('renames and the Trash carry the views along', () => {
  const all = { '/p/docs/a.md': 'preview', '/p/docs/sub/b.md': 'split', '/p/c.md': 'preview' } as const;
  expect(renameMdViews(all, '/p/docs', '/p/notes')).toEqual({ '/p/notes/a.md': 'preview', '/p/notes/sub/b.md': 'split', '/p/c.md': 'preview' });
  expect(dropMdViews(all, '/p/docs')).toEqual({ '/p/c.md': 'preview' });
  expect(renameMdViews(all, '/p/x', '/p/y')).toBe(all);
});

test('⇧⌘V: Preview goes back to Source, Source and Split go to Preview', () => {
  expect(toggledView('preview')).toBe('source');
  expect(toggledView('source')).toBe('preview');
  expect(toggledView('split')).toBe('preview');
});

test('saved in localStorage (real files only); unreadable storage means no saved views', () => {
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  saveMdViews({ '/p/a.md': 'preview', 'untitled:2': 'split' });
  expect(loadMdViews()).toEqual({ '/p/a.md': 'preview' });
  g.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(loadMdViews()).toEqual({});
  expect(() => saveMdViews({ '/p/a.md': 'preview' })).not.toThrow();
});

import { afterEach, beforeEach, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from './store';
import { answerUnsaved } from './confirms/answer-for-tests';

const store = new Map<string, string>();
let answering: ReturnType<typeof answerUnsaved>;
const g = globalThis as { localStorage?: unknown; window?: unknown };
beforeEach(() => {
  store.clear();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  g.window = { atelier: { terminals: { close: async () => {} } } };
  answering = answerUnsaved(() => 'discard');
  useApp.setState({ openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], dirty: {}, preview: null, recentFiles: [], comments: [], commentDraft: null,
    settings: DEFAULT_SETTINGS, mdViews: {}, langOverrides: {}, project: { root: '/p', realRoot: '/p', name: 'p' } });
});
afterEach(() => { answering.stop(); delete g.localStorage; delete g.window; });

const st = () => useApp.getState();
const saved = () => JSON.parse(store.get('atelier.markdownViews') ?? '{}') as Record<string, string>;

test('the view of a Markdown file: the default until chosen, remembered (and saved) per file', () => {
  expect(st().mdViewOf('/p/a.md')).toBe('source');
  st().setMdView('/p/a.md', 'preview');
  expect(st().mdViewOf('/p/a.md')).toBe('preview');
  expect(saved()).toEqual({ '/p/a.md': 'preview' });
  // The Settings default only matters for files without a choice.
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, markdownView: 'preview' } });
  expect(st().mdViewOf('/p/b.md')).toBe('preview');
  st().setMdView('/p/a.md', 'preview');
  expect(saved()).toEqual({});
});

test('a JSON file: its default comes from "Open JSON files in"; Tree is stored as preview', () => {
  expect(st().mdViewOf('/p/a.json')).toBe('source');
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, jsonView: 'tree' } });
  expect(st().mdViewOf('/p/a.json')).toBe('preview');
  expect(st().mdViewOf('/p/a.md')).toBe('source');
  st().setMdView('/p/a.json', 'source');
  expect(saved()).toEqual({ '/p/a.json': 'source' });
  st().setMdView('/p/a.json', 'preview');
  expect(saved()).toEqual({});
  // A tab set to JSON with Change Language Mode follows the JSON default.
  useApp.setState({ langOverrides: { '/p/data.txt': 'jsonc' } });
  expect(st().mdViewOf('/p/data.txt')).toBe('preview');
});

test('a CSV file: its default comes from "Open CSV files in"; Table is stored as preview', () => {
  expect(st().mdViewOf('/p/orders.csv')).toBe('source');
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, csvView: 'table' } });
  expect(st().mdViewOf('/p/orders.csv')).toBe('preview');
  expect(st().mdViewOf('/p/export.tsv')).toBe('preview');
  expect(st().mdViewOf('/p/a.json')).toBe('source');
  st().setMdView('/p/orders.csv', 'source');
  expect(saved()).toEqual({ '/p/orders.csv': 'source' });
  useApp.setState({ langOverrides: { '/p/data.txt': 'csv' } });
  expect(st().mdViewOf('/p/data.txt')).toBe('preview');
});

test('Split or Preview on a tab showing the Diff view goes back to Margin first', () => {
  st().openFile('/p/a.md', 'a.md', null, 'diff');
  st().setMdView('/p/a.md', 'split');
  expect(st().openFiles[0]!.mode).toBe('margin');
  st().setFileMode('/p/a.md', 'diff');
  st().setMdView('/p/a.md', 'source');
  expect(st().openFiles[0]!.mode).toBe('diff');
});

test('renames and the Trash carry the views along', () => {
  st().setMdView('/p/docs/a.md', 'preview');
  st().renameOpenFiles('/p/docs', '/p/notes', '/p');
  expect(st().mdViews).toEqual({ '/p/notes/a.md': 'preview' });
  st().dropOpenFiles('/p/notes');
  expect(st().mdViews).toEqual({});
});

test('a new untitled tab forgets the view an earlier tab with its number had', () => {
  st().newUntitled();
  st().setMdView('untitled:1', 'preview');
  st().closeTab('untitled:1');
  st().newUntitled();
  expect(st().mdViewOf('untitled:1')).toBe('source');
  // Untitled tabs are not saved.
  st().setMdView('untitled:1', 'split');
  expect(saved()).toEqual({});
});

test('a CSV file\'s parse options: set per file, saved, following renames and the Trash', () => {
  useApp.setState({ csvOptions: {} });
  const opts = () => JSON.parse(store.get('atelier.csvOptions') ?? '{}') as Record<string, unknown>;
  st().setCsvOptions('/p/data/a.csv', { delimiter: ';', header: 'auto', decimal: ',', skip: 0 });
  expect(st().csvOptions['/p/data/a.csv']).toMatchObject({ delimiter: ';', decimal: ',' });
  expect(Object.keys(opts())).toEqual(['/p/data/a.csv']);
  st().renameOpenFiles('/p/data', '/p/exports', '/p');
  expect(Object.keys(st().csvOptions)).toEqual(['/p/exports/a.csv']);
  st().dropOpenFiles('/p/exports');
  expect(st().csvOptions).toEqual({});
  expect(opts()).toEqual({});
});

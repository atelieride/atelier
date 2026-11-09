import { afterEach, beforeEach, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from './store';
import { setActivePreviewView, togglePreview } from './markdown-commands';

const g = globalThis as { localStorage?: unknown; window?: unknown };
const toasts: string[] = [];
beforeEach(() => {
  toasts.length = 0;
  g.localStorage = { getItem: () => null, setItem: () => {} };
  g.window = { atelier: {} };
  useApp.setState({ openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], dirty: {}, preview: null, recentFiles: [],
    settings: DEFAULT_SETTINGS, mdViews: {}, langOverrides: {}, project: { root: '/p', realRoot: '/p', name: 'p' },
    showToast: (m: string) => { toasts.push(m); } });
});
afterEach(() => { delete g.localStorage; delete g.window; });

const st = () => useApp.getState();

test('⇧⌘V toggles a JSON tab\'s Tree as it toggles a Markdown preview', () => {
  st().openFile('/p/a.json', 'a.json', null, 'margin');
  togglePreview();
  expect(st().mdViewOf('/p/a.json')).toBe('preview');
  togglePreview();
  expect(st().mdViewOf('/p/a.json')).toBe('source');
  setActivePreviewView('split');
  expect(st().mdViewOf('/p/a.json')).toBe('split');
  expect(toasts).toEqual([]);
});

test('⇧⌘V toggles a CSV tab\'s Table', () => {
  st().openFile('/p/orders.csv', 'orders.csv', null, 'margin');
  togglePreview();
  expect(st().mdViewOf('/p/orders.csv')).toBe('preview');
  setActivePreviewView('split');
  expect(st().mdViewOf('/p/orders.csv')).toBe('split');
  expect(toasts).toEqual([]);
});

test('another tab: a toast naming the three kinds', () => {
  st().openFile('/p/a.ts', 'a.ts', null, 'margin');
  togglePreview();
  expect(toasts).toEqual(['Not a Markdown, JSON or CSV file']);
});

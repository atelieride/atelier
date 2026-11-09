import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Comments, notes and task links have bulky shapes: their loaders are stubbed, the rest read the real fake storage.
vi.mock('./comments', async (orig) => ({ ...(await orig<typeof import('./comments')>()), loadComments: vi.fn((root: string) => [{ stub: `comments:${root}` }]) }));
vi.mock('./notes', async (orig) => ({ ...(await orig<typeof import('./notes')>()), loadNotes: vi.fn((root: string) => [{ stub: `notes:${root}` }]) }));
vi.mock('./task-links', async (orig) => ({ ...(await orig<typeof import('./task-links')>()), loadTaskLinks: vi.fn((root: string) => ({ stub: `links:${root}` })) }));

import { useApp } from './store';
import { installStorageSync, reloadFor } from './storage-sync';
import { KEY as PINS } from './pins';
import { KEY as HIDDEN } from './hidden-tabs';
import { KEY as COMMENTS } from './comments';
import { KEY as NOTES } from './notes';
import { KEY as LINKS } from './task-links';
import { KEY as MD } from './markdown-views';
import { KEY as LANG } from './lang-overrides';

const mem = new Map<string, string>();
const setItem = vi.fn((k: string, v: string) => { mem.set(k, v); });
const listeners = new Set<(e: { key: string | null; newValue: string | null }) => void>();
const fire = (key: string | null, newValue: string | null = 'x') => listeners.forEach((l) => l({ key, newValue }));
const project = { root: '/p' } as never;
let off: () => void;

beforeEach(() => {
  mem.clear();
  setItem.mockClear();
  listeners.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem });
  vi.stubGlobal('window', {
    addEventListener: (_t: string, l: never) => listeners.add(l),
    removeEventListener: (_t: string, l: never) => listeners.delete(l),
  });
  useApp.setState({ project, popout: null, pins: [], hidden: [], comments: [], notes: [], taskLinks: {}, mdViews: {}, langOverrides: {} });
  off = installStorageSync();
});
afterEach(() => { off(); vi.unstubAllGlobals(); });

test('a storage event for each per-project key reloads its slice without writing back', () => {
  mem.set(PINS, JSON.stringify({ '/p': ['a', 'b'] }));
  mem.set(HIDDEN, JSON.stringify({ '/p': ['h'] }));
  fire(PINS); fire(HIDDEN); fire(COMMENTS); fire(NOTES); fire(LINKS);
  const s = useApp.getState();
  expect(s.pins).toEqual(['a', 'b']);
  expect(s.hidden).toEqual(['h']);
  expect(s.comments).toEqual([{ stub: 'comments:/p' }]);
  expect(s.notes).toEqual([{ stub: 'notes:/p' }]);
  expect(s.taskLinks).toEqual({ stub: 'links:/p' });
  expect(setItem).not.toHaveBeenCalled();
});

test('a key removed from storage (newValue null) empties its slice', () => {
  useApp.setState({ pins: ['a'], hidden: ['h'] });
  fire(PINS, null);
  fire(HIDDEN, null);
  expect(useApp.getState().pins).toEqual([]);
  expect(useApp.getState().hidden).toEqual([]);
  expect(setItem).not.toHaveBeenCalled();
});

test('comments this window could not save (storage full) are never replaced by a reload; once saved, reloads go on', () => {
  const mine = [{ id: 'c1', mine: true }] as never;
  useApp.setState({ comments: mine });
  setItem.mockImplementation((k: string, v: string) => { if (k === COMMENTS) throw new Error('quota'); mem.set(k, v); });
  useApp.getState().updateComment('c1', {});
  fire(COMMENTS);
  expect(useApp.getState().comments).toEqual(mine);
  // Saved again: the next change elsewhere reloads.
  setItem.mockImplementation((k: string, v: string) => { mem.set(k, v); });
  useApp.getState().updateComment('c1', {});
  fire(COMMENTS);
  expect(useApp.getState().comments).toEqual([{ stub: 'comments:/p' }]);
});

test('Markdown views and language overrides are global: reloaded even without a project', () => {
  useApp.setState({ project: null });
  mem.set(MD, JSON.stringify({ '/a.md': 'preview' }));
  mem.set(LANG, JSON.stringify({ '/b.txt': 'markdown' }));
  fire(MD); fire(LANG);
  expect(useApp.getState().mdViews).toEqual({ '/a.md': 'preview' });
  expect(useApp.getState().langOverrides).toEqual({ '/b.txt': 'markdown' });
  expect(setItem).not.toHaveBeenCalled();
});

test('hidden tabs belong to the main window: ignored in pop-out mode', () => {
  useApp.setState({ popout: {} as never, hidden: ['mine'] });
  mem.set(HIDDEN, JSON.stringify({ '/p': ['other'] }));
  fire(HIDDEN);
  expect(useApp.getState().hidden).toEqual(['mine']);
  expect(reloadFor(HIDDEN)).toBeNull();
});

test('unrelated keys, a cleared storage and a missing project change nothing', () => {
  expect(reloadFor('atelier.showChanges')).toBeNull();
  fire('atelier.showChanges'); fire(null, null);
  useApp.setState({ project: null });
  mem.set(PINS, JSON.stringify({ '/p': ['a'] }));
  fire(PINS, null);
  expect(useApp.getState().pins).toEqual([]);
  expect(reloadFor(PINS)).toBeNull();
});

test('the returned function stops listening', () => {
  off();
  mem.set(PINS, JSON.stringify({ '/p': ['a'] }));
  fire(PINS);
  expect(useApp.getState().pins).toEqual([]);
});

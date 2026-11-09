import { afterEach, beforeEach, expect, test } from 'vitest';
import { useApp } from './store';
import { reloadFor } from './storage-sync';

// The Shelf in the store.

const saved = new Map<string, string>();
const prev = (globalThis as { localStorage?: unknown }).localStorage;
beforeEach(() => {
  saved.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  useApp.setState({ project: null, shelf: [], shelfCollapsed: false, popout: null });
});
afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = prev;
  useApp.setState({ project: null, shelf: [], shelfCollapsed: false });
});

const shelfRels = () => useApp.getState().shelf.map((x) => x.rel);

test('loaded per project, added at a place or moved, removed, cleared and saved', () => {
  saved.set('atelier.shelf', JSON.stringify({ '/p': [{ path: '/p/a.ts', rel: 'a.ts' }], '/q': [{ path: '/q/z.ts', rel: 'z.ts' }] }));
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  expect(shelfRels()).toEqual(['a.ts']);
  const st = useApp.getState();
  st.addToShelf('/p/b.ts', 'b.ts');
  st.addToShelf('/p/c.ts', 'c.ts', '/p/a.ts');
  expect(shelfRels()).toEqual(['c.ts', 'a.ts', 'b.ts']);
  st.addToShelf('/p/b.ts', 'b.ts', '/p/c.ts');
  expect(shelfRels()).toEqual(['b.ts', 'c.ts', 'a.ts']);
  expect(JSON.parse(saved.get('atelier.shelf')!)['/p'].map((x: { rel: string }) => x.rel)).toEqual(['b.ts', 'c.ts', 'a.ts']);
  st.removeFromShelf('/p/c.ts');
  expect(shelfRels()).toEqual(['b.ts', 'a.ts']);
  st.clearShelf();
  expect(shelfRels()).toEqual([]);
  expect(JSON.parse(saved.get('atelier.shelf')!)).toEqual({ '/q': [{ path: '/q/z.ts', rel: 'z.ts' }] });
  useApp.getState().setProject({ root: '/q', name: 'q', realRoot: '/q' });
  expect(shelfRels()).toEqual(['z.ts']);
});

test('untitled tabs are refused; an outside file is taken', () => {
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  useApp.getState().addToShelf('untitled:Untitled-1', 'Untitled-1');
  useApp.getState().addToShelf('/elsewhere/x.sql', '~/x.sql');
  expect(shelfRels()).toEqual(['~/x.sql']);
});

test('a drop on a collapsed shelf opens it; collapsing is saved for every project', () => {
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  useApp.getState().toggleShelfCollapsed();
  expect(useApp.getState().shelfCollapsed).toBe(true);
  expect(saved.get('atelier.shelfCollapsed')).toBe('1');
  useApp.getState().addToShelf('/p/a.ts', 'a.ts');
  expect(useApp.getState().shelfCollapsed).toBe(false);
  expect(saved.has('atelier.shelfCollapsed')).toBe(false);
});

test('renamed or moved in Atelier the row follows; moved to the Trash it leaves', () => {
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  const st = useApp.getState();
  st.addToShelf('/p/src/a.ts', 'src/a.ts');
  st.addToShelf('/p/b.ts', 'b.ts');
  st.addToShelf('/p/docs/c.md', 'docs/c.md');
  st.renameOpenFiles('/p/src', '/p/lib', '/p');
  st.renameOpenFiles('/p/b.ts', '/p/bb.ts', '/p');
  expect(useApp.getState().shelf).toEqual([{ path: '/p/lib/a.ts', rel: 'lib/a.ts' }, { path: '/p/bb.ts', rel: 'bb.ts' }, { path: '/p/docs/c.md', rel: 'docs/c.md' }]);
  useApp.getState().dropOpenFiles('/p/docs');
  expect(shelfRels()).toEqual(['lib/a.ts', 'bb.ts']);
  expect(JSON.parse(saved.get('atelier.shelf')!)['/p'].map((x: { rel: string }) => x.rel)).toEqual(['lib/a.ts', 'bb.ts']);
});

test('a disk change under a shelved file bumps the shelf\'s check (deleted from a terminal, Atelier focused)', () => {
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  useApp.getState().addToShelf('/p/src/a.ts', 'src/a.ts');
  const before = useApp.getState().shelfNonce;
  useApp.getState().filesChanged(['/p/other.ts']);
  expect(useApp.getState().shelfNonce).toBe(before);
  useApp.getState().filesChanged(['/p/src/a.ts']);
  expect(useApp.getState().shelfNonce).toBe(before + 1);
});

test('another window that changes the shelf is followed (storage sync)', () => {
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  saved.set('atelier.shelf', JSON.stringify({ '/p': [{ path: '/p/x.ts', rel: 'x.ts' }] }));
  expect(reloadFor('atelier.shelf')).toEqual({ shelf: [{ path: '/p/x.ts', rel: 'x.ts' }] });
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { popoutBarMenu, shelfCommand, shelfHeadMenu, shelfRowMenu, tabMenu, treeMenu } from './menus';
import type { MenuItem } from './menu-model';
import { useApp } from './store';
import type { TerminalInfo } from '@shared/protocol';

// The Shelf in the menus.

type Entry = Exclude<MenuItem, 'sep'>;
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '-' : i.id));
const item = (items: MenuItem[], id: string) => items.find((i): i is Entry => i !== 'sep' && i.id === id);
const g = globalThis as { window?: unknown; localStorage?: unknown };
const reveal = vi.fn(async (_p: string) => {});
const write = vi.fn(async (_t: string) => true);
const term: TerminalInfo = { id: 't', projectRoot: '/p', cwd: '/p', title: 't', name: null, color: '#fff', foreground: 'zsh', createdAt: 0, session: null };

beforeEach(() => {
  g.window = { atelier: { reveal, clipboard: { write } } };
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  reveal.mockClear();
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, shelf: [], shelfCollapsed: false, terminals: [term],
    openFiles: [{ path: '/p/a.ts', rel: 'a.ts', line: null, nonce: 1, mode: 'margin' }], tabOrder: ['t:t', 'f:/p/a.ts'], activeTab: '/p/a.ts', preview: null
  });
});
afterEach(() => { delete g.window; delete g.localStorage; useApp.setState({ project: null, shelf: [] }); });

test('a project file tab: Add to Shelf, then Remove from Shelf; its tab stays open', () => {
  const add = item(tabMenu('f:/p/a.ts'), 'shelf');
  expect(add?.label).toBe('Add to Shelf');
  add!.run();
  expect(useApp.getState().shelf).toEqual([{ path: '/p/a.ts', rel: 'a.ts' }]);
  expect(useApp.getState().tabOrder).toContain('f:/p/a.ts');
  const remove = item(tabMenu('f:/p/a.ts'), 'shelf');
  expect(remove?.label).toBe('Remove from Shelf');
  remove!.run();
  expect(useApp.getState().shelf).toEqual([]);
});

test('no shelf item for terminals, untitled tabs, folders, or in a pop-out', () => {
  expect(item(tabMenu('t:t'), 'shelf')).toBeUndefined();
  useApp.setState({ openFiles: [{ path: 'untitled:Untitled-1', rel: 'Untitled-1', line: null, nonce: 1, mode: 'margin' }, { path: '/elsewhere/x.ts', rel: '~/x.ts', line: null, nonce: 2, mode: 'margin' }] });
  expect(item(tabMenu('f:untitled:Untitled-1'), 'shelf')).toBeUndefined();
  // An outside file can go on the shelf too.
  expect(item(tabMenu('f:/elsewhere/x.ts'), 'shelf')?.label).toBe('Add to Shelf');
  expect(item(treeMenu({ path: '/p/src', rel: 'src', dir: true }, () => {}), 'shelf')).toBeUndefined();
  expect(ids(popoutBarMenu('f:/p/a.ts'))).not.toContain('shelf');
});

test('a file of the tree: Add to Shelf / Remove from Shelf', () => {
  const add = item(treeMenu({ path: '/p/src/b.ts', rel: 'src/b.ts', dir: false }, () => {}), 'shelf');
  expect(add?.label).toBe('Add to Shelf');
  add!.run();
  expect(useApp.getState().shelf).toEqual([{ path: '/p/src/b.ts', rel: 'src/b.ts' }]);
  expect(item(treeMenu({ path: '/p/src/b.ts', rel: 'src/b.ts', dir: false }, () => {}), 'shelf')?.label).toBe('Remove from Shelf');
});

test('a shelf row: open, to the side, the path items, remove and clear', () => {
  useApp.getState().addToShelf('/p/a.ts', 'a.ts');
  useApp.getState().addToShelf('/p/b.ts', 'b.ts');
  const open = vi.fn();
  const menu = shelfRowMenu({ path: '/p/b.ts', rel: 'b.ts' }, open);
  expect(ids(menu)).toEqual(['open', 'open-to-side', '-', 'copy-path', 'copy-rel', 'reveal-tree', 'reveal-finder', '-', 'shelf-up', 'shelf-down', '-', 'shelf-remove', 'shelf-clear']);
  item(menu, 'open')!.run();
  expect(open).toHaveBeenCalled();
  item(menu, 'reveal-finder')!.run();
  expect(reveal).toHaveBeenCalledWith('/p/b.ts');
  item(menu, 'shelf-remove')!.run();
  expect(useApp.getState().shelf.map((x) => x.rel)).toEqual(['a.ts']);
  expect(item(shelfHeadMenu(), 'shelf-clear')?.label).toBe('Clear Shelf');
  item(shelfRowMenu({ path: '/p/a.ts', rel: 'a.ts' }, open), 'shelf-clear')!.run();
  expect(useApp.getState().shelf).toEqual([]);
});

test('Clear Shelf can be undone from its toast', () => {
  useApp.setState({ toast: null });
  useApp.getState().addToShelf('/p/a.ts', 'a.ts');
  useApp.getState().addToShelf('/p/b.ts', 'b.ts');
  item(shelfHeadMenu(), 'shelf-clear')!.run();
  expect(useApp.getState().shelf).toEqual([]);
  const toast = useApp.getState().toast;
  expect(toast?.text).toBe('Shelf cleared');
  const undo = [toast?.action].flat().find((a) => a?.label === 'Undo');
  undo!.run();
  expect(useApp.getState().shelf.map((x) => x.rel)).toEqual(['a.ts', 'b.ts']);
  useApp.setState({ toast: null });
});

test('a row moves up or down from its menu (the keyboard way to reorder); none past the ends', () => {
  for (const r of ['a', 'b', 'c']) useApp.getState().addToShelf(`/p/${r}.ts`, `${r}.ts`);
  const menu = (r: string) => shelfRowMenu({ path: `/p/${r}.ts`, rel: `${r}.ts` }, () => {});
  expect(item(menu('a'), 'shelf-up')?.disabled).toBe(true);
  expect(item(menu('c'), 'shelf-down')?.disabled).toBe(true);
  item(menu('b'), 'shelf-up')!.run();
  expect(useApp.getState().shelf.map((x) => x.rel)).toEqual(['b.ts', 'a.ts', 'c.ts']);
  item(menu('b'), 'shelf-down')!.run();
  expect(useApp.getState().shelf.map((x) => x.rel)).toEqual(['a.ts', 'b.ts', 'c.ts']);
});

test('the palette: Add / Remove Current File for the project file in front; nothing for a terminal in front', () => {
  const add = shelfCommand();
  expect(add?.label).toBe('Add Current File to Shelf');
  add!.run();
  expect(useApp.getState().shelf.map((x) => x.rel)).toEqual(['a.ts']);
  const remove = shelfCommand();
  expect(remove?.label).toBe('Remove Current File from Shelf');
  remove!.run();
  expect(useApp.getState().shelf).toEqual([]);
  useApp.setState({ activeTab: 'term', selectedId: 't' });
  expect(shelfCommand()).toBeNull();
});

test('the head menu: collapse or expand (Title Case), then Clear Shelf', () => {
  expect(item(shelfHeadMenu(), 'shelf-toggle')?.label).toBe('Collapse Shelf');
  item(shelfHeadMenu(), 'shelf-toggle')!.run();
  expect(useApp.getState().shelfCollapsed).toBe(true);
  expect(item(shelfHeadMenu(), 'shelf-toggle')?.label).toBe('Expand Shelf');
  useApp.getState().toggleShelfCollapsed();
});

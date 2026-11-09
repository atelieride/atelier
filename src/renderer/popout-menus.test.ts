import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { popoutBarMenu } from './menus';
import type { MenuItem } from './menu-model';
import { useApp } from './store';
import type { TerminalInfo } from '@shared/protocol';

// Tab pop-out windows: the pop-out's bar has a context menu (right-click, Shift+F10) — Move Back,
// then its tab's own items that make sense in a window of its own; nothing about the strip or panes it isn't in.
const term = (id: string): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 1, session: null });
type Entry = Exclude<MenuItem, 'sep'>;
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '-' : i.id));
const item = (items: MenuItem[], id: string) => items.find((i): i is Entry => i !== 'sep' && i.id === id);
const dock = vi.fn(async (_r: unknown) => {});
const reveal = vi.fn(async (_p: string) => {});
const g = globalThis as { window?: unknown };
const st = () => useApp.getState();
const STRIP_ONLY = ['open-to-side', 'move-window', 'unsplit', 'close', 'close-others', 'close-right', 'close-files', 'close-all'];

beforeEach(() => {
  g.window = { addEventListener: () => {}, atelier: { popout: { dock }, reveal, terminals: { close: async () => {} } } };
  dock.mockClear(); reveal.mockClear();
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, terminals: [], openFiles: [], tabOrder: [], preview: null });
});
afterEach(() => { delete g.window; });

test('a file pop-out: Move Back first, then Copy Path, Reveal in Finder… — no strip, pane or Files-tree items', () => {
  st().enterPopout({ key: 'f:/p/src/a.ts', payload: { kind: 'file', rel: 'src/a.ts', mode: 'margin' } });
  const menu = popoutBarMenu('f:/p/src/a.ts');
  // No Reveal in Files: a pop-out has no Files tree.
  expect(ids(menu)).toEqual(['move-back', '-', 'copy-path', 'copy-rel', 'reveal-finder']);
  const back = item(menu, 'move-back')!;
  expect(back.label).toBe('Move Back to Main Window');
  expect(back.hint).toBe('⌘W');
  back.run();
  expect(dock).toHaveBeenCalledTimes(1);
  item(menu, 'reveal-finder')!.run();
  expect(reveal).toHaveBeenCalledWith('/p/src/a.ts');
});

test('a session pop-out: its items, Rename in its bar, its real close; never a separator at an end or twice', () => {
  const session = { ...term('a'), session: { sessionId: 's', state: 'done', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } } as TerminalInfo;
  st().enterPopout({ key: 't:a' });
  st().setTerminals([session]);
  const menu = popoutBarMenu('t:a');
  expect(ids(menu)[0]).toBe('move-back');
  expect(ids(menu)).toContain('close-terminal');
  expect(ids(menu)).toContain('session-panel');
  for (const id of [...STRIP_ONLY, 'changes']) expect(ids(menu)).not.toContain(id);
  expect(menu.at(-1)).not.toBe('sep');
  expect(ids(menu).join(',')).not.toContain('-,-');
  item(menu, 'rename')!.run();
  expect(st().renaming).toEqual({ id: 'a', at: 'bar' });
  st().setRenaming(null);
  // Its close is asked under the pop-out's bar.
  item(menu, 'close-terminal')!.run();
  expect(st().closeAsk).toEqual({ id: 'a', at: 'popout', stops: { kind: 'claude', doing: 'idle' }, note: 'history' });
  st().cancelClose();
});

test('a plain terminal pop-out: no Rename (its name is renamed in a tab, there is none here)', () => {
  st().enterPopout({ key: 't:a' });
  st().setTerminals([term('a')]);
  const menu = popoutBarMenu('t:a');
  expect(ids(menu)).not.toContain('rename');
  expect(ids(menu)).toEqual(['move-back', '-', 'term-here', 'open-in-finder', '-', 'close-terminal']);
});

test('an untitled buffer or a special tab: Move Back alone (or with its own items)', () => {
  st().enterPopout({ key: 'f:untitled:1', payload: { kind: 'file', rel: 'Untitled-1', mode: 'margin' } });
  expect(ids(popoutBarMenu('f:untitled:1'))).toEqual(['move-back']);
  st().enterPopout({ key: 'services' });
  expect(ids(popoutBarMenu('services'))).toEqual(['move-back']);
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useApp } from './store';
import { single } from './split';
import { t } from './i18n/en';
import type { TerminalInfo } from '@shared/protocol';
import type { EditorHandoff, PopoutOpenResult } from '@shared/popout';
import type { RestoredTabs } from '@shared/tabs-state';
import type { TaskLink } from './task-links';
import { registerSaver } from './editor/savers';
import { hasHandoff, isMoving, takeHandoff } from './editor/handoff';
import { useDb } from './databases/store';
import { emptyViews } from './spaces';

// Tab pop-out windows: the main window's store keeps popped-out keys out of its strip and
// panes and sends every "show it" to their window; a pop-out's store holds its one tab and never persists tabs/layout.
const term = (id: string, createdAt: number): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt, session: null });
const abc = () => [term('a', 1), term('b', 2), term('c', 3)];
const open = vi.fn(async (): Promise<PopoutOpenResult> => ({ ok: true }));
const focus = vi.fn(async () => {});
const openInMain = vi.fn(async (_path: string, _line?: number) => {});
const showInMain = vi.fn(async (_r: unknown) => {});
const forward = vi.fn(async (_cmd: string) => {});
const tabsSave = vi.fn(async () => {});
let restored: RestoredTabs | null = null;
const tabsRestore = vi.fn(async () => restored);
const saveAs = vi.fn(async (rel: string, _text: string) => ({ path: `/p/${rel}` }));
const rekey = vi.fn(async (_from: string, _to: string) => {});
const dock = vi.fn(async (_r: unknown) => {});
const writes: string[] = [];
const stored = new Map<string, string>();
const g = globalThis as { window?: unknown; localStorage?: unknown };
const st = () => useApp.getState();

beforeEach(() => {
  g.window = {
    addEventListener: () => {},
    atelier: { terminals: { close: vi.fn(), markSeen: vi.fn(async () => {}) }, files: { saveAs }, popout: { open, focus, openInMain, showInMain, forward, rekey, dock }, tabs: { save: tabsSave, restore: tabsRestore } }
  };
  saveAs.mockClear(); rekey.mockClear(); dock.mockClear();
  g.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); stored.set(k, v); }, removeItem: (k: string) => { writes.push(k); stored.delete(k); } };
  open.mockReset(); open.mockImplementation(async () => ({ ok: true }));
  focus.mockClear(); openInMain.mockClear(); showInMain.mockClear(); forward.mockClear(); tabsSave.mockClear(); tabsRestore.mockClear();
  writes.length = 0; stored.clear(); restored = null;
  useApp.setState({
    project: null, openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], selectedId: null, pendingAnchor: null, hidden: [], pins: [],
    servicesOpen: false, review: null, historyTab: null, backgroundTab: null, dockerTabs: [], dockerPreview: null, redisTabs: [], revFiles: [], dirty: {}, preview: null,
    split: single(), toast: null, popout: null, poppedOut: [], dockHover: null, layoutRestored: false, tabsRestored: false,
    space: 'sessions', spaceViews: emptyViews(), activity: 'sessions'
  });
});
afterEach(() => { delete g.window; delete g.localStorage; vi.useRealTimers(); });

test('a popped-out terminal leaves the strip like a closed tab, without being hidden; the terminal stays', () => {
  st().setTerminals(abc());
  st().select('b');
  st().applyPoppedOut(['t:b']);
  expect(st().poppedOut).toEqual(['t:b']);
  expect(st().tabOrder).toEqual(['t:a', 't:c']);
  expect(st().activeKey()).toBe('t:c');
  expect(st().hidden).toEqual([]);
  expect(st().terminals.map((x) => x.id)).toEqual(['a', 'b', 'c']);
});

test('the next terminal lists keep it out of the strip', () => {
  st().setTerminals(abc());
  st().applyPoppedOut(['t:b']);
  st().setTerminals(abc());
  expect(st().tabOrder).toEqual(['t:a', 't:c']);
});

test('the selection never lands on a popped-out terminal (behind a file, then on the next list)', () => {
  st().setTerminals(abc());
  st().select('b');
  st().openFile('/p/x.ts', 'x.ts');
  st().applyPoppedOut(['t:b']);
  expect(st().selectedId).not.toBe('b');
  useApp.setState({ selectedId: 'b' });
  st().setTerminals(abc());
  expect(st().selectedId).not.toBe('b');
  expect(st().activeTab).toBe('/p/x.ts');
});

test('selecting, activating or opening to the side a popped-out terminal brings its window forward and changes nothing', () => {
  st().setTerminals(abc());
  st().select('a');
  st().applyPoppedOut(['t:b']);
  const before = { tabOrder: st().tabOrder, selectedId: st().selectedId, activeTab: st().activeTab, split: st().split, hidden: st().hidden };
  st().select('b');
  expect(focus).toHaveBeenLastCalledWith('t:b');
  st().activate('t:b');
  st().openToSide('t:b');
  expect(focus).toHaveBeenCalledTimes(3);
  for (const call of focus.mock.calls) expect(call).toEqual(['t:b']);
  expect({ tabOrder: st().tabOrder, selectedId: st().selectedId, activeTab: st().activeTab, split: st().split, hidden: st().hidden }).toEqual(before);
});

test('opening a popped-out file again passes the line to its window; the main window opens nothing', () => {
  st().openFile('/p/a.ts', 'a.ts');
  st().openFile('/p/x.ts', 'x.ts');
  st().applyPoppedOut(['f:/p/a.ts']);
  expect(st().openFiles.map((f) => f.path)).toEqual(['/p/x.ts']);
  const files = st().openFiles;
  st().openFile('/p/a.ts', 'a.ts', 12);
  expect(focus).toHaveBeenLastCalledWith('f:/p/a.ts', { line: 12 });
  st().openFile('/p/a.ts', 'a.ts');
  expect(focus).toHaveBeenLastCalledWith('f:/p/a.ts');
  st().openFileToSide('/p/a.ts', 'a.ts');
  expect(focus).toHaveBeenCalledTimes(3);
  expect(st().openFiles).toBe(files);
  expect(st().tabOrder).toEqual(['f:/p/x.ts']);
});

test('a popped-out file with unsaved changes leaves its dirty flag with it', () => {
  st().openFile('/p/a.ts', 'a.ts');
  st().setDirty('/p/a.ts', true);
  st().applyPoppedOut(['f:/p/a.ts']);
  expect(st().dirty['/p/a.ts']).toBeFalsy();
  expect(st().unsavedAsk).toBeNull();
});

test('special tabs popped out: opening them again goes to their window with what was asked', () => {
  st().openReview('all');
  st().applyPoppedOut(['review', 'dk:overview', 'rd:queues', 'rd:keys', 'background', 'history', 'services', 'rev:abc:a.ts']);
  expect(st().review).toBeNull();
  expect(st().tabOrder).toEqual([]);
  st().openReview('all');
  expect(focus).toHaveBeenLastCalledWith('review', { payload: { kind: 'review', scope: 'all' } });
  st().openReview('t1', { againstMain: true });
  expect(focus).toHaveBeenLastCalledWith('review', { payload: { kind: 'review', scope: 't1', againstMain: true } });
  // A Docker tab's key names its target: only a view asked for goes along.
  st().openDocker({ kind: 'overview' });
  expect(focus).toHaveBeenLastCalledWith('dk:overview');
  st().openDocker({ kind: 'overview' }, 'inspect');
  expect(focus).toHaveBeenLastCalledWith('dk:overview', { payload: { kind: 'docker', target: { kind: 'overview' }, view: 'inspect' } });
  // A Redis tab's key names its view: its window comes forward, nothing more to say.
  st().openRedis('queues');
  expect(focus).toHaveBeenLastCalledWith('rd:queues');
  st().openRedis();
  expect(focus).toHaveBeenLastCalledWith('rd:keys');
  st().openBackground({ terminalId: 'a', itemId: 'x' });
  expect(focus).toHaveBeenLastCalledWith('background', { payload: { kind: 'background', terminalId: 'a', itemId: 'x' } });
  st().openHistory({ repo: '/p', scope: { kind: 'refs', refs: 'all', firstParent: false } });
  expect(focus).toHaveBeenLastCalledWith('history', { payload: { kind: 'history', repo: '/p', scope: { kind: 'refs', refs: 'all', firstParent: false } } });
  st().openServices();
  expect(focus).toHaveBeenLastCalledWith('services');
  st().activate('services');
  expect(focus).toHaveBeenLastCalledWith('services');
  st().openRevFile({ root: '/p', oid: 'abc', rel: 'a.ts' });
  expect(focus).toHaveBeenLastCalledWith('rev:abc:a.ts', { payload: { kind: 'rev', root: '/p', oid: 'abc', rel: 'a.ts' } });
  expect(st().tabOrder).toEqual([]);
  expect(st().review).toBeNull();
  expect(st().dockerTabs).toEqual([]);
  expect(st().redisTabs).toEqual([]);
  expect(st().backgroundTab).toBeNull();
  expect(st().historyTab).toBeNull();
  expect(st().revFiles).toEqual([]);
  expect(st().servicesOpen).toBe(false);
});

test('a terminal docked back comes in right after the active tab, active, no longer popped out', () => {
  st().setTerminals(abc());
  st().select('a');
  st().applyPoppedOut(['t:b']);
  st().applyDock({ key: 't:b' });
  expect(st().poppedOut).toEqual([]);
  expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
  expect(st().activeKey()).toBe('t:b');
  st().setTerminals(abc());
  expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
});

test('a file docked back opens with its mode and is active', () => {
  st().setTerminals(abc());
  st().select('a');
  st().applyPoppedOut(['f:/p/a.ts']);
  st().applyDock({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } });
  expect(st().openFiles.map((f) => [f.path, f.rel, f.mode])).toEqual([['/p/a.ts', 'a.ts', 'margin']]);
  expect(st().tabOrder).toEqual(['t:a', 'f:/p/a.ts', 't:b', 't:c']);
  expect(st().activeTab).toBe('/p/a.ts');
  expect(st().poppedOut).toEqual([]);
});

test('the review docked back keeps its scope and Against main', () => {
  st().applyPoppedOut(['review']);
  st().applyDock({ key: 'review', payload: { kind: 'review', scope: 'all', againstMain: true } });
  expect(st().review).toMatchObject({ scope: 'all', againstMain: true });
  expect(st().activeKey()).toBe('review');
  expect(st().tabOrder).toEqual(['review']);
});

test('docked at a place: before a strip tab, or in a new pane on the right', () => {
  st().setTerminals(abc());
  st().select('c');
  st().applyPoppedOut(['f:/p/a.ts', 't:b']);
  st().applyDock({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } }, { kind: 'strip', pane: 0, before: 't:a' });
  expect(st().tabOrder).toEqual(['f:/p/a.ts', 't:a', 't:c']);
  expect(st().activeTab).toBe('/p/a.ts');
  st().applyDock({ key: 't:b' }, { kind: 'pane', pane: 0, zone: 'right' });
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['f:/p/a.ts', 't:a', 't:c'], ['t:b']]);
  expect(st().split.focus).toBe(1);
  expect(st().activeKey()).toBe('t:b');
  expect(st().poppedOut).toEqual([]);
});

test('docked into a split: before a tab of a pane\'s strip, into a pane\'s middle, or Move Back to the focused pane', () => {
  st().setTerminals(abc());
  st().select('c');
  st().moveTabStep(1);
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['t:a', 't:b'], ['t:c']]);
  st().applyPoppedOut(['f:/p/a.ts', 'f:/p/b.ts', 'f:/p/c.ts']);
  st().applyDock({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } }, { kind: 'strip', pane: 0, before: 't:b' });
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['t:a', 'f:/p/a.ts', 't:b'], ['t:c']]);
  expect(st().split.focus).toBe(0);
  expect(st().activeKey()).toBe('f:/p/a.ts');
  st().applyDock({ key: 'f:/p/b.ts', payload: { kind: 'file', rel: 'b.ts', mode: 'margin' } }, { kind: 'pane', pane: 1, zone: 'middle' });
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['t:a', 'f:/p/a.ts', 't:b'], ['t:c', 'f:/p/b.ts']]);
  expect(st().split.focus).toBe(1);
  st().applyDock({ key: 'f:/p/c.ts', payload: { kind: 'file', rel: 'c.ts', mode: 'margin' } });
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['t:a', 'f:/p/a.ts', 't:b'], ['t:c', 'f:/p/b.ts', 'f:/p/c.ts']]);
  expect(st().tabOrder).toEqual(['t:a', 'f:/p/a.ts', 't:b', 't:c', 'f:/p/b.ts', 'f:/p/c.ts']);
});

test('docked while an empty pane is focused — it lands where it was dropped; the empty pane stays', () => {
  st().setTerminals(abc());
  st().select('c');
  st().splitRight();
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['t:a', 't:b', 't:c'], []]);
  st().applyPoppedOut(['f:/p/a.ts', 'f:/p/b.ts']);
  // Onto the left pane's middle: there, in front, that pane focused; the empty pane stays empty.
  st().applyDock({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } }, { kind: 'pane', pane: 0, zone: 'middle' });
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['t:a', 't:b', 't:c', 'f:/p/a.ts'], []]);
  expect(st().split.panes[0]!.front).toBe('f:/p/a.ts');
  expect(st().split.focus).toBe(0);
  // Onto the left pane's strip, before t:b, with the empty pane focused again: there; the split stays.
  st().focusPane(1);
  st().applyDock({ key: 'f:/p/b.ts', payload: { kind: 'file', rel: 'b.ts', mode: 'margin' } }, { kind: 'strip', pane: 0, before: 't:b' });
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['t:a', 'f:/p/b.ts', 't:b', 't:c', 'f:/p/a.ts'], []]);
  expect(st().split.focus).toBe(0);
  expect(st().activeKey()).toBe('f:/p/b.ts');
});

test('a pane\'s only tab popping out closes that pane (like a close; nothing hidden)', () => {
  st().setTerminals(abc());
  st().select('c');
  st().moveTabStep(1);
  st().applyPoppedOut(['t:c']);
  expect(st().split).toEqual(single());
  expect(st().tabOrder).toEqual(['t:a', 't:b']);
  expect(st().hidden).toEqual([]);
});

test('popout mode: the store holds its one tab whatever the lists say, and never saves tabs, layout, hidden or pins', async () => {
  vi.useFakeTimers();
  st().enterPopout({ key: 't:b' });
  st().setProject({ root: '/p', name: 'p', realRoot: '/p', popout: { key: 't:b' } });
  st().setTerminals(abc());
  expect(st().tabOrder).toEqual(['t:b']);
  expect(st().selectedId).toBe('b');
  expect(st().activeKey()).toBe('t:b');
  expect(st().layoutRestored).toBe(true);
  expect(st().tabsRestored).toBe(true);
  st().setTerminals([term('b', 2), term('d', 4)]);
  expect(st().tabOrder).toEqual(['t:b']);
  // What would write them in the main window: a hidden id shown again, pins and task links pruned once the resumables
  // are known (saved data naming terminals that are gone).
  useApp.setState({ hidden: ['b', 'gone'], pins: ['b', 'gone'], taskLinks: { gone: {} as TaskLink } });
  st().select('b');
  st().setResumables([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(tabsSave).not.toHaveBeenCalled();
  expect(tabsRestore).not.toHaveBeenCalled();
  expect(writes.filter((k) => /hiddenTabs|pins|splitLayout|taskLinks/.test(k))).toEqual([]);
});

test('popout mode for a file: its tab from the payload; a reveal moves to the line', () => {
  st().enterPopout({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'diff' } });
  expect(st().tabOrder).toEqual(['f:/p/a.ts']);
  expect(st().openFiles.map((f) => [f.path, f.rel, f.mode])).toEqual([['/p/a.ts', 'a.ts', 'diff']]);
  expect(st().activeTab).toBe('/p/a.ts');
  const nonce = st().openFiles[0]!.nonce;
  st().revealInPopout({ line: 7 });
  expect(st().openFiles[0]).toMatchObject({ path: '/p/a.ts', line: 7, mode: 'diff' });
  expect(st().openFiles[0]!.nonce).not.toBe(nonce);
});

test('popout mode for the review: a reveal with a payload retargets it', () => {
  st().enterPopout({ key: 'review', payload: { kind: 'review', scope: 'all' } });
  expect(st().activeKey()).toBe('review');
  st().revealInPopout({ payload: { kind: 'review', scope: 't1', againstMain: true } });
  expect(st().review).toMatchObject({ scope: 't1', againstMain: true });
  expect(st().tabOrder).toEqual(['review']);
});

test('popout mode with its terminal gone from the list: nothing throws, no tab left', () => {
  st().enterPopout({ key: 't:b' });
  expect(() => st().setTerminals([term('a', 1)])).not.toThrow();
  expect(st().tabOrder).toEqual([]);
  expect(st().selectedId).toBeNull();
});

test('popOut: open asked with the tab’s payload and a default size; ok → the tab leaves; inside → nothing; failed → a toast', async () => {
  st().setTerminals(abc());
  st().select('b');
  await st().popOut('t:b', 'cascade');
  expect(open).toHaveBeenLastCalledWith({ key: 't:b', payload: { kind: 'terminal', ask: false }, size: { width: 900, height: 620 }, at: 'cascade' });
  expect(st().poppedOut).toEqual(['t:b']);
  expect(st().tabOrder).toEqual(['t:a', 't:c']);
  expect(st().activeKey()).toBe('t:c');

  // Asked again: its window comes forward, never a second one.
  await st().popOut('t:b', 'cascade');
  expect(open).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenLastCalledWith('t:b');

  st().openFile('/p/a.ts', 'a.ts', null, 'diff');
  open.mockImplementation(async () => ({ ok: false, reason: 'inside' }));
  const before = { tabOrder: st().tabOrder, openFiles: st().openFiles, poppedOut: st().poppedOut };
  await st().popOut('f:/p/a.ts', 'cursor', { width: 700, height: 500 });
  expect(open).toHaveBeenLastCalledWith({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'diff' }, size: { width: 700, height: 500 }, at: 'cursor' });
  expect({ tabOrder: st().tabOrder, openFiles: st().openFiles, poppedOut: st().poppedOut }).toEqual(before);
  expect(st().toast).toBeNull();

  open.mockImplementation(async () => ({ ok: false, reason: 'failed' }));
  await st().popOut('f:/p/a.ts', 'cascade');
  expect(st().toast?.text).toBe(t.popout.failed);
  expect(st().tabOrder).toEqual(before.tabOrder);
});

test('a table tab: popped out with its payload, gone here with its state; docked back kept; released over another window, gone', async () => {
  const K = 'db:c0123456789ab/public/orders' as const;
  const ref = { connId: 'c0123456789ab', schema: 'public', name: 'orders', kind: 'view' as const, view: 'data' as const };
  useApp.setState({ dbTabs: [], dbPreview: null });
  useDb.setState({ tabs: {} });
  st().setTerminals(abc());
  st().openDbTab(ref, { preview: true, view: 'structure' });
  useDb.getState().patchTab(K, { wrap: true });
  await st().popOut(K, 'cascade');
  const payload = { kind: 'db', connId: 'c0123456789ab', schema: 'public', name: 'orders', view: 'structure', rel: 'view' } as const;
  expect(open).toHaveBeenLastCalledWith({ key: K, payload, size: { width: 900, height: 620 }, at: 'cascade' });
  expect(st().poppedOut).toEqual([K]);
  // Databases is left with nothing in front; Sessions keeps its terminals.
  expect(st().space).toBe('databases');
  expect(st().tabOrder).toEqual([]);
  expect(st().activeTab).toBe('none');
  expect(st().dbTabs).toEqual([]);
  expect(st().dbPreview).toBeNull();
  expect(useDb.getState().tabs).toEqual({});
  // Opened again (the sidebar, the palette): its window comes forward, nothing opens here.
  st().openDbTab(ref, { preview: true });
  expect(focus).toHaveBeenLastCalledWith(K);
  expect(st().tabOrder).toEqual([]);
  // Docked back from Sessions: into Databases (which comes to the front), in front, kept, with its view and kind.
  st().select('a');
  expect(st().space).toBe('sessions');
  st().applyDock({ key: K, payload });
  expect(st().poppedOut).toEqual([]);
  expect(st().space).toBe('databases');
  expect(st().tabOrder).toEqual([K]);
  expect(st().activeKey()).toBe(K);
  expect(st().dbTabs).toEqual([{ key: K, ...ref, view: 'structure' }]);
  expect(st().dbPreview).toBeNull();
  // Dragged out over another project's window that took it: it lives there now.
  open.mockImplementation(async () => ({ ok: false, reason: 'moved' }));
  await st().popOut(K, 'cursor');
  expect(st().tabOrder).toEqual([]);
  expect(st().dbTabs).toEqual([]);
  st().select('a');
  expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
});

test('popout mode for a table tab: its tab from the payload, no preview; a reveal changes its view', () => {
  const K = 'db:c0123456789ab/public/orders' as const;
  useApp.setState({ dbTabs: [], dbPreview: K });
  st().enterPopout({ key: K, payload: { kind: 'db', connId: 'c0123456789ab', schema: 'public', name: 'orders', view: 'relations', rel: 'matview' } });
  expect(st().tabOrder).toEqual([K]);
  expect(st().activeKey()).toBe(K);
  expect(st().dbPreview).toBeNull();
  expect(st().dbTabs).toEqual([{ key: K, connId: 'c0123456789ab', schema: 'public', name: 'orders', kind: 'matview', view: 'relations' }]);
  st().revealInPopout({ payload: { kind: 'db', connId: 'c0123456789ab', schema: 'public', name: 'orders', view: 'data' } });
  expect(st().dbTabs[0]!.view).toBe('data');
});

// ⌘⇧O works on the tab in front, whatever its kind; an automation's tab has no pop-out.
test('an automation’s tab never pops out (⌘⇧O on it): nothing is asked of main, the tab stays', async () => {
  useApp.setState({ automations: { automations: [{ automation: { id: 'a1', project: '/p', name: 'a1' } } as never] }, autoTabs: [], autoPreview: null });
  st().openAutomations('a1');
  const key = st().activeKey()!;
  expect(key.startsWith('au:')).toBe(true);
  await st().popOut(key, 'cascade');
  expect(open).not.toHaveBeenCalled();
  expect(st().tabOrder).toEqual([key]);
});

test('a rejected open counts as failed', async () => {
  st().setTerminals(abc());
  open.mockImplementation(async () => { throw new Error('gone'); });
  await st().popOut('t:a', 'cascade');
  expect(st().toast?.text).toBe(t.popout.failed);
  expect(st().poppedOut).toEqual([]);
});

test('restored tabs never bring back a popped-out key', async () => {
  vi.useFakeTimers();
  st().applyPoppedOut(['t:b', 'f:/p/a.ts']);
  restored = { files: [{ path: '/p/a.ts', rel: 'a.ts', external: false }, { path: '/p/x.ts', rel: 'x.ts', external: false }], order: ['f:/p/a.ts', 't:b', 'f:/p/x.ts', 't:a'], active: 't:b' };
  st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  st().setTerminals(abc());
  st().setDaemon({ ...st().daemon, connected: true, listed: true });
  await vi.runAllTimersAsync();
  expect(tabsRestore).toHaveBeenCalled();
  expect(st().openFiles.map((f) => f.path)).toEqual(['/p/x.ts']);
  expect(st().tabOrder).not.toContain('t:b');
  expect(st().tabOrder).not.toContain('f:/p/a.ts');
  expect(focus).not.toHaveBeenCalled();
  expect(st().activeKey()).not.toBe('t:b');
});

test('the drag-back hover point is kept for the strip and panes to show', () => {
  st().setDockHover({ x: 10, y: 20 });
  expect(st().dockHover).toEqual({ x: 10, y: 20 });
  st().setDockHover(null);
  expect(st().dockHover).toBeNull();
});

test('the only tab popped out: the empty state, no selection left on the popped terminal', () => {
  st().setTerminals([term('b', 2)]);
  st().select('b');
  expect(st().tabOrder).toEqual(['t:b']);
  st().applyPoppedOut(['t:b']);
  expect(st().tabOrder).toEqual([]);
  expect(st().activeTab).toBe('term');
  expect(st().selectedId).toBeNull();
  expect(st().activeKey()).toBeNull();
});

test('a popped terminal in front of a file: the file comes forward, and closing it never shows the popped terminal', () => {
  st().setTerminals([term('b', 2)]);
  st().select('b');
  st().openFile('/p/x.ts', 'x.ts');
  st().activate('t:b');
  expect(st().tabOrder).toEqual(['t:b', 'f:/p/x.ts']);
  st().applyPoppedOut(['t:b']);
  expect(st().activeTab).toBe('/p/x.ts');
  expect(st().selectedId).not.toBe('b');
  st().closeTab('/p/x.ts');
  expect(st().selectedId).not.toBe('b');
  expect(st().activeKey()).toBeNull();
});

test('the saved split layout never gives a pane to a popped-out terminal', () => {
  stored.set('atelier.splitLayout', JSON.stringify({ '/p': { panes: ['t:a', 't:b', 't:c'], fractions: [1 / 3, 1 / 3, 1 / 3], focus: 1 } }));
  st().applyPoppedOut(['t:b']);
  useApp.setState({ tabsRestored: true, daemon: { ...st().daemon, listed: false } });
  st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  st().setTerminals(abc());
  expect(st().layoutRestored).toBe(true);
  expect(st().split.panes.map((p) => p.tabs)).toEqual([['t:a'], ['t:c']]);
  // Its saved focus was the popped terminal: the restore neither brings that window forward nor selects it.
  expect(focus).not.toHaveBeenCalled();
  expect(st().selectedId).not.toBe('b');
});

test('docking a special tab whose payload gives it nothing to show adds no dead tab', () => {
  st().setTerminals(abc());
  st().select('a');
  st().applyPoppedOut(['history', 'background', 'rev:abc:a.ts']);
  st().applyDock({ key: 'history' });
  st().applyDock({ key: 'background' });
  st().applyDock({ key: 'rev:abc:a.ts' });
  expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
  expect(st().activeKey()).toBe('t:a');
  expect(st().poppedOut).toEqual([]);
});

test('popout mode: a Background tab closed with its terminal stays closed on the next lists, and its window goes (docked once)', () => {
  st().enterPopout({ key: 'background', payload: { kind: 'background', terminalId: 'b', itemId: null } });
  st().setTerminals(abc());
  expect(st().tabOrder).toEqual(['background']);
  expect(dock).not.toHaveBeenCalled();
  st().setTerminals([term('a', 1)]);
  expect(st().backgroundTab).toBeNull();
  expect(st().tabOrder).toEqual([]);
  // No empty bar left: the window gives its (dead) tab back, and main closes it; the main window adds no tab for it.
  expect(dock).toHaveBeenCalledTimes(1);
  expect(dock).toHaveBeenCalledWith({});
  st().setTerminals([term('a', 1)]);
  expect(st().tabOrder).toEqual([]);
  expect(dock).toHaveBeenCalledTimes(1);
});

test('a terminal pop-out whose terminal ends never docks: main closes its window', () => {
  st().enterPopout({ key: 't:b' });
  st().setTerminals(abc());
  st().setTerminals([term('a', 1)]);
  expect(st().tabOrder).toEqual([]);
  expect(dock).not.toHaveBeenCalled();
});

test('main window: a Background tab docked for a terminal that is gone adds no tab', () => {
  st().setTerminals(abc());
  st().select('a');
  st().applyPoppedOut(['background']);
  st().applyDock({ key: 'background', payload: { kind: 'background', terminalId: 'gone', itemId: null } });
  expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
  expect(st().backgroundTab).toBeNull();
  // Its terminal alive: it comes back.
  st().applyDock({ key: 'background', payload: { kind: 'background', terminalId: 'b', itemId: null } });
  expect(st().tabOrder).toContain('background');
});

test('popout mode: an unchanged list keeps the same tab order array', () => {
  st().enterPopout({ key: 't:b' });
  st().setTerminals(abc());
  const order = st().tabOrder;
  st().setTerminals(abc());
  expect(st().tabOrder).toBe(order);
});

test('popout mode: Save As of its untitled buffer re-keys the window, here and in main; its view stays', async () => {
  st().enterPopout({ key: 'f:untitled:1', payload: { kind: 'file', rel: 'Untitled-1', mode: 'margin' } });
  st().setProject({ root: '/p', name: 'p', realRoot: '/p', popout: { key: 'f:untitled:1', payload: { kind: 'file', rel: 'Untitled-1', mode: 'margin' } } });
  void st().requestSaveAs('untitled:1', () => 'text');
  expect(await st().submitSaveAs('notes.md')).toEqual({ path: '/p/notes.md' });
  expect(st().popout).toEqual({ key: 'f:/p/notes.md', payload: { kind: 'file', rel: 'notes.md', mode: 'margin' } });
  expect(st().tabOrder).toEqual(['f:/p/notes.md']);
  expect(rekey).toHaveBeenCalledWith('f:untitled:1', 'f:/p/notes.md');
  // The next lists keep it: the window never goes empty, nothing docks.
  st().setTerminals(abc());
  expect(st().tabOrder).toEqual(['f:/p/notes.md']);
  expect(st().activeKey()).toBe('f:/p/notes.md');
  expect(dock).not.toHaveBeenCalled();
});

test('main window: Save As of an untitled tab asks no rekey', async () => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' } });
  st().newUntitled();
  void st().requestSaveAs('untitled:1', () => 'text');
  await st().submitSaveAs('notes.md');
  expect(st().tabOrder).toEqual(['f:/p/notes.md']);
  expect(rekey).not.toHaveBeenCalled();
});

test('a new untitled tab never takes the name of an untitled buffer living in a pop-out', () => {
  st().newUntitled();
  const first = st().openFiles[0]!.path;
  st().applyPoppedOut([`f:${first}`]);
  expect(st().openFiles).toEqual([]);
  st().newUntitled();
  expect(st().openFiles[0]!.path).not.toBe(first);
  expect(st().openFiles[0]!.rel).toBe('Untitled-2');
});

// An unsaved buffer moves with its tab (the editor's handoff), out and back.
const handoff = (path: string, doc = 'mine'): EditorHandoff => ({ path, state: { doc, selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 } }, saved: 'disk', stamp: { mtimeMs: 1, size: 4, hash: 'h' }, eol: 'lf', scrollTop: 12 });

test('popOut of a file sends its editor’s buffer with the open request, taken before the tab leaves', async () => {
  st().openFile('/p/a.ts', 'a.ts');
  const h = handoff('/p/a.ts');
  const asked: string[] = [];
  const off = registerSaver('/p/a.ts', async () => true, () => true, () => { asked.push(st().tabOrder.join(',')); return h; });
  await st().popOut('f:/p/a.ts', 'cascade');
  expect(open).toHaveBeenLastCalledWith({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' }, handoff: h, size: { width: 900, height: 620 }, at: 'cascade' });
  // Asked while the tab was still in the strip (its editor still mounted).
  expect(asked).toEqual(['f:/p/a.ts']);
  expect(st().poppedOut).toEqual(['f:/p/a.ts']);
  off();
});

test('popOut of a file whose open fails: nothing changes, its editor stays with the buffer and takes edits again', async () => {
  st().openFile('/p/a.ts', 'a.ts');
  const off = registerSaver('/p/a.ts', async () => true, () => true, () => handoff('/p/a.ts'));
  const during: boolean[] = [];
  open.mockImplementation(async () => { during.push(isMoving('/p/a.ts')); return { ok: false, reason: 'failed' }; });
  await st().popOut('f:/p/a.ts', 'cascade');
  expect(during).toEqual([true]);
  expect(isMoving('/p/a.ts')).toBe(false);
  expect(st().openFiles.map((f) => f.path)).toEqual(['/p/a.ts']);
  expect(st().tabOrder).toEqual(['f:/p/a.ts']);
  expect(hasHandoff('/p/a.ts')).toBe(false);
  // A rejected open too.
  open.mockImplementation(async () => { throw new Error('gone'); });
  await st().popOut('f:/p/a.ts', 'cascade');
  expect(isMoving('/p/a.ts')).toBe(false);
  off();
});

test('popOut whose open throws before giving a promise: the editor is never left frozen', async () => {
  st().openFile('/p/a.ts', 'a.ts');
  const off = registerSaver('/p/a.ts', async () => true, () => true, () => handoff('/p/a.ts'));
  open.mockImplementation((() => { throw new Error('no bridge'); }) as never);
  try {
    await st().popOut('f:/p/a.ts', 'cascade').catch(() => {});
    expect(isMoving('/p/a.ts')).toBe(false);
    expect(st().tabOrder).toEqual(['f:/p/a.ts']);
  } finally { off(); }
});

test('popOut of a file without an editor sends no handoff', async () => {
  st().openFile('/p/a.ts', 'a.ts');
  await st().popOut('f:/p/a.ts', 'cascade');
  expect((open.mock.calls.at(-1) as unknown[] | undefined)?.[0]).not.toHaveProperty('handoff');
  expect(open).toHaveBeenCalledTimes(1);
});

test('a file docked back finds its buffer waiting when it joins the open files', () => {
  st().applyPoppedOut(['f:/p/a.ts']);
  const seen: boolean[] = [];
  const unsub = useApp.subscribe((s, prev) => { if (s.openFiles.length !== prev.openFiles.length) seen.push(hasHandoff('/p/a.ts')); });
  const h = handoff('/p/a.ts');
  st().applyDock({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'diff' }, handoff: h });
  unsub();
  expect(seen).toEqual([true]);
  expect(takeHandoff('/p/a.ts')).toBe(h);
  expect(st().activeTab).toBe('/p/a.ts');
});

test('a file docked back into a pane finds its buffer waiting too', () => {
  st().setTerminals(abc());
  st().select('a');
  st().applyPoppedOut(['f:/p/a.ts']);
  const seen: boolean[] = [];
  const unsub = useApp.subscribe((s, prev) => { if (s.openFiles.length !== prev.openFiles.length) seen.push(hasHandoff('/p/a.ts')); });
  st().applyDock({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' }, handoff: handoff('/p/a.ts') }, { kind: 'pane', pane: 0, zone: 'right' });
  unsub();
  expect(seen).toEqual([true]);
  expect(takeHandoff('/p/a.ts')).not.toBeNull();
});

test('a handoff for another path than the docked file is ignored', () => {
  st().applyPoppedOut(['f:/p/a.ts']);
  st().applyDock({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' }, handoff: handoff('/p/other.ts') });
  expect(hasHandoff('/p/other.ts')).toBe(false);
  expect(hasHandoff('/p/a.ts')).toBe(false);
});

test('popout mode: another file asked for (a link, a path) opens in the project window, at its line; this tab stays', () => {
  st().enterPopout({ key: 't:b' });
  st().setTerminals(abc());
  st().openFile('/p/x.ts', 'x.ts', 12, undefined, { preview: true });
  expect(openInMain).toHaveBeenLastCalledWith('/p/x.ts', 12);
  st().openFile('/p/y.ts', 'y.ts');
  expect(openInMain).toHaveBeenLastCalledWith('/p/y.ts', undefined);
  st().openFileToSide('/p/z.ts', 'z.ts');
  expect(openInMain).toHaveBeenLastCalledWith('/p/z.ts', undefined);
  // An untitled buffer exists in no other window: nothing to open there.
  st().openFile('untitled:3', 'Untitled-3');
  expect(openInMain).toHaveBeenCalledTimes(3);
  expect(st().openFiles).toEqual([]);
  expect(st().tabOrder).toEqual(['t:b']);
  expect(st().activeKey()).toBe('t:b');
});

test('popout mode for a file: its own path opens here (a line to go to), never in the project window', () => {
  st().enterPopout({ key: 'f:/p/a.ts', payload: { kind: 'file', rel: 'a.ts', mode: 'margin' } });
  st().openFile('/p/a.ts', 'a.ts', 9);
  expect(openInMain).not.toHaveBeenCalled();
  expect(st().openFiles.map((f) => [f.path, f.line])).toEqual([['/p/a.ts', 9]]);
  expect(st().tabOrder).toEqual(['f:/p/a.ts']);
});

test('main window: opening files never goes through openInMain', () => {
  st().openFile('/p/x.ts', 'x.ts', 3);
  expect(openInMain).not.toHaveBeenCalled();
  expect(st().activeTab).toBe('/p/x.ts');
});

test('popout mode: every other tab asked for is shown in the project window, with what it needs; this one stays', () => {
  st().enterPopout({ key: 't:b' });
  st().setTerminals(abc());
  useApp.setState({ scmRepo: '/p', bgPopover: { terminalId: 'a' } as never, menu: { x: 0, y: 0, items: [] } as never });
  st().openBackground({ terminalId: 'a', itemId: 'x1' });
  expect(showInMain).toHaveBeenLastCalledWith({ key: 'background', payload: { kind: 'background', terminalId: 'a', itemId: 'x1' } });
  // What led there (the popover, a menu) closes: the inspector opened elsewhere.
  expect(st().bgPopover).toBeNull();
  expect(st().menu).toBeNull();
  st().openRevFile({ root: '/p', oid: 'abc', rel: 'src/a.ts' });
  expect(showInMain).toHaveBeenLastCalledWith({ key: 'rev:abc:src/a.ts', payload: { kind: 'rev', root: '/p', oid: 'abc', rel: 'src/a.ts' } });
  st().openReview('all');
  expect(showInMain).toHaveBeenLastCalledWith({ key: 'review', payload: { kind: 'review', scope: 'all' } });
  // History with nothing asked for still says which repository and scope (the project window may have none open).
  st().openHistory();
  expect(showInMain).toHaveBeenLastCalledWith({ key: 'history', payload: { kind: 'history', repo: '/p', scope: { kind: 'refs', refs: 'all', firstParent: false } } });
  st().openDocker({ kind: 'overview' });
  expect(showInMain).toHaveBeenLastCalledWith({ key: 'dk:overview' });
  st().openRedis('keys');
  expect(showInMain).toHaveBeenLastCalledWith({ key: 'rd:keys' });
  st().openServices();
  expect(showInMain).toHaveBeenLastCalledWith({ key: 'services' });
  st().select('a');
  expect(showInMain).toHaveBeenLastCalledWith({ key: 't:a' });
  st().activate('t:c');
  expect(showInMain).toHaveBeenLastCalledWith({ key: 't:c' });
  st().openToSide('t:a');
  expect(showInMain).toHaveBeenCalledTimes(10);
  // A file goes through the opener (grants, the line).
  st().activate('f:/p/q.ts');
  expect(openInMain).toHaveBeenLastCalledWith('/p/q.ts', undefined);
  expect(showInMain).toHaveBeenCalledTimes(10);
  // Its own terminal stays here, and nothing was added to this window.
  st().select('b');
  expect(showInMain).toHaveBeenCalledTimes(10);
  expect(st().tabOrder).toEqual(['t:b']);
  expect(st().activeKey()).toBe('t:b');
  expect([st().backgroundTab, st().review, st().historyTab, st().dockerTabs.length, st().redisTabs.length, st().servicesOpen, st().revFiles.length]).toEqual([null, null, null, 0, 0, false, 0]);
});

test('popout mode for its own special tab: asking for it again retargets it here', () => {
  st().enterPopout({ key: 'review', payload: { kind: 'review', scope: 'all' } });
  st().openReview('t1', { againstMain: true });
  expect(showInMain).not.toHaveBeenCalled();
  expect(st().review).toMatchObject({ scope: 't1', againstMain: true });
  expect(st().tabOrder).toEqual(['review']);
});

test('popout mode: Settings opens in the project window (this one is never covered by it)', () => {
  st().enterPopout({ key: 't:b' });
  st().setSettingsOpen('dictation');
  expect(forward).toHaveBeenLastCalledWith('open-settings');
  st().setSettingsOpen('connectors');
  expect(forward).toHaveBeenLastCalledWith('open-connectors');
  expect(st().settingsOpen).toBeNull();
  st().setSettingsOpen(null);
  expect(forward).toHaveBeenCalledTimes(2);
});

test('popout mode: a connector notice is a toast here too; its action goes on in the project window', () => {
  st().enterPopout({ key: 't:b' });
  st().connectorNotice({ id: 'clickup', kind: 'unavailable' });
  const toast = st().toast;
  expect(toast?.text).toBeTruthy();
  toast!.action!.run();
  // …on that connector's details page, never this window's.
  expect(forward).toHaveBeenLastCalledWith('open-connector:clickup');
  expect(st().settingsOpen).toBeNull();
  expect(st().connectorDetail).toBeNull();
});

test('popout mode: opening a connector\'s details forwards it; going back to the list has nothing to forward', () => {
  st().enterPopout({ key: 't:b' });
  st().openConnector('notion');
  expect(forward).toHaveBeenLastCalledWith('open-connector:notion');
  expect(st().connectorDetail).toBeNull();
  forward.mockClear();
  st().openConnector(null);
  expect(forward).not.toHaveBeenCalled();
});

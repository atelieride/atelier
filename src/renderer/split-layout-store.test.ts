import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { ProjectInfo } from '@shared/api';
import { useApp } from './store';
import { flatten, isSplit, single } from './split';

// Split view with tab groups in the store: divider fractions and the layout saved per project, restored once per
// window when the saved tabs are back.

const term = (id: string, createdAt = 0, root = '/p'): TerminalInfo => ({
  id, projectRoot: root, cwd: root, title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt, session: null
});
const project = (root = '/p') => ({ root, realRoot: root, name: 'p' }) as unknown as ProjectInfo;
const st = () => useApp.getState();
const tabs = () => st().split.panes.map((p) => p.tabs);
const LIST = [term('a', 1), term('b', 2), term('c', 3)];

function invariant() {
  const s = st().split;
  if (!isSplit(s)) { expect(s).toEqual(single()); return; }
  expect(st().tabOrder).toEqual(flatten(s));
  expect(s.panes[s.focus]!.front).toBe(st().activeKey());
}

const g = globalThis as { localStorage?: unknown; window?: unknown };
const prevStorage = g.localStorage;
let saved: Map<string, string>;
const layouts = () => JSON.parse(saved.get('atelier.splitLayout') ?? '{}') as Record<string, unknown>;
const save = (root: string, layout: unknown) => saved.set('atelier.splitLayout', JSON.stringify({ [root]: layout }));
const v2 = (panes: string[][], focus = 0, fractions = panes.map(() => 1 / panes.length)) => ({ v: 2, panes: panes.map((t) => ({ tabs: t, front: t[0] })), fractions, focus });

beforeEach(() => {
  saved = new Map();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  useApp.setState({
    project: null, terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], hidden: [], pins: [], openFiles: [], preview: null,
    pendingAnchor: null, review: null, servicesOpen: false, split: single(), toast: null, dirty: {}, layoutRestored: false, tabsRestored: true,
    daemon: { ...useApp.getState().daemon, listed: false }
  });
});
afterEach(() => { g.localStorage = prevStorage; delete g.window; vi.useRealTimers(); });

describe('dividers (store)', () => {
  test('fractions set by a divider; equalize; a stale list is ignored', () => {
    st().setTerminals(LIST);
    st().openToSide('t:a');
    st().setFractions([0.7, 0.3]);
    expect(st().split.fractions).toEqual([0.7, 0.3]);
    st().equalizePanes();
    expect(st().split.fractions).toEqual([0.5, 0.5]);
    st().setFractions([1]);
    expect(st().split.fractions).toEqual([0.5, 0.5]);
  });
});

describe('saved layout (store)', () => {
  test('restored once the saved tabs are back: files return to their pane', async () => {
    useApp.setState({ tabsRestored: false });
    g.window = { atelier: { tabs: { save: async () => {}, restore: async () => ({ files: [{ path: '/p/x.md', rel: 'x.md' }], order: ['t:a', 'f:/p/x.md', 't:b', 't:c'], active: 't:a' }) } } };
    save('/p', v2([['t:a', 'f:/p/x.md'], ['t:b']], 1));
    st().setProject(project());
    st().setDaemon({ ...st().daemon, listed: true });
    st().setTerminals(LIST);
    // The terminals alone don't restore it: the file isn't open yet.
    expect(isSplit(st().split)).toBe(false);
    await vi.waitFor(() => expect(st().tabsRestored).toBe(true));
    // Tabs the layout doesn't name join the focused pane.
    expect(tabs()).toEqual([['t:a', 'f:/p/x.md'], ['t:b', 't:c']]);
    expect(st().split.focus).toBe(1);
    expect(st().activeKey()).toBe('t:b');
    invariant();
  });
  test('a layout saved before tab groups (v1) still restores: one terminal per pane, the rest with the focused one', () => {
    save('/p', { panes: ['t:a', 't:b'], fractions: [0.3, 0.7], focus: 0 });
    st().setProject(project());
    st().setTerminals(LIST);
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
    expect(st().split.fractions).toEqual([0.3, 0.7]);
    expect(st().selectedId).toBe('a');
    invariant();
  });
  test('also when the list comes before the project', () => {
    save('/p', v2([['t:a'], ['t:b']], 1));
    st().setTerminals(LIST);
    st().setProject(project());
    expect(tabs()).toEqual([['t:a'], ['t:b', 't:c']]);
    expect(st().selectedId).toBe('b');
    invariant();
  });
  test('an empty first list does not use up the restore', () => {
    save('/p', v2([['t:a'], ['t:b']]));
    st().setProject(project());
    st().setTerminals([]);
    st().setTerminals(LIST);
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
  });
  test('dead terminals and other projects\' terminals drop out; fewer than two panes: one pane', () => {
    save('/p', v2([['t:a'], ['t:zz'], ['t:q']], 1));
    st().setProject(project());
    st().setTerminals([term('q', 0, '/other'), ...LIST]);
    expect(isSplit(st().split)).toBe(false);
    expect(st().selectedId).toBe('c');
  });
  test('hidden terminals named in the layout get their tab back in their pane', () => {
    saved.set('atelier.hiddenTabs', JSON.stringify({ '/p': ['a'] }));
    save('/p', v2([['t:a'], ['t:b']], 1));
    st().setProject(project());
    st().setTerminals(LIST);
    expect(tabs()).toEqual([['t:a'], ['t:b', 't:c']]);
    expect(st().hidden).not.toContain('a');
    invariant();
  });
  test('only once per window: later lists never bring it back', () => {
    save('/p', v2([['t:a'], ['t:b']]));
    st().setProject(project());
    st().setTerminals(LIST);
    st().closeOtherPanes();
    st().setTerminals([...LIST, term('d', 4)]);
    expect(isSplit(st().split)).toBe(false);
  });
  test('saved (debounced, v2) on every split change, only after the restore; one pane removes the entry', () => {
    vi.useFakeTimers();
    const first = v2([['t:a'], ['t:b']]);
    save('/p', first);
    st().setProject(project());
    vi.advanceTimersByTime(1000);
    expect(layouts()['/p']).toEqual(first);
    st().setTerminals(LIST);
    st().setFractions([0.25, 0.75]);
    st().focusPane(1);
    vi.advanceTimersByTime(100);
    expect(layouts()['/p']).toEqual(first);
    vi.advanceTimersByTime(300);
    expect(layouts()['/p']).toEqual({ v: 2, panes: [{ tabs: ['t:a', 't:c'], front: 't:a' }, { tabs: ['t:b'], front: 't:b' }], fractions: [0.25, 0.75], focus: 1 });
    st().closeOtherPanes();
    vi.advanceTimersByTime(400);
    expect(layouts()['/p']).toBeUndefined();
  });
  test('a split made before the restore cancels it', () => {
    save('/p', v2([['t:a'], ['t:b']]));
    st().setTerminals(LIST.slice(0, 2));
    useApp.setState({ project: null });
    st().splitRight();
    st().setProject(project());
    st().setTerminals(LIST);
    expect(tabs()).toEqual([['t:a', 't:b', 't:c'], []]);
  });
});

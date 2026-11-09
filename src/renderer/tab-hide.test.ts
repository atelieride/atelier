import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useApp } from './store';
import type { TerminalInfo } from '@shared/protocol';

// Closing a terminal's tab only hides the tab: the terminal keeps running in atelierd and stays in the sidebar.
const term = (id: string, createdAt: number): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt, session: null });
const abc = () => [term('a', 1), term('b', 2), term('c', 3)];
const close = vi.fn(async () => {});
const g = globalThis as { window?: unknown; localStorage?: unknown };
const st = () => useApp.getState();

beforeEach(() => {
  g.window = { atelier: { terminals: { close } } };
  close.mockClear();
  useApp.setState({ project: null, openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], selectedId: null, pendingAnchor: null, hidden: [], servicesOpen: false, review: null, dirty: {}, preview: null });
});
afterEach(() => { delete g.window; });

test('closing a terminal tab hides it: no close request, the terminal stays, the neighbor becomes active', () => {
  st().setTerminals(abc());
  st().select('b');
  st().closeTab('t:b');
  expect(close).not.toHaveBeenCalled();
  expect(st().terminals.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  expect(st().tabOrder).toEqual(['t:a', 't:c']);
  expect(st().hidden).toEqual(['b']);
  expect(st().activeKey()).toBe('t:c');
});

test('⌘W (no argument) on the active terminal hides it too', () => {
  st().setTerminals(abc());
  st().select('c');
  st().closeTab();
  expect(close).not.toHaveBeenCalled();
  expect(st().tabOrder).toEqual(['t:a', 't:b']);
  expect(st().activeKey()).toBe('t:b');
});

test('a hidden terminal does not come back with the next lists; a new terminal still opens as a tab', () => {
  st().setTerminals(abc());
  st().closeTab('t:b');
  st().setTerminals(abc());
  expect(st().tabOrder).toEqual(['t:a', 't:c']);
  st().setTerminals([...abc(), term('d', 4)]);
  expect(st().tabOrder).toContain('t:d');
  expect(st().tabOrder).not.toContain('t:b');
});

test('selecting a hidden terminal (sidebar, palette, ⌘J…) shows its tab next to the active one and activates it', () => {
  st().setTerminals(abc());
  st().closeTab('t:b');
  st().select('a');
  st().select('b');
  expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
  expect(st().hidden).toEqual([]);
  expect(st().activeKey()).toBe('t:b');
  // It stays shown when the list comes again.
  st().setTerminals(abc());
  expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
});

test('Close Others / Close All hide terminal tabs without any confirmation', async () => {
  st().setTerminals(abc());
  st().openFile('/p/x.ts', 'x.ts');
  await st().closeTabs(['t:a', 't:b', 't:c']);
  expect(close).not.toHaveBeenCalled();
  expect(st().tabOrder).toEqual(['f:/p/x.ts']);
  expect(st().activeTab).toBe('/p/x.ts');
  expect(st().terminals).toHaveLength(3);
});

test('no tabs left: the empty state (no selection), and a new list does not pick a hidden terminal', async () => {
  st().setTerminals(abc());
  await st().closeTabs(['t:a', 't:b', 't:c']);
  expect(st().tabOrder).toEqual([]);
  expect(st().activeTab).toBe('term');
  expect(st().selectedId).toBeNull();
  st().setTerminals(abc());
  expect(st().selectedId).toBeNull();
  expect(st().tabOrder).toEqual([]);
});

test('hiding the selected terminal behind an active file moves the selection to a terminal still in the tabs', async () => {
  st().setTerminals(abc());
  st().select('a');
  st().openFile('/p/x.ts', 'x.ts');
  await st().closeTabs(['t:a']);
  expect(st().activeTab).toBe('/p/x.ts');
  expect(st().selectedId).toBe('c');
  // Closing the file afterwards shows a tab, never the hidden terminal.
  await st().closeTabs(['t:b', 't:c']);
  st().closeTab();
  expect(st().activeTab).toBe('term');
  expect(st().selectedId).toBeNull();
});

test('closing a tab that is not there (already hidden) does nothing', () => {
  st().setTerminals(abc());
  st().select('a');
  st().closeTab('t:b');
  st().closeTab('t:b');
  expect(st().tabOrder).toEqual(['t:a', 't:c']);
  expect(st().activeKey()).toBe('t:a');
});

test('remembered per project, pruned like the pins (never by an empty list); a list before the project loses its hidden tabs', () => {
  const saved = new Map<string, string>([['atelier.hiddenTabs', JSON.stringify({ '/p': ['b', 'gone'], '/other': ['x'] })]]);
  const prev = g.localStorage;
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  try {
    // The list arrives first: every terminal has a tab until the project (and its hidden set) is known.
    st().setTerminals(abc());
    st().select('b');
    st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    expect(st().hidden).toEqual(['b']);
    expect(st().tabOrder).toEqual(['t:a', 't:c']);
    expect(st().selectedId).not.toBe('b');
    expect(JSON.parse(saved.get('atelier.hiddenTabs')!)).toEqual({ '/other': ['x'], '/p': ['b'] });
    st().setTerminals([]);
    expect(st().hidden).toEqual(['b']);
    st().setTerminals(abc());
    st().closeTab('t:c');
    expect(JSON.parse(saved.get('atelier.hiddenTabs')!)['/p']).toEqual(['b', 'c']);
    st().select('b');
    expect(JSON.parse(saved.get('atelier.hiddenTabs')!)['/p']).toEqual(['c']);
    // A terminal closed for real leaves the hidden set.
    st().setTerminals([term('a', 1), term('b', 2)]);
    expect(st().hidden).toEqual([]);
  } finally {
    g.localStorage = prev;
  }
});

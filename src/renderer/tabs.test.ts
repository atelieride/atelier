import { beforeEach, expect, test } from 'vitest';
import { useApp } from './store';

import type { TerminalInfo } from '@shared/protocol';

const term = (id: string, createdAt: number): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'zsh', createdAt, session: null });

beforeEach(() => useApp.setState({ openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], selectedId: null, servicesOpen: false }));

test('opening a file adds a tab and activates it', () => {
  useApp.getState().openFile('/p/a.ts', 'a.ts', 14);
  expect(useApp.getState().activeTab).toBe('/p/a.ts');
  expect(useApp.getState().openFiles).toMatchObject([{ path: '/p/a.ts', line: 14 }]);
});
test('reopening the same file does not duplicate it and updates the line', () => {
  const s = useApp.getState();
  s.openFile('/p/a.ts', 'a.ts', 3);
  s.openFile('/p/b.ts', 'b.ts');
  s.openFile('/p/a.ts', 'a.ts', 40);
  const st = useApp.getState();
  expect(st.openFiles.map((f) => f.path)).toEqual(['/p/a.ts', '/p/b.ts']);
  expect(st.openFiles[0]).toMatchObject({ line: 40 });
  expect(st.activeTab).toBe('/p/a.ts');
});
test('closing the active tab moves to the neighboring one, then to the terminal', () => {
  const s = useApp.getState();
  s.openFile('/p/a.ts', 'a.ts');
  s.openFile('/p/b.ts', 'b.ts');
  s.closeTab();
  expect(useApp.getState().activeTab).toBe('/p/a.ts');
  useApp.getState().closeTab();
  expect(useApp.getState().activeTab).toBe('term');
  useApp.getState().closeTab(); // on the terminal it does nothing
  expect(useApp.getState().activeTab).toBe('term');
});
test('selecting a session goes back to the terminal', () => {
  useApp.getState().openFile('/p/a.ts', 'a.ts');
  useApp.getState().select('x');
  expect(useApp.getState().activeTab).toBe('term');
});

test('each terminal has its own tab, and the first list shows the most recent', () => {
  useApp.getState().setTerminals([term('a', 1), term('b', 2)]);
  const st = useApp.getState();
  expect(st.tabOrder).toEqual(['t:a', 't:b']);
  expect(st.selectedId).toBe('b');
});
test('a file opens next to the active tab; closing it goes back to the tab it was opened from', () => {
  const s = useApp.getState();
  s.setTerminals([term('a', 1), term('b', 2)]);
  s.select('a');
  s.openFile('/p/x.ts', 'x.ts');
  expect(useApp.getState().tabOrder).toEqual(['t:a', 'f:/p/x.ts', 't:b']);
  useApp.getState().closeTab();
  const st = useApp.getState();
  expect(st.activeTab).toBe('term');
  expect(st.selectedId).toBe('a');
});
test('the active terminal disappearing gives way to the neighboring tab', () => {
  const s = useApp.getState();
  s.setTerminals([term('a', 1), term('b', 2), term('c', 3)]);
  s.select('b');
  useApp.getState().setTerminals([term('a', 1), term('c', 3)]);
  const st = useApp.getState();
  expect(st.tabOrder).toEqual(['t:a', 't:c']);
  expect(st.selectedId).toBe('c');
  expect(st.activeTab).toBe('term');
});
test('reordering by dragging', () => {
  const s = useApp.getState();
  s.setTerminals([term('a', 1), term('b', 2)]);
  s.moveTab('t:b', 't:a');
  expect(useApp.getState().tabOrder).toEqual(['t:b', 't:a']);
});
test('closing several file tabs at once (no confirmation needed without terminals)', async () => {
  const s = useApp.getState();
  s.openFile('/p/a.ts', 'a.ts');
  s.openFile('/p/b.ts', 'b.ts');
  s.openFile('/p/c.ts', 'c.ts');
  await useApp.getState().closeTabs(['f:/p/b.ts', 'f:/p/c.ts']);
  const st = useApp.getState();
  expect(st.openFiles.map((f) => f.path)).toEqual(['/p/a.ts']);
  expect(st.activeTab).toBe('/p/a.ts');
});

test('a terminal created from the UI enters next to the active tab (select arrives before the list)', () => {
  const s = useApp.getState();
  s.setTerminals([term('a', 1), term('b', 2), term('c', 3)]);
  s.select('a');
  useApp.getState().select('d');
  useApp.getState().setTerminals([term('a', 1), term('b', 2), term('c', 3), term('d', 4)]);
  expect(useApp.getState().tabOrder).toEqual(['t:a', 't:d', 't:b', 't:c']);
});
test('with an active file the new terminal enters after the file', () => {
  const s = useApp.getState();
  s.setTerminals([term('a', 1), term('b', 2)]);
  s.select('a');
  useApp.getState().openFile('/p/x.ts', 'x.ts');
  useApp.getState().select('c');
  useApp.getState().setTerminals([term('a', 1), term('b', 2), term('c', 3)]);
  expect(useApp.getState().tabOrder).toEqual(['t:a', 'f:/p/x.ts', 't:c', 't:b']);
});
test('renaming a folder moves the tabs of the open files inside it; trashing it closes them', () => {
  const s = useApp.getState();
  s.openFile('/p/src/a.ts', 'src/a.ts');
  s.openFile('/p/b.ts', 'b.ts');
  useApp.getState().renameOpenFiles('/p/src', '/p/lib', '/p');
  let st = useApp.getState();
  expect(st.openFiles.map((f) => [f.path, f.rel])).toEqual([['/p/lib/a.ts', 'lib/a.ts'], ['/p/b.ts', 'b.ts']]);
  expect(st.tabOrder).toEqual(['f:/p/lib/a.ts', 'f:/p/b.ts']);
  useApp.getState().dropOpenFiles('/p/lib');
  st = useApp.getState();
  expect(st.openFiles.map((f) => f.path)).toEqual(['/p/b.ts']);
});

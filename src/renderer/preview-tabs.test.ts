import { beforeEach, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from './store';
import { registerSaver } from './editor/savers';

const preview = { preview: true } as const;

beforeEach(() => useApp.setState({ openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], selectedId: null, servicesOpen: false, preview: null, dirty: {}, settings: DEFAULT_SETTINGS }));

const paths = () => useApp.getState().openFiles.map((f) => f.path);

test('a single-click open replaces the preview tab in place; a normal tab stays', () => {
  const s = useApp.getState();
  s.openFile('/p/n.ts', 'n.ts');
  s.openFile('/p/a.ts', 'a.ts', null, undefined, preview);
  s.activate('f:/p/n.ts');
  useApp.getState().openFile('/p/b.ts', 'b.ts', null, undefined, preview);
  const st = useApp.getState();
  expect(st.tabOrder).toEqual(['f:/p/n.ts', 'f:/p/b.ts']);
  expect(paths()).toEqual(['/p/n.ts', '/p/b.ts']);
  expect(st.preview).toBe('/p/b.ts');
  expect(st.activeTab).toBe('/p/b.ts');
  expect(st.recentFiles.map((f) => f.path)).toContain('/p/a.ts');
});

test('a file already open as a normal tab is only activated', () => {
  const s = useApp.getState();
  s.openFile('/p/n.ts', 'n.ts');
  s.openFile('/p/a.ts', 'a.ts', null, undefined, preview);
  useApp.getState().openFile('/p/n.ts', 'n.ts', null, undefined, preview);
  expect(paths()).toEqual(['/p/n.ts', '/p/a.ts']);
  expect(useApp.getState().preview).toBe('/p/a.ts');
  expect(useApp.getState().activeTab).toBe('/p/n.ts');
});

test('promotion: a normal open (double click), Keep Open, typing, dragging', () => {
  const s = useApp.getState();
  s.openFile('/p/a.ts', 'a.ts', null, undefined, preview);
  useApp.getState().openFile('/p/a.ts', 'a.ts');
  expect(useApp.getState().preview).toBeNull();

  useApp.getState().openFile('/p/b.ts', 'b.ts', null, undefined, preview);
  useApp.getState().keepOpen('/p/b.ts');
  expect(useApp.getState().preview).toBeNull();

  useApp.getState().openFile('/p/c.ts', 'c.ts', null, undefined, preview);
  useApp.getState().setDirty('/p/c.ts', true);
  expect(useApp.getState().preview).toBeNull();

  useApp.getState().openFile('/p/d.ts', 'd.ts', null, undefined, preview);
  useApp.getState().moveTab('f:/p/d.ts', 'f:/p/a.ts');
  expect(useApp.getState().preview).toBeNull();
  expect(paths()).toEqual(['/p/a.ts', '/p/b.ts', '/p/c.ts', '/p/d.ts']);
});

test('a preview tab with edits not yet reported (typed just now) is kept, not replaced', () => {
  useApp.getState().openFile('/p/a.ts', 'a.ts', null, undefined, preview);
  const off = registerSaver('/p/a.ts', async () => true, () => true);
  try {
    useApp.getState().openFile('/p/b.ts', 'b.ts', null, undefined, preview);
    expect(paths()).toEqual(['/p/a.ts', '/p/b.ts']);
    expect(useApp.getState().preview).toBe('/p/b.ts');
  } finally { off(); }
});

test('closing the preview tab forgets it: reopening the file normally is not italic', async () => {
  useApp.getState().openFile('/p/a.ts', 'a.ts', null, undefined, preview);
  useApp.getState().closeTab('/p/a.ts');
  expect(useApp.getState().preview).toBeNull();
  useApp.getState().openFile('/p/b.ts', 'b.ts', null, undefined, preview);
  await useApp.getState().closeTabs(['f:/p/b.ts']);
  expect(useApp.getState().preview).toBeNull();
  useApp.getState().openFile('/p/c.ts', 'c.ts', null, undefined, preview);
  useApp.getState().dropOpenFiles('/p/c.ts');
  expect(useApp.getState().preview).toBeNull();
});

test('renaming the preview file keeps it the preview under its new path', () => {
  useApp.getState().openFile('/p/src/a.ts', 'src/a.ts', null, undefined, preview);
  useApp.getState().renameOpenFiles('/p/src', '/p/lib', '/p');
  expect(useApp.getState().preview).toBe('/p/lib/a.ts');
});

test('setting off: every open is a normal tab, and turning it off promotes the current preview', () => {
  useApp.getState().openFile('/p/a.ts', 'a.ts', null, undefined, preview);
  useApp.getState().setSettings({ ...DEFAULT_SETTINGS, previewTabs: false });
  expect(useApp.getState().preview).toBeNull();
  useApp.getState().openFile('/p/b.ts', 'b.ts', null, undefined, preview);
  expect(paths()).toEqual(['/p/a.ts', '/p/b.ts']);
  expect(useApp.getState().preview).toBeNull();
});

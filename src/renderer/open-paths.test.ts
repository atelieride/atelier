import { beforeEach, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { OpenPathsEvent } from '@shared/files';
import { useApp } from './store';
import { applyOpenPaths, openPathsToast } from './open-paths';

const ev = (o: Partial<OpenPathsEvent>): OpenPathsEvent => ({ files: [], reveal: null, skipped: 0, capped: null, needsProject: 0, ...o });

beforeEach(() => useApp.setState({ openFiles: [], activeTab: 'term', tabOrder: [], terminals: [], selectedId: null, preview: null, dirty: {}, toast: null, treeReveal: null, settings: { ...DEFAULT_SETTINGS, previewTabs: true } }));

test('files open as normal tabs (never the preview), the last one in front', () => {
  applyOpenPaths(ev({ files: [{ path: '/p/a.ts', rel: 'a.ts', external: false }, { path: '/h/x.json', rel: '~/x.json', external: true }] }));
  const st = useApp.getState();
  expect(st.openFiles.map((f) => [f.path, f.rel])).toEqual([['/p/a.ts', 'a.ts'], ['/h/x.json', '~/x.json']]);
  expect(st.preview).toBeNull();
  expect(st.activeTab).toBe('/h/x.json');
});

test('a file sent with a line opens at that line', () => {
  applyOpenPaths(ev({ files: [{ path: '/p/a.ts', rel: 'a.ts', external: false, line: 42 }] }));
  expect(useApp.getState().openFiles[0]).toMatchObject({ path: '/p/a.ts', line: 42 });
  applyOpenPaths(ev({ files: [{ path: '/p/b.ts', rel: 'b.ts', external: false }] }));
  expect(useApp.getState().openFiles[1]).toMatchObject({ path: '/p/b.ts', line: null });
});

test('a project folder is revealed in the Files tree', () => {
  applyOpenPaths(ev({ reveal: '/p/src' }));
  expect(useApp.getState().treeReveal?.path).toBe('/p/src');
  expect(useApp.getState().activity).toBe('files');
});

test('a shelf file main did not grant again at launch is no longer missing once opened again (Open File…, Finder)', () => {
  useApp.setState({ shelfUngranted: ['/h/gone.sql', '/h/other.sql'] });
  applyOpenPaths(ev({ files: [{ path: '/h/gone.sql', rel: '~/gone.sql', external: true }] }));
  expect(useApp.getState().shelfUngranted).toEqual(['/h/other.sql']);
  useApp.setState({ shelfUngranted: [] });
});

test('one toast says what did not open', () => {
  expect(openPathsToast(ev({ files: [{ path: '/a', rel: 'a', external: false }] }))).toBeNull();
  expect(openPathsToast(ev({ capped: 31 }))).toBe('Opened 20 of 31 files.');
  expect(openPathsToast(ev({ skipped: 1 }))).toBe("1 item couldn't be opened.");
  expect(openPathsToast(ev({ skipped: 3 }))).toBe("3 items couldn't be opened.");
  expect(openPathsToast(ev({ capped: 31, skipped: 2 }))).toBe("Opened 20 of 31 files. 2 items couldn't be opened.");
  expect(openPathsToast(ev({ needsProject: 2 }))).toBe('Open a folder first to open files.');
  applyOpenPaths(ev({ skipped: 1 }));
  expect(useApp.getState().toast?.text).toBe("1 item couldn't be opened.");
});

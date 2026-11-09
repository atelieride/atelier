import { beforeEach, expect, test } from 'vitest';
import { useApp } from './store';

const project = { root: '/p', realRoot: '/p', name: 'p' } as unknown as ReturnType<typeof useApp.getState>['project'];

beforeEach(() => useApp.setState({ project, activity: 'sessions', activeTab: 'term', openFiles: [], treeReveal: null }));

test('opening Files with a project file in front shows that file in the tree, quietly', () => {
  useApp.setState({ activeTab: '/p/src/deep/a.ts' });
  useApp.getState().setActivity('files');
  expect(useApp.getState().activity).toBe('files');
  expect(useApp.getState().treeReveal).toMatchObject({ path: '/p/src/deep/a.ts', quiet: true });
});

test('a project opened through a link: a file under its real root is a project file too', () => {
  useApp.setState({ project: { ...project!, root: '/var/p', realRoot: '/private/var/p' }, activeTab: '/private/var/p/a.ts' });
  useApp.getState().setActivity('files');
  expect(useApp.getState().treeReveal?.path).toBe('/private/var/p/a.ts');
});

test('a terminal, a file outside the project or an untitled tab in front: nothing to show, and no old reveal comes back', () => {
  useApp.setState({ treeReveal: { path: '/p/old.ts', nonce: 1 } });
  useApp.getState().setActivity('files');
  expect(useApp.getState().treeReveal).toBeNull();
  for (const activeTab of ['/elsewhere/x.ts', 'untitled:1']) {
    useApp.setState({ activity: 'sessions', activeTab });
    useApp.getState().setActivity('files');
    expect(useApp.getState().treeReveal).toBeNull();
  }
});

test('Files already open, or opened to collapse its folders: the tree is left as it is', () => {
  useApp.setState({ activity: 'files', activeTab: '/p/a.ts' });
  useApp.getState().setActivity('files');
  expect(useApp.getState().treeReveal).toBeNull();
  useApp.setState({ activity: 'sessions' });
  useApp.getState().setActivity('files', { reveal: false });
  expect(useApp.getState().treeReveal).toBeNull();
});

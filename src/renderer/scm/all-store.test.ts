import { afterEach, beforeEach, expect, test } from 'vitest';
import { useApp } from '../store';

// Source Control's view (One or All Repositories) and the blocks folded by hand: per project, back with the project,
// in a pop-out too.

const saved = new Map<string, string>();
const g = globalThis as { localStorage?: unknown };
beforeEach(() => {
  saved.clear();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  useApp.setState({ project: null, scmView: 'one', scmFolds: {} });
});
afterEach(() => { delete g.localStorage; });

test('the view and the folds are saved per project and come back with it', () => {
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  useApp.getState().setScmView('all');
  useApp.getState().setScmFold('/p/api', true, false);
  useApp.getState().setScmFold('/p/api/.wt/x', false, true);
  expect(useApp.getState()).toMatchObject({ scmView: 'all', scmFolds: { '/p/api': true, '/p/api/.wt/x': false } });
  useApp.setState({ scmView: 'one', scmFolds: {} });
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  expect(useApp.getState()).toMatchObject({ scmView: 'all', scmFolds: { '/p/api': true, '/p/api/.wt/x': false } });
  // Another project starts as today: One, nothing folded by hand.
  useApp.getState().setProject({ root: '/q', name: 'q', realRoot: '/q' });
  expect(useApp.getState()).toMatchObject({ scmView: 'one', scmFolds: {} });
});

test('a fold back to its default is forgotten, not kept: only folds by hand take room', () => {
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  useApp.getState().setScmFold('/p/api', true, false);
  useApp.getState().setScmFold('/p/api', false, false);
  useApp.getState().setScmFold('/p/api/.wt/x', false, true);
  useApp.getState().setScmFold('/p/api/.wt/x', true, true);
  expect(useApp.getState().scmFolds).toEqual({});
});

test('a pop-out reads them too', () => {
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
  useApp.getState().setScmView('all');
  useApp.setState({ scmView: 'one', project: null });
  useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p', popout: { key: 't:b' } });
  expect(useApp.getState().scmView).toBe('all');
});

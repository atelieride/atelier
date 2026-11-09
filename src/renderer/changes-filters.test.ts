import { expect, test } from 'vitest';
import { filtersView } from './changes-filters';

test('the Filters funnel: lit when the view is not the usual one, its tooltip says which', () => {
  // The usual view: by repository, every change of the project.
  expect(filtersView('repo', 'all', true)).toEqual({ changed: false, tip: 'Filters' });
  expect(filtersView('session', 'all', true)).toEqual({ changed: true, tip: 'Filters · by session' });
  expect(filtersView('repo', 'ws', true)).toEqual({ changed: true, tip: 'Filters · this workspace' });
  expect(filtersView('session', 'ws', true)).toEqual({ changed: true, tip: 'Filters · by session · this workspace' });
  // Workspaces off: the scope means nothing.
  expect(filtersView('repo', 'ws', false)).toEqual({ changed: false, tip: 'Filters' });
});

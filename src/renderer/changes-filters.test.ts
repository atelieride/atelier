import { expect, test } from 'vitest';
import { filtersView } from './changes-filters';

const ALL4 = ['all', 'ws', 'activity', 'session'] as const;

test('the Filters funnel: lit when the view is not the usual one, its tooltip says which', () => {
  // The usual view: by repository, every change of the project.
  expect(filtersView('repo', 'all', ALL4)).toEqual({ changed: false, tip: 'Filters' });
  expect(filtersView('session', 'all', ALL4)).toEqual({ changed: true, tip: 'Filters · by session' });
  expect(filtersView('repo', 'ws', ALL4)).toEqual({ changed: true, tip: 'Filters · this workspace' });
  expect(filtersView('session', 'ws', ALL4)).toEqual({ changed: true, tip: 'Filters · by session · this workspace' });
  expect(filtersView('repo', 'activity', ALL4)).toEqual({ changed: true, tip: 'Filters · this activity' });
  expect(filtersView('repo', 'session', ['all', 'session'])).toEqual({ changed: true, tip: 'Filters · this session' });
});

test('the Filters funnel: a choice no longer offered (its feature turned off) is no filter', () => {
  expect(filtersView('repo', 'ws', ['all', 'session'])).toEqual({ changed: false, tip: 'Filters' });
  expect(filtersView('repo', 'activity', ['all', 'ws', 'session'])).toEqual({ changed: false, tip: 'Filters' });
  expect(filtersView('repo', 'session', ['all'])).toEqual({ changed: false, tip: 'Filters' });
});

import { expect, test } from 'vitest';
import { distinctNames } from './repo-names';

// Changes names repositories by their folder. Deeper discovery finds `group/subgroup/project` layouts where names repeat:
// only those show the end of their path that tells them apart.

const names = (roots: string[], project = '/p') => Object.fromEntries(distinctNames(roots, project));

test('names nobody else has stay as they are', () => {
  expect(names(['/p/api', '/p/web', '/p/g/s/billing'])).toEqual({ '/p/api': 'api', '/p/web': 'web', '/p/g/s/billing': 'billing' });
});

test('the same name in two groups: the shortest end of each path that differs', () => {
  expect(names(['/p/team-a/tools/ci', '/p/team-b/tools/ci', '/p/api'])).toEqual({
    '/p/team-a/tools/ci': 'team-a/tools/ci', '/p/team-b/tools/ci': 'team-b/tools/ci', '/p/api': 'api'
  });
  expect(names(['/p/a/x/api', '/p/b/y/api'])).toEqual({ '/p/a/x/api': 'x/api', '/p/b/y/api': 'y/api' });
});

test('one path is the end of the other: the shorter keeps its whole path', () => {
  expect(names(['/p/ci', '/p/team-a/ci'])).toEqual({ '/p/ci': 'ci', '/p/team-a/ci': 'team-a/ci' });
});

test('three of a kind, two of them close', () => {
  expect(names(['/p/a/s/api', '/p/b/s/api', '/p/c/api'])).toEqual({ '/p/a/s/api': 'a/s/api', '/p/b/s/api': 'b/s/api', '/p/c/api': 'c/api' });
});

test('the project root is named by its folder, and clashes like any other', () => {
  expect(names(['/w/api', '/w/api/api'], '/w/api')).toEqual({ '/w/api': 'api', '/w/api/api': 'api/api' });
  expect(names(['/w/shop'], '/w/shop')).toEqual({ '/w/shop': 'shop' });
});

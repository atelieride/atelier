import { expect, test } from 'vitest';
import { baselineFor } from './baseline';
import type { RepoStatus } from '@shared/git';

const repo: RepoStatus = {
  root: '/p/app', name: 'app', branch: 'dev', detached: false, ahead: 0, behind: 0, oid: 'abc', checkedAt: 0, truncated: 0,
  changes: [
    { path: '/p/app/m.ts', rel: 'm.ts', kind: 'M', stage: 'none', added: 1, removed: 1 },
    { path: '/p/app/n.ts', rel: 'n.ts', kind: '?', stage: 'none', added: 3, removed: 0 },
    { path: '/p/app/a.ts', rel: 'a.ts', kind: 'A', stage: 'all', added: 3, removed: 0 },
    { path: '/p/app/after.ts', rel: 'after.ts', origRel: 'before.ts', kind: 'R', stage: 'all', added: 0, removed: 0 }
  ]
};

test('outside every repo → no comparison', () => expect(baselineFor('/other/x.ts', [repo])).toEqual({ kind: 'none' }));
test('clean or ignored (no status row) → no marker', () => expect(baselineFor('/p/app/clean.ts', [repo])).toEqual({ kind: 'clean' }));
test('new or added → everything added', () => {
  expect(baselineFor('/p/app/n.ts', [repo])).toEqual({ kind: 'new' });
  expect(baselineFor('/p/app/a.ts', [repo])).toEqual({ kind: 'new' });
});
test('modified → HEAD of the same file, tied to the commit', () => {
  expect(baselineFor('/p/app/m.ts', [repo])).toEqual({ kind: 'head', headPath: '/p/app/m.ts', oid: 'abc' });
});
test('renamed → HEAD of the old name', () => {
  expect(baselineFor('/p/app/after.ts', [repo])).toEqual({ kind: 'head', headPath: '/p/app/before.ts', oid: 'abc' });
});
test('nested repos: the deepest wins', () => {
  const outer: RepoStatus = { ...repo, root: '/p', changes: [] };
  expect(baselineFor('/p/app/m.ts', [outer, repo])).toMatchObject({ kind: 'head' });
});

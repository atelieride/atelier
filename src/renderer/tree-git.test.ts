import { expect, test } from 'vitest';
import { TREE_GIT_LETTER, treeGitMap } from './tree-git';
import type { ChangeKind, RepoStatus } from '@shared/git';

const repo = (root: string, changes: [string, ChangeKind][]): RepoStatus => ({
  root, name: root.split('/').at(-1)!, branch: 'main', detached: false, ahead: 0, behind: 0, oid: 'abc', checkedAt: 0, truncated: 0,
  changes: changes.map(([rel, kind]) => ({ path: `${root}/${rel}`, rel, kind, stage: 'none' as const, added: 1, removed: 0 }))
});

test('files take the kind of their change; deleted files are not in the tree', () => {
  const { files } = treeGitMap([repo('/p', [['a.ts', 'M'], ['b.ts', 'A'], ['c.ts', '?'], ['d.ts', 'R'], ['e.ts', 'U'], ['f.ts', 'D']])], '/p');
  expect(Object.fromEntries(files)).toEqual({ '/p/a.ts': 'modified', '/p/b.ts': 'added', '/p/c.ts': 'untracked', '/p/d.ts': 'renamed', '/p/e.ts': 'conflict' });
});

test('letters: M modified, A added, U untracked, R renamed, ! conflict', () => {
  expect(TREE_GIT_LETTER).toEqual({ modified: 'M', added: 'A', untracked: 'U', renamed: 'R', conflict: '!' });
});

test('folders take the strongest kind among their descendants, up to the project root (excluded)', () => {
  const { dirs } = treeGitMap([repo('/p', [['src/x/a.ts', 'R'], ['src/b.ts', '?'], ['src/x/c.ts', 'M'], ['lib/d.ts', 'R'], ['lib/e.ts', 'A'], ['docs/f.md', 'U'], ['docs/g.md', 'M'], ['gone/h.ts', 'D']])], '/p');
  expect(Object.fromEntries(dirs)).toEqual({ '/p/src/x': 'modified', '/p/src': 'modified', '/p/lib': 'added', '/p/docs': 'conflict' });
  expect(dirs.has('/p')).toBe(false);
  expect(dirs.has('/')).toBe(false);
});

test('untracked children give their folder the added kind (same color, one dot)', () => {
  const { dirs } = treeGitMap([repo('/p', [['new/a.ts', '?']])], '/p');
  expect(dirs.get('/p/new')).toBe('added');
});

test('nested repos color the folders of the outer project too', () => {
  const { dirs, files } = treeGitMap([repo('/p', []), repo('/p/apps/web', [['src/a.ts', 'M']])], '/p');
  expect(files.get('/p/apps/web/src/a.ts')).toBe('modified');
  expect(dirs.get('/p/apps/web/src')).toBe('modified');
  expect(dirs.get('/p/apps/web')).toBe('modified');
  expect(dirs.get('/p/apps')).toBe('modified');
});

test('a path listed twice (staged and unstaged) keeps its strongest kind', () => {
  const { files } = treeGitMap([repo('/p', [['a.ts', 'R'], ['a.ts', 'M']])], '/p');
  expect(files.get('/p/a.ts')).toBe('modified');
});

test('changes of repos outside the project root add no folder dots', () => {
  const { dirs } = treeGitMap([repo('/elsewhere/r', [['a/b.ts', 'M']])], '/p');
  expect(dirs.size).toBe(0);
});

test('an untracked folder reported with a trailing slash maps to its path', () => {
  const { files, dirs } = treeGitMap([repo('/p', [['vendor/lib/', '?']])], '/p');
  expect(files.get('/p/vendor/lib')).toBe('untracked');
  expect(dirs.get('/p/vendor')).toBe('added');
});

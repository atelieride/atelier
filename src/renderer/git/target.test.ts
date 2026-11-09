import { expect, test } from 'vitest';
import type { FileChange } from '@shared/git';
import { defaultTarget, nextTarget, rootOf, stagedCount, undoTarget } from './target';

// The drawer's target: which working tree it commits to on opening and after a commit.

const ch = (rel: string, stage: FileChange['stage']): FileChange => ({ path: `/x/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0 });
const repo = (root: string, ...stages: FileChange['stage'][]) => ({ root, changes: stages.map((s, i) => ch(`f${i}`, s)) });

test('rootOf: the deepest repository holding the path (nested repositories, worktrees inside the project)', () => {
  const roots = ['/p', '/p/plugins/pay', '/p/plugins/payments'];
  expect(rootOf('/p/plugins/pay/src/a.ts', roots)).toBe('/p/plugins/pay');
  expect(rootOf('/p/plugins/payments/a.ts', roots)).toBe('/p/plugins/payments');
  expect(rootOf('/p/README.md', roots)).toBe('/p');
  expect(rootOf('/p', roots)).toBe('/p');
  expect(rootOf('/elsewhere/a.ts', roots)).toBeNull();
  expect(rootOf(null, roots)).toBeNull();
});

test('stagedCount: all and partial files count', () => {
  expect(stagedCount(repo('/a', 'all', 'partial', 'none'))).toBe(2);
});

test('1. the repository the drawer was opened for', () => {
  const repos = [repo('/a', 'all'), repo('/b', 'none')];
  expect(defaultTarget({ openedFor: '/b', lastStaged: '/a/f0', repos, activeFile: null })).toBe('/b');
  // Not listed (gone meanwhile): the next rule.
  expect(defaultTarget({ openedFor: '/gone', lastStaged: null, repos, activeFile: null })).toBe('/a');
});

test('2. else the repository of the last file staged in this window', () => {
  const repos = [repo('/a', 'all', 'all'), repo('/b', 'all')];
  expect(defaultTarget({ openedFor: null, lastStaged: '/b/src/x.ts', repos, activeFile: null })).toBe('/b');
  // Its repository has nothing left to commit (committed meanwhile): the next rule.
  expect(defaultTarget({ openedFor: null, lastStaged: '/c/x.ts', repos: [...repos, repo('/c')], activeFile: null })).toBe('/a');
});

test('3. else the one with the most staged files (the first on a tie)', () => {
  expect(defaultTarget({ openedFor: null, lastStaged: null, repos: [repo('/a', 'all', 'none'), repo('/b', 'all', 'partial'), repo('/c', 'all', 'all')], activeFile: '/a/x' })).toBe('/b');
});

test("4. else the active tab's repository, 5. else the first with changes", () => {
  const repos = [repo('/a', 'none'), repo('/b', 'none'), repo('/c')];
  expect(defaultTarget({ openedFor: null, lastStaged: null, repos, activeFile: '/b/src/x.ts' })).toBe('/b');
  expect(defaultTarget({ openedFor: null, lastStaged: null, repos, activeFile: '/c/x.ts' })).toBe('/a');
  expect(defaultTarget({ openedFor: null, lastStaged: null, repos, activeFile: null })).toBe('/a');
});

test('nothing changed anywhere: the active tab\'s repository (amend can reword), else the first, else none', () => {
  const repos = [repo('/a'), repo('/b')];
  expect(defaultTarget({ openedFor: null, lastStaged: null, repos, activeFile: '/b/x' })).toBe('/b');
  expect(defaultTarget({ openedFor: null, lastStaged: null, repos, activeFile: null })).toBe('/a');
  expect(defaultTarget({ openedFor: null, lastStaged: null, repos: [], activeFile: null })).toBeNull();
});

test('after a commit: the next repository in list order with staged files, wrapping around, never the one just committed', () => {
  const repos = [repo('/a', 'all'), repo('/b', 'none'), repo('/c', 'all'), repo('/d', 'partial')];
  expect(nextTarget(repos, '/c')).toBe('/d');
  expect(nextTarget(repos, '/d')).toBe('/a');
  // Its status still shows the staged files until the next read: skipped anyway.
  expect(nextTarget([repo('/a', 'all')], '/a')).toBeNull();
  expect(nextTarget([repo('/a', 'none'), repo('/b')], '/a')).toBeNull();
  // The committed repository is no longer listed: from the start.
  expect(nextTarget(repos, '/gone')).toBe('/a');
});

test('Git › Undo Last Commit: the target while main offers its Undo, else the latest commit main still offers', () => {
  const undo = (oid: string) => ({ undo: { oid, files: [] } });
  const facts = { '/a': undo('a1'), '/b': undo('b1'), '/c': { undo: null } };
  const results = { '/a': { sha: 'a1', at: 10, undo: { oid: 'a1' } }, '/b': { sha: 'b1', at: 20, undo: { oid: 'b1' } } };
  expect(undoTarget({ target: '/a', facts, results, roots: ['/a', '/b', '/c'] })).toEqual({ root: '/a', oid: 'a1' });
  // The drawer moved on to a repository without one: the latest commit.
  expect(undoTarget({ target: '/c', facts, results, roots: ['/a', '/b', '/c'] })).toEqual({ root: '/b', oid: 'b1' });
  expect(undoTarget({ target: null, facts, results, roots: ['/a', '/b', '/c'] })).toEqual({ root: '/b', oid: 'b1' });
  // Only this project's repositories; none offered: nothing to undo.
  expect(undoTarget({ target: '/c', facts, results, roots: ['/a', '/c'] })).toEqual({ root: '/a', oid: 'a1' });
  expect(undoTarget({ target: '/c', facts: { '/c': { undo: null } }, results, roots: ['/a', '/b', '/c'] })).toBeNull();
});

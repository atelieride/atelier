import { expect, test } from 'vitest';
import { foldsWhileOpen, groupShown, keptFamily, keptSession, toggleUnfold } from './fold';

// Folding while the drawer is open: every group but the one being committed folds to its header.

test('drawer closed: nothing folds because of it', () => {
  expect(foldsWhileOpen('/b', '/a', { open: false, unfolded: [] })).toBe(false);
});

test('drawer open: every group but the kept one folds, unless unfolded by hand', () => {
  const s = { open: true, unfolded: ['/c'] };
  expect(foldsWhileOpen('/a', '/a', s)).toBe(false);
  expect(foldsWhileOpen('/b', '/a', s)).toBe(true);
  expect(foldsWhileOpen('/c', '/a', s)).toBe(false);
  // Nothing to keep (no target yet): all fold.
  expect(foldsWhileOpen('/a', null, { open: true, unfolded: [] })).toBe(true);
});

test("a chevron click unfolds a folded group, a second one folds it again; unfolds don't pile up", () => {
  expect(toggleUnfold([], '/b')).toEqual(['/b']);
  expect(toggleUnfold(['/b'], '/b')).toEqual([]);
  expect(toggleUnfold(['/b'], '/c')).toEqual(['/b', '/c']);
});

test('by session: the session the drawer was opened for stays open, else the one holding the last staged file', () => {
  const sessions = [{ key: 't1', paths: ['/p/a.ts'] }, { key: 't2', paths: ['/p/b.ts', '/p/c.ts'] }];
  expect(keptSession({ openedFor: 't1', lastStaged: '/p/c.ts', sessions })).toBe('t1');
  expect(keptSession({ openedFor: null, lastStaged: '/p/c.ts', sessions })).toBe('t2');
  expect(keptSession({ openedFor: 'gone', lastStaged: '/p/a.ts', sessions })).toBe('t1');
  expect(keptSession({ openedFor: null, lastStaged: '/p/z.ts', sessions })).toBeNull();
  expect(keptSession({ openedFor: null, lastStaged: null, sessions })).toBeNull();
});
test("a group's rows show: drawer closed or the kept group, as the user left it; any other only when unfolded by hand", () => {
  const closed = { open: false, unfolded: [] };
  expect(groupShown('repo:/b', 'repo:/a', closed, [])).toEqual({ open: true, unfoldable: false });
  expect(groupShown('repo:/b', 'repo:/a', closed, ['repo:/b'])).toEqual({ open: false, unfoldable: false });
  const open = { open: true, unfolded: ['repo:/c'] };
  expect(groupShown('repo:/a', 'repo:/a', open, [])).toEqual({ open: true, unfoldable: false });
  expect(groupShown('repo:/a', 'repo:/a', open, ['repo:/a'])).toEqual({ open: false, unfoldable: false });
  expect(groupShown('repo:/b', 'repo:/a', open, [])).toEqual({ open: false, unfoldable: true });
  // Unfolded by hand: open even when the user had collapsed it (or its chevron could never open it again).
  expect(groupShown('repo:/c', 'repo:/a', open, ['repo:/c'])).toEqual({ open: true, unfoldable: true });
});

test('by repository, the family that stays open: the target, or the repository one of whose worktrees is the target', () => {
  const families = [{ root: '/p/a', worktrees: ['/p/a/.wt/x'] }, { root: '/p/b', worktrees: [] }];
  expect(keptFamily('/p/b', families)).toBe('/p/b');
  expect(keptFamily('/p/a/.wt/x', families)).toBe('/p/a');
  expect(keptFamily('/p/gone', families)).toBeNull();
  expect(keptFamily(null, families)).toBeNull();
});

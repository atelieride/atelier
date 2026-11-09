import { expect, test } from 'vitest';
import { MenuStates } from './menu-state';
import { menuStateSchema } from './ipc-schemas';

// The application menu follows the window in front (the Git menu): each window reports its state;
// the menu shows the focused window's, else the last one heard from (windows in tests are never focused).

const NONE = { gitUndo: false, hasRepos: false, gitWrites: false, messages: false };
const A = { gitUndo: true, hasRepos: true, gitWrites: true, messages: true };
const B = { gitUndo: false, hasRepos: true, gitWrites: false, messages: true };

test('the focused window wins; none focused: the last window heard from; a closed window is forgotten', () => {
  const s = new MenuStates();
  // No window said anything yet: no repository, so no Git menu at all.
  expect(s.front(null)).toEqual(NONE);
  s.set(1, A);
  s.set(2, B);
  expect(s.front(1)).toEqual(A);
  expect(s.front(2)).toEqual(B);
  expect(s.front(null)).toEqual(B);
  s.set(1, A);
  expect(s.front(null)).toEqual(A);
  // A focused window that never said anything (Settings, a pop-out): nothing to show there.
  expect(s.front(7)).toEqual(NONE);
  s.drop(1);
  expect(s.front(1)).toEqual(NONE);
  expect(s.front(null)).toEqual(NONE);
});

test('the IPC schema: exactly the four booleans', () => {
  expect(menuStateSchema.safeParse(A).success).toBe(true);
  expect(menuStateSchema.safeParse({ ...A, gitUndo: 'yes' }).success).toBe(false);
  expect(menuStateSchema.safeParse({ ...A, hasRepos: 1 }).success).toBe(false);
  expect(menuStateSchema.safeParse({ gitUndo: true }).success).toBe(false);
  expect(menuStateSchema.safeParse({ ...A, other: 1 }).success).toBe(false);
  expect(menuStateSchema.safeParse(null).success).toBe(false);
});

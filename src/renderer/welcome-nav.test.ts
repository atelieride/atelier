import { expect, test } from 'vitest';
import { welcomeNext } from './welcome-nav';

// Items: 0 = "Open Folder", then the recent folders.

test('↓/↑ move one item and stop at both ends (no wrap-around)', () => {
  expect(welcomeNext(0, 'ArrowDown', 3)).toBe(1);
  expect(welcomeNext(1, 'ArrowDown', 3)).toBe(2);
  expect(welcomeNext(2, 'ArrowDown', 3)).toBe(2);
  expect(welcomeNext(2, 'ArrowUp', 3)).toBe(1);
  expect(welcomeNext(0, 'ArrowUp', 3)).toBe(0);
});

test('Home/End: the first and the last item', () => {
  expect(welcomeNext(2, 'Home', 4)).toBe(0);
  expect(welcomeNext(0, 'End', 4)).toBe(3);
});

test('nothing focused yet: an arrow lands on the first recent folder (Open Folder when there is none)', () => {
  expect(welcomeNext(null, 'ArrowDown', 3)).toBe(1);
  expect(welcomeNext(null, 'ArrowUp', 3)).toBe(1);
  expect(welcomeNext(null, 'ArrowDown', 1)).toBe(0);
  expect(welcomeNext(null, 'End', 3)).toBe(2);
});

test('other keys, or no item at all: nothing to move', () => {
  expect(welcomeNext(1, 'Enter', 3)).toBeNull();
  expect(welcomeNext(1, 'a', 3)).toBeNull();
  expect(welcomeNext(null, 'ArrowDown', 0)).toBeNull();
});

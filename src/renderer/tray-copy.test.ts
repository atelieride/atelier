import { expect, test } from 'vitest';
import { trayCopy } from './tray-copy';

// The session icons' words: a dot per session in macOS's menu bar, one icon in Windows'
// notification area.

test('macOS: the menu bar, a dot per session', () => {
  const c = trayCopy('darwin');
  expect(c.label).toBe('Sessions in the menu bar');
  expect(c.hint).toMatch(/^Atelier’s Λ for each session that needs you, in the colour of its state/);
  expect(c.command).toBe('Session icons in the menu bar');
});

test('Windows: one icon in the notification area, and closing the last window keeps Atelier there', () => {
  const c = trayCopy('win32');
  expect(c.label).toBe('Icon in the notification area');
  expect(c.hint).toMatch(/^A dot on Atelier’s icon when sessions need you/);
  expect(c.hint).toMatch(/Closing the last window keeps Atelier running there\.$/);
  expect(c.command).toBe('Atelier icon in the notification area');
});

import { afterEach, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { sessionPlusMenu } from './menus';
import type { MenuItem } from './menu-model';

// Sessions' "+": a drop-down with the two ways to start a session.

afterEach(() => resetPlatformForTests());

const items = (m: MenuItem[]) => m.filter((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep');

test('the Sessions "+" menu: New Claude Session ⌘N, then Session in Folder… ⌘⌥⇧N', () => {
  initPlatform('darwin');
  const session = vi.fn();
  const folder = vi.fn();
  const m = items(sessionPlusMenu({ session, folder }));
  expect(m.map((i) => [i.id, i.label, i.icon, i.hint])).toEqual([
    ['new-session', 'New Claude Session', 'sparkle', '⌘N'],
    ['session-in-folder', 'Session in Folder…', 'files', '⌘⌥⇧N']
  ]);
  m[0]!.run();
  expect(session).toHaveBeenCalledOnce();
  expect(folder).not.toHaveBeenCalled();
  m[1]!.run();
  expect(folder).toHaveBeenCalledOnce();
});

test('on Windows the hints are its keymap', () => {
  initPlatform('win32');
  expect(items(sessionPlusMenu({ session: () => {}, folder: () => {} })).map((i) => i.hint)).toEqual(['Ctrl+Shift+N', 'Ctrl+Alt+Shift+N']);
});

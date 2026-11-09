import { expect, test } from 'vitest';
import { acceleratorFor, formatAccelerator, windowsAccelerator } from './keys';
import { MENU_SPEC, NO_MENU_STATE, menuItems } from './menu-spec';
import { windowsMenu, type WinMenuItem } from './windows-menu';

// The Windows keymap: derived from macOS's, never a key a
// terminal program needs.

test('the design table', () => {
  const table: [string, string | null][] = [
    ['CmdOrCtrl+,', 'Ctrl+,'], ['CmdOrCtrl+N', 'Ctrl+Shift+N'], ['CmdOrCtrl+T', 'Ctrl+Shift+T'], ['CmdOrCtrl+Shift+N', 'Shift+Alt+N'],
    ['CmdOrCtrl+Alt+N', 'Ctrl+Alt+N'], ['CmdOrCtrl+Alt+Shift+N', 'Ctrl+Alt+Shift+N'], ['CmdOrCtrl+S', 'Ctrl+S'], ['CmdOrCtrl+Alt+S', 'Ctrl+Alt+S'], ['Ctrl+Cmd+N', null],
    ['CmdOrCtrl+O', 'Ctrl+Shift+O'], ['CmdOrCtrl+Alt+O', 'Ctrl+Alt+O'], ['CmdOrCtrl+Alt+R', 'Shift+Alt+R'], ['CmdOrCtrl+W', 'Ctrl+Shift+W'],
    ['CmdOrCtrl+Shift+W', 'Alt+F4'], ['CmdOrCtrl+K', 'Ctrl+Shift+K'], ['F1', 'F1'], ['CmdOrCtrl+Shift+P', 'Ctrl+Shift+P'],
    ['CmdOrCtrl+Shift+1', 'Ctrl+Shift+1'], ['CmdOrCtrl+Shift+2', 'Ctrl+Shift+2'], ['CmdOrCtrl+Shift+3', null],
    ['Ctrl+Shift+G', 'Ctrl+Shift+G'], ['Ctrl+Shift+D', 'Ctrl+Shift+D'], ['Ctrl+Shift+R', 'Ctrl+Shift+R'], ['Ctrl+Shift+B', 'Ctrl+Shift+B'], ['CmdOrCtrl+Alt+B', 'Ctrl+Alt+B'],
    ['CmdOrCtrl+0', 'Ctrl+0'], ['CmdOrCtrl+Shift+M', 'Shift+Alt+M'], ['CmdOrCtrl+Shift+J', 'Shift+Alt+J'], ['CmdOrCtrl+Shift+V', 'Shift+Alt+V'],
    ['CmdOrCtrl+\\', 'Ctrl+Shift+\\'], ['CmdOrCtrl+Alt+Right', 'Ctrl+Alt+Right'], ['CmdOrCtrl+Alt+Left', 'Ctrl+Alt+Left'],
    ['CmdOrCtrl+Shift+O', 'Shift+Alt+O'], ['CmdOrCtrl+Alt+K', 'Ctrl+Alt+K'], ['CmdOrCtrl+Alt+M', 'Ctrl+Alt+M'], ['CmdOrCtrl+J', 'Ctrl+Shift+J'],
    ['Alt+F5', 'Alt+F5'], ['Alt+Shift+F5', 'Alt+Shift+F5'], ['Ctrl+Tab', 'Ctrl+Tab'], ['Ctrl+Shift+Tab', 'Ctrl+Shift+Tab'],
    ['CmdOrCtrl+1', 'Ctrl+1'], ['CmdOrCtrl+9', 'Ctrl+9'], ['CmdOrCtrl+Alt+C', 'Ctrl+Alt+C'],
    // Sidebar: Ctrl+Shift+B, where ⌘B would go, is Databases'.
    ['CmdOrCtrl+B', 'Shift+Alt+B'],
    // Move Tab to Left/Right Pane: Ctrl+Win+arrows switch virtual desktops on Windows.
    ['Ctrl+Cmd+Left', 'Ctrl+Alt+Shift+Left'], ['Ctrl+Cmd+Right', 'Ctrl+Alt+Shift+Right']
  ];
  for (const [mac, win] of table) expect(windowsAccelerator(mac), mac).toBe(win);
});

test('no menu shortcut on Windows takes a terminal’s key: no Ctrl+letter (but Save), no Ctrl+Shift+C or V', () => {
  const accels = menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator ? [windowsAccelerator(i.accelerator)] : [])).filter((a): a is string => !!a);
  expect(accels.length).toBeGreaterThan(30);
  for (const a of accels) {
    if (a === 'Ctrl+S') continue; // editor-only: the terminal-first rule keeps it out of terminals
    expect(/^Ctrl\+[A-Z]$/.test(a), a).toBe(false);
    expect(['Ctrl+Shift+C', 'Ctrl+Shift+V'], a).not.toContain(a);
  }
  expect(new Set(accels).size, 'two commands on one key').toBe(accels.length);
});

test('one key, one item in the whole Windows menu: role keys (Close Window, Full Screen, the development-only ones) count too', () => {
  // Every condition on: each item that can show does.
  const every = Object.fromEntries(Object.keys(NO_MENU_STATE).map((k) => [k, true])) as unknown as typeof NO_MENU_STATE;
  const menus = windowsMenu(MENU_SPEC, { profiles: [], accounts: [], state: every, isPackaged: false });
  const keys: string[] = [];
  const walk = (items: readonly WinMenuItem[]) => {
    for (const i of items) { if (i.kind === 'item' && i.accel) keys.push(i.accel); else if (i.kind === 'submenu') walk(i.items); }
  };
  for (const m of menus) walk(m.items);
  expect(keys).toContain('Ctrl+Shift+N');
  expect(keys).toContain('F11');
  // Ask About This Session and the development-only DevTools: Chromium's two DevTools keys, one each.
  expect(keys).toContain('Ctrl+Shift+I');
  expect(keys).toContain('F12');
  expect(keys.filter((k, i) => keys.indexOf(k) !== i), 'two items on one key').toEqual([]);
});

test('labels: macOS as before, Windows as text', () => {
  expect(formatAccelerator(acceleratorFor('CmdOrCtrl+Shift+N', 'darwin')!, 'darwin')).toBe('⌘⇧N');
  expect(formatAccelerator(acceleratorFor('CmdOrCtrl+Shift+N', 'win32')!, 'win32')).toBe('Shift+Alt+N');
  expect(acceleratorFor('Ctrl+Cmd+N', 'win32')).toBe(null);
  expect(acceleratorFor('Ctrl+Cmd+N', 'darwin')).toBe('Ctrl+Cmd+N');
});

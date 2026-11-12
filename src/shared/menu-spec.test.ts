import { expect, test } from 'vitest';
import { MENU_SPEC, NO_MENU_STATE, menuItems, type MenuSpecItem } from './menu-spec';
import { windowsMenu, type WinMenuItem } from './windows-menu';

const items = menuItems(MENU_SPEC);
const accels = items.flatMap((i) => ('accelerator' in i && i.accelerator ? [i.accelerator] : []));

test('the menus, in the native order; the Edit and Window menus are platform roles', () => {
  expect(MENU_SPEC.map((m) => ('role' in m ? `role:${m.role}` : 'app' in m ? 'app' : m.label)))
    .toEqual(['app', 'File', 'role:editMenu', 'View', 'Git', 'Go', 'Review', 'role:windowMenu']);
});

test('every accelerator is unique: one key, one item', () => {
  expect(accels.length).toBeGreaterThan(30);
  expect(accels.filter((a, i) => accels.indexOf(a) !== i)).toEqual([]);
  // The same key spelled two ways (Ctrl+Cmd+N vs Cmd+Ctrl+N) would also clash: compare the modifier sets.
  const norm = accels.map((a) => { const p = a.split('+'); return [...p.slice(0, -1).sort(), p.at(-1)].join('+'); });
  expect(new Set(norm).size).toBe(norm.length);
});

test('commands: a few items send the same one on purpose (the palette on ⌘K, F1 and a hidden ⌘⇧P)', () => {
  const cmds = items.flatMap((i) => ('command' in i && i.command ? [i.command] : []));
  const dupes = [...new Set(cmds.filter((c, i) => cmds.indexOf(c) !== i))];
  expect(dupes).toEqual(['open-palette']);
  const palette = items.filter((i): i is Extract<MenuSpecItem, { command: string }> => 'command' in i && i.command === 'open-palette');
  expect(palette.map((i) => [i.accelerator, i.visible ?? true])).toEqual([['CmdOrCtrl+K', true], ['F1', true], ['CmdOrCtrl+Shift+P', false]]);
});

test('View: Move Tab to Left / Right Pane (⌃⌘← / ⌃⌘→) right after the pane focus keys', () => {
  const view = MENU_SPEC.find((m) => 'label' in m && m.label === 'View');
  const sub = view && 'submenu' in view ? view.submenu : [];
  const labels = sub.map((i) => ('label' in i ? i.label : '-'));
  const at = labels.indexOf('Focus Previous Pane');
  expect(labels.slice(at, at + 5)).toEqual(['Focus Previous Pane', 'Move Tab to Left Pane', 'Move Tab to Right Pane', 'Unsplit', 'Unsplit All']);
  expect(sub.find((i) => 'label' in i && i.label === 'Move Tab to Left Pane')).toEqual({ label: 'Move Tab to Left Pane', accelerator: 'Ctrl+Cmd+Left', command: 'move-tab-left' });
  expect(sub.find((i) => 'label' in i && i.label === 'Move Tab to Right Pane')).toEqual({ label: 'Move Tab to Right Pane', accelerator: 'Ctrl+Cmd+Right', command: 'move-tab-right' });
});

test('View › Sidebar (⌘B) right after Changes, showing or hiding the sidebar', () => {
  const view = MENU_SPEC.find((m) => 'label' in m && m.label === 'View');
  const sub = view && 'submenu' in view ? view.submenu : [];
  const labels = sub.map((i) => ('label' in i ? i.label : '-'));
  expect(labels[labels.indexOf('Changes') + 1]).toBe('Sidebar');
  expect(sub.find((i) => 'label' in i && i.label === 'Sidebar')).toEqual({ label: 'Sidebar', accelerator: 'CmdOrCtrl+B', command: 'toggle-sidebar' });
});

test('View › Find in Files (⇧⌘F) right after Files; on Windows the keymap gives it Shift+Alt+F, a key no other item has', () => {
  const view = MENU_SPEC.find((m) => 'label' in m && m.label === 'View');
  const sub = view && 'submenu' in view ? view.submenu : [];
  const labels = sub.map((i) => ('label' in i ? i.label : '-'));
  expect(labels[labels.indexOf('Files') + 1]).toBe('Find in Files');
  expect(sub.find((i) => 'label' in i && i.label === 'Find in Files')).toEqual({ label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', command: 'find-in-files' });
  // F4 / ⇧F4 are the page's own keys (a terminal keeps them): never a menu accelerator.
  expect(accels.filter((a) => /(^|\+)F4$/.test(a))).toEqual([]);
  const win = windowsMenu(MENU_SPEC, { profiles: [], accounts: [], state: { ...NO_MENU_STATE, hasRepos: true, gitWrites: true }, isPackaged: true });
  const all: WinMenuItem[] = [];
  const walk = (items: WinMenuItem[]) => { for (const i of items) { if (i.kind === 'submenu') walk(i.items); else all.push(i); } };
  for (const m of win) walk(m.items);
  const item = all.find((i) => i.kind === 'item' && i.label === 'Find in Files');
  expect(item).toMatchObject({ id: 'command:find-in-files', accel: 'Shift+Alt+F' });
  expect(all.filter((i) => i.kind === 'item' && i.accel === 'Shift+Alt+F')).toHaveLength(1);
});

test('every item does one thing: a command, a main-process action, a role, a dynamic submenu, dynamic items or a separator', () => {
  for (const i of items) {
    const kinds = ['command', 'action', 'role', 'dynamicSubmenu', 'dynamicItems', 'separator'].filter((k) => k === 'separator' ? 'type' in i : k in i);
    expect(kinds, JSON.stringify(i)).toHaveLength(1);
  }
});

test('the dynamic parts are declared, not computed: profiles and development-only items', () => {
  const file = MENU_SPEC.find((m) => 'label' in m && m.label === 'File');
  const sub = file && 'submenu' in file ? file.submenu : [];
  expect(sub.find((i) => 'label' in i && i.label === 'New Terminal with Profile')).toEqual({ label: 'New Terminal with Profile', dynamicSubmenu: 'profiles', enabledWhen: 'profiles' });
  expect(sub.find((i) => 'label' in i && i.label === 'Reload Shell Environment')).toMatchObject({ command: 'reload-shell-env', enabledWhen: 'profiles' });
  expect(sub.find((i) => 'label' in i && i.label === 'New Session with Account')).toEqual({ label: 'New Session with Account', dynamicSubmenu: 'accounts' });
  const dev = items.filter((i) => i.when === 'development');
  expect(dev.map((i) => ('role' in i ? i.role : 'type' in i ? i.type : '?'))).toEqual(['reload', 'toggleDevTools', 'separator']);
  // Pure data: the demo (a browser bundle) reads it as is.
  expect(JSON.parse(JSON.stringify(MENU_SPEC))).toEqual(MENU_SPEC);
});

test('⌘1…⌘9 go to tabs 1–8 and the last one', () => {
  const tabs = items.filter((i) => 'command' in i && /^tab-\d$/.test(i.command));
  expect(tabs.map((i) => ['label' in i ? i.label : '', 'accelerator' in i ? i.accelerator : '', 'command' in i ? i.command : '']))
    .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n === 9 ? 'Last Tab' : `Tab ${n}`, `CmdOrCtrl+${n}`, `tab-${n}`]));
});

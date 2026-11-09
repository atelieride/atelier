import { expect, test } from 'vitest';
import { MENU_SPEC, NO_MENU_STATE } from './menu-spec';
import { menuIds, windowsMenu, type WinMenuItem } from './windows-menu';

// Atelier's menu on Windows: drawn in the window's header from the same definition as
// the macOS menu, Windows roles and shortcuts.

const env = { profiles: [{ key: 'atelier', label: 'Atelier' }, { key: 'user', label: 'PowerShell (your profile)' }], accounts: [], state: { ...NO_MENU_STATE, hasRepos: true, gitWrites: true }, isPackaged: true };
const menus = windowsMenu(MENU_SPEC, env);
const titles = menus.map((m) => m.label);
const find = (label: string): WinMenuItem | undefined => {
  const walk = (items: WinMenuItem[]): WinMenuItem | undefined => {
    for (const i of items) {
      if (i.kind === 'item' && i.label === label) return i;
      if (i.kind === 'submenu') { const f = walk(i.items); if (f) return f; }
    }
    return undefined;
  };
  for (const m of menus) { const f = walk(m.items); if (f) return f; }
  return undefined;
};

test('Windows menus: no app menu (Help instead), Edit and Window as Windows has them', () => {
  expect(titles).toEqual(['File', 'Edit', 'View', 'Git', 'Go', 'Review', 'Window', 'Help']);
  const edit = menus[1]!.items.filter((i) => i.kind === 'item').map((i) => [i.label, i.accel, i.native]);
  expect(edit).toEqual([['Undo', 'Ctrl+Z', true], ['Redo', 'Ctrl+Y', true], ['Cut', 'Ctrl+X', true], ['Copy', 'Ctrl+C', true], ['Paste', 'Ctrl+V', true], ['Select All', 'Ctrl+A', true]]);
  expect(menus[6]!.items.filter((i) => i.kind === 'item').map((i) => i.label)).toEqual(['Minimize', 'Maximize']);
  // Check for Updates… asks the Microsoft Store.
  expect(menus[7]!.items.filter((i) => i.kind === 'item').map((i) => i.label)).toEqual(['About Atelier', 'Check for Updates…', "What's New…"]);
  expect(find('Check for Updates…')).toMatchObject({ id: 'action:check-for-updates', accel: null, enabled: true });
});

test('commands keep their ids and get the Windows shortcuts', () => {
  expect(find('New Claude Session')).toMatchObject({ id: 'command:new-session', accel: 'Ctrl+Shift+N', enabled: true });
  expect(find('Open Folder…')).toMatchObject({ id: 'action:open-folder', accel: 'Ctrl+Shift+O' });
  expect(find('Settings…')).toMatchObject({ id: 'command:open-settings', accel: 'Ctrl+,' });
  expect(find('New Window')).toMatchObject({ id: 'action:new-window', accel: null });
  expect(find('Close Window')).toMatchObject({ id: 'role:close', accel: 'Alt+F4' });
  expect(find('Exit')).toMatchObject({ id: 'role:quit' });
  expect(find('Reveal in File Explorer')).toMatchObject({ id: 'command:reveal-in-finder', accel: 'Shift+Alt+R' });
  // View › Change Terminal Font…, next to Change Theme…, no shortcut.
  expect(find('Change Terminal Font…')).toMatchObject({ id: 'command:change-terminal-font', accel: null, enabled: true });
  expect(find('Full Screen')).toMatchObject({ id: 'role:togglefullscreen', accel: 'F11' });
});

test('what Windows has no use for is left out: Services, the Mac app menu roles, the shell command', () => {
  for (const label of ['Services', 'Hide Atelier', 'Quit Atelier', "Install 'atelier' Command", 'Reveal in Finder', 'Reload Shell Environment']) expect(find(label), label).toBeUndefined();
});

test('View › Automations only while turned on in Settings; Services never, even turned on (2026-11-02)', () => {
  const view = (state: typeof env.state) => windowsMenu(MENU_SPEC, { ...env, state }).find((m) => m.label === 'View')!.items.map((i) => i.kind === 'item' && i.label);
  expect(view(env.state)).not.toContain('Automations');
  expect(view({ ...env.state, automations: true, services: true })).toContain('Automations');
  expect(view({ ...env.state, automations: true, services: true })).not.toContain('Services');
});

test('dynamic submenus and conditions as on macOS', () => {
  const profiles = find('New Terminal with Profile');
  expect(profiles).toBeUndefined();
  const sub = menus[0]!.items.find((i) => i.kind === 'submenu' && i.label === 'New Terminal with Profile');
  expect(sub).toMatchObject({ kind: 'submenu', enabled: true });
  expect(sub!.kind === 'submenu' && sub!.items.map((i) => i.kind === 'item' && i.id)).toEqual(['command:new-terminal-profile:atelier', 'command:new-terminal-profile:user']);
  expect(menus.find((m) => m.label === 'Git')).toBeDefined();
  expect(windowsMenu(MENU_SPEC, { ...env, state: NO_MENU_STATE }).map((m) => m.label)).not.toContain('Git');
  expect(find('Undo Last Commit')).toMatchObject({ enabled: false });
});

test('development-only items only in development', () => {
  const dev = windowsMenu(MENU_SPEC, { ...env, isPackaged: false });
  const view = dev.find((m) => m.label === 'View')!.items.filter((i) => i.kind === 'item').map((i) => i.label);
  expect(view).toContain('Toggle Developer Tools');
  expect(find('Toggle Developer Tools')).toBeUndefined();
  // F12: Ctrl+Shift+I is Ask About This Session's (⌘I on macOS).
  expect(dev.find((m) => m.label === 'View')!.items.find((i) => i.kind === 'item' && i.label === 'Toggle Developer Tools')).toMatchObject({ id: 'role:toggleDevTools', accel: 'F12' });
});

test('Ask About This Session: in View right after Session Panel, on Ctrl+Shift+I, packaged or not', () => {
  const dev = windowsMenu(MENU_SPEC, { ...env, isPackaged: false });
  for (const menu of [menus, dev]) {
    expect([...menuIds(menu)]).toContain('command:ask-session');
    const view = menu.find((m) => m.label === 'View')!.items.flatMap((i) => (i.kind === 'item' ? [i.id] : []));
    expect(view[view.indexOf('command:session-panel') + 1]).toBe('command:ask-session');
  }
  expect(find('Ask About This Session')).toMatchObject({ id: 'command:ask-session', accel: 'Ctrl+Shift+I', enabled: true });
});

// Workspaces: the same list in the folded menu, with Ctrl+Alt+1…9; nothing while off.
test('Go lists the workspaces with Ctrl+Alt+1…9 and New Workspace… is Ctrl+Alt+T, only while they are on', () => {
  const on = windowsMenu(MENU_SPEC, { ...env, state: { ...env.state, workspaces: { names: ['Auth', 'Billing'], active: 0 } } });
  const go = on.find((m) => m.label === 'Go')!.items.filter((i) => i.kind === 'item');
  expect(go.filter((i) => i.label === 'Auth' || i.label === 'Billing').map((i) => [i.label, i.id, i.accel, i.checked, i.radio]))
    .toEqual([['Auth', 'command:workspace-0', 'Ctrl+Alt+1', true, true], ['Billing', 'command:workspace-1', 'Ctrl+Alt+2', false, true]]);
  const file = on.find((m) => m.label === 'File')!.items;
  expect(file.find((i) => i.kind === 'item' && i.label === 'New Workspace…')).toMatchObject({ id: 'command:new-workspace', accel: 'Ctrl+Alt+T' });
  expect(find('New Workspace…')).toBeUndefined();
  expect(find('Next Workspace')).toBeUndefined();
  expect(find('Toggle Workspaces for This Project')).toMatchObject({ id: 'command:toggle-workspaces', enabled: false });
  const project = windowsMenu(MENU_SPEC, { ...env, state: { ...env.state, project: true } });
  expect(project.find((m) => m.label === 'View')!.items.find((i) => i.kind === 'item' && i.label === 'Toggle Workspaces for This Project')).toMatchObject({ enabled: true });
});

// Word wrap: View › Word Wrap, ✓ while on (main adds it from the settings); no
// shortcut in the menu (Alt+Z is the editor's).
// A checkable item says so when off too (checked: false), so the drop-down can announce it as a checkbox.
test('View › Word Wrap carries a ✓ while word wrap is on, and no shortcut', () => {
  expect(find('Word Wrap')).toMatchObject({ id: 'command:toggle-word-wrap', accel: null, enabled: true, checked: false });
  expect(find('Word Wrap')).not.toHaveProperty('radio');
  expect(find('Save')).not.toHaveProperty('checked');
  const on = windowsMenu(MENU_SPEC, { ...env, state: { ...env.state, wordWrap: true } });
  expect(on.find((m) => m.label === 'View')!.items.find((i) => i.kind === 'item' && i.label === 'Word Wrap')).toMatchObject({ checked: true });
});

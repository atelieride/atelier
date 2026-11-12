import { describe, expect, test } from 'vitest';
import { MENU_SPEC, type MenuSpecMenu } from '@shared/menu-spec';
import type { MenuEffect } from './effects';
import type { Settings } from '@shared/settings';
import { buildMenus, demoMenuEnv, entryRole, hasChecks, step, type DemoMenuEntry } from './menu-model';

const ACCOUNTS = [{ id: 'default', name: 'Personal' }, { id: 'work', name: 'Work' }];
const menus = buildMenus(MENU_SPEC, { profiles: true, accounts: ACCOUNTS });
const menu = (label: string) => menus.find((m) => m.label === label)!;
const labels = (entries: DemoMenuEntry[]) => entries.map((e) => (e.kind === 'separator' ? '—' : e.label));
type AnyEntry = { kind: 'item' | 'submenu'; label: string; keys?: string; effect?: MenuEffect; disabled?: boolean; reserved?: string; items?: DemoMenuEntry[] };
const item = (menuLabel: string, label: string): AnyEntry => {
  const e = menu(menuLabel).items.find((x) => x.kind !== 'separator' && x.label === label);
  if (!e || e.kind === 'separator') throw new Error(`${menuLabel} › ${label} not found`);
  return e;
};

describe('buildMenus', () => {
  test("the menu definition's menus, in order, the app menu in bold, then the demo's Help", () => {
    expect(menus.map((m) => m.label)).toEqual(['Atelier', 'File', 'Edit', 'View', 'Git', 'Go', 'Review', 'Window', 'Help']);
    expect(menus[0]!.app).toBe(true);
  });

  test('items show their accelerators as the app labels them; hidden and development-only items are not drawn', () => {
    expect(item('View', 'Search…').keys).toBe('⌘K');
    expect(item('View', 'Split Right').keys).toBe('⌘\\');
    expect(item('View', 'Command Palette').keys).toBe('F1');
    // The hidden ⌘⇧P duplicate is not a row (its key still works: accelerators.ts).
    expect(labels(menu('View').items).filter((l) => l === 'Command Palette')).toHaveLength(1);
    expect(labels(menu('View').items)).not.toContain('Reload');
    expect(labels(menu('View').items)).not.toContain('Toggle Developer Tools');
    expect(labels(menu('View').items).at(-1)).toBe('Enter Full Screen');
    // A development separator is skipped with its items: no double separator at the end.
    const view = labels(menu('View').items);
    expect(view.some((l, i) => l === '—' && view[i + 1] === '—')).toBe(false);
  });

  test('View › Find in Files, ⌘⇧F, right after Files: the command the key sends too, a key the browser leaves to the page', () => {
    expect(item('View', 'Find in Files')).toMatchObject({ keys: '⌘⇧F', effect: { kind: 'command', command: 'find-in-files' } });
    expect(item('View', 'Find in Files').reserved).toBeUndefined();
    const view = labels(menu('View').items);
    expect(view[view.indexOf('Files') + 1]).toBe('Find in Files');
  });

  test('View › Ask About This Session, ⌘I, after Session Panel: the command ⌘I sends', () => {
    expect(item('View', 'Ask About This Session')).toMatchObject({ keys: '⌘I', effect: { kind: 'command', command: 'ask-session' } });
    expect(item('View', 'Ask About This Session').reserved).toBeUndefined();
    const view = labels(menu('View').items);
    expect(view[view.indexOf('Session Panel') + 1]).toBe('Ask About This Session');
  });

  test('commands go to the renderer, actions need the Mac', () => {
    expect(item('Go', 'Next Session Needing Attention').effect).toEqual({ kind: 'command', command: 'next-attention' });
    expect(item('File', 'Open Folder…').effect).toEqual({ kind: 'not-in-demo', what: 'Open Folder' });
    expect(item('Atelier', 'Check for Updates…').effect).toEqual({ kind: 'not-in-demo', what: 'Check for Updates' });
    expect(item('File', 'Restart atelierd (closes all sessions)…').effect).toEqual({ kind: 'not-in-demo', what: 'Restart atelierd (closes all sessions)' });
  });

  test("the app menu's roles: About opens the app's own About, Hide and Quit leave, Services and Hide Others are disabled", () => {
    expect(item('Atelier', 'About Atelier').effect).toEqual({ kind: 'command', command: 'open-about' });
    expect(item('Atelier', 'Hide Atelier')).toMatchObject({ keys: '⌘H', effect: { kind: 'exit' } });
    expect(item('Atelier', 'Quit Atelier')).toMatchObject({ keys: '⌘Q', effect: { kind: 'exit' } });
    expect(item('Atelier', 'Services').disabled).toBe(true);
    expect(item('Atelier', 'Hide Others').disabled).toBe(true);
    expect(item('Atelier', 'Show All').disabled).toBe(true);
    expect(item('File', 'Close Window')).toMatchObject({ keys: '⌘⇧W', effect: { kind: 'exit' } });
    expect(item('View', 'Enter Full Screen').effect).toEqual({ kind: 'fullscreen' });
  });

  test('Edit and Window are the standard macOS menus', () => {
    expect(labels(menu('Edit').items)).toEqual(['Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Delete', 'Select All']);
    expect(item('Edit', 'Copy')).toMatchObject({ keys: '⌘C', effect: { kind: 'edit', op: 'copy' } });
    expect(item('Edit', 'Redo').keys).toBe('⌘⇧Z');
    expect(labels(menu('Window').items)).toEqual(['Minimize', 'Zoom', '—', 'Bring All to Front']);
    expect(item('Window', 'Minimize').effect).toEqual({ kind: 'exit' });
    expect(item('Window', 'Zoom').effect).toEqual({ kind: 'fullscreen' });
    expect(item('Window', 'Bring All to Front').disabled).toBe(true);
  });

  test("Help: Things to Try, the website, Licenses (the bundle's third-party notices), Download", () => {
    expect(labels(menu('Help').items)).toEqual(['Things to Try', '—', 'Atelier Website', 'Licenses', '—', 'Download for Mac']);
    expect(item('Help', 'Licenses').effect).toEqual({ kind: 'licenses' });
    expect(item('Help', 'Download for Mac').effect).toEqual({ kind: 'link', href: '/download/mac?from=demo' });
  });

  test('profiles: a submenu with the default profile, or disabled without profile support', () => {
    const sub = item('File', 'New Terminal with Profile');
    expect(sub.kind).toBe('submenu');
    if (sub.kind !== 'submenu') return;
    expect(sub.disabled).toBeFalsy();
    expect(sub.items).toEqual([{ kind: 'item', label: 'Default', effect: { kind: 'command', command: 'new-terminal' } }]);
    const off = buildMenus(MENU_SPEC, { profiles: false, accounts: ACCOUNTS }).find((m) => m.label === 'File')!.items.find((e) => e.kind === 'submenu' && e.label === 'New Terminal with Profile')!;
    expect(off).toMatchObject({ disabled: true });
    expect(buildMenus(MENU_SPEC, { profiles: false, accounts: ACCOUNTS }).find((m) => m.label === 'File')!.items.find((e) => e.kind !== 'separator' && e.label === 'Reload Shell Environment')).toMatchObject({ disabled: true });
  });

  test("Claude accounts: one item per account, as main builds it; none with one account", () => {
    const sub = item('File', 'New Session with Account');
    expect(sub).toMatchObject({ kind: 'submenu', items: [
      { kind: 'item', label: 'Personal', effect: { kind: 'command', command: 'new-session-account:default' } },
      { kind: 'item', label: 'Work', effect: { kind: 'command', command: 'new-session-account:work' } }
    ] });
    const one = buildMenus(MENU_SPEC, { profiles: true, accounts: ACCOUNTS.slice(0, 1) }).find((m) => m.label === 'File')!;
    expect(labels(one.items)).not.toContain('New Session with Account');
  });

  test('browser-reserved shortcuts carry a tooltip', () => {
    expect(item('File', 'New Terminal').reserved).toMatch(/browser keeps ⌘T/);
    expect(item('Go', 'Tab 1').reserved).toMatch(/⌘1/);
    expect(item('View', 'Search…').reserved).toBeUndefined();
  });

  test("the Git menu: the demo's project has repositories and Git actions on, so every item shows", () => {
    expect(labels(menu('Git').items)).toEqual([
      'Commit…', 'Commit All Repositories…', 'Write Commit Message with Claude', 'Undo Last Commit', '—',
      'Push', 'Pull', 'Sync', 'Sync All Repositories', '—',
      'Fetch', 'Fetch All Repositories', '—',
      'New Branch…', 'Switch to Branch…', 'Stash Changes…'
    ]);
    expect(item('Git', 'Commit…').keys).toBe('⌘⌥K');
    expect(item('Git', 'Push').effect).toEqual({ kind: 'command', command: 'git-push' });
    // Its commits change nothing, so there is never one to undo.
    expect(item('Git', 'Undo Last Commit').disabled).toBe(true);
    expect(labels(menu('View').items)).not.toContain('Fetch');
  });

  // Workspaces: the toggle always; while they are on, Go lists them with
  // ⌘⌥1…9 and a ✓ on the one in front, and File shows New Workspace…, as main builds them from the page's state.
  test('workspaces: the toggle in View; their list, Next/Previous and New Workspace… only while they are on', () => {
    expect(item('View', 'Toggle Workspaces for This Project').effect).toEqual({ kind: 'command', command: 'toggle-workspaces' });
    expect(item('View', 'Toggle Workspaces for This Project').disabled).toBeFalsy();
    expect(labels(menu('Go').items)).not.toContain('Next Workspace');
    expect(labels(menu('File').items)).not.toContain('New Workspace…');
    const on = buildMenus(MENU_SPEC, { profiles: true, accounts: ACCOUNTS, workspaces: { names: ['Auth & sessions', 'Billing'], active: 1 } });
    const go = on.find((m) => m.label === 'Go')!.items;
    expect(labels(go).slice(0, 7)).toEqual(['Next Session Needing Attention', '—', 'Auth & sessions', 'Billing', 'Next Workspace', 'Previous Workspace', '—']);
    const billing = go.find((e) => e.kind === 'item' && e.label === 'Billing') as AnyEntry & { checked?: boolean };
    expect(billing).toMatchObject({ keys: '⌘⌥2', effect: { kind: 'command', command: 'workspace-1' }, checked: true });
    expect((go.find((e) => e.kind === 'item' && e.label === 'Auth & sessions') as { checked?: boolean }).checked).toBeFalsy();
    expect(on.find((m) => m.label === 'File')!.items.find((e) => e.kind === 'item' && e.label === 'New Workspace…')).toMatchObject({ keys: '⌘⌥T', effect: { kind: 'command', command: 'new-workspace' } });
  });

  // Word wrap: the command, ✓ while the demo's settings have it on.
  test('View › Word Wrap sends its command and shows a ✓ while word wrap is on', () => {
    expect(item('View', 'Word Wrap').effect).toEqual({ kind: 'command', command: 'toggle-word-wrap' });
    expect(item('View', 'Word Wrap')).toMatchObject({ checked: false, checkbox: true });
    const on = buildMenus(MENU_SPEC, { profiles: true, accounts: ACCOUNTS, wordWrap: true });
    expect(on.find((m) => m.label === 'View')!.items.find((e) => e.kind === 'item' && e.label === 'Word Wrap')).toMatchObject({ checked: true, checkbox: true });
  });

  test('a checkbox for any checkedWhen of the definition: unchecked while the demo has nothing to say', () => {
    const spec: MenuSpecMenu[] = [{ label: 'View', submenu: [{ label: 'Thing', command: 'fetch', checkedWhen: 'project' }] }];
    expect(buildMenus(spec, { profiles: true, accounts: ACCOUNTS })[0]!.items).toEqual([{ kind: 'item', label: 'Thing', effect: { kind: 'command', command: 'fetch' }, checked: false, checkbox: true }]);
  });

  test('roles: a checkbox, a radio (a workspace) or a plain item; a menu with any checkable item gives every item the ✓ column', () => {
    const on = buildMenus(MENU_SPEC, { profiles: true, accounts: ACCOUNTS, workspaces: { names: ['Auth', 'Billing'], active: 0 } });
    const go = on.find((m) => m.label === 'Go')!.items;
    expect(entryRole(item('View', 'Word Wrap') as DemoMenuEntry)).toBe('menuitemcheckbox');
    expect(entryRole(go.find((e) => e.kind === 'item' && e.label === 'Auth')!)).toBe('menuitemradio');
    expect(entryRole(item('View', 'Split Right') as DemoMenuEntry)).toBe('menuitem');
    expect(hasChecks(menu('View').items)).toBe(true);
    expect(hasChecks(go)).toBe(true);
    expect(hasChecks(menu('Go').items)).toBe(false);
  });

  test("the shell's menu env from the demo's settings: accounts, word wrap, the workspaces when on", () => {
    const s = { claudeAccounts: { list: ACCOUNTS }, wordWrap: true } as unknown as Settings;
    expect(demoMenuEnv(s, undefined)).toEqual({ profiles: true, accounts: ACCOUNTS, wordWrap: true });
    expect(demoMenuEnv(s, { names: ['A'], active: 0 })).toMatchObject({ wordWrap: true, workspaces: { names: ['A'], active: 0 } });
  });

  test('a new item in the definition reaches the demo by itself', () => {
    const spec: MenuSpecMenu[] = [{ label: 'File', submenu: [{ label: 'Brand New Thing', accelerator: 'CmdOrCtrl+Alt+Y', command: 'fetch' }] }];
    expect(buildMenus(spec, { profiles: true, accounts: ACCOUNTS })[0]!.items).toEqual([{ kind: 'item', label: 'Brand New Thing', keys: '⌘⌥Y', effect: { kind: 'command', command: 'fetch' } }]);
  });
});

describe('step (keyboard navigation inside a menu)', () => {
  const entries: DemoMenuEntry[] = [
    { kind: 'item', label: 'A', effect: { kind: 'exit' } },
    { kind: 'separator' },
    { kind: 'item', label: 'B', effect: { kind: 'exit' }, disabled: true },
    { kind: 'item', label: 'C', effect: { kind: 'exit' } }
  ];
  test('skips separators and disabled items, and wraps', () => {
    expect(step(entries, -1, 1)).toBe(0);
    expect(step(entries, 0, 1)).toBe(3);
    expect(step(entries, 3, 1)).toBe(0);
    expect(step(entries, 0, -1)).toBe(3);
    expect(step(entries, -1, -1)).toBe(3);
  });
  test('nothing to land on: -1', () => {
    expect(step([{ kind: 'separator' }], -1, 1)).toBe(-1);
  });
});

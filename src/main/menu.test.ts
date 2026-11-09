import { describe, expect, test, vi } from 'vitest';
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';
import type { MenuState } from '@shared/api';
import type { ProfileKey } from '@shared/profiles';

vi.mock('electron', () => ({ app: { name: 'Atelier', isPackaged: true }, Menu: { buildFromTemplate: vi.fn() } }));
const { menuTemplate } = await import('./menu');

type Call = string;
const WIN = { fake: 'window' } as unknown as BaseWindow;

// The template as plain data: every Electron field the menu sets, and, for each click, the actions it calls (with
// the command and whether the window the shortcut came from is passed on). The click runs with Electron's arguments.
function serialize(items: MenuItemConstructorOptions[], calls: Call[]): unknown[] {
  return items.map((item) => {
    const out: Record<string, unknown> = {};
    for (const k of ['id', 'type', 'role', 'label', 'accelerator', 'enabled', 'checked', 'visible'] as const) {
      if (item[k] !== undefined) out[k] = item[k];
    }
    if (item.click) {
      calls.length = 0;
      (item.click as (...a: unknown[]) => void)({ menuItem: true }, WIN, {});
      out.click = calls.join(' + ');
    }
    if (item.submenu) out.submenu = serialize(item.submenu as MenuItemConstructorOptions[], calls);
    return out;
  });
}

// JSON with one item per line (a submenu opens its own block), so a menu change reads as a one-line diff.
function format(states: Record<string, unknown[]>): string {
  const items = (list: unknown[], pad: string): string => list.map((it) => {
    const { submenu, ...rest } = it as { submenu?: unknown[] };
    const head = JSON.stringify(rest);
    return submenu ? `${pad}${head.slice(0, -1)}${head === '{}' ? '' : ', '}"submenu": [\n${items(submenu, pad + '  ')}\n${pad}]}` : `${pad}${head}`;
  }).join(',\n');
  const body = Object.entries(states).map(([k, v]) => `  ${JSON.stringify(k)}: [\n${items(v, '    ')}\n  ]`).join(',\n');
  return `{\n${body}\n}\n`;
}

function snapshot(profiles: { key: ProfileKey; label: string }[] | null, isPackaged: boolean): unknown[] {
  const calls: Call[] = [];
  const actions = {
    openFolder: () => { calls.push('openFolder()'); },
    newWindow: () => { calls.push('newWindow()'); },
    restartDaemon: () => { calls.push('restartDaemon()'); },
    // "(win)": the window the shortcut came from is passed on (the command goes to it, not the frontmost one).
    command: (cmd: string, win?: BaseWindow) => { calls.push(`command(${cmd}${win === WIN ? ', win' : ''})`); },
    checkForUpdates: (win?: BaseWindow) => { calls.push(`checkForUpdates(${win === WIN ? 'win' : ''})`); }
  };
  return serialize(menuTemplate(actions, profiles, { appName: 'Atelier', isPackaged }, [], ON), calls);
}

const PROFILES: { key: ProfileKey; label: string }[] = [{ key: 'atelier', label: 'Atelier' }, { key: '/bin/bash', label: 'bash' }];
/** A project window with repositories and Git actions on (the snapshot's state; the Git menu's tests vary it). */
const ON: MenuState = { gitUndo: false, hasRepos: true, gitWrites: true, messages: true, services: true, automations: true };

// The native menu as it was before it was built from src/shared/menu-spec.ts: the refactor
// must not change a label, a key, a role, a state or what a click sends. The fixture is the reference; regenerate it
// (vitest -u) only for a deliberate menu change, and read its diff.
test('the native menu template: unchanged in every state that shapes it', async () => {
  const states = {
    'packaged, profiles': snapshot(PROFILES, true),
    'packaged, no profiles (older atelierd)': snapshot(null, true),
    'packaged, profiles supported but none': snapshot([], true),
    'development, profiles': snapshot(PROFILES, false)
  };
  await expect(format(states)).toMatchFileSnapshot('./menu.template.json');
});

// Workspaces: Go lists the front window's workspaces with ⌘⌥1…9, the active one
// checked; New Workspace… and Next/Previous Workspace show only then.
test('Go lists the workspaces with their keys; File › New Workspace… only while they are on', () => {
  const sent: string[] = [];
  const actions = { openFolder() {}, newWindow() {}, restartDaemon() {}, checkForUpdates() {}, command: (c: string) => { sent.push(c); } };
  const names = Array.from({ length: 10 }, (_, i) => `W${i + 1}`);
  const menu = (state: MenuState) => menuTemplate(actions, null, { appName: 'Atelier', isPackaged: true }, [], state);
  const sub = (m: MenuItemConstructorOptions[], label: string) => m.find((x) => x.label === label)!.submenu as MenuItemConstructorOptions[];
  const on = menu({ ...ON, workspaces: { names, active: 1 } });
  const listed = sub(on, 'Go').filter((i) => names.includes(i.label ?? ''));
  expect(listed.map((i) => [i.label, i.accelerator ?? null, i.type, i.checked])).toEqual(names.map((n, i) => [n, i < 9 ? `CmdOrCtrl+Alt+${i + 1}` : null, 'radio', i === 1]));
  (listed[2]!.click as () => void)();
  expect(sent).toEqual(['workspace-2']);
  expect(sub(on, 'File').find((i) => i.label === 'New Workspace…')!.visible).not.toBe(false);
  expect(sub(on, 'Go').find((i) => i.label === 'Next Workspace')!.visible).not.toBe(false);
  const off = menu(ON);
  expect(sub(off, 'Go').some((i) => names.includes(i.label ?? ''))).toBe(false);
  // The toggle: enabled in a project window only (not the welcome window, not a pop-out).
  expect(sub(off, 'View').find((i) => i.label === 'Toggle Workspaces for This Project')!.enabled).toBe(false);
  expect(sub(menu({ ...ON, project: true }), 'View').find((i) => i.label === 'Toggle Workspaces for This Project')!.enabled).toBe(true);
  // On in every project (Settings): the project's own switch is set aside.
  expect(sub(menu({ ...ON, project: true, wsEverywhere: true }), 'View').find((i) => i.label === 'Toggle Workspaces for This Project')!.enabled).toBe(false);
  expect(sub(off, 'File').find((i) => i.label === 'New Workspace…')!.visible).toBe(false);
  expect(sub(off, 'Go').find((i) => i.label === 'Next Workspace')!.visible).toBe(false);
});

// Services (tmux) and Automations (2026-11-02): off by default; View lists them only once turned on in Settings (main
// adds the views to the front window's state). Hidden, not left out: the key still reaches the window, which refuses.
test('View › Services and View › Automations show only while turned on in Settings', () => {
  const actions = { openFolder() {}, newWindow() {}, restartDaemon() {}, checkForUpdates() {}, command() {} };
  const view = (state: MenuState) => (menuTemplate(actions, null, { appName: 'Atelier', isPackaged: true }, [], state).find((x) => x.label === 'View')!.submenu as MenuItemConstructorOptions[]);
  const shown = (state: MenuState, label: string) => view(state).find((i) => i.label === label)!.visible !== false;
  const base: MenuState = { gitUndo: false, hasRepos: true, gitWrites: true, messages: true };
  expect([shown(base, 'Services'), shown(base, 'Automations')]).toEqual([false, false]);
  expect([shown({ ...base, services: true }, 'Services'), shown({ ...base, services: true }, 'Automations')]).toEqual([true, false]);
  expect([shown({ ...base, automations: true }, 'Services'), shown({ ...base, automations: true }, 'Automations')]).toEqual([false, true]);
});

// Word wrap: a checkbox in View, checked from the settings main adds to the state.
// Electron flips a checkbox before its click runs: the click puts it back, the rebuild after the settings change shows
// the truth (a click no window takes leaves the check as the setting is).
test('View › Word Wrap: a checkbox checked while wrap is on; a click sends the command and never flips the check itself', () => {
  const sent: string[] = [];
  const actions = { openFolder() {}, newWindow() {}, restartDaemon() {}, checkForUpdates() {}, command: (c: string) => { sent.push(c); } };
  const wrap = (state: MenuState) => (menuTemplate(actions, null, { appName: 'Atelier', isPackaged: true }, [], state).find((x) => x.label === 'View')!.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Word Wrap')!;
  const base: MenuState = { gitUndo: false, hasRepos: true, gitWrites: true, messages: true };
  expect(wrap(base)).toMatchObject({ type: 'checkbox', checked: false });
  expect(wrap({ ...base, wordWrap: true })).toMatchObject({ type: 'checkbox', checked: true });
  expect(wrap(base).accelerator).toBeUndefined();
  const flipped = { checked: true };
  (wrap(base).click as (...a: unknown[]) => void)(flipped, WIN, {});
  expect(flipped.checked).toBe(false);
  expect(sent).toEqual(['toggle-word-wrap']);
  const on = { checked: false };
  (wrap({ ...base, wordWrap: true }).click as (...a: unknown[]) => void)(on, WIN, {});
  expect(on.checked).toBe(true);
});

test('buildMenu builds the template with the app name and packaging of the running app', async () => {
  const { Menu, app } = await import('electron');
  const { buildMenu } = await import('./menu');
  const actions = { openFolder() {}, newWindow() {}, command() {}, restartDaemon() {}, checkForUpdates() {} };
  buildMenu(actions, null);
  // Clicks are fresh closures on each build: compare the data (JSON drops functions).
  const built = vi.mocked(Menu.buildFromTemplate).mock.calls[0]![0];
  expect(JSON.stringify(built)).toBe(JSON.stringify(menuTemplate(actions, null, { appName: app.name, isPackaged: app.isPackaged })));
  expect(built[0]!.label).toBe('Atelier');
});

test('File › New Session with Account: one entry per account, only with two or more', () => {
  const sent: string[] = [];
  const actions = { openFolder() {}, newWindow() {}, restartDaemon() {}, checkForUpdates() {}, command: (c: string) => { sent.push(c); } };
  const file = (accounts: { id: string; label: string }[]) => menuTemplate(actions, PROFILES, { appName: 'Atelier', isPackaged: true }, accounts)[1]!.submenu as MenuItemConstructorOptions[];
  const two = file([{ id: 'default', label: 'Claude' }, { id: 'ops', label: 'Ops' }]);
  const i = two.findIndex((x) => x.label === 'New Session with Account');
  expect(two[i - 1]!.label).toBe('New Claude Session');
  expect(two[i]!.visible).not.toBe(false);
  const sub = two[i]!.submenu as MenuItemConstructorOptions[];
  expect(sub.map((x) => x.label)).toEqual(['Claude', 'Ops']);
  (sub[1]!.click as () => void)();
  expect(sent).toEqual(['new-session-account:ops']);
  // One account (everyone who never added one): no new row at all.
  expect(file([{ id: 'default', label: 'Claude' }]).find((x) => x.label === 'New Session with Account')).toMatchObject({ visible: false, submenu: [] });
  expect(menuTemplate(actions, PROFILES, { appName: 'Atelier', isPackaged: true })[1]!.submenu).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'New Session with Account', visible: false })]));
});

test('File › New Terminal with Profile: one entry per profile; with an older atelierd it and Reload stay, disabled', () => {
  const sent: string[] = [];
  const actions = { openFolder() {}, newWindow() {}, restartDaemon() {}, checkForUpdates() {}, command: (c: string) => { sent.push(c); } };
  const file = (profiles: typeof PROFILES | null) => menuTemplate(actions, profiles, { appName: 'Atelier', isPackaged: true })[1]!.submenu as MenuItemConstructorOptions[];
  const on = file(PROFILES);
  const prof = on.find((i) => i.label === 'New Terminal with Profile')!;
  const reload = on.find((i) => i.label === 'Reload Shell Environment')!;
  expect(prof.enabled).toBe(true);
  const sub = prof.submenu as MenuItemConstructorOptions[];
  expect(sub.map((x) => x.label)).toEqual(['Atelier', 'bash']);
  (sub[1]!.click as () => void)();
  expect(sent).toEqual(['new-terminal-profile:/bin/bash']);
  expect(reload.enabled).toBe(true);
  (reload.click as () => void)();
  expect(sent.at(-1)).toBe('reload-shell-env');

  const off = file(null);
  expect(off.find((i) => i.label === 'New Terminal with Profile')).toMatchObject({ enabled: false, submenu: [] });
  expect(off.find((i) => i.label === 'Reload Shell Environment')!.enabled).toBe(false);
});

describe('the Git menu: it follows the front window', () => {
  const sent: string[] = [];
  const actions = { openFolder() {}, newWindow() {}, restartDaemon() {}, checkForUpdates() {}, command: (c: string) => { sent.push(c); } };
  const template = (state?: MenuState) => menuTemplate(actions, PROFILES, { appName: 'Atelier', isPackaged: true }, [], state);
  const git = (state?: MenuState) => template(state).find((m) => m.label === 'Git')!;
  const items = (state?: MenuState) => git(state).submenu as MenuItemConstructorOptions[];
  /** What macOS draws: the visible rows, separators as '-'. */
  const shown = (state: MenuState) => items(state).filter((i) => i.visible !== false).map((i) => (i.type === 'separator' ? '-' : i.label));

  test('Undo Last Commit: enabled only while the front window says main offers an Undo', () => {
    sent.length = 0;
    const undo = (state?: MenuState) => items(state).find((i) => i.label === 'Undo Last Commit')!;
    expect(undo()).toMatchObject({ id: 'git-undo-commit', enabled: false });
    expect(undo(ON).enabled).toBe(false);
    expect(undo({ ...ON, gitUndo: true }).enabled).toBe(true);
    (undo({ ...ON, gitUndo: true }).click as () => void)();
    expect(sent).toEqual(['git-undo-commit']);
  });

  test('every item, in order, with Fetch and Fetch All moved from View (same commands)', () => {
    expect(shown(ON)).toEqual([
      'Commit…', 'Commit All Repositories…', 'Write Commit Message with Claude', 'Undo Last Commit', '-',
      'Push', 'Pull', 'Sync', 'Sync All Repositories', '-',
      'Fetch', 'Fetch All Repositories', '-',
      'New Branch…', 'Switch to Branch…', 'Stash Changes…'
    ]);
    sent.length = 0;
    for (const i of items(ON)) (i.click as (() => void) | undefined)?.();
    expect(sent).toEqual(['git-commit', 'git-commit-all', 'git-write-message', 'git-undo-commit', 'git-push', 'git-pull', 'git-sync', 'git-sync-all',
      'fetch', 'fetch-all', 'git-new-branch', 'git-switch-branch', 'git-stash']);
    const view = (template(ON).find((m) => m.label === 'View')!.submenu as MenuItemConstructorOptions[]).map((i) => i.label);
    expect(view).not.toContain('Fetch');
    expect(view).not.toContain('Fetch All Repositories');
  });

  test('hidden while the project has no repository (and before any window said)', () => {
    expect(git().visible).toBe(false);
    expect(git({ ...ON, hasRepos: false }).visible).toBe(false);
    expect(git(ON).visible).not.toBe(false);
  });

  test('Read-only: only the Fetch items, no stray separator', () => {
    expect(shown({ ...ON, gitWrites: false })).toEqual(['Fetch', 'Fetch All Repositories']);
    // Still in the menu (hidden), so a stale key press reaches the renderer, which refuses it there too.
    expect(items({ ...ON, gitWrites: false }).find((i) => i.label === 'Commit…')).toMatchObject({ visible: false });
  });

  test('messages with Claude Off: no Write Commit Message with Claude', () => {
    expect(shown({ ...ON, messages: false })).not.toContain('Write Commit Message with Claude');
    expect(shown({ ...ON, messages: false })).toContain('Commit…');
  });
});

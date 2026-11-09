import { app, Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand, MenuState } from '@shared/api';
import { MENU_SPEC, NO_MENU_STATE, type MenuAction, type MenuCondition, type MenuSpecItem } from '@shared/menu-spec';
import type { ProfileKey } from '@shared/profiles';

export interface MenuActions { openFolder(): void; newWindow(): void; command(cmd: MenuCommand, win?: BaseWindow): void; restartDaemon(): void; checkForUpdates(win?: BaseWindow): void }
type Click = NonNullable<MenuItemConstructorOptions['click']>;

/** A Claude account for File › New Session with Account. */
export interface MenuAccount { id: string; label: string }

/**
 * profiles: the terminal profiles on offer; null while the running atelierd doesn't support them. accounts: the Claude
 * accounts (the default first); with fewer than two the entry is hidden.
 */
export function buildMenu(actions: MenuActions, profiles: { key: ProfileKey; label: string }[] | null = null, accounts: MenuAccount[] = [], state?: MenuState): Menu {
  return Menu.buildFromTemplate(menuTemplate(actions, profiles, { appName: app.name, isPackaged: app.isPackaged }, accounts, state));
}

/**
 * The application menu's template, built from the shared spec (src/shared/menu-spec.ts, also the website demo's
 * menu): this fills in what only the main process knows (the app's name, packaging, terminal profiles) and the
 * clicks. Pure: Electron's Menu stays at the edge, in buildMenu. `state`: the front window's (the Git menu).
 */
export function menuTemplate(actions: MenuActions, profiles: { key: ProfileKey; label: string }[] | null, env: { appName: string; isPackaged: boolean }, accounts: MenuAccount[] = [], state: MenuState = NO_MENU_STATE): MenuItemConstructorOptions[] {
  // The command goes to the window the shortcut came from (or the frontmost one).
  const cmd = (c: MenuCommand): Click => (_item, win) => actions.command(c, win);
  const run: Record<MenuAction, Click> = {
    'check-for-updates': (_item, win) => actions.checkForUpdates(win),
    'new-window': () => actions.newWindow(),
    'open-folder': actions.openFolder,
    'restart-daemon': actions.restartDaemon
  };
  const shown = (i: MenuSpecItem) => i.when !== 'development' || !env.isPackaged;
  const holds: Record<MenuCondition, boolean> = {
    profiles: profiles !== null, 'git-undo': state.gitUndo, 'git-repos': state.hasRepos, 'git-writes': state.gitWrites, 'git-messages': state.gitWrites && state.messages,
    workspaces: !!state.workspaces, project: !!state.project, services: !!state.services, automations: !!state.automations,
    'ws-toggle': !!state.project && !state.wsEverywhere, 'word-wrap': !!state.wordWrap
  };
  const enabled = (i: { enabledWhen?: MenuCondition }) => (i.enabledWhen ? { enabled: holds[i.enabledWhen] } : {});
  // Hidden, not left out: the item keeps its place (and its key, which the renderer refuses in Read-only too).
  const visible = (i: { visibleWhen?: MenuCondition }) => (i.visibleWhen && !holds[i.visibleWhen] ? { visible: false } : {});
  const keys = (i: { id?: string; accelerator?: string }) => ({ ...(i.id && { id: i.id }), ...(i.accelerator && { accelerator: i.accelerator }) });
  // A command item's click, and its check for a checkbox (View › Word Wrap): Electron flips the check before the click
  // runs; the click puts it back, and the rebuild after the setting changes shows the truth (a click no window takes
  // leaves it as the setting is).
  const commandClick = (i: { checkedWhen?: MenuCondition; command: MenuCommand }): MenuItemConstructorOptions => {
    if (!i.checkedWhen) return { click: cmd(i.command) };
    const checked = holds[i.checkedWhen];
    return { type: 'checkbox', checked, click: (item, win, e) => { item.checked = checked; cmd(i.command)(item, win, e); } };
  };
  // Workspaces: the front window's, each sending workspace-<index>; ⌘⌥1…9 on the first nine.
  // Radio items: the key of the workspace already in front can't take its check away (a checkbox would flip).
  const ws = state.workspaces;
  const expand = (i: MenuSpecItem): MenuItemConstructorOptions[] => ('dynamicItems' in i
    ? (ws?.names ?? []).map((name, n) => ({ label: name, type: 'radio' as const, checked: n === ws!.active, ...(n < 9 && { accelerator: `CmdOrCtrl+Alt+${n + 1}` }), click: cmd(`workspace-${n}`) }))
    : [item(i)]);
  const item = (i: Exclude<MenuSpecItem, { dynamicItems: string }>): MenuItemConstructorOptions => {
    if ('type' in i) return { type: 'separator', ...visible(i) };
    if ('role' in i) return { role: i.role, ...(i.label && { label: i.label }), ...keys(i) };
    if ('command' in i) return { ...keys(i), label: i.label, ...commandClick(i), ...(i.visible === false && { visible: false }), ...visible(i), ...enabled(i) };
    if ('action' in i) return { ...keys(i), label: i.label, click: run[i.action] };
    // dynamicSubmenu 'accounts': only with two or more Claude accounts; with one, nothing new in the menu.
    if (i.dynamicSubmenu === 'accounts') {
      return accounts.length < 2 ? { label: i.label, visible: false, submenu: [] } : { label: i.label, submenu: accounts.map((a) => ({ label: a.label, click: cmd(`new-session-account:${a.id}`) })) };
    }
    // dynamicSubmenu 'profiles': with an older atelierd the entry stays, disabled and empty (Settings › Terminal explains).
    return { label: i.label, ...enabled(i), submenu: (profiles ?? []).map((p) => ({ label: p.label, click: cmd(`new-terminal-profile:${p.key}`) })) };
  };
  return MENU_SPEC.map((m): MenuItemConstructorOptions => 'role' in m
    ? { role: m.role }
    : { label: m.app ? env.appName : m.label, ...visible(m), submenu: m.submenu.filter(shown).flatMap(expand) });
}

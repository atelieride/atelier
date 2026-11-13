import type { MenuState } from './api';
import { windowsAccelerator } from './keys';
import type { MenuCondition, MenuItemRole, MenuSpecItem, MenuSpecMenu } from './menu-spec';

// Atelier's menu on Windows: Windows has no menu bar of its own here (the
// window is frameless), so main builds this plain model from the same definition as the macOS menu and the window's
// header draws it. Clicks and shortcuts send an item's id back to main, which runs what the native menu would.
// macOS's app menu becomes Help (and Settings goes to File), the Edit and Window menus are Windows', the items
// Windows has no use for are left out.

export type WinMenuItem =
  | { kind: 'separator' }
  /** id: `command:<MenuCommand>`, `action:<MenuAction>` or `role:<WinRole>`. native: the focused field or editor
   *  handles the shortcut itself (Edit), the menu only shows it. */
  | { kind: 'item'; id: string; label: string; accel: string | null; enabled: boolean; native?: true;
      /** A checkable item, on or off: an option (Word Wrap), or with radio a choice (the workspace in front). */ checked?: boolean; radio?: true }
  | { kind: 'submenu'; label: string; enabled: boolean; items: WinMenuItem[] };

export interface WinMenu { label: string; items: WinMenuItem[] }

/** What main runs for a role item: the sender's webContents (Edit) or window. */
export type WinRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'minimize' | 'maximize' | 'close' | 'quit' | 'togglefullscreen' | 'reload' | 'toggleDevTools';

export interface WinMenuEnv {
  /** The terminal profiles on offer; null while the running atelierd doesn't support them. */
  profiles: { key: string; label: string }[] | null;
  /** The Claude accounts (the default first); with fewer than two, New Session with Account is left out. */
  accounts: { id: string; label: string }[];
  state: MenuState;
  isPackaged: boolean;
}

const SEP: WinMenuItem = { kind: 'separator' };
const role = (r: WinRole, label: string, accel: string | null = null, native = false): WinMenuItem =>
  ({ kind: 'item', id: `role:${r}`, label, accel, enabled: true, ...(native && { native: true as const }) });

/** macOS roles of the definition as Windows has them; null: left out. */
const ROLES: Record<MenuItemRole, WinMenuItem | null> = {
  about: null, services: null, hide: null, hideOthers: null, unhide: null,
  quit: role('quit', 'Exit'),
  close: role('close', 'Close Window', 'Alt+F4'),
  togglefullscreen: role('togglefullscreen', 'Full Screen', 'F11'),
  reload: role('reload', 'Reload'),
  // F12, Chromium's other DevTools key: Ctrl+Shift+I is Ask About This Session (⌘I on macOS).
  toggleDevTools: role('toggleDevTools', 'Toggle Developer Tools', 'F12')
};

const EDIT: WinMenu = { label: 'Edit', items: [
  role('undo', 'Undo', 'Ctrl+Z', true), role('redo', 'Redo', 'Ctrl+Y', true), SEP,
  role('cut', 'Cut', 'Ctrl+X', true), role('copy', 'Copy', 'Ctrl+C', true), role('paste', 'Paste', 'Ctrl+V', true), SEP,
  role('selectAll', 'Select All', 'Ctrl+A', true)
] };

const WINDOW: WinMenu = { label: 'Window', items: [role('minimize', 'Minimize'), role('maximize', 'Maximize')] };

/** Labels that name a macOS place. */
const LABELS: Record<string, string> = { 'Reveal in Finder': 'Reveal in File Explorer' };

/**
 * Commands with no use on Windows: Services is the tmux view (hidden there); the `atelier` shell command (a symlink)
 * and the zsh environment capture are macOS's (features.ts has the same list).
 */
const LEFT_OUT = new Set(['view-services', 'install-shell-command', 'uninstall-shell-command', 'reload-shell-env']);

/** No separator first, last or twice in a row (left-out items can leave them so). */
function tidy(items: WinMenuItem[]): WinMenuItem[] {
  const out: WinMenuItem[] = [];
  for (const i of items) {
    if (i.kind === 'separator' && (out.length === 0 || out.at(-1)!.kind === 'separator')) continue;
    out.push(i);
  }
  while (out.at(-1)?.kind === 'separator') out.pop();
  return out;
}

export function windowsMenu(spec: readonly MenuSpecMenu[], env: WinMenuEnv): WinMenu[] {
  const holds: Record<MenuCondition, boolean> = {
    profiles: env.profiles !== null, 'git-undo': env.state.gitUndo, 'git-repos': env.state.hasRepos,
    'git-writes': env.state.gitWrites, 'git-messages': env.state.gitWrites && env.state.messages, workspaces: !!env.state.workspaces, project: !!env.state.project,
    services: !!env.state.services, automations: !!env.state.automations, 'ws-toggle': !!env.state.project && !env.state.wsEverywhere,
    'word-wrap': !!env.state.wordWrap, 'ws-activities': !!env.state.wsActivities, 'ws-activities-here': !!env.state.wsActivities && !!env.state.workspaces
  };
  const accel = (a: string | undefined) => (a ? windowsAccelerator(a) : null);
  // Workspaces: one item per workspace, Ctrl+Alt+1…9 on the first nine, the active one checked.
  const ws = env.state.workspaces;
  const expand = (i: MenuSpecItem): (WinMenuItem | null)[] => ('dynamicItems' in i
    ? (ws?.names ?? []).map((name, n): WinMenuItem => ({ kind: 'item', id: `command:workspace-${n}`, label: name, accel: n < 9 ? accel(`CmdOrCtrl+Alt+${n + 1}`) : null, enabled: true, checked: n === ws!.active, radio: true }))
    : [item(i)]);
  const item = (i: Exclude<MenuSpecItem, { dynamicItems: string }>): WinMenuItem | null => {
    if (i.when === 'development' && env.isPackaged) return null;
    if (i.visibleWhen && !holds[i.visibleWhen]) return null;
    if ('type' in i) return SEP;
    if ('role' in i) return ROLES[i.role];
    if ('dynamicSubmenu' in i) {
      if (i.dynamicSubmenu === 'accounts') {
        if (env.accounts.length < 2) return null;
        return { kind: 'submenu', label: i.label, enabled: true, items: env.accounts.map((a) => ({ kind: 'item', id: `command:new-session-account:${a.id}`, label: a.label, accel: null, enabled: true })) };
      }
      return { kind: 'submenu', label: i.label, enabled: !i.enabledWhen || holds[i.enabledWhen], items: (env.profiles ?? []).map((p) => ({ kind: 'item', id: `command:new-terminal-profile:${p.key}`, label: p.label, accel: null, enabled: true })) };
    }
    if ('command' in i) {
      if (i.visible === false || LEFT_OUT.has(i.command)) return null;
      return {
        kind: 'item', id: `command:${i.command}`, label: LABELS[i.label] ?? i.label, accel: accel(i.accelerator), enabled: !i.enabledWhen || holds[i.enabledWhen],
        ...(i.checkedWhen && { checked: holds[i.checkedWhen] })
      };
    }
    return { kind: 'item', id: `action:${i.action}`, label: i.label, accel: accel(i.accelerator), enabled: true };
  };
  const out: WinMenu[] = [];
  let appItems: MenuSpecItem[] = [];
  for (const m of spec) {
    if ('role' in m) { out.push(m.role === 'editMenu' ? EDIT : WINDOW); continue; }
    if (m.visibleWhen && !holds[m.visibleWhen]) continue;
    if (m.app) { appItems = [...m.submenu]; continue; }
    let items = m.submenu.flatMap(expand).filter((i): i is WinMenuItem => i !== null);
    // File: Settings and Connectors from the app menu, Exit last.
    if (m.label === 'File') {
      const settings = appItems.filter((i) => 'command' in i && (i.command === 'open-settings' || i.command === 'open-connectors')).flatMap(expand).filter((i): i is WinMenuItem => i !== null);
      items = [...items, SEP, ...settings, SEP, ROLES.quit!];
    }
    out.push({ label: m.label, items: tidy(items) });
  }
  // Help: what the app menu had besides Settings (About, Check for Updates… asking the Microsoft Store, What's New).
  const help: WinMenuItem[] = [{ kind: 'item', id: 'command:open-about', label: 'About Atelier', accel: null, enabled: true }];
  for (const i of appItems) if (('action' in i && i.action === 'check-for-updates') || ('command' in i && i.command === 'whats-new')) help.push(item(i)!);
  out.push({ label: 'Help', items: help });
  return out;
}

/** Every item id of a menu (main runs only these). */
export function menuIds(menus: readonly WinMenu[]): Set<string> {
  const ids = new Set<string>();
  // Enabled items only, in enabled submenus: what a click could choose.
  const walk = (items: readonly WinMenuItem[]) => {
    for (const i of items) { if (i.kind === 'item' && i.enabled) ids.add(i.id); else if (i.kind === 'submenu' && i.enabled) walk(i.items); }
  };
  for (const m of menus) walk(m.items);
  return ids;
}

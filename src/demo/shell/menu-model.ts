import type { MenuCondition, MenuItemRole, MenuSpecItem, MenuSpecMenu } from '@shared/menu-spec';
import type { Settings } from '@shared/settings';
import { keysOf } from '../../renderer/kbd';
import { isReservedAccel } from './accelerators';
import { plainLabel, type EditOp, type MenuEffect } from './effects';

// The demo's menu bar as data, built from the same definition as the native menu:
// every item, shortcut and separator; a new item reaches the demo by itself. The platform's parts (the app menu's
// roles, the Edit and Window menus) are drawn as macOS draws them, and do what makes sense in a browser.

export type DemoMenuEntry =
  | { kind: 'separator' }
  | {
    kind: 'item'; label: string; keys?: string; effect: MenuEffect; disabled?: boolean; reserved?: string;
    /** Checkable: a ✓ while on. checkbox: an option (Word Wrap); without it a choice among others (a workspace). */
    checked?: boolean; checkbox?: true
  }
  | { kind: 'submenu'; label: string; items: DemoMenuEntry[]; disabled?: boolean };

export interface DemoMenu { label: string; app?: boolean; items: DemoMenuEntry[] }

export interface MenuEnv {
  /** The running atelierd supports terminal profiles (the demo's does). */
  profiles: boolean;
  /** The Claude accounts, default first (the world's: Personal and Work). */
  accounts: readonly { id: string; name: string }[];
  /** Workspaces on in the demo's project (the page says so, as it tells main): their names and the one in front. */
  workspaces?: { names: readonly string[]; active: number };
  /** Word wrap on in the demo's settings: View › Word Wrap's ✓. */
  wordWrap?: boolean;
}

export const DOWNLOAD_HREF = '/download/mac?from=demo';

const reservedTip = (keys: string) => `Your browser keeps ${keys}: choose it here instead.`;

const item = (label: string, effect: MenuEffect, accel?: string, extra: { disabled?: boolean } = {}): DemoMenuEntry => {
  const keys = accel ? keysOf(accel) : undefined;
  return {
    kind: 'item', label, ...(keys && { keys }), effect, ...(extra.disabled && { disabled: true }),
    ...(accel && isReservedAccel(accel) && { reserved: reservedTip(keys!) })
  };
};

/** The app menu's and File's platform roles, labelled and keyed as macOS shows them. */
const ROLE: Record<MenuItemRole, { label: string; accel?: string; effect: MenuEffect; disabled?: boolean }> = {
  about: { label: 'About Atelier', effect: { kind: 'command', command: 'open-about' } },
  services: { label: 'Services', effect: { kind: 'exit' }, disabled: true },
  hide: { label: 'Hide Atelier', accel: 'CmdOrCtrl+H', effect: { kind: 'exit' } },
  hideOthers: { label: 'Hide Others', accel: 'CmdOrCtrl+Alt+H', effect: { kind: 'exit' }, disabled: true },
  unhide: { label: 'Show All', effect: { kind: 'exit' }, disabled: true },
  quit: { label: 'Quit Atelier', accel: 'CmdOrCtrl+Q', effect: { kind: 'exit' } },
  close: { label: 'Close Window', accel: 'CmdOrCtrl+Shift+W', effect: { kind: 'exit' } },
  togglefullscreen: { label: 'Enter Full Screen', accel: 'Ctrl+CmdOrCtrl+F', effect: { kind: 'fullscreen' } },
  reload: { label: 'Reload', effect: { kind: 'exit' }, disabled: true },
  toggleDevTools: { label: 'Toggle Developer Tools', effect: { kind: 'exit' }, disabled: true }
};

const edit = (label: string, op: EditOp, accel?: string) => item(label, { kind: 'edit', op }, accel);
const SEP: DemoMenuEntry = { kind: 'separator' };

/** Electron's editMenu on macOS (the Speech submenu aside). */
const EDIT_MENU: DemoMenu = { label: 'Edit', items: [
  edit('Undo', 'undo', 'CmdOrCtrl+Z'), edit('Redo', 'redo', 'CmdOrCtrl+Shift+Z'), SEP,
  edit('Cut', 'cut', 'CmdOrCtrl+X'), edit('Copy', 'copy', 'CmdOrCtrl+C'), edit('Paste', 'paste', 'CmdOrCtrl+V'),
  edit('Paste and Match Style', 'pasteAndMatchStyle', 'CmdOrCtrl+Alt+Shift+V'), edit('Delete', 'delete'), edit('Select All', 'selectAll', 'CmdOrCtrl+A')
] };

/** Electron's windowMenu on macOS: minimize goes back to the page, zoom is the browser's full screen. */
const WINDOW_MENU: DemoMenu = { label: 'Window', items: [
  item('Minimize', { kind: 'exit' }, 'CmdOrCtrl+M'), item('Zoom', { kind: 'fullscreen' }), SEP,
  item('Bring All to Front', { kind: 'exit' }, undefined, { disabled: true })
] };

/** The demo's own Help menu (the app has none): the checklist, the site, the bundle's notices, the download. */
const HELP_MENU: DemoMenu = { label: 'Help', items: [
  item('Things to Try', { kind: 'checklist' }), SEP,
  item('Atelier Website', { kind: 'link', href: '/' }), item('Licenses', { kind: 'licenses' }), SEP,
  item('Download for Mac', { kind: 'link', href: DOWNLOAD_HREF })
] };

/** What the demo knows of the definition's checkedWhen conditions (any other: unchecked, still a checkbox). */
const checksOf = (env: MenuEnv): Partial<Record<MenuCondition, boolean>> => ({ 'word-wrap': !!env.wordWrap });

/** How an item is announced: a checkbox (Word Wrap), a radio (a workspace) or a plain item. */
export function entryRole(e: DemoMenuEntry): 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' {
  if (e.kind !== 'item' || e.checked === undefined) return 'menuitem';
  return e.checkbox ? 'menuitemcheckbox' : 'menuitemradio';
}

/** A menu with any checkable item: every item gets the ✓ column, as macOS lines up a menu's labels. */
export const hasChecks = (entries: readonly DemoMenuEntry[]): boolean => entries.some((e) => entryRole(e) !== 'menuitem');

/** The shell's menu env from the demo's settings, as main builds its menu from the app's (and the page's workspaces). */
export function demoMenuEnv(s: Settings, workspaces: MenuEnv['workspaces']): MenuEnv {
  return { profiles: true, accounts: s.claudeAccounts.list, wordWrap: s.wordWrap, ...(workspaces && { workspaces }) };
}

function entry(i: MenuSpecItem, env: MenuEnv): DemoMenuEntry | null {
  if (i.when === 'development') return null;
  // Workspaces: what needs them shows while they are on (the list itself: entries()).
  if ('dynamicItems' in i || (i.visibleWhen === 'workspaces' && !env.workspaces)) return null;
  // visibleWhen: the demo's project has repositories, Git actions on and messages with Claude on (the defaults).
  if ('type' in i) return SEP;
  if ('role' in i) {
    const r = ROLE[i.role];
    return item(i.label ?? r.label, r.effect, i.accelerator ?? r.accel, { disabled: r.disabled });
  }
  if ('dynamicSubmenu' in i) {
    // As main builds it: one item per Claude account, no entry with only one.
    if (i.dynamicSubmenu === 'accounts') {
      if (env.accounts.length < 2) return null;
      return { kind: 'submenu', label: i.label, items: env.accounts.map((a) => item(a.name, { kind: 'command', command: `new-session-account:${a.id}` })) };
    }
    const off = i.enabledWhen === 'profiles' && !env.profiles;
    return { kind: 'submenu', label: i.label, items: off ? [] : [item('Default', { kind: 'command', command: 'new-terminal' })], ...(off && { disabled: true }) };
  }
  if ('command' in i) {
    if (i.visible === false) return null;
    // 'git-undo': the demo never commits (it asks to download), so there is never one to undo.
    const e = item(i.label, { kind: 'command', command: i.command }, i.accelerator, { disabled: (i.enabledWhen === 'profiles' && !env.profiles) || i.enabledWhen === 'git-undo' });
    // A checkbox (View › Word Wrap): its ✓ follows the demo's settings, as main's menu follows the app's.
    return e.kind === 'item' && i.checkedWhen ? { ...e, checked: !!checksOf(env)[i.checkedWhen], checkbox: true } : e;
  }
  return item(i.label, { kind: 'not-in-demo', what: plainLabel(i.label) }, i.accelerator);
}

/** No separator first, last or twice in a row (skipped items can leave them so). */
function tidy(entries: DemoMenuEntry[]): DemoMenuEntry[] {
  const out: DemoMenuEntry[] = [];
  for (const e of entries) {
    if (e.kind === 'separator' && (out.length === 0 || out.at(-1)!.kind === 'separator')) continue;
    out.push(e);
  }
  while (out.at(-1)?.kind === 'separator') out.pop();
  return out;
}

/** An item as drawn, or the workspaces as main lists them in Go (one item each, ⌘⌥1…9 on the first nine, ✓ in front). */
function entries(i: MenuSpecItem, env: MenuEnv): DemoMenuEntry[] {
  if (!('dynamicItems' in i)) { const e = entry(i, env); return e ? [e] : []; }
  const ws = env.workspaces;
  return (ws?.names ?? []).map((name, n) => ({ ...item(name, { kind: 'command', command: `workspace-${n}` }, n < 9 ? `CmdOrCtrl+Alt+${n + 1}` : undefined), checked: n === ws!.active }));
}

export function buildMenus(spec: readonly MenuSpecMenu[], env: MenuEnv): DemoMenu[] {
  const menus = spec.map((m): DemoMenu => {
    if ('role' in m) return m.role === 'editMenu' ? EDIT_MENU : WINDOW_MENU;
    const items = tidy(m.submenu.flatMap((i) => entries(i, env)));
    return { label: m.label, ...(m.app && { app: true }), items };
  });
  return [...menus, HELP_MENU];
}

const landable = (e: DemoMenuEntry | undefined) => !!e && e.kind !== 'separator' && !e.disabled;

/** The next item ↑/↓ lands on from `from` (-1: none yet), skipping separators and disabled items, wrapping. */
export function step(entries: readonly DemoMenuEntry[], from: number, dir: 1 | -1): number {
  const n = entries.length;
  if (!entries.some(landable)) return -1;
  let i = from < 0 ? (dir === 1 ? -1 : n) : from;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (landable(entries[i])) return i;
  }
  return -1;
}

// Workspace menus: the workspace's own (right-click on its head or card,
// Shift+F10) and Move to Workspace › on rows and tabs.
import type { MenuItem } from './menu-model';
import type { TabKey } from './tabs-model';
import { useApp } from './store';
import { t } from './i18n/en';
import { kbd } from './kbd';
import { newTerminalIn } from './launch';
import { memberOf, workspaceKey, workspaceOf, workspacesOf, WS_COLORS } from './workspaces';
import { cardOf } from './workspace-view';

const st = () => useApp.getState();

/** The workspace's menu: Rename, Color ›, New Session/Terminal Here, Move Up/Down, New Workspace…, Close Workspace…. */
export function workspaceMenu(id: string): MenuItem[] {
  const ws = st().ws;
  const i = ws?.list.findIndex((w) => w.id === id) ?? -1;
  const w = ws?.list[i];
  if (!ws || !w) return [];
  // "Here": the workspace comes to the front first, so what starts belongs to it.
  const here = (fn: () => void) => () => { st().switchWorkspace(id); fn(); };
  const last = ws.list.length <= 1;
  const colors: MenuItem[] = Array.from({ length: WS_COLORS }, (_, n) => ({
    id: `ws-color:${n + 1}`, label: t.ws.colors[n]!, ...(w.color === n + 1 ? { icon: 'check' as const } : {}), run: () => st().recolorWorkspace(id, n + 1)
  }));
  return [
    { id: 'ws-rename', label: t.ws.rename, icon: 'edit', run: () => st().setWsRenaming(id) },
    { id: 'ws-color', label: t.ws.color, run: () => {}, submenu: colors },
    'sep',
    { id: 'ws-new-session', label: t.ws.newSessionHere, icon: 'sparkle', hint: kbd('⌘N'), run: here(() => st().setNewSessionOpen(true)) },
    { id: 'ws-new-terminal', label: t.ws.newTerminalHere, icon: 'terminal', hint: kbd('⌘T'), run: here(() => void newTerminalIn()) },
    'sep',
    { id: 'ws-up', label: t.ws.moveUp, icon: 'arrowUp', disabled: i === 0, run: () => st().moveWorkspace(id, -1) },
    { id: 'ws-down', label: t.ws.moveDown, icon: 'arrowDown', disabled: i === ws.list.length - 1, run: () => st().moveWorkspace(id, 1) },
    'sep',
    { id: 'ws-new', label: t.ws.newWorkspace, icon: 'plus', hint: kbd('⌘⌥T'), run: () => st().setWsSheet({}) },
    { id: 'ws-close', label: t.ws.close, icon: 'x', danger: true, disabled: last, ...(last ? { tip: t.ws.lastTip } : {}), run: () => askCloseWorkspace(id) }
  ];
}

/**
 * Next / Previous Workspace (the Go menu, the palette): the neighbouring workspace in the sidebar's order, wrapping
 * around, where it was left.
 */
export function stepWorkspace(dir: -1 | 1): void {
  const s = st();
  if (!s.ws?.on || s.popout) return;
  const wss = workspacesOf(s.ws);
  if (wss.length < 2) return;
  const here = workspaceOf(s.ws, s.ws.active);
  const i = wss.findIndex((w) => w.id === here);
  const n = wss.length;
  s.goToWorkspace(wss[(i + dir + n) % n]!.id);
}

/** ⌥⌘1…9 and the Go menu's list: workspace `n` (0-based, activities aside), where it was left. */
export function goToWorkspaceAt(n: number): void {
  const s = st();
  const w = s.ws?.on && !s.popout ? workspacesOf(s.ws)[n] : undefined;
  if (w) s.goToWorkspace(w.id);
}

/** Close Workspace…: an empty workspace closes at once; one with something in it asks first. */
export function askCloseWorkspace(id: string): void {
  const s = st();
  const ws = s.workspacesNow();
  if (!ws || !s.project) return;
  const card = cardOf(ws, id, s.terminals, s.resumables, s.project.root, s.openFiles.map((f) => f.path), s.revFiles.map((f) => f.key));
  if (card.empty) void s.closeWorkspace(id, 'move');
  else s.setWsCloseAsk(id);
}

/** Move to Workspace › for a row or a tab: the other workspaces, then New Workspace…. None while off, none for project views. */
export function moveToWorkspaceItems(key: TabKey): MenuItem[] {
  const s = st();
  if (!s.ws?.on || s.popout || !workspaceKey(key)) return [];
  // A row of a workspace not in front (open in the sidebar): every workspace but its own.
  const own = key.startsWith('t:') ? memberOf(s.ws, key.slice(2)) : s.ws.active;
  const others = s.ws.list.filter((w) => w.id !== own);
  const sub: MenuItem[] = [
    ...others.map((w): MenuItem => ({ id: `move-ws:${w.id}`, label: w.name, run: () => st().moveToWorkspace(key, w.id) })),
    ...(others.length ? ['sep' as const] : []),
    { id: 'move-ws-new', label: t.ws.newWorkspace, icon: 'plus', run: () => st().setWsSheet({ move: key }) }
  ];
  return [{ id: 'move-workspace', label: t.ws.moveTo, icon: 'workspace', run: () => {}, submenu: sub }];
}

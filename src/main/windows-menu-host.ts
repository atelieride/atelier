import type { MenuCommand } from '@shared/api';
import type { MenuAction } from '@shared/menu-spec';
import { menuIds, type WinMenu, type WinRole } from '@shared/windows-menu';

// The menu on Windows: no native menu (the window is frameless, and a
// native menu would take its shortcuts before the page could leave Ctrl+letter to a terminal). Each window gets the
// model of its own menu (the Git menu follows its project), draws it in its header and sends back the id of what was
// chosen; only an id this window was sent runs.

interface Target { id: number; send(model: WinMenu[]): void }

export class WindowsMenuHost {
  private sent = new Map<number, string>();
  private ids = new Map<number, Set<string>>();
  private watched = new Set<number>();

  /** `watch` hears of a window once, with what to call when it is gone. */
  constructor(private readonly deps: { windows(): Target[]; build(wcId: number): WinMenu[]; watch?(wcId: number, gone: () => void): void }) {}

  /** Sends each window its model again when it changed. */
  refresh(): void {
    for (const w of this.deps.windows()) {
      const m = this.deps.build(w.id);
      const key = JSON.stringify(m);
      if (this.sent.get(w.id) === key) continue;
      this.sent.set(w.id, key);
      this.ids.set(w.id, menuIds(m));
      w.send(m);
    }
  }

  /** A window asking for its model (on load). */
  model(wcId: number): WinMenu[] {
    if (!this.watched.has(wcId)) { this.watched.add(wcId); this.deps.watch?.(wcId, () => this.forget(wcId)); }
    const m = this.deps.build(wcId);
    this.sent.set(wcId, JSON.stringify(m));
    this.ids.set(wcId, menuIds(m));
    return m;
  }

  allowed(wcId: number, id: string): boolean {
    return this.ids.get(wcId)?.has(id) ?? false;
  }

  forget(wcId: number): void {
    this.sent.delete(wcId);
    this.ids.delete(wcId);
    this.watched.delete(wcId);
  }
}

interface MenuWindow { isDestroyed(): boolean; webContents: { isDestroyed(): boolean; getURL(): string } }

/**
 * The windows that get a menu: app pages still alive. A closing window's page is destroyed before the window, and the
 * menu is refreshed from that page's 'destroyed' event: its URL can no longer be read (it throws).
 */
export function menuTargets<W extends MenuWindow>(all: W[], isApp: (url: string) => boolean): W[] {
  return all.filter((b) => !b.isDestroyed() && !b.webContents.isDestroyed() && isApp(b.webContents.getURL()));
}

const ROLES = new Set<WinRole>(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'minimize', 'maximize', 'close', 'quit', 'togglefullscreen', 'reload', 'toggleDevTools']);
const ACTIONS = new Set<MenuAction>(['check-for-updates', 'new-window', 'open-folder', 'restart-daemon']);

/** Runs a menu item by its id: a command to the window (as a native click sends it), an action in main, a role. */
export function runMenuItem(id: string, h: { command(c: MenuCommand): void; action(a: MenuAction): void; role(r: WinRole): void }): void {
  const at = id.indexOf(':');
  const kind = id.slice(0, at);
  const what = id.slice(at + 1);
  if (kind === 'command' && what) h.command(what as MenuCommand);
  else if (kind === 'action' && ACTIONS.has(what as MenuAction)) h.action(what as MenuAction);
  else if (kind === 'role' && ROLES.has(what as WinRole)) h.role(what as WinRole);
}

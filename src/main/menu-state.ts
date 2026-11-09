import type { MenuState } from '@shared/api';
import { NO_MENU_STATE as NONE } from '@shared/menu-spec';

/**
 * What each window told main for the application menu (the Git menu), by webContents
 * id. The menu is the app's, so it shows the focused window's state; with none focused (a hidden test window, the
 * moment between two windows), the last window heard from.
 */
export class MenuStates {
  private readonly by = new Map<number, MenuState>();
  private last: number | null = null;

  set(id: number, s: MenuState): void {
    this.by.set(id, s);
    this.last = id;
  }

  drop(id: number): void {
    this.by.delete(id);
    if (this.last === id) this.last = null;
  }

  /** One window's own state (Windows: each window draws its own menu). */
  of(id: number): MenuState {
    return this.by.get(id) ?? NONE;
  }

  front(focused: number | null): MenuState {
    const id = focused ?? this.last;
    return (id !== null ? this.by.get(id) : undefined) ?? NONE;
  }
}

// The sidebar hidden: a preference of this installation, like Changes' (store.ts
// readShowChanges), so the next window and the next launch open as it was left. Missing storage: shown.
import { focusTerminal } from './terminal/focus';

export const SIDEBAR_HIDDEN_KEY = 'atelier.sidebarHidden';

export function readSidebarHidden(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1'; } catch { return false; }
}

export function writeSidebarHidden(hidden: boolean): void {
  try { localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0'); } catch { /* storage unavailable */ }
}

/** The keyboard is in the sidebar or on its edge (⌘B pressed from the tree, a row, the edge). */
export function keyboardInSidebar(): boolean {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  return !!el?.closest('.body > .sidebar, .body > .sidebar + .resizer');
}

/** Where the keyboard goes when the sidebar hides under it: the terminal in front, else the tab in front. */
export function keyboardToWork(key: string | null): void {
  if (key?.startsWith('t:')) focusTerminal(key.slice(2));
  else document.querySelector<HTMLElement>('.workspace [role="tab"][tabindex="0"]')?.focus();
}

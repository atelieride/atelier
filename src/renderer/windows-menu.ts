import { matches, parseAccelerator, typedWithAltGr, type Combo, type KeyLike } from '@shared/accelerators';
import type { WinMenu, WinMenuItem } from '@shared/windows-menu';
import type { MenuItem } from './menu-model';

// The menu in the window's header on Windows: its drop-downs are the app's
// context menu, its shortcuts are matched here (there is no native menu to take them), and a terminal keeps every
// Ctrl+letter: Claude Code and the shell use them (Ctrl+C, Ctrl+R, Ctrl+W…).

/** The items of one menu as context-menu items; `invoke` sends the chosen id to main. */
export function toContextItems(items: readonly WinMenuItem[], invoke: (id: string) => void): MenuItem[] {
  return items.map((i, n): MenuItem => {
    if (i.kind === 'separator') return 'sep';
    if (i.kind === 'submenu') return { id: `sub-${n}`, label: i.label, disabled: !i.enabled || i.items.length === 0, submenu: toContextItems(i.items, invoke), run: () => {} };
    return {
      id: i.id, label: i.label, ...(i.checked !== undefined && { checked: i.checked, ...(i.radio && { radio: true as const }) }), ...(i.checked && { icon: 'check' as const }),
      ...(i.accel && { hint: i.accel }), ...(!i.enabled && { disabled: true }), run: () => invoke(i.id)
    };
  });
}

export interface MenuBinding { id: string; combo: Combo; enabled: boolean }

/** F1 opens the palette in the page's own keydown (App.tsx), before any menu; Windows closes the window on Alt+F4
 *  itself: never bound twice. */
const PAGE_OWNED = new Set(['F1', 'Alt+F4']);

/** The shortcuts to match: menu items, not the native Edit keys (the focused field handles them itself). */
export function menuBindings(menus: readonly WinMenu[]): MenuBinding[] {
  const out: MenuBinding[] = [];
  const walk = (items: readonly WinMenuItem[]) => {
    for (const i of items) {
      if (i.kind === 'submenu') walk(i.items);
      else if (i.kind === 'item' && i.accel && !i.native && !PAGE_OWNED.has(i.accel)) out.push({ id: i.id, combo: parseAccelerator(i.accel, false), enabled: i.enabled });
    }
  };
  for (const m of menus) walk(m.items);
  return out;
}

/** Ctrl and a letter alone: the terminal's (spec: rule 1). */
const terminalKey = (e: KeyLike) => e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && /^Key[A-Z]$/.test(e.code);

/** The item a keydown runs; null for none, a key the focused terminal keeps, or one the page already handled. */
export function pickBinding(bindings: readonly MenuBinding[], e: KeyLike, inTerminal: boolean): string | null {
  if (e.isComposing || e.defaultPrevented || (inTerminal && terminalKey(e))) return null;
  const b = bindings.find((x) => matches(x.combo, e) && !typedWithAltGr(x.combo, e, false));
  return b && b.enabled ? b.id : null;
}

type KeyEvent = KeyLike & { preventDefault(): void; stopPropagation(): void };

export interface MenuKeysDeps {
  bindings(): readonly MenuBinding[];
  inTerminal(): boolean;
  /** The focused terminal's program runs full screen and wants F10 (htop, mc): the menu leaves it the key. */
  terminalTakesF10?(): boolean;
  /** Opens the first menu; false when the window has none (a pop-out). */
  open(): boolean;
  invoke(id: string): void;
}

/**
 * The window's keydown/keyup listeners for its menu. A focused terminal's keys are matched in the capture phase, before
 * xterm stops them (F11, arrows, Tab); every other key in the bubble phase, after the page: a key CodeMirror or a field
 * handled (preventDefault) stays theirs, as macOS gives the page the key before the menu. Alt pressed and released
 * alone opens the menu; Alt as a modifier (Alt+B in a shell, Alt+click) does not.
 */
export function menuKeys(d: MenuKeysDeps) {
  let altAlone = false;
  const run = (e: KeyEvent, inTerminal: boolean) => {
    const id = pickBinding(d.bindings(), e, inTerminal);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    d.invoke(id);
  };
  return {
    capture(e: KeyEvent): void {
      altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (d.inTerminal() && d.terminalTakesF10?.()) return;
        if (d.open()) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (d.inTerminal()) run(e, true);
    },
    bubble(e: KeyEvent): void {
      if (!d.inTerminal()) run(e, false);
    },
    up(e: KeyEvent): void {
      if (e.key !== 'Alt' || !altAlone) return;
      altAlone = false;
      if (d.open()) e.preventDefault();
    },
    /** A click, a wheel turn or leaving the window between Alt's press and release: Alt was a modifier. */
    reset(): void { altAlone = false; }
  };
}

/**
 * The menu bar folded behind a hamburger on Windows: the titles unfold
 * sideways from the button and fold away once the user is done with them. `open`: the title whose drop-down is open.
 */
/**
 * Where a title's drop-down hangs: 4 px under the bar the titles sit on, not under the
 * title itself — placeDropDown puts a menu 6 px under its anchor.
 */
export function titleAnchor(title: { left: number; right: number }, barBottom: number): { left: number; right: number; bottom: number } {
  return { left: title.left, right: title.right, bottom: barBottom - 2 };
}

export interface BarState { expanded: boolean; open: number | null }

export type BarEvent =
  | { type: 'toggle' }
  | { type: 'title'; index: number }
  /** The pointer on a title: switches drop-downs while one is open. */
  | { type: 'hover'; index: number }
  /** ← / → in a drop-down. */
  | { type: 'step'; dir: -1 | 1 }
  /** Alt alone or F10. */
  | { type: 'keys' }
  /** The drop-down closed by itself (an item chosen, Esc, a click outside it). */
  | { type: 'closed'; overTitles: boolean }
  /** A click elsewhere, Esc, the window left, with no drop-down open. */
  | { type: 'dismiss' };

export const CLOSED_BAR: BarState = { expanded: false, open: null };

export function reduceBar(s: BarState, e: BarEvent, count: number): BarState {
  switch (e.type) {
    case 'toggle': return s.expanded ? CLOSED_BAR : { expanded: true, open: null };
    case 'title': return { expanded: true, open: s.open === e.index ? null : e.index };
    case 'hover': return s.open !== null && s.open !== e.index ? { expanded: true, open: e.index } : s;
    case 'step': return s.open === null || count === 0 ? s : { expanded: true, open: (s.open + e.dir + count) % count };
    case 'keys': return count === 0 ? s : s.open !== null ? CLOSED_BAR : { expanded: true, open: 0 };
    // Clicking the open title closes its drop-down from the menu's layer: the titles stay for the next pick. A bar
    // already folded (the window left before the menu heard of it) stays folded.
    case 'closed': return !s.expanded ? s : e.overTitles ? { expanded: true, open: null } : CLOSED_BAR;
    case 'dismiss': return s.expanded ? CLOSED_BAR : s;
  }
}

export interface MenuBarHost<M> {
  count(): number;
  /** Opens title i's drop-down as the app's context menu; the store's menu it made, null when it had nothing to show. */
  open(i: number): M | null;
  close(): void;
  /** The store's menu now. */
  current(): M | null;
  /** The pointer is on a title (the menu's layer covers them, so the window follows it). */
  overTitles(): boolean;
}

/**
 * The folded bar wired to the app's one context menu (the store's `menu`): its state, and the drop-down that follows
 * it. `sync` runs once the titles are drawn (the titles of a bar unfolded by Alt exist only after that render);
 * `storeChanged` hears every change of the store's menu, synchronously, inside openMenu and closeMenu too.
 */
export function menuBar<M>(host: MenuBarHost<M>) {
  let state = CLOSED_BAR;
  // The drop-down this bar opened; `opening`: the store is changing because of this bar.
  let ours: M | null = null;
  let opening = false;
  const listeners = new Set<() => void>();
  const dispatch = (e: BarEvent) => {
    const next = reduceBar(state, e, host.count());
    if (next.expanded === state.expanded && next.open === state.open) return;
    state = next;
    for (const l of listeners) l();
  };
  return {
    state: () => state,
    subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
    dispatch,
    sync(): void {
      if (state.open === null) {
        const mine = ours;
        ours = null;
        if (mine !== null && host.current() === mine) { opening = true; host.close(); opening = false; }
        return;
      }
      const prev = ours;
      opening = true;
      const m = host.open(state.open);
      // Nothing to show: no drop-down (the one before closes too), the titles stay.
      if (m === null && prev !== null && host.current() === prev) host.close();
      opening = false;
      ours = m;
      if (m === null) dispatch({ type: 'closed', overTitles: true });
    },
    storeChanged(menu: M | null): void {
      if (opening || ours === null || menu === ours) return;
      ours = null;
      dispatch({ type: 'closed', overTitles: host.overTitles() });
    },
    /** The window's menu changed: an open drop-down's items, even its index, are stale. */
    menusChanged(): void { if (state.open !== null) dispatch({ type: 'dismiss' }); },
    /** Esc: folds titles unfolded with no drop-down, and the key is the bar's then (true). */
    escape(): boolean {
      if (!state.expanded || state.open !== null) return false;
      dispatch({ type: 'dismiss' });
      return true;
    }
  };
}

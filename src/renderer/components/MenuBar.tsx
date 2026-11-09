import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { currentPlatform } from '@shared/platform';
import type { WinMenu } from '@shared/windows-menu';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';
import { menuBar, menuBindings, menuKeys, titleAnchor, toContextItems } from '../windows-menu';
import { terminalTakesF10 } from '../terminal/registry';

// Windows: no system title bar; the window's one
// bar is Atelier's header — the menu behind a hamburger at its start, the caption buttons the system draws over its end.
//The menu titles unfold
// sideways from the hamburger, on a veil over the bar, and fold away once used.
// Each window loads its own menu from main; the drop-downs are the app's context menu; the shortcuts are matched here
// (menuKeys: after the page, before xterm, every Ctrl+letter left to a focused terminal). F10 or Alt alone unfold the
// titles and open the first menu.

let menus: WinMenu[] = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

const invoke = (id: string) => window.atelier.menu.invoke(id);

type StoreMenu = ReturnType<typeof useApp.getState>['menu'];
const titles = () => [...document.querySelectorAll<HTMLElement>('.menubar .menubar-title')];
let pointer: { x: number; y: number } | null = null;
const titleAt = (x: number, y: number) => titles().findIndex((el) => { const r = el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; });

const bar = menuBar<NonNullable<StoreMenu>>({
  count: () => menus.length,
  open: (i) => {
    const el = titles()[i];
    const m = menus[i];
    if (!el || !m) return null;
    const r = el.getBoundingClientRect();
    // Under the bar the titles sit on (the header, or the Welcome window's bar), not under the title itself.
    const at = titleAnchor(r, el.closest('.header, .titlebar')?.getBoundingClientRect().bottom ?? r.bottom);
    const before = useApp.getState().menu;
    useApp.getState().openMenu({ x: at.left, y: at.bottom, anchor: at }, toContextItems(m.items, invoke), { onStep: (dir) => bar.dispatch({ type: 'step', dir }) });
    // A menu with no item opens nothing (openMenu keeps what was there).
    const now = useApp.getState().menu;
    return now !== before ? now : null;
  },
  close: () => useApp.getState().closeMenu(),
  current: () => useApp.getState().menu,
  overTitles: () => !!pointer && titleAt(pointer.x, pointer.y) >= 0
});
useApp.subscribe((s) => bar.storeChanged(s.menu));

const setMenus = (m: WinMenu[]) => { menus = m; bar.menusChanged(); for (const l of listeners) l(); };

/** Opens the first menu (F10, Alt): a pop-out has no hamburger, nothing happens there. */
function openFromKeys(): boolean {
  if (!document.querySelector('.menubar-toggle') || !menus[0]) return false;
  bar.dispatch({ type: 'keys' });
  return true;
}

/** Windows: this window's menu and its shortcuts. Once per window (App), project windows and pop-outs alike. */
export function useWindowsMenu(): void {
  useEffect(() => {
    if (currentPlatform() !== 'win32') return;
    let live = true;
    void window.atelier.menu.model().then((m) => { if (live && m) setMenus(m); }).catch(() => { /* no menu: shortcuts off */ });
    const off = window.atelier.on.menuModel(setMenus);
    let bindings = menuBindings(menus);
    const unsub = subscribe(() => { bindings = menuBindings(menus); });
    const keys = menuKeys({
      bindings: () => bindings,
      inTerminal: () => !!(document.activeElement as HTMLElement | null)?.closest('.xterm'),
      terminalTakesF10: () => terminalTakesF10(document.activeElement),
      open: openFromKeys,
      invoke
    });
    const reset = () => keys.reset();
    window.addEventListener('keydown', keys.capture, true);
    window.addEventListener('keydown', keys.bubble);
    window.addEventListener('keyup', keys.up, true);
    window.addEventListener('mousedown', reset, true);
    window.addEventListener('wheel', reset, { capture: true, passive: true });
    window.addEventListener('blur', reset);
    return () => {
      live = false;
      off();
      unsub();
      window.removeEventListener('keydown', keys.capture, true);
      window.removeEventListener('keydown', keys.bubble);
      window.removeEventListener('keyup', keys.up, true);
      window.removeEventListener('mousedown', reset, true);
      window.removeEventListener('wheel', reset, true);
      window.removeEventListener('blur', reset);
    };
  }, []);
}

/**
 * The window menu on Windows: the hamburger, and while it is open a veil over the bar it sits in with the titles it
 * unfolds and how to close it. A click keeps the focus where it was (a command lands where the user was).
 */
export function WindowMenu() {
  const list = useSyncExternalStore(subscribe, () => menus);
  const state = useSyncExternalStore(bar.subscribe, bar.state);
  const nav = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  // The drop-down follows the bar once its titles are drawn: opened under its title, switched, or closed.
  useLayoutEffect(() => { bar.sync(); }, [state.open]);

  useEffect(() => {
    if (!state.expanded) return;
    pointer = null;
    // The menu's layer covers the titles while a drop-down is open: the pointer is followed on the window.
    const move = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      const i = titleAt(e.clientX, e.clientY);
      if (i >= 0) bar.dispatch({ type: 'hover', index: i });
    };
    const down = (e: MouseEvent) => {
      const at = e.target as Node | null;
      if (bar.state().open !== null || nav.current?.contains(at) || toggle.current?.contains(at)) return;
      bar.dispatch({ type: 'dismiss' });
    };
    // Before xterm (which would send ESC to the program): Esc that folds the titles is the bar's.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !bar.escape()) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const blur = () => bar.dispatch({ type: 'dismiss' });
    window.addEventListener('pointermove', move, true);
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
    };
  }, [state.expanded]);

  return (
    <>
      <button ref={toggle} type="button" className={`menubar-toggle${state.expanded ? ' is-open' : ''}`} aria-label={t.menuBar} aria-expanded={state.expanded}
        data-tip={state.expanded ? undefined : t.menuBar} data-kbd={state.expanded ? undefined : 'Alt'}
        onMouseDown={(e) => e.preventDefault()} onClick={() => bar.dispatch({ type: 'toggle' })}>
        <Icon name="menu" size={16} stroke={1.7} />
      </button>
      {state.expanded && (
        // The veil's empty part is outside the titles: a click there folds them (the window's mousedown, above).
        <div className="menubar-veil">
          <nav ref={nav} className="menubar" aria-label={t.menuBar}>
            {list.map((m, i) => (
              <button key={m.label} type="button" className={`menubar-title${state.open === i ? ' is-open' : ''}`} aria-haspopup="menu" aria-expanded={state.open === i}
                onMouseDown={(e) => e.preventDefault()} onClick={() => bar.dispatch({ type: 'title', index: i })}>
                {m.label}
              </button>
            ))}
          </nav>
          <span className="menubar-hint" aria-hidden="true">{t.menuBarHint}</span>
        </div>
      )}
    </>
  );
}

/** The Welcome window's bar on Windows (no header there): the window menu in a row as tall as the header. */
export function TitleBar({ floating = false }: { floating?: boolean }) {
  return <div className={`titlebar${floating ? ' is-floating' : ''}`}><WindowMenu /></div>;
}

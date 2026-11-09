import { DOWNLOAD_HREF, entryRole, hasChecks, step, type DemoMenu, type DemoMenuEntry } from './menu-model';
import { h, icon, ICONS } from './dom';
import type { MenuEffect } from './effects';

// The macOS-style menu bar. Menus open on click and follow the pointer while one is open;
// the keyboard works as on a Mac (←/→ between menus, ↑/↓ items, Enter, Esc, a letter jumps). Opened with the mouse, a
// menu never takes the focus (a native menu doesn't): the terminal or the editor keeps it, so Copy or Undo act on
// them and a command lands where the visitor was. Opened from the keyboard (Tab to a title, ⌃F2), the focus follows
// the highlighted item, for screen readers. The drop-downs reuse the app's context-menu look (.ctx-menu).

export interface MenubarDeps {
  menus: DemoMenu[];
  run(effect: MenuEffect): void;
  /** Before an item runs: the focus back where the visitor was in the app. */
  restoreFocus(): void;
  isFullscreen(): boolean;
  exit(): void;
}

interface Popup { el: HTMLElement; entries: DemoMenuEntry[]; buttons: (HTMLButtonElement | null)[]; active: number }

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Tab', 'Home', 'End']);

export function createMenubar(layer: HTMLElement, d: MenubarDeps) {
  const bar = h('nav', { class: 'dm-bar', 'aria-label': 'Live demo' });
  const strip = h('div', { class: 'dm-menus', role: 'menubar', 'aria-label': 'Atelier' });
  const titles = d.menus.map((m, i) => {
    const b = h('button', { type: 'button', class: `dm-title${m.app ? ' is-app' : ''}`, role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: i === 0 ? 0 : -1, id: `dm-title-${i}` }, m.label);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { if (open === i) close('none'); else openMenu(i, e.detail === 0); });
    b.addEventListener('pointerenter', () => { if (open >= 0 && open !== i) openMenu(i, keyboard); });
    strip.append(b);
    return b;
  });

  const download = h('a', { class: 'dm-download', href: DOWNLOAD_HREF, target: '_top' }, icon(ICONS.download, 13, 1.8), 'Download for Mac');
  const exit = h('button', { type: 'button', class: 'dm-exit' }, 'Exit demo');
  exit.addEventListener('click', () => d.exit());
  for (const el of [download, exit]) el.addEventListener('mousedown', (e) => e.preventDefault());
  const right = h('div', { class: 'dm-right' },
    h('span', { class: 'dm-live' }, h('i', { class: 'dm-live-dot', 'aria-hidden': 'true' }), 'Live demo · scripted sessions'),
    download, exit);
  bar.append(strip, right);
  layer.append(bar);

  let open = -1;
  let keyboard = false;
  let main: Popup | null = null;
  let sub: Popup | null = null;

  const labelOf = (e: Exclude<DemoMenuEntry, { kind: 'separator' }>) =>
    (e.kind === 'item' && e.effect.kind === 'fullscreen' && e.label === 'Enter Full Screen' && d.isFullscreen() ? 'Exit Full Screen' : e.label);

  function build(entries: DemoMenuEntry[], label: string, isSub: boolean): Popup {
    const el = h('div', { class: `ctx-menu dm-menu${isSub ? ' ctx-submenu' : ''}`, role: 'menu', 'aria-label': label });
    const p: Popup = { el, entries, buttons: [], active: -1 };
    // Checkable items (Go's workspaces, View › Word Wrap): a ✓ column for every item of the menu, as macOS lines up a
    // menu's labels; radios and checkboxes announced as such.
    const checks = hasChecks(entries);
    entries.forEach((e, i) => {
      if (e.kind === 'separator') { el.append(h('div', { class: 'ctx-sep', role: 'separator' })); p.buttons.push(null); return; }
      const role = entryRole(e);
      const b = h('button', {
        type: 'button', class: `ctx-item${checks ? ' is-choice' : ''}`, role, tabindex: -1, 'aria-disabled': e.disabled ? 'true' : undefined,
        'aria-checked': role !== 'menuitem' ? String(e.kind === 'item' && !!e.checked) : undefined,
        'aria-haspopup': e.kind === 'submenu' ? 'menu' : undefined, title: e.kind === 'item' ? e.reserved : undefined
      }, h('span', { class: 'ctx-label' }, labelOf(e)));
      if (checks) b.prepend(h('span', { class: 'dm-menu-check', 'aria-hidden': 'true' }, ...(e.kind === 'item' && e.checked ? [icon(ICONS.check, 12)] : [])));
      if (e.kind === 'item' && e.keys) b.append(h('span', { class: `ctx-hint mono${e.reserved ? ' is-reserved' : ''}` }, e.keys));
      if (e.kind === 'submenu') b.append(h('span', { class: 'ctx-sub', 'aria-hidden': 'true' }, icon(ICONS.chevronRight, 12)));
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.addEventListener('pointermove', () => {
        if (p.active === i) return;
        setActive(p, i, false);
        if (p === main) {
          if (e.kind === 'submenu' && !e.disabled) openSub(i, false);
          else closeSub();
        }
      });
      b.addEventListener('click', () => activate(p, i));
      el.append(b);
      p.buttons.push(b);
    });
    el.addEventListener('mousedown', (ev) => ev.preventDefault());
    el.addEventListener('pointerleave', () => { if (p === main && sub) return; setActive(p, -1, false); });
    return p;
  }

  function setActive(p: Popup, i: number, focus: boolean) {
    p.buttons[p.active]?.classList.remove('is-active');
    p.active = i;
    const b = p.buttons[i];
    b?.classList.add('is-active');
    if (b && focus) b.focus({ preventScroll: true });
  }

  function place(el: HTMLElement, left: number, top: number) {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    layer.append(el);
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth - 8) el.style.left = `${Math.max(8, innerWidth - 8 - r.width)}px`;
    if (r.bottom > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - 8 - r.height)}px`;
  }

  function openMenu(i: number, kb: boolean) {
    closeSub();
    main?.el.remove();
    if (open >= 0) titles[open]!.setAttribute('aria-expanded', 'false');
    titles[open]?.classList.remove('is-open');
    open = i;
    keyboard = kb;
    const t = titles[i]!;
    t.classList.add('is-open');
    t.setAttribute('aria-expanded', 'true');
    main = build(d.menus[i]!.items, d.menus[i]!.label, false);
    main.el.id = `dm-menu-${i}`;
    t.setAttribute('aria-controls', main.el.id);
    const r = t.getBoundingClientRect();
    place(main.el, r.left - 2, bar.getBoundingClientRect().bottom + 3);
    if (kb) setActive(main, step(main.entries, -1, 1), true);
  }

  function openSub(i: number, kb: boolean) {
    if (!main) return;
    const e = main.entries[i];
    if (!e || e.kind !== 'submenu' || e.disabled) return;
    closeSub();
    sub = build(e.items, e.label, true);
    const r = main.buttons[i]!.getBoundingClientRect();
    place(sub.el, r.right + 4, r.top - 6);
    if (kb) setActive(sub, step(sub.entries, -1, 1), true);
  }

  function closeSub() { sub?.el.remove(); sub = null; }

  /** `title`: back to the menu's title (Esc from the keyboard); `none`: the focus stays where it is. */
  function close(focus: 'title' | 'none') {
    if (open < 0) return;
    const t = titles[open]!;
    const hadFocus = main?.el.contains(document.activeElement) || sub?.el.contains(document.activeElement);
    closeSub();
    main?.el.remove();
    main = null;
    t.classList.remove('is-open');
    t.setAttribute('aria-expanded', 'false');
    open = -1;
    if (focus === 'title' && (hadFocus || keyboard)) t.focus({ preventScroll: true });
    else if (hadFocus) d.restoreFocus();
  }

  function activate(p: Popup, i: number) {
    const e = p.entries[i];
    if (!e || e.kind === 'separator' || e.disabled) return;
    if (e.kind === 'submenu') { openSub(i, true); return; }
    close('none');
    d.restoreFocus();
    d.run(e.effect);
  }

  /** Letters jump to the next item starting with them, as in macOS menus. */
  function jump(p: Popup, ch: string) {
    const n = p.entries.length;
    for (let k = 1; k <= n; k++) {
      const i = (p.active + k + n) % n;
      const e = p.entries[i];
      if (e && e.kind !== 'separator' && !e.disabled && e.label.toLowerCase().startsWith(ch)) { setActive(p, i, keyboard); return; }
    }
  }

  /** The window's capture keydown hands keys here first; true: the menu bar used the key. */
  function onKey(e: KeyboardEvent): boolean {
    const titleFocus = titles.indexOf(document.activeElement as HTMLButtonElement);
    if (open < 0) {
      if (titleFocus < 0) return false;
      const n = titles.length;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = titles[(titleFocus + (e.key === 'ArrowRight' ? 1 : -1) + n) % n]!;
        titles.forEach((t) => t.setAttribute('tabindex', t === next ? '0' : '-1'));
        next.focus();
        return true;
      }
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { openMenu(titleFocus, true); return true; }
      // Esc on a title: out of the menu bar, back to the app, as on a Mac.
      if (e.key === 'Escape') { d.restoreFocus(); return true; }
      return false;
    }
    const p = sub ?? main!;
    const mods = e.metaKey || e.ctrlKey || e.altKey;
    if (mods && !NAV_KEYS.has(e.key)) { close('none'); return false; } // an accelerator: the menu closes, the key runs
    switch (e.key) {
      case 'Escape': if (sub) { const at = main!.active; closeSub(); setActive(main!, at, keyboard); } else close('title'); return true;
      case 'ArrowDown': setActive(p, step(p.entries, p.active, 1), true); keyboard = true; return true;
      case 'ArrowUp': setActive(p, step(p.entries, p.active, -1), true); keyboard = true; return true;
      case 'Home': setActive(p, step(p.entries, -1, 1), true); keyboard = true; return true;
      case 'End': setActive(p, step(p.entries, -1, -1), true); keyboard = true; return true;
      case 'ArrowRight': {
        const e2 = main!.entries[main!.active];
        if (!sub && e2?.kind === 'submenu' && !e2.disabled) { openSub(main!.active, true); return true; }
        openMenu((open + 1) % titles.length, true);
        return true;
      }
      case 'ArrowLeft':
        if (sub) { const at = main!.active; closeSub(); setActive(main!, at, true); return true; }
        openMenu((open - 1 + titles.length) % titles.length, true);
        return true;
      case 'Enter': case ' ': if (p.active >= 0) activate(p, p.active); return true;
      case 'Tab': close('none'); d.restoreFocus(); return true;
      default:
        if (e.key.length === 1 && !mods) jump(p, e.key.toLowerCase());
        return true; // a menu is modal: nothing reaches the app behind it
    }
  }

  // Outside the bar and its menus, a press closes the menu (the press itself goes on to what it hit).
  addEventListener('pointerdown', (e) => {
    if (open < 0) return;
    const t = e.target as Node;
    if (bar.contains(t) || main?.el.contains(t) || sub?.el.contains(t)) return;
    close('none');
  }, true);
  addEventListener('blur', () => close('none'));
  addEventListener('resize', () => close('none'));

  return {
    isOpen: () => open >= 0,
    onKey,
    /** ⌃F2, as on a Mac: the keyboard into the menu bar. */
    focus() { titles[0]?.focus(); },
    height: () => bar.getBoundingClientRect().height
  };
}

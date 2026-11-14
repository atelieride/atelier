import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { edgeIndex, itemRole, menuFocus, nextIndex, placeAnchored, placeDropDown, placeMenu, placeSubmenu, type MenuItem } from '../menu-model';
import { useApp } from '../store';

type Entry = Exclude<MenuItem, 'sep'>;

function Item({ it, i, active, prefix, onEnter, onClick }: { it: Entry; i: number; active: boolean; prefix: string; onEnter: () => void; onClick: () => void }) {
  return (
    // A disabled item with a reason stays hoverable (aria-disabled) so its tooltip can say why.
    <button id={`${prefix}-${i}`} type="button" {...itemRole(it)} disabled={it.disabled && !it.tip} aria-disabled={it.disabled || undefined} tabIndex={-1}
      aria-haspopup={it.submenu ? 'menu' : undefined} data-tip={it.tip}
      className={`ctx-item ${active ? 'is-active' : ''} ${it.danger ? 'is-danger' : ''} ${it.accent ? 'is-accent' : ''} ${it.detail !== undefined ? 'has-detail' : ''} ${it.indent ? 'is-indent' : ''}`}
      onMouseEnter={onEnter} onClick={onClick}>
      <span className="ctx-icon">
        {it.swatch
          ? <span className={`ctx-swatch${it.checked ? ' is-on' : ''}`} style={{ '--sw': it.swatch } as CSSProperties} />
          : it.icon && <Icon name={it.icon} size={14} stroke={1.7} />}
      </span>
      {it.detail !== undefined
        ? <span className="ctx-label"><span className="ctx-detail-name">{it.label}</span><span className="ctx-detail mono">{it.detail}</span></span>
        : <span className="ctx-label">{it.label}</span>}
      {it.hint && <span className="ctx-hint mono">{it.hint}</span>}
      {it.submenu && <span className="ctx-sub"><Icon name="chevron" size={12} stroke={1.9} /></span>}
      {it.swatch && it.checked && <span className="ctx-check"><Icon name="check" size={13} stroke={2} /></span>}
    </button>
  );
}

/** Aurora right-click menu: closes on outside click, Esc, losing focus or scrolling. One level of submenus. */
export function ContextMenu() {
  const menu = useApp((s) => s.menu);
  const close = useApp((s) => s.closeMenu);
  const box = useRef<HTMLDivElement>(null);
  const subBox = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  const [active, setActive] = useState(-1);
  // Open submenu: the index of its item; keys go to it while subKeys is on (opened with → / Enter).
  const [sub, setSub] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(-1);
  const [subKeys, setSubKeys] = useState(false);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  // Moving the pointer diagonally to the submenu crosses other items: the submenu closes only after a short pause.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };

  // Focus returns to where it was (terminal, editor, tree) when the menu closes, unless the action moved it; a menu
  // replacing another keeps where the first found it.
  // In the cleanup, as early as the commit allows: before a sheet the chosen item opened focuses its own button.
  const [focus] = useState(() => menuFocus<HTMLElement>());
  useLayoutEffect(() => {
    if (!menu) return;
    focus.shown(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    return () => {
      // The store already holds what comes next: another menu keeps the focus to give back.
      if (useApp.getState().menu) return;
      const el = focus.closed();
      const now = document.activeElement;
      if (el && el.isConnected && (!now || now === document.body || now.closest('.ctx-menu'))) el.focus();
    };
  }, [menu, focus]);

  useLayoutEffect(() => {
    if (!menu || !box.current) { setPos(null); return; }
    const r = box.current.getBoundingClientRect();
    // A menu bar's drop-down (it steps to its neighbours) stays under the bar and scrolls when taller than the room.
    setPos(menu.anchor && menu.onStep ? placeDropDown(menu.anchor, r.width, r.height, window.innerWidth, window.innerHeight)
      : menu.anchor ? placeAnchored(menu.anchor, r.width, r.height, window.innerWidth, window.innerHeight) : placeMenu(menu.x, menu.y, r.width, r.height, window.innerWidth, window.innerHeight));
    setActive(-1);
    setSub(null);
    box.current.focus();
  }, [menu]);

  useLayoutEffect(() => {
    if (sub === null || !subBox.current || !box.current) { setSubPos(null); return; }
    const item = box.current.querySelector(`#ctx-item-${sub}`)?.getBoundingClientRect();
    if (!item) return;
    const r = subBox.current.getBoundingClientRect();
    setSubPos(placeSubmenu(item, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [sub, pos]);

  useEffect(() => {
    if (!menu) return;
    const shut = () => close();
    // Closes when the user scrolls (wheel), not when a log or a reloaded file scrolls by itself; a menu that scrolls
    // (a tall drop-down) takes the wheel over itself.
    const wheel = (e: WheelEvent) => {
      const el = box.current;
      if (el && el.scrollHeight > el.clientHeight && el.contains(e.target as Node | null)) return;
      close();
    };
    window.addEventListener('blur', shut);
    window.addEventListener('resize', shut);
    document.addEventListener('wheel', wheel, { capture: true, passive: true });
    return () => { window.removeEventListener('blur', shut); window.removeEventListener('resize', shut); document.removeEventListener('wheel', wheel, { capture: true }); cancelClose(); };
  }, [menu, close]);

  // The keys' item stays in sight in a menu that scrolls.
  useEffect(() => { if (active >= 0) box.current?.querySelector(`#ctx-item-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  if (!menu) return null;
  const subItems = sub !== null ? (menu.items[sub] as Entry | undefined)?.submenu ?? null : null;
  const openSub = (i: number, withKeys: boolean) => {
    const it = menu.items[i];
    if (!it || it === 'sep' || it.disabled || !it.submenu) return false;
    cancelClose();
    setActive(i);
    setSub(i);
    setSubKeys(withKeys);
    setSubActive(withKeys ? edgeIndex(it.submenu, 'first') : -1);
    return true;
  };
  const closeSub = () => { cancelClose(); setSub(null); setSubKeys(false); setSubActive(-1); };
  const runItem = (it: MenuItem | undefined) => {
    if (!it || it === 'sep' || it.disabled) return;
    close();
    it.run();
  };
  const pick = (i: number) => { if (!openSub(i, true)) runItem(menu.items[i]); };
  const hover = (i: number) => {
    setActive(i);
    const it = menu.items[i];
    if (it && it !== 'sep' && it.submenu && !it.disabled) { openSub(i, false); return; }
    if (sub !== null && !closeTimer.current) closeTimer.current = setTimeout(() => { closeTimer.current = null; setSub(null); setSubKeys(false); }, 250);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (subKeys && subItems) {
      if (e.key === 'Escape' || e.key === 'ArrowLeft') { e.preventDefault(); closeSub(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSubActive((a) => nextIndex(subItems, a, 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSubActive((a) => nextIndex(subItems, a < 0 ? 0 : a, -1)); }
      else if (e.key === 'Home') { e.preventDefault(); setSubActive(edgeIndex(subItems, 'first')); }
      else if (e.key === 'End') { e.preventDefault(); setSubActive(edgeIndex(subItems, 'last')); }
      else if (e.key === 'Tab') { e.preventDefault(); close(); }
      else if ((e.key === 'Enter' || e.key === ' ') && subActive >= 0) { e.preventDefault(); runItem(subItems[subActive]); }
      else if (e.key === 'ArrowRight' && menu.onStep) { e.preventDefault(); menu.onStep(1); }
      return;
    }
    // A menu bar's drop-down: ← and → (when no submenu opens) go to the neighbouring menu, as Windows menus do.
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); closeSub(); setActive((a) => nextIndex(menu.items, a, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); closeSub(); setActive((a) => nextIndex(menu.items, a < 0 ? 0 : a, -1)); }
    else if (e.key === 'ArrowRight' && !(active >= 0 && openSub(active, true)) && menu.onStep) { e.preventDefault(); menu.onStep(1); }
    else if (e.key === 'ArrowRight') e.preventDefault();
    else if (e.key === 'ArrowLeft' && menu.onStep) { e.preventDefault(); menu.onStep(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(edgeIndex(menu.items, 'first')); }
    else if (e.key === 'End') { e.preventDefault(); setActive(edgeIndex(menu.items, 'last')); }
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
    else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) { e.preventDefault(); pick(active); }
  };

  const descendant = subKeys && subActive >= 0 ? `ctx-sub-${subActive}` : active >= 0 ? `ctx-item-${active}` : undefined;
  return (
    <div className="menu-layer" onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div ref={box} className="ctx-menu" role="menu" tabIndex={-1} aria-activedescendant={descendant} style={pos ? { left: pos.left, top: pos.top, ...(pos.maxHeight !== undefined && { maxHeight: pos.maxHeight, overflowY: 'auto' as const }) } : { left: -9999, top: -9999 }}
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        {menu.items.map((it, i) => it === 'sep'
          ? <div key={`sep-${i}`} className="ctx-sep" role="separator" />
          : <Item key={it.id} it={it} i={i} prefix="ctx-item" active={i === active || sub === i} onEnter={() => hover(i)} onClick={() => pick(i)} />)}
      </div>
      {subItems && (
        <div ref={subBox} className="ctx-menu ctx-submenu" role="menu" aria-label={(menu.items[sub!] as Entry).label}
          style={subPos ? { left: subPos.left, top: subPos.top } : { left: -9999, top: -9999 }}
          onMouseDown={(e) => e.stopPropagation()} onMouseEnter={cancelClose}>
          {subItems.map((it, i) => it === 'sep'
            ? <div key={`sep-${i}`} className="ctx-sep" role="separator" />
            : <Item key={it.id} it={it} i={i} prefix="ctx-sub" active={i === subActive} onEnter={() => { cancelClose(); setActive(sub!); setSubActive(i); }} onClick={() => runItem(it)} />)}
        </div>
      )}
    </div>
  );
}

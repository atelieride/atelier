import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/en';
import { FontList, useFontBrowse } from './FontList';
import { Icon } from './Icon';

const POP_WIDTH = 356;
const GAP = 6;
const MARGIN = 8;

/**
 * Under the button (above it when there is no room), on <body> so the Settings sheet's edges don't clip it. Settings
 * leaves its keys alone (Settings.tsx, `.font-pop`): Esc goes back here, Tab too. A press outside goes back; when the
 * Settings pane scrolls it follows its row, and goes back once the row leaves the pane.
 */
export function FontPopover({ anchor, onClose }: { anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  // Closed from inside (keys, a click in the list) the focus goes back to the button; a press elsewhere keeps its own.
  const b = useFontBrowse(() => {
    onClose();
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (!now || now === document.body || !now.isConnected) anchor.current?.focus({ preventScroll: true });
    });
  });
  const back = useRef(b.back);
  back.current = b.back;

  useLayoutEffect(() => {
    const el = pop.current;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a || !el) return;
      // Its row scrolled out of the Settings pane: nothing left to point at.
      const pane = anchor.current?.closest('.set-content')?.getBoundingClientRect();
      const mid = a.top + a.height / 2;
      if (pane && (mid < pane.top || mid > pane.bottom)) { back.current(); return; }
      const h = el.offsetHeight;
      const below = window.innerHeight - a.bottom - GAP - MARGIN;
      const up = below < h && a.top - GAP - MARGIN > below;
      const left = Math.max(MARGIN, Math.min(a.right - POP_WIDTH, window.innerWidth - POP_WIDTH - MARGIN));
      setPos({ left, top: up ? Math.max(MARGIN, a.top - GAP - h) : a.bottom + GAP, up });
    };
    place();
    // The list arrives after the first paint: its height can move the popover above the button.
    const sizes = new ResizeObserver(place);
    if (el) sizes.observe(el);
    window.addEventListener('resize', place);
    // The Settings pane scrolling (the wheel, or the focus bringing the button below the docked preview): it follows.
    const pane = anchor.current?.closest('.set-content');
    pane?.addEventListener('scroll', place);
    return () => { sizes.disconnect(); window.removeEventListener('resize', place); pane?.removeEventListener('scroll', place); };
  }, [anchor]);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    const down = (e: PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      // The button closes it on its own click (a toggle; unmounting puts the font in use back).
      if (!target || pop.current?.contains(target) || anchor.current?.contains(target)) return;
      back.current();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [anchor]);

  const active = b.index >= 0 ? `font-pop-${b.index}` : undefined;
  return createPortal(
    <div ref={pop} className={`font-pop ${pos?.up ? 'is-up' : ''}`} role="dialog" aria-label={t.fontPick.popover} data-own-esc=""
      // Until measured (a layout effect, before the first paint): the window's corner, never below it at the end of
      // <body>. Not hidden: the search field takes the focus from the same commit.
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0 }}
      onKeyDown={(e) => {
        if (e.key === 'Tab') { e.preventDefault(); b.back(); return; }
        b.onKey(e);
      }}>
      <label className="font-pop-search">
        <Icon name="search" size={14} stroke={1.8} />
        <input ref={input} type="text" placeholder={t.fontPick.search} value={b.query} spellCheck={false} aria-label={t.fontPick.search}
          role="combobox" aria-expanded="true" aria-controls="font-pop-list" aria-activedescendant={active}
          onChange={(e) => b.search(e.target.value)} />
        {b.query.trim() && <span className="font-pop-count mono">{t.fontPick.count(b.choices.flat.length, b.total)}</span>}
      </label>
      <FontList b={b} idPrefix="font-pop" variant="pop" />
      <div className="font-pop-foot">
        <span className="mono">{t.fontPick.keys}</span>
        <span>{t.fontPick.monoOnly}</span>
      </div>
    </div>,
    document.body
  );
}

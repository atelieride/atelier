// The editor's anchored popover: under its field, flipped above when the sheet has
// no room below, at most 280 px tall. It lives in a portal: the sheet's blur would otherwise be its containing block.
// A press outside it and its field closes it; it follows the field when the form scrolls or the field grows; the field
// owns the keys. React portals bubble through the React tree, so the sheet still stops its presses and its Esc.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const GAP = 4;
const MARGIN = 8;
const MAX_HEIGHT = 280;
/** Below this much room under the field, it opens above when there is more there. */
const MIN_BELOW = 160;

type Place = { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number });

function place(anchor: HTMLElement, minWidth: number): Place {
  const r = anchor.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, minWidth), window.innerWidth - 2 * MARGIN);
  const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - MARGIN - width));
  const below = window.innerHeight - r.bottom - GAP - MARGIN;
  const above = r.top - GAP - MARGIN;
  if (below < MIN_BELOW && above > below) return { left, width, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) };
  return { left, width, top: r.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) };
}

export function ChoicePopover({ anchor, minWidth = 280, onClose, className = '', children }: {
  anchor: HTMLElement; minWidth?: number; onClose: () => void; className?: string; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(() => place(anchor, minWidth));
  useLayoutEffect(() => {
    const again = () => setAt(place(anchor, minWidth));
    const ro = new ResizeObserver(again);
    ro.observe(anchor);
    const scrolled = (e: Event) => { if (!box.current?.contains(e.target as Node)) again(); };
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', again);
    return () => { ro.disconnect(); window.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', again); };
  }, [anchor, minWidth]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [anchor, onClose]);
  return createPortal(
    <div ref={box} className={`ae-pop ${'bottom' in at ? 'is-above' : ''} ${className}`}
      style={{ left: at.left, width: at.width, maxHeight: at.maxHeight, ...('top' in at ? { top: at.top } : { bottom: at.bottom }) }}
      // A press inside never takes the focus from the field that owns the keys.
      onMouseDown={(e) => { if (!(e.target as HTMLElement).closest('input')) e.preventDefault(); }}>
      {children}
    </div>,
    document.body
  );
}

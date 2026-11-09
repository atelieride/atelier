// A confirm hanging from what it was asked from: under a tab or the pop-out's bar; with
// nothing on screen to hang from, the same box as a centered top sheet.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { onEscCancel, useDismiss } from './InlineConfirm';

const WIDTH = 300;
const GAP = 8;
const MARGIN = 12;

/** Where the box goes for an anchor's rect: under it, its `align` edge on the anchor's, kept inside the window. */
export function popoverPlace(rect: { left: number; right: number; bottom: number } | null, align: 'start' | 'end', viewport: { width: number }): { left: number; top: number; arrow: number } | null {
  if (!rect) return null;
  const want = align === 'end' ? rect.right - WIDTH : rect.left;
  const left = Math.max(MARGIN, Math.min(want, viewport.width - WIDTH - MARGIN));
  // The arrow points at the anchor's middle, within the box's rounded corners.
  const mid = (rect.left + rect.right) / 2 - left;
  return { left, top: rect.bottom + GAP, arrow: Math.max(18, Math.min(mid, WIDTH - 18)) };
}

export function ConfirmPopover({ anchor, align, label, onCancel, children }: { anchor: string | null; align: 'start' | 'end'; label: string; onCancel: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof popoverPlace>>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = anchor ? document.querySelector(anchor) : null;
      const r = el instanceof HTMLElement && el.offsetParent !== null ? el.getBoundingClientRect() : null;
      setPlace(popoverPlace(r, align, { width: window.innerWidth }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchor, align]);
  useDismiss(box, onCancel);
  return (
    <div ref={box} className={`confirm-pop${place ? '' : ' is-centered'}`} role="alertdialog" aria-label={label} data-own-esc=""
      style={place ? { left: place.left, top: place.top, ['--arrow' as string]: `${place.arrow}px` } : undefined}
      onKeyDown={onEscCancel(onCancel)}>
      {children}
    </div>
  );
}

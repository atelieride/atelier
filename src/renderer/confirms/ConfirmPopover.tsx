// A confirm hanging from what it was asked from: under a tab or the pop-out's bar, or beside a
// sidebar row (a bubble); with nothing on screen to hang from, the same box as a centered top sheet.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { onEscCancel, useDismiss } from './InlineConfirm';

const WIDTH = 300;
const GAP = 8;
const MARGIN = 12;
const SIDE_GAP = 10;

/** Where the box goes for an anchor's rect: under it, its `align` edge on the anchor's, kept inside the window. */
export function popoverPlace(rect: { left: number; right: number; bottom: number } | null, align: 'start' | 'end', viewport: { width: number }): { left: number; top: number; arrow: number } | null {
  if (!rect) return null;
  const want = align === 'end' ? rect.right - WIDTH : rect.left;
  const left = Math.max(MARGIN, Math.min(want, viewport.width - WIDTH - MARGIN));
  // The arrow points at the anchor's middle, within the box's rounded corners.
  const mid = (rect.left + rect.right) / 2 - left;
  return { left, top: rect.bottom + GAP, arrow: Math.max(18, Math.min(mid, WIDTH - 18)) };
}

/**
 * Where a bubble goes beside a row: right of it, the box's `pivot` (its danger button's middle) level with the row's
 * middle, so the answer is a short move from what was pressed; kept inside the window. The arrow points at the row.
 */
export function sidePlace(rect: { right: number; top: number; bottom: number } | null, box: { width: number; height: number; pivot: number }, viewport: { width: number; height: number }): { left: number; top: number; arrow: number } | null {
  if (!rect) return null;
  const left = Math.max(MARGIN, Math.min(rect.right + SIDE_GAP, viewport.width - box.width - MARGIN));
  const mid = (rect.top + rect.bottom) / 2;
  const top = Math.max(MARGIN, Math.min(mid - box.pivot, viewport.height - box.height - MARGIN));
  return { left, top, arrow: Math.max(16, Math.min(mid - top, box.height - 16)) };
}

/**
 * `side`: a bubble beside the anchor (a sidebar row) instead of a box under it. `restore`: what takes the focus back
 * once answered from the keyboard. `keep`: a press there doesn't cancel (the button that asked takes the question back
 * itself).
 */
export function ConfirmPopover({ anchor, align, side = false, restore, keep, label, onCancel, children }: { anchor: string | null; align: 'start' | 'end'; side?: boolean; restore?: string; keep?: string; label: string; onCancel: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof popoverPlace>>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = anchor ? document.querySelector(anchor) : null;
      const r = el instanceof HTMLElement && el.offsetParent !== null ? el.getBoundingClientRect() : null;
      const b = box.current;
      if (!side || !b) { setPlace(popoverPlace(r, align, { width: window.innerWidth })); return; }
      // Layout sizes: the entrance's transform doesn't move them.
      const go = b.querySelector<HTMLElement>('.btn-danger');
      const pivot = go ? go.offsetTop + go.offsetHeight / 2 : b.offsetHeight / 2;
      setPlace(sidePlace(r, { width: b.offsetWidth, height: b.offsetHeight, pivot }, { width: window.innerWidth, height: window.innerHeight }));
    };
    measure();
    window.addEventListener('resize', measure);
    // The list scrolling under it: the bubble follows its row.
    if (side) window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchor, align, side]);
  useDismiss(box, onCancel, undefined, keep);
  // Answered from the keyboard: the focus goes back to what asked, unless something else took it meanwhile.
  useEffect(() => () => {
    if (!restore) return;
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (!now || now === document.body) document.querySelector<HTMLElement>(restore)?.focus({ preventScroll: true });
    });
  }, [restore]);
  return (
    <div ref={box} className={`confirm-pop${side ? ' is-side' : ''}${place ? '' : ' is-centered'}`} role="alertdialog" aria-label={label} data-own-esc=""
      style={place ? { left: place.left, top: place.top, ['--arrow' as string]: `${place.arrow}px` } : undefined}
      onKeyDown={onEscCancel(onCancel)}>
      {children}
    </div>
  );
}

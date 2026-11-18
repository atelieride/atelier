// A confirm hanging from what it was asked from: under a tab or the pop-out's bar, or beside a
// sidebar row (a bubble); with nothing on screen to hang from, the same box as a centered top sheet.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { onEscCancel, useDismiss } from './InlineConfirm';

const WIDTH = 300;
const GAP = 8;
const MARGIN = 12;
const SIDE_GAP = 10;

/** Where a confirm stands: its corner, where its arrow points along its edge and, beside a row, on which side of it. */
export interface Place { left: number; top: number; arrow: number; side?: 'left' | 'right' }

/** Where the box goes for an anchor's rect: under it, its `align` edge on the anchor's, kept inside the window. */
export function popoverPlace(rect: { left: number; right: number; bottom: number } | null, align: 'start' | 'end', viewport: { width: number }): Place | null {
  if (!rect) return null;
  const want = align === 'end' ? rect.right - WIDTH : rect.left;
  const left = Math.max(MARGIN, Math.min(want, viewport.width - WIDTH - MARGIN));
  // The arrow points at the anchor's middle, within the box's rounded corners.
  const mid = (rect.left + rect.right) / 2 - left;
  return { left, top: rect.bottom + GAP, arrow: Math.max(18, Math.min(mid, WIDTH - 18)) };
}

/**
 * Where a bubble goes beside a row: right of it when it fits there, else left of it (the sidebar at the window's right
 * edge), else on the side with more room; the box's `pivot` (its danger button's middle) level with the row's middle,
 * so the answer is a short move from what was pressed; kept inside the window. The arrow points at the row. A row
 * whose middle is outside `sight` (the part of its list on screen; the window by default) has no place: nothing there
 * to point at.
 */
export function sidePlace(rect: { left: number; right: number; top: number; bottom: number } | null, box: { width: number; height: number; pivot: number }, viewport: { width: number; height: number }, sight: { top: number; bottom: number } = { top: 0, bottom: viewport.height }): Place | null {
  if (!rect) return null;
  const mid = (rect.top + rect.bottom) / 2;
  if (mid < sight.top || mid > sight.bottom) return null;
  const roomRight = viewport.width - MARGIN - rect.right - SIDE_GAP;
  const roomLeft = rect.left - SIDE_GAP - MARGIN;
  const side = roomRight >= box.width || roomRight >= roomLeft ? 'right' : 'left';
  const want = side === 'right' ? rect.right + SIDE_GAP : rect.left - SIDE_GAP - box.width;
  const left = Math.max(MARGIN, Math.min(want, viewport.width - box.width - MARGIN));
  const top = Math.max(MARGIN, Math.min(mid - box.pivot, viewport.height - box.height - MARGIN));
  return { left, top, arrow: Math.max(16, Math.min(mid - top, box.height - 16)), side };
}

/** The ancestors that cut off what they hold (the scrolling sidebar): a row outside them is out of sight. */
function clippers(el: Element): Element[] {
  const out: Element[] = [];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (getComputedStyle(p).overflowY !== 'visible') out.push(p);
  }
  return out;
}

const samePlace = (a: Place | null, b: Place | null) =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.arrow === b.arrow && a.side === b.side);

/** What Tab reaches inside the box. */
const TABBABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * `side`: a bubble beside the anchor (a sidebar row) instead of a box under it. `restore`: what takes the focus back
 * once answered, the first of them on the page. `keep`: a press there doesn't cancel (the button that asked takes the
 * question back itself). `describedBy`: the ids of the lines that say what answering does.
 */
export function ConfirmPopover({ anchor, align, side = false, restore, keep, label, describedBy, onCancel, children }: { anchor: string | null; align: 'start' | 'end'; side?: boolean; restore?: readonly string[]; keep?: string; label: string; describedBy?: string; onCancel: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);
  // Measured every frame while open — one read of the anchor's box (and of the lists around a row), a new place only
  // when it changes — so it follows whatever moves the anchor: a scroll, a row above it appearing or folding away, its
  // row changing section or growing a line, the window resized. An anchor that leaves the screen or its list's sight
  // hands the question over to the centered box, and takes it back once in sight again.
  useLayoutEffect(() => {
    let el: HTMLElement | null = null;
    let clips: Element[] = [];
    let last: Place | null = null;
    let frame = 0;
    const measure = () => {
      const b = box.current;
      if (!b) return;
      if (!el?.isConnected) {
        const found = anchor ? document.querySelector(anchor) : null;
        el = found instanceof HTMLElement ? found : null;
        clips = el && side ? clippers(el) : [];
      }
      const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
      let next: Place | null;
      if (!side) next = popoverPlace(r, align, { width: window.innerWidth });
      else {
        // Layout sizes: the entrance's transform doesn't move them.
        const go = b.querySelector<HTMLElement>('.btn-danger');
        const pivot = go ? go.offsetTop + go.offsetHeight / 2 : b.offsetHeight / 2;
        const sight = { top: 0, bottom: window.innerHeight };
        for (const c of clips) {
          const k = c.getBoundingClientRect();
          sight.top = Math.max(sight.top, k.top);
          sight.bottom = Math.min(sight.bottom, k.bottom);
        }
        next = sidePlace(r, { width: b.offsetWidth, height: b.offsetHeight, pivot }, { width: window.innerWidth, height: window.innerHeight }, sight);
      }
      if (samePlace(next, last)) return;
      last = next;
      setPlace(next);
    };
    const tick = () => { measure(); frame = requestAnimationFrame(tick); };
    measure();
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [anchor, align, side]);
  useDismiss(box, onCancel, undefined, keep);
  // Once answered (the keyboard's or the pointer's answer): the focus goes back to what asked, unless something else
  // took it meanwhile.
  const back = useRef(restore);
  back.current = restore;
  useEffect(() => () => {
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now && now !== document.body) return;
      for (const s of back.current ?? []) {
        const el = document.querySelector<HTMLElement>(s);
        if (el) { el.focus({ preventScroll: true }); return; }
      }
    });
  }, []);
  const esc = onEscCancel(onCancel);
  // Tab and Shift+Tab go round the question's own answers: the keyboard stays with it, where Esc answers it.
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') { esc(e); return; }
    const all = [...(box.current?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])];
    if (all.length === 0) return;
    e.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (e.shiftKey ? all.length - 1 : 0) : (at + (e.shiftKey ? all.length - 1 : 1)) % all.length;
    all[next]!.focus();
  };
  return (
    <div ref={box} className={`confirm-pop${side ? ' is-side' : ''}${place ? '' : ' is-centered'}${place?.side === 'left' ? ' is-left' : ''}`} role="alertdialog"
      aria-label={label} aria-describedby={describedBy || undefined} data-own-esc=""
      style={place ? { left: place.left, top: place.top, ['--arrow' as string]: `${place.arrow}px` } : undefined}
      onKeyDown={keys}>
      {children}
    </div>
  );
}

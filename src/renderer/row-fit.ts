// A row's chips give way to its name: full while the name shows whole, compact (glyphs, one
// port chip) once full chips would cut it. The decision is always taken in the full layout: a compact row tries it
// (attribute off, measure, back on: read at once, never painted) when that can succeed, so a row never flips between
// the two at one width and goes full again as soon as its chips shrink.
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

interface Measure { need: number; room: number; chips: number }

/** need: the name's whole width; room: what it has (its width plus its line's free space); chips: how far they reach past it. */
export function cutsName(m: Measure): boolean {
  return m.chips > 0 && m.need > m.room + 0.5;
}

/**
 * Compact, whether a trial in the full layout is worth it: the chips changed since they were last full (`sig`: their
 * text, the same in both forms), or the room the name would keep beside them (`full`: how far they reached) holds it.
 */
export function worthTrial(last: { full: number; sig: string }, m: Measure & { sig: string }): boolean {
  return last.sig !== m.sig || m.need <= m.room - (last.full - m.chips) + 0.5;
}

export interface RowFitParts {
  /** The name's element. */
  name: string;
  /** The chips that have a compact form. */
  chips: string;
  /** While the row matches this it keeps its form: never changed under the pointer or the keyboard, nor mid-rename. */
  busy?: string;
}

/**
 * The width a name's text needs, whatever its box: a name that fills its line (a terminal's) is wider than its text,
 * a cut one narrower. Its text's own extent (an ellipsis only hides the end), plus a dot drawn after it (unread).
 */
function textWidth(el: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  const after = getComputedStyle(el, '::after');
  const dot = after.content && after.content !== 'none' ? (parseFloat(after.width) || 0) + (parseFloat(after.marginLeft) || 0) : 0;
  return range.getBoundingClientRect().width + dot;
}

function measure(el: HTMLElement, name: HTMLElement, chipsSel: string): Measure {
  const nb = name.getBoundingClientRect();
  // From the name's end to the last chip's: their gaps change with them, so they count too.
  const ends = [...el.querySelectorAll<HTMLElement>(chipsSel)].map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0).map((b) => b.right);
  const chips = ends.length ? Math.max(0, Math.max(...ends) - nb.right) : 0;
  // The line's free space after its last piece shown (a name that doesn't fill its line has more than its width).
  const line = name.parentElement!;
  const shown = [...line.children].filter((c) => (c as HTMLElement).offsetWidth > 0);
  const end = shown.length ? shown[shown.length - 1]!.getBoundingClientRect().right : nb.right;
  const free = Math.max(0, line.getBoundingClientRect().right - (parseFloat(getComputedStyle(line).paddingRight) || 0) - end);
  return { need: textWidth(name), room: nb.width + free, chips };
}

/**
 * Keeps `data-tight` on the row (an attribute: React owns className): measured after every render, and a frame after
 * the row or its name changes size or the pointer leaves it (a frame later, so a change never feeds back into the same
 * ResizeObserver pass). Written only when it changes.
 */
export function useRowFit(row: RefObject<HTMLElement | null>, parts: RowFitParts): void {
  const last = useRef({ full: 0, sig: '' });
  const ro = useRef<ResizeObserver | null>(null);
  const watched = useRef<Element | null>(null);
  const run = useRef(() => {});
  run.current = () => {
    const el = row.current;
    if (!el) return;
    const name = el.querySelector<HTMLElement>(parts.name);
    // The name's element changes (a rename, a question answered): watch the one shown.
    if (ro.current && name !== watched.current) {
      if (watched.current) ro.current.unobserve(watched.current);
      if (name) ro.current.observe(name);
      watched.current = name;
    }
    if (!name || (parts.busy && el.matches(parts.busy))) return;
    const chipEls = [...el.querySelectorAll<HTMLElement>(parts.chips)];
    const sig = `${chipEls.length}:${chipEls.map((c) => c.textContent).join('|')}`;
    if (el.hasAttribute('data-tight')) {
      if (!worthTrial(last.current, { ...measure(el, name, parts.chips), sig })) return;
      el.removeAttribute('data-tight');
    }
    const m = measure(el, name, parts.chips);
    last.current = { full: m.chips, sig };
    if (cutsName(m)) el.setAttribute('data-tight', '');
  };
  useLayoutEffect(() => run.current());
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => run.current()); };
    const observer = new ResizeObserver(later);
    observer.observe(el);
    ro.current = observer;
    watched.current = null;
    run.current();
    el.addEventListener('pointerleave', later);
    el.addEventListener('focusout', later);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      ro.current = null;
      el.removeEventListener('pointerleave', later);
      el.removeEventListener('focusout', later);
    };
  }, [row]);
}

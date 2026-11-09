// The layout at every width (asked for after the FK peek card's name, plan chip and "Open ›" collided in a
// mockup): what a surface shows must never overlap, spill out of its box, wrap inside a control
// or be cut without an ellipsis. Generalizes the session rows' rowOverlaps (states.spec.ts) to any root and its parts.
import type { Locator } from '@playwright/test';

export interface LayoutProblems {
  /** Two parts drawn over each other by more than half a pixel each way ("a × b"); a part inside another doesn't count. */
  overlaps: string[];
  /** A part reaching out of the root by more than half a pixel; a text running past its own box ("spills"). */
  outside: string[];
  /** A control — a button, a link, a chip, a tag, a radio, a menu item; a part or inside one — whose text takes more than one line. */
  wrapped: string[];
  /** Text cut by its box (overflow hidden) without an ellipsis: in a part or an element inside it. */
  clipped: string[];
}

/**
 * The problems of `root`'s `parts` (CSS selectors, matched inside root) as drawn now. Parts hidden or of no size are left
 * out; each problem names the selector and the start of its text. Every list empty: the layout holds.
 */
export function layoutProblems(root: Locator, parts: string[]): Promise<LayoutProblems> {
  return root.evaluate((rootEl, sels) => {
    const label = (s: string, el: Element) => {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
      return text ? `${s} "${text}"` : s;
    };
    const drawn = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    };
    const boxes = sels.flatMap((s) => [...rootEl.querySelectorAll(s)].filter(drawn).map((el) => ({ s, el, r: el.getBoundingClientRect() })));
    const own = rootEl.getBoundingClientRect();
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 0.5 && h > 0.5) overlaps.push(`${label(a.s, a.el)} × ${label(b.s, b.el)}`);
      }
    }
    // Outside: what reaches past the root where nothing between them hides it (a box inside the root that hides its
    // overflow cuts it instead — `clipped` says whether that cut shows an ellipsis; one that scrolls lets it be reached).
    // The root's own hiding doesn't excuse it — but for a root that ellipsizes, its sideways overflow is that ellipsis.
    const hides = (el: Element) => { const cs = getComputedStyle(el); return cs.overflowX !== 'visible' || cs.overflowY !== 'visible'; };
    const held = (el: Element) => { for (let p = el.parentElement; p && p !== rootEl; p = p.parentElement) if (hides(p)) return true; return false; };
    const rootEllipsis = getComputedStyle(rootEl).textOverflow === 'ellipsis';
    const outside = boxes
      .filter((b) => (!rootEllipsis && (b.r.left < own.left - 0.5 || b.r.right > own.right + 0.5)) || b.r.top < own.top - 0.5 || b.r.bottom > own.bottom + 0.5)
      .filter((b) => !held(b.el))
      .map((b) => label(b.s, b.el));
    // Spilling: a part, or an element in it, whose own text runs past its box where nothing hides it (a button's label
    // wider than the button, a word wider than its card).
    const spills = (el: Element) => {
      if (!(el instanceof HTMLElement) || !drawn(el) || hides(el)) return false;
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim())) return false;
      return el.scrollWidth > el.clientWidth + 0.5 || el.scrollHeight > el.clientHeight + 0.5;
    };
    const spilled = new Set<Element>();
    for (const b of boxes) {
      for (const el of [b.el, ...b.el.querySelectorAll('*')]) {
        if (spilled.has(el) || !spills(el) || held(el)) continue;
        spilled.add(el);
        outside.push(`${label(el === b.el ? b.s : `${b.s} ${el.tagName.toLowerCase()}`, el)} spills out of its box`);
      }
    }
    const CONTROL = 'button, a, [role="button"], [role="radio"], [role="menuitem"], [role="tab"]';
    // Chips, pills, tags, badges, Open › and links by their class names' ends (db-env, dbt-fchip, dbt-cchip, dbi-peek-open…).
    const isControl = (el: Element) => el.matches(CONTROL)
      || (typeof el.className === 'string' && el.className.split(/\s+/).some((c) => /(chip|pill|env|tag|badge|open|link)$/.test(c)));
    /**
     * Its text's line boxes: more than one when a run of its text breaks across lines (a text node's rects at different
     * heights). A control laid out on two lines on purpose — a name, its columns under it — has one run per line.
     */
    const lines = (el: Element) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!(n.textContent ?? '').trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
        if (rects.length < 2) continue;
        const h = Math.min(...rects.map((r) => r.height));
        const tops = rects.map((r) => r.top);
        if (Math.max(...tops) - Math.min(...tops) > h / 2) return 2;
      }
      return 1;
    };
    // The parts that are controls, and the controls inside the parts.
    const controls = new Map<Element, string>();
    for (const b of boxes) {
      if (isControl(b.el)) controls.set(b.el, b.s);
      for (const el of b.el.querySelectorAll('*')) if (!controls.has(el) && drawn(el) && isControl(el)) controls.set(el, `${b.s} ${el.tagName.toLowerCase()}`);
    }
    const wrapped = [...controls].filter(([el]) => lines(el) > 1).map(([el, s]) => label(s, el));
    // Cut: a box that hides what overflows it, its text wider than it, and nothing to say so — no ellipsis, no fade (a
    // mask on it or its parent).
    const faded = (el: Element | null) => !!el && ((s) => (s.webkitMaskImage || s.maskImage || 'none') !== 'none')(getComputedStyle(el));
    const cut = (el: Element) => {
      if (!(el instanceof HTMLElement) || !drawn(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') return false;
      if (el.scrollWidth <= el.clientWidth + 0.5) return false;
      if (!(el.textContent ?? '').trim()) return false;
      return cs.textOverflow !== 'ellipsis' && !faded(el) && !faded(el.parentElement);
    };
    const clipped: string[] = [];
    const seen = new Set<Element>([rootEl]);
    if (cut(rootEl)) clipped.push(label('(root)', rootEl));
    for (const b of boxes) {
      for (const el of [b.el, ...b.el.querySelectorAll('*')]) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (cut(el)) clipped.push(label(el === b.el ? b.s : `${b.s} ${el.tagName.toLowerCase()}.${(typeof el.className === 'string' ? el.className : '').split(' ')[0]}`, el));
      }
    }
    return { overlaps, outside, wrapped, clipped };
  }, parts);
}

/** No problem at all: the empty lists (what a test expects). */
export const NO_PROBLEMS: LayoutProblems = { overlaps: [], outside: [], wrapped: [], clipped: [] };

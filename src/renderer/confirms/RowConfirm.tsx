// Closing from a sidebar row: its × asks in a bubble beside the row (the row keeps its size), and a
// row whose terminal is gone folds away.
import { useLayoutEffect, type RefObject } from 'react';
import { useApp } from '../store';
import { reducedMotion } from '../motion';

/**
 * A row's ×: asks, or closes at once; then its × is gone ("Closing…"), so the focus goes to the row's own button.
 * Pressed while its question is open, it takes the question back.
 */
export function closeFromRow(id: string, row: HTMLElement | null): void {
  const st = useApp.getState();
  if (st.closeAsk?.id === id && st.closeAsk.at === 'row') { st.cancelClose(); return; }
  st.askClose(id, 'row');
  if (useApp.getState().closing[id]) row?.querySelector<HTMLElement>('.row-main')?.focus({ preventScroll: true });
}

/**
 * What a row's look is made of: its pieces' boxes, places, paint and text. Only these are held (a whole computed
 * style is ~750 properties per element, ten times the work for nothing anyone sees in a fold this short).
 */
const LOOK = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'box-sizing', 'width', 'height', 'min-width', 'max-width',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap', 'align-items', 'align-self', 'align-content',
  'justify-content', 'justify-items', 'justify-self', 'order', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows',
  'grid-auto-flow', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'overflow-x', 'overflow-y',
  'vertical-align', 'visibility', 'aspect-ratio', 'object-fit',
  'color', 'background-color', 'background-image', 'background-size', 'background-position-x', 'background-position-y',
  'background-repeat', 'background-clip', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius',
  'border-bottom-left-radius', 'box-shadow', 'opacity', 'transform', 'transform-origin', 'filter', 'clip-path', 'mask-image',
  '-webkit-mask-image', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-ligatures', 'font-variant-numeric', 'font-feature-settings',
  'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line', 'text-decoration-color', 'text-overflow',
  'white-space', 'word-break', 'overflow-wrap', '-webkit-line-clamp', '-webkit-box-orient', 'text-shadow'
];

/**
 * Every element of `copy` keeps the look its twin in `from` has now, held in its own style, and loses its classes:
 * no selector finds or restyles it any more (the rows' rules, their state cues, a test looking for a row), and
 * nothing in it plays its entrance again. The root's fold (its animation, overflow, pointer) comes from .row-leaving.
 */
function freeze(from: HTMLElement, copy: HTMLElement): void {
  const twins = [from, ...from.querySelectorAll('*')];
  const copies = [copy, ...copy.querySelectorAll('*')];
  twins.forEach((el, i) => {
    const to = copies[i];
    if (!(to instanceof HTMLElement || to instanceof SVGElement)) return;
    const cs = getComputedStyle(el);
    let text = '';
    for (const p of LOOK) {
      if (i === 0 && (p === 'overflow-x' || p === 'overflow-y')) continue;
      text += `${p}:${cs.getPropertyValue(p)};`;
    }
    to.style.cssText = i === 0 ? text : `${text}animation:none;transition:none;`;
    to.removeAttribute('class');
  });
}

/**
 * A row leaving because its terminal is gone folds away instead of vanishing: a lifeless copy takes its place for
 * the length of the animation, then removes itself. A row that leaves for any other reason (another view, another
 * workspace, a filter) just goes, and so does every row under Reduce motion (the setting's or the system's).
 */
export function useRowLeave(row: RefObject<HTMLElement | null>, id: string): void {
  useLayoutEffect(() => () => {
    // Read as the row goes: it is still in the page, about to be removed.
    const el = row.current;
    if (!el?.isConnected || el.offsetParent === null) return;
    if (useApp.getState().terminals.some((t) => t.id === id)) return;
    if (reducedMotion()) return;
    // Another row is the selected one now: the copy isn't marked as it. Its look is taken as it ends, not halfway
    // through a transition (none runs on a row about to go).
    for (const x of [el, ...el.querySelectorAll('*')]) if (x instanceof HTMLElement || x instanceof SVGElement) x.style.transition = 'none';
    el.classList.remove('is-selected', 'is-asking');
    const ghost = el.cloneNode(true) as HTMLElement;
    freeze(el, ghost);
    // Nothing finds it as a row: no id, no role, no focus, no pointer.
    ghost.removeAttribute('data-term-row');
    ghost.removeAttribute('data-tip');
    ghost.setAttribute('role', 'presentation');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.className = 'row-leaving';
    ghost.style.setProperty('--leave-h', `${el.offsetHeight}px`);
    // A closing row's content is already faded: the copy starts from there.
    if (el.classList.contains('is-closing')) ghost.style.setProperty('--leave-o', '.7');
    el.after(ghost);
    const done = () => ghost.remove();
    ghost.addEventListener('animationend', (e) => { if (e.target === ghost) done(); });
    // Never left behind (a fold that never runs: a window that doesn't render): gone once it would have ended, with
    // room to spare, however long the motion tokens make it.
    const ms = Number.parseFloat(getComputedStyle(ghost).animationDuration) * 1000;
    setTimeout(done, (Number.isFinite(ms) ? ms : 0) * 2 + 50);
  }, [row, id]);
}

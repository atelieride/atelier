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
 * A row leaving because its terminal is gone folds away instead of vanishing: a lifeless copy takes its place for
 * the length of the animation, then removes itself. A row that leaves for any other reason (another view, another
 * workspace, a filter) just goes, and so does every row under Reduce motion (the setting's or the system's).
 * The copy keeps the row's classes, so it looks as the row did (its faded "closing" content, its unread dot); the app
 * finds rows by `data-term-row`, which the copy doesn't have.
 */
export function useRowLeave(row: RefObject<HTMLElement | null>, id: string): void {
  useLayoutEffect(() => () => {
    // Read as the row goes: it is still in the page, about to be removed.
    const el = row.current;
    if (!el?.isConnected || el.offsetParent === null) return;
    if (useApp.getState().terminals.some((t) => t.id === id)) return;
    if (reducedMotion()) return;
    // Another row is the selected one now: the copy isn't marked as it, and doesn't fade out of that look either (no
    // transition runs on a row about to go). No drop caret or question either.
    for (const x of [el, ...el.querySelectorAll('*')]) if (x instanceof HTMLElement || x instanceof SVGElement) x.style.transition = 'none';
    el.classList.remove('is-selected', 'is-asking', 'is-caret-before', 'is-caret-after');
    const ghost = el.cloneNode(true) as HTMLElement;
    // Nothing finds it as a row: no id, no role, no focus, no pointer.
    ghost.removeAttribute('data-term-row');
    ghost.removeAttribute('data-tip');
    ghost.setAttribute('role', 'presentation');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    // Nothing in it plays its entrance (or a spinner) again: only the fold moves.
    for (const x of ghost.querySelectorAll('*')) if (x instanceof HTMLElement || x instanceof SVGElement) x.style.animation = 'none';
    ghost.classList.remove('enter');
    ghost.classList.add('row-leaving');
    ghost.style.setProperty('--leave-h', `${el.offsetHeight}px`);
    el.after(ghost);
    const done = () => ghost.remove();
    ghost.addEventListener('animationend', (e) => { if (e.target === ghost) done(); });
    // Never left behind (a fold that never runs: a window that doesn't render): gone once it would have ended, with
    // room to spare, however long the motion tokens make it.
    const ms = Number.parseFloat(getComputedStyle(ghost).animationDuration) * 1000;
    setTimeout(done, (Number.isFinite(ms) ? ms : 0) * 2 + 50);
  }, [row, id]);
}

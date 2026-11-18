// Closing from a sidebar row: its × asks in a bubble beside the row (the row keeps its size), and a
// row whose terminal is gone folds away.
import { useLayoutEffect, type RefObject } from 'react';
import { useApp } from '../store';

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
 * workspace, a filter) just goes, and so does every row under "Reduce motion".
 */
export function useRowLeave(row: RefObject<HTMLElement | null>, id: string): void {
  useLayoutEffect(() => () => {
    // Read as the row goes: it is still in the page, about to be removed.
    const el = row.current;
    if (!el?.isConnected || el.offsetParent === null) return;
    if (useApp.getState().terminals.some((t) => t.id === id)) return;
    if (document.documentElement.dataset.motion === 'reduced') return;
    const ghost = el.cloneNode(true) as HTMLElement;
    // Nothing finds it as a row: no id, no role, no focus, no pointer.
    ghost.removeAttribute('data-term-row');
    ghost.removeAttribute('data-tip');
    ghost.setAttribute('role', 'presentation');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.classList.remove('enter', 'is-selected', 'is-asking');
    ghost.classList.add('row-leaving');
    ghost.style.setProperty('--leave-h', `${el.offsetHeight}px`);
    el.after(ghost);
    const done = () => ghost.remove();
    ghost.addEventListener('animationend', (e) => { if (e.target === ghost) done(); });
    // Never left behind (an animation that never ran: a hidden window).
    setTimeout(done, 600);
  }, [row, id]);
}

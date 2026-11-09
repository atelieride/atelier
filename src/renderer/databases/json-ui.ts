// What the JSON view's parts share: the lines on screen of a virtualized list (a
// fixed line height) and a copy that says so. Lazy, with the table's chunk.
import { useLayoutEffect, useState, type RefObject } from 'react';
import { copyText } from '../clipboard';
import { tdt } from '../i18n/db-table';
import { useApp } from '../store';
import { visibleRange } from './grid-model';

/** Lines drawn past each end of the screen. */
const OVERSCAN = 10;

const toast = (text: string, info = true) => useApp.getState().showToast(text, undefined, info ? 'info' : undefined);

/** Copies, then says so (`done`); a failure says that. */
export function copyOut(text: string, done: string): void {
  void copyText(text).then((ok) => { if (ok) toast(done); }, () => toast(tdt.copyFailed, false));
}

/**
 * The lines on screen of a virtualized list (fixed `rowH`): its scroll and height read on scroll (a frame at most) and
 * on resize; a render only when the first line on screen or the count of lines changes.
 */
export function useRange(ref: RefObject<HTMLElement | null>, count: number, rowH: number): { first: number; last: number } {
  const [vp, setVp] = useState({ row: 0, rows: Math.ceil(600 / rowH) });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const row = Math.floor(el.scrollTop / rowH);
      const rows = Math.ceil(el.clientHeight / rowH);
      setVp((v) => (v.row === row && v.rows === rows ? v : { row, rows }));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    read();
    return () => { ro.disconnect(); el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [ref, rowH]);
  return visibleRange(vp.row * rowH, vp.rows * rowH, rowH, count, OVERSCAN);
}

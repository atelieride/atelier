import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { DIVIDER_STEP_PX, dragDivider } from '../split';

/** The panes' widths as shown (the grid may hold a pane at its 240 px minimum) and their total, from their frames. */
function shown(el: HTMLElement): { fractions: number[]; width: number } | null {
  const frames = [...(el.parentElement?.querySelectorAll<HTMLElement>(':scope > .pane-frame') ?? [])]
    .sort((a, b) => Number(a.dataset.pane) - Number(b.dataset.pane));
  const widths = frames.map((f) => f.getBoundingClientRect().width);
  const width = widths.reduce((a, b) => a + b, 0);
  return width > 0 ? { fractions: widths.map((w) => w / width), width } : null;
}

/**
 * The divider between split-view panes `index` and `index + 1`: drag to resize (neither pane below
 * 240 px while the workspace has room), double-click for equal widths, ←/→ by 24 px when focused. A thin line that
 * brightens on hover over a wider invisible grab area; the store is updated at most once a frame while dragging (the
 * terminals refit through their own ResizeObserver).
 */
export function PaneDivider({ index, style }: { index: number; style: CSSProperties }) {
  const pos = useApp((s) => Math.round(s.split.fractions.slice(0, index + 1).reduce((a, b) => a + b, 0) * 100));
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; fractions: number[]; width: number } | null>(null);
  const frame = useRef(0);
  const pending = useRef<number[] | null>(null);
  const flush = () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (pending.current) useApp.getState().setFractions(pending.current);
    pending.current = null;
  };
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); document.documentElement.classList.remove('is-resizing'); }, []);
  const stop = () => {
    if (!start.current) return;
    start.current = null;
    flush();
    setDragging(false);
    document.documentElement.classList.remove('is-resizing');
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label={t.split.divider} tabIndex={0}
      aria-valuenow={pos} aria-valuemin={0} aria-valuemax={100} data-pane-keep data-tip={t.split.dividerHint}
      className={`pane-divider ${dragging ? 'is-dragging' : ''}`} style={style}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const m = shown(e.currentTarget);
        if (!m) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, ...m };
        setDragging(true);
        document.documentElement.classList.add('is-resizing');
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        pending.current = dragDivider(s.fractions, index, e.clientX - s.x, s.width);
        if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; flush(); });
      }}
      onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); stop(); }}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={() => useApp.getState().equalizePanes()}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? DIVIDER_STEP_PX : e.key === 'ArrowLeft' ? -DIVIDER_STEP_PX : 0;
        if (!step) return;
        e.preventDefault();
        const m = shown(e.currentTarget);
        if (m) useApp.getState().setFractions(dragDivider(m.fractions, index, step, m.width));
      }} />
  );
}

import { useRef, useState } from 'react';
import { PANEL_DEFAULTS, clampPanel, resizeDir, resizedWidth, type Panel } from '../panels';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { useDrawnWidth } from '../panel-drawn';

/**
 * Draggable edge of a side panel: dragging it away from its panel's side widens it (sides swap with the setting).
 * Double click: default width. With focus, the arrow keys change it by 16 px. The width is saved on release.
 * A small window draws a panel narrower than its saved width: narrowing starts from the width
 * drawn, so the edge moves at once; widening never lowers the saved width (panels.ts resizedWidth).
 */
export function Resizer({ panel }: { panel: Panel }) {
  const width = useApp((s) => s.panels[panel]);
  const setWidth = useApp((s) => s.setPanelWidth);
  const dir = resizeDir(panel, useApp((s) => s.settings.swapSidePanels));
  // saved: the width at the drag's start (the store's moves with the drag); moved: past the few pixels a click wobbles.
  const start = useRef<{ x: number; w: number; saved: number; moved: boolean } | null>(null);
  // What the edge reports: the width drawn (a small window draws it narrower than saved).
  const shown = useDrawnWidth(panel, true);
  const [dragging, setDragging] = useState(false);
  const label = panel === 'sidebar' ? t.resizeSidebar : t.resizeChanges;
  const drawn = (edge: HTMLElement) => {
    const el = edge.parentElement?.querySelector<HTMLElement>(panel === 'sidebar' ? ':scope > .sidebar' : ':scope > .changes');
    return el ? Math.min(width, Math.round(el.getBoundingClientRect().width)) : width;
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      aria-valuenow={shown ?? width} aria-valuemin={clampPanel(panel, 0)} aria-valuemax={clampPanel(panel, 1e6)}
      className={`resizer ${dragging ? 'is-dragging' : ''}`} data-tip={t.resizeHint(label)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: drawn(e.currentTarget), saved: width, moved: false };
        setDragging(true);
        document.documentElement.classList.add('is-resizing');
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        // A click that wobbles a pixel or two is not a drag (it would save the width drawn over the saved one).
        if (!s.moved && Math.abs(e.clientX - s.x) < 3) return;
        s.moved = true;
        setWidth(panel, resizedWidth(s.saved, s.w, dir * (e.clientX - s.x)), false);
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        start.current = null;
        setDragging(false);
        document.documentElement.classList.remove('is-resizing');
        setWidth(panel, useApp.getState().panels[panel], true);
      }}
      onDoubleClick={() => setWidth(panel, PANEL_DEFAULTS[panel], true)}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
        if (!step) return;
        e.preventDefault();
        setWidth(panel, resizedWidth(width, drawn(e.currentTarget), dir * step), true);
      }} />
  );
}

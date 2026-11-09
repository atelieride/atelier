// The width a side panel is drawn at: a small window draws it narrower than its saved width,
// and what sits beside it (toasts) or tells its size (its edge's aria-valuenow) follows what is drawn.
import { useLayoutEffect, useState } from 'react';
import type { Panel } from './panels';
import { useApp } from './store';

const SEL: Record<Panel, string> = { sidebar: ':scope > .sidebar', changes: ':scope > .changes' };

/**
 * Its drawn width while `active` (null otherwise, or without the panel): read again as the window resizes and whenever
 * either panel's saved width, Changes' visibility or the sidebar's view changes.
 */
export function useDrawnWidth(panel: Panel, active: boolean): number | null {
  const [w, setW] = useState<number | null>(null);
  const layout = useApp((s) => `${s.panels.sidebar}:${s.panels.changes}:${s.showChanges}:${s.activity}:${s.sidebarHidden}`);
  useLayoutEffect(() => {
    if (!active) { setW(null); return; }
    const body = document.querySelector<HTMLElement>('.app > .body');
    if (!body) { setW(null); return; }
    const read = () => {
      const el = body.querySelector<HTMLElement>(SEL[panel]);
      setW(el ? Math.round(el.getBoundingClientRect().width) : null);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(body);
    return () => ro.disconnect();
  }, [panel, active, layout]);
  return w;
}
